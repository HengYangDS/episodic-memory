import fs from 'fs';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
  admitExchanges,
  archiveAdmittedConversation,
  archiveIsCurrent,
  conversationLines,
  isCompressedConversation,
  isArchiveDivergence,
  isAdmissionRefusal,
  readRecordExclusions,
  recordExclusionsChangedMs,
} from './record-admission.js';
import path from 'path';
import { archivedRolloutRelativePath, getExcludedProjects, findJsonlFiles, statIfExists } from './paths.js';
import { formatErrorSentinel, shouldQueueForSummary } from './summary-sentinel.js';
import { getMaxMessageBytes, isOversizeExchange } from './message-size.js';

export { shouldSkipConversation } from './record-admission.js';
import { shouldSkipConversation } from './record-admission.js';

/**
 * True when a transcript contains at least one message line in any supported
 * harness format. Summarizer-spawned Agent SDK sessions materialize as
 * message-less stub files (a single {"type":"ai-title"} line) that defeat the
 * marker-based exclusion above and would otherwise re-enter the sync queue on
 * every run — one new stub per summary generated. A transcript that has no
 * messages *yet* (a session that just started) is skipped this run and picked
 * up on a later sync once it has content, since its mtime keeps advancing.
 * Reading stops at the first message line, so a large transcript is not
 * loaded whole.
 */
async function hasConversationContent(filePath: string): Promise<boolean> {
  try {
    for await (const line of conversationLines(filePath)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        // Claude: {type: "user"|"assistant", message: {...}}
        if ((parsed.type === 'user' || parsed.type === 'assistant') && parsed.message) {
          return true;
        }
        // Codex: {type: "response_item"|..., payload: {...}}
        if (parsed.payload) {
          return true;
        }
        // Cursor: {role: "user"|"assistant", message: {...}}
        if (parsed.role && parsed.message) {
          return true;
        }
        // opencode: {type: "opencode_message", message: {...}, parts: [...]}.
        // The message line has no top-level `role` and its `type` is neither
        // user nor assistant, so without this branch #113's pre-copy guard would
        // skip every opencode transcript before it is copied/indexed/summarized.
        if (parsed.type === 'opencode_message' && parsed.message) {
          return true;
        }
        // OMP: {type: "message", message: {role, content}, id, parentId}.
        // A session-header-only file has no message lines and is still skipped.
        if (parsed.type === 'message' && parsed.message && parsed.message.role) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    // If we can't read the file, let the normal pipeline handle it
    return true;
  }
}

export interface SyncResult {
  copied: number;
  skipped: number;
  indexed: number;
  summarized: number;
  /** Changed transcripts left for a later run by the whole-operation budget. */
  deferred: number;
  /** Changed transcripts whose single admission would exceed the per-file byte limit. */
  deferredOversize: number;
  /**
   * Transcripts whose current bytes the record policy refuses. The run that
   * first sees a refusal also reports it as an error; later runs hold the
   * unchanged file until it or the policy changes.
   */
  refused: number;
  /** Rewritten transcripts whose indexed archive is kept, because index rows address its lines; reported like refusals. */
  diverged: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Bounds for one whole sync operation. Admission screens every new record, so
 * an unbounded run over a large backlog can occupy the scanner for hours.
 * Unset limits are unbounded, which preserves the previous behavior.
 */
export interface SyncLimits {
  /** Transcripts admitted (copied or extended) in this run. */
  maxFiles?: number;
  /** Estimated transcript bytes admitted in this run. */
  maxBytes?: number;
  /** Defer any transcript whose own admission would read more than this. */
  maxFileBytes?: number;
  /** Epoch milliseconds after which no new admission or indexing starts. */
  deadlineMs?: number;
  /**
   * Epoch milliseconds after which no new admission starts, so the rest of the
   * window indexes what was admitted. Defaults to `deadlineMs`.
   */
  admissionDeadlineMs?: number;
}

/** One budget shared by every source directory of a sync run. */
export interface SyncBudget {
  readonly limits: SyncLimits;
  files: number;
  bytes: number;
}

export function createSyncBudget(limits: SyncLimits = {}): SyncBudget {
  return { limits, files: 0, bytes: 0 };
}

function pastDeadline(budget: SyncBudget): boolean {
  return budget.limits.deadlineMs !== undefined && Date.now() >= budget.limits.deadlineMs;
}

function pastAdmissionDeadline(budget: SyncBudget): boolean {
  const deadline = budget.limits.admissionDeadlineMs ?? budget.limits.deadlineMs;
  return deadline !== undefined && Date.now() >= deadline;
}

export interface SyncOptions {
  skipIndex?: boolean;
  skipSummaries?: boolean;
  summaryLimit?: number; // Max summaries to generate per run (default: 10)
  budget?: SyncBudget;
  /**
   * Replace an indexed archive whose source was rewritten with the admitted
   * rewrite and rebuild its rows from scratch. A rebuild interrupted after the
   * archive was replaced is finished by the next indexing run.
   */
  replaceDiverged?: boolean;
}

/**
 * Derive sync options from the process environment.
 *
 * `EPISODIC_MEMORY_SKIP_SUMMARIES=1` turns the summarization pass off.
 * Only the exact string '1' enables the switch — unset, '0', 'true',
 * and anything else leave summarization on, so a stray value can't
 * silently disable a feature the user still expects.
 *
 * Why anyone wants this: summaries are display-only. search.ts reads
 * the `-summary.txt` sidecar solely to decorate result output; summary
 * text is never embedded and never searched, so skipping it leaves
 * recall untouched. The summarizer, by contrast, resumes each
 * conversation through the Claude Agent SDK, which spends the user's
 * Claude quota and can stall on a permission prompt.
 */
export function buildSyncOptionsFromEnv(env: NodeJS.ProcessEnv): SyncOptions {
  return { skipSummaries: env.EPISODIC_MEMORY_SKIP_SUMMARIES === '1' };
}

export function extractSessionIdFromPath(filePath: string): string | null {
  // Extract session ID from Claude filename or Codex rollout filename.
  const basename = path.basename(filePath, '.jsonl');
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
  const matches = basename.match(uuidPattern);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1];
  }
  return null;
}

interface SyncCandidate {
  source: string;
  destination: string;
  size: number;
  mtimeMs: number;
}

/**
 * Bytes an admission would read: only the appended part of an archived
 * transcript, and an allowance for decompressing a compressed rollout.
 */
function admissionCost(candidate: SyncCandidate): number {
  if (isCompressedConversation(candidate.source)) return candidate.size * 8;
  const archived = statIfExists(candidate.destination);
  return archived?.isFile() ? Math.max(0, candidate.size - archived.size) : candidate.size;
}

/** A rebuild stage marks an archive whose rows must be replaced before it is trusted again. */
type SyncStage = 'admission' | 'index' | 'rebuild';

/** Identity, size and time of a regular file; any write or replacement changes it. */
function fileState(file: string): string | undefined {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` : undefined;
  } catch {
    return undefined;
  }
}

/** The source bytes and archive an admission is about to compare. */
interface AdmissionRead {
  source: fs.Stats;
  archive: string;
}

function admissionRead(source: string, archive: string): AdmissionRead | undefined {
  try {
    const info = fs.lstatSync(source);
    return info.isFile() ? { source: info, archive: fileState(archive) ?? '' } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where admission stopped on a source. A refusal or divergence lies in the
 * bytes admission read, so the hold also covers the source's appended growth:
 * it lasts while the source still starts with exactly those bytes and its
 * archive is unchanged. A live conversation is then neither screened nor
 * reported again on every run while it grows.
 */
interface SourceHold {
  dev: number;
  ino: number;
  size: number;
  sha256: string;
  /** The last state found held, accepted again without reading the source. */
  seenSize: number;
  seenMtimeMs: number;
  archive: string;
}

function digestPrefix(file: string, size: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let position = 0; position < size;) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (read <= 0) return undefined;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Index lookups and holds over one index connection. */
interface SyncState {
  indexed(archive: string): boolean;
  /** Why admission stopped on this source, if it only grew since and its archive is unchanged. */
  heldSource(source: string, archive: string): string | undefined;
  /** Hold a source on the bytes the stopped admission read. */
  holdSource(source: string, archive: string, read: AdmissionRead | undefined, error: Error): void;
  /** Why indexing stopped on this archive in exactly this state, if it did. */
  heldArchive(archive: string, state: string | undefined): string | undefined;
  /** Hold an archive only when it still has the state the stopped indexing read. */
  holdArchive(archive: string, readState: string | undefined, currentState: string | undefined, error: Error): void;
  release(stage: SyncStage, file: string): void;
  /** Mark an archive about to be replaced, so its rows are rebuilt even after an interruption. */
  markRebuild(archive: string): void;
  /** Archives whose rows must be rebuilt from scratch. */
  pendingRebuilds(): string[];
}

function createSyncState(db: Database.Database, policyDigest: string): SyncState {
  const indexed = db.prepare('SELECT 1 FROM exchanges WHERE archive_path = ? LIMIT 1');
  const find = db.prepare('SELECT state, policy, reason FROM sync_holds WHERE stage = ? AND path = ?');
  const record = db.prepare(
    'INSERT OR REPLACE INTO sync_holds (stage, path, state, policy, reason, held_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const forget = db.prepare('DELETE FROM sync_holds WHERE stage = ? AND path = ?');
  const rebuilds = db.prepare("SELECT path FROM sync_holds WHERE stage = 'rebuild'");
  const row = (stage: SyncStage, file: string) => {
    const found = find.get(stage, file) as { state: string; policy: string; reason: string } | undefined;
    return found?.policy === policyDigest ? found : undefined;
  };
  return {
    indexed: archive => indexed.get(archive) !== undefined,
    heldSource(source, archive) {
      const found = row('admission', source);
      if (!found) return undefined;
      let hold: SourceHold;
      let info: fs.Stats;
      try {
        hold = JSON.parse(found.state) as SourceHold;
        info = fs.lstatSync(source);
      } catch {
        return undefined;
      }
      if (!info.isFile() || info.dev !== hold.dev || info.ino !== hold.ino || info.size < hold.size) return undefined;
      if ((fileState(archive) ?? '') !== hold.archive) return undefined;
      if (info.size === hold.seenSize && info.mtimeMs === hold.seenMtimeMs) return found.reason;
      if (digestPrefix(source, hold.size) !== hold.sha256) return undefined;
      const seen: SourceHold = { ...hold, seenSize: info.size, seenMtimeMs: info.mtimeMs };
      record.run('admission', source, JSON.stringify(seen), policyDigest, found.reason, Date.now());
      return found.reason;
    },
    holdSource(source, archive, read, error) {
      if (!read) return;
      let info: fs.Stats;
      try { info = fs.lstatSync(source); } catch { return; }
      if (!info.isFile() || info.dev !== read.source.dev || info.ino !== read.source.ino || info.size < read.source.size) return;
      if ((fileState(archive) ?? '') !== read.archive) return;
      const sha256 = digestPrefix(source, read.source.size);
      if (sha256 === undefined) return;
      const hold: SourceHold = {
        dev: info.dev, ino: info.ino, size: read.source.size, sha256,
        seenSize: info.size, seenMtimeMs: info.mtimeMs, archive: read.archive,
      };
      record.run('admission', source, JSON.stringify(hold), policyDigest, error.message, Date.now());
    },
    heldArchive(archive, state) {
      const found = row('index', archive);
      return found !== undefined && state !== undefined && found.state === state ? found.reason : undefined;
    },
    holdArchive(archive, readState, currentState, error) {
      if (readState !== undefined && readState === currentState) {
        record.run('index', archive, readState, policyDigest, error.message, Date.now());
      }
    },
    release(stage, file) {
      forget.run(stage, file);
    },
    markRebuild(archive) {
      record.run('rebuild', archive, '', policyDigest, 'Archive replaced; rows pending rebuild', Date.now());
    },
    pendingRebuilds() {
      return (rebuilds.all() as Array<{ path: string }>).map(entry => entry.path);
    },
  };
}

/** A hold on a file that no longer exists has nothing left to protect. */
function releaseVanishedHolds(db: Database.Database): void {
  const forget = db.prepare('DELETE FROM sync_holds WHERE stage = ? AND path = ?');
  for (const row of db.prepare('SELECT stage, path FROM sync_holds').all() as Array<{ stage: string; path: string }>) {
    if (fileState(row.path) === undefined) forget.run(row.stage, row.path);
  }
}

/** Count a stage that stopped on a file's content rather than failing. */
function countHold(result: SyncResult, error: unknown): boolean {
  if (isAdmissionRefusal(error)) result.refused++;
  else if (isArchiveDivergence(error)) result.diverged++;
  else return false;
  return true;
}

function countHeld(result: SyncResult, reason: string): void {
  const held = new Error(reason);
  if (isArchiveDivergence(held)) result.diverged++;
  else if (isAdmissionRefusal(held)) result.refused++;
}

/** An archive whose exchanges are all empty, oversize or opted out gets no rows, so a row lookup cannot tell it was indexed. */
const NOTHING_TO_INDEX = 'Conversation has nothing to index';

export async function syncConversations(
  sourceDir: string,
  destDir: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const exclusions = readRecordExclusions();
  const exclusionsChangedMs = recordExclusionsChangedMs();
  const budget = options.budget ?? createSyncBudget();
  const { maxFiles, maxBytes, maxFileBytes } = budget.limits;
  const result: SyncResult = {
    copied: 0,
    skipped: 0,
    indexed: 0,
    summarized: 0,
    deferred: 0,
    deferredOversize: 0,
    refused: 0,
    diverged: 0,
    errors: []
  };

  // Ensure source directory exists
  if (!fs.existsSync(sourceDir)) {
    return result;
  }

  // Collect files to index and summarize
  const filesToIndex: string[] = [];
  const filesToSummarize: Array<{ path: string; sessionId: string | undefined }> = [];
  const summaryLimit = options.summaryLimit ?? 10;
  let summariesOutstanding = 0;

  // Walk source directory
  const projects = fs.readdirSync(sourceDir);
  const excludedProjects = getExcludedProjects();
  const excludedDirSet = new Set(excludedProjects);
  const candidates: SyncCandidate[] = [];

  for (const project of projects) {
    if (excludedProjects.includes(project)) {
      console.log("\nSkipping excluded project: " + project);
      continue;
    }

    const projectPath = path.join(sourceDir, project);
    const stat = statIfExists(projectPath);

    if (stat?.isFile()) {
      // A finished Codex rollout moved out of its dated directory.
      const relative = archivedRolloutRelativePath(project);
      if (relative) {
        candidates.push({ source: projectPath, destination: path.join(destDir, relative), size: stat.size, mtimeMs: stat.mtimeMs });
      }
      continue;
    }
    if (!stat?.isDirectory()) continue;

    const files = findJsonlFiles(projectPath, excludedDirSet, { includeCompressed: true });

    for (const file of files) {
      const source = path.join(projectPath, file);
      const destination = path.join(destDir, project, file.replace(/\.zst$/, ''));
      const info = statIfExists(source);
      candidates.push({ source, destination, size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0 });
    }
  }

  // Recent conversations are the most useful to recall, so a bounded run reaches them first.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Holds are remembered for this exact policy; any policy change retries them.
  const policyDigest = crypto.createHash('sha256').update(JSON.stringify(exclusions)).digest('hex');
  let state: SyncState | undefined;
  let closeState: (() => void) | undefined;
  if (!options.skipIndex) {
    const { initDatabase } = await import('./db.js');
    const db = initDatabase();
    closeState = () => db.close();
    releaseVanishedHolds(db);
    state = createSyncState(db, policyDigest);
  }

  try {
    for (const candidate of candidates) {
      const { source: srcFile, destination: destFile } = candidate;
      try {
        if (archiveIsCurrent(srcFile, destFile, exclusions, exclusionsChangedMs)) {
          result.skipped++;
          // An archive whose indexing never completed is indexed from its archive copy.
          if (state && !pastDeadline(budget) && !state.indexed(destFile)) filesToIndex.push(destFile);
        } else {
          const heldFor = state?.heldSource(srcFile, destFile);
          // An explicit migration replaces a rewritten archive instead of keeping it.
          const replacing = options.replaceDiverged === true && heldFor !== undefined && isArchiveDivergence(new Error(heldFor));
          if (heldFor !== undefined && !replacing) {
            countHeld(result, heldFor);
            continue;
          }
          const cost = admissionCost(candidate);
          if (maxFileBytes !== undefined && cost > maxFileBytes) {
            result.deferredOversize++;
            continue;
          }
          if (pastAdmissionDeadline(budget) || (maxFiles !== undefined && budget.files >= maxFiles) ||
              (maxBytes !== undefined && budget.bytes + cost > maxBytes)) {
            result.deferred++;
            continue;
          }

          // Skip message-less transcripts (summarizer-spawned stubs, sessions
          // that haven't produced content yet) before they enter the archive.
          if (!(await hasConversationContent(srcFile))) {
            result.skipped++;
            continue;
          }

          budget.files++;
          budget.bytes += cost;
          const read = admissionRead(srcFile, destFile);
          // Index rows address archive lines, so an indexed archive keeps its coordinates.
          const keepCoordinates = !replacing && state !== undefined && statIfExists(destFile)?.isFile() === true && state.indexed(destFile);
          const admit = (keep: boolean) => archiveAdmittedConversation(srcFile, destFile, exclusions, { keepCoordinates: keep });
          let rebuilding = false;
          let wasCopied: boolean;
          try {
            if (replacing) {
              state?.markRebuild(destFile);
              rebuilding = true;
            }
            try {
              wasCopied = await admit(keepCoordinates);
            } catch (error) {
              if (!(options.replaceDiverged && state && isArchiveDivergence(error))) throw error;
              // Marked before the archive changes, so an interrupted replacement still rebuilds its rows.
              state.markRebuild(destFile);
              rebuilding = true;
              wasCopied = await admit(false);
            }
          } catch (error) {
            // An archive that was not replaced keeps its rows.
            if (rebuilding) state?.release('rebuild', destFile);
            if (!countHold(result, error)) throw error;
            // A stop on new content fails this run once; the source is then held while it only grows.
            result.errors.push({ file: srcFile, error: (error as Error).message });
            state?.holdSource(srcFile, destFile, read, error as Error);
            continue;
          }
          if (rebuilding && !wasCopied) state?.release('rebuild', destFile);
          state?.release('admission', srcFile);
          if (wasCopied) {
            result.copied++;
            filesToIndex.push(destFile);
          } else {
            result.skipped++;
            // Re-admission can confirm an unchanged archive whose indexing never completed.
            if (state && !state.indexed(destFile) && archiveIsCurrent(srcFile, destFile, exclusions, exclusionsChangedMs)) {
              filesToIndex.push(destFile);
            }
          }
        }

        // Check if this file needs a summary (whether newly copied or existing).
        // shouldQueueForSummary skips files that already have a real summary or
        // an empty zero-exchange sentinel, and retries stale error sentinels (#96).
        // Only the summaries this run can generate are screened for markers.
        if (!options.skipSummaries && summaryLimit > 0 && fs.existsSync(destFile)) {
          const summaryPath = destFile.replace('.jsonl', '-summary.txt');
          if (shouldQueueForSummary(summaryPath)) {
            if (filesToSummarize.length >= summaryLimit) {
              summariesOutstanding++;
            } else if (!shouldSkipConversation(destFile)) {
              // sessionId enables source-session summarization. When the filename
              // has no UUID (e.g. agent-<hex>.jsonl), queue anyway: Codex uses an
              // isolated transcript-only thread; other harnesses use their own
              // transcript-text route without resuming a source session.
              const sessionId = extractSessionIdFromPath(destFile) ?? undefined;
              filesToSummarize.push({ path: destFile, sessionId });
            }
          }
        }
      } catch (error) {
        result.errors.push({
          file: srcFile,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    // Archives replaced under their rows, including by an interrupted earlier run, are rebuilt first.
    if (state) {
      const root = path.resolve(destDir) + path.sep;
      for (const archive of state.pendingRebuilds().reverse()) {
        if (!path.resolve(archive).startsWith(root)) continue;
        const at = filesToIndex.indexOf(archive);
        if (at !== -1) filesToIndex.splice(at, 1);
        filesToIndex.unshift(archive);
      }
    }
  } finally {
    closeState?.();
  }

  // Index copied files (unless skipIndex is set)
  if (!options.skipIndex && filesToIndex.length > 0) {
    const { parseConversation } = await import('./parser.js');

    // Load the embedding backend first. It can fail on hosts where sharp's
    // native binding (pulled in transitively by @huggingface/transformers)
    // can't dlopen libvips (#135). That must not abort the whole sync — copying
    // has already happened and summaries still need to run — so surface a
    // clear, actionable error and skip semantic indexing for this run instead
    // of throwing out of syncConversations (which would crash the SessionStart
    // hook that invokes it).
    let embeddings: typeof import('./embeddings.js') | null = null;
    try {
      embeddings = await import('./embeddings.js');
      await embeddings.initEmbeddings();
    } catch (error) {
      embeddings = null;
      result.errors.push({
        file: '(embeddings)',
        error: `Semantic indexing skipped — embedding backend unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
      console.error(
        'episodic-memory: embedding backend failed to load; skipping semantic ' +
        'indexing this run (copying and summaries still run). See the error above.'
      );
    }

    if (embeddings) {
      const { deleteExchange, getExchangesNeedingIndex, initDatabase, insertExchange } = await import('./db.js');
      const { generateExchangeEmbedding } = embeddings;

      const db = initDatabase();
      const indexState = createSyncState(db, policyDigest);
      const pendingRebuild = new Set(indexState.pendingRebuilds());
      const archiveRows = db.prepare('SELECT id FROM exchanges WHERE archive_path = ?');

      const maxMessageBytes = getMaxMessageBytes();
      let oversizeSkipped = 0;

      for (const file of filesToIndex) {
        // An archive left unindexed at the deadline has no rows and is indexed next run.
        if (pastDeadline(budget)) {
          result.deferred++;
          continue;
        }
        const readState = fileState(file);
        const heldFor = indexState.heldArchive(file, readState);
        if (heldFor !== undefined) {
          countHeld(result, heldFor);
          continue;
        }
        try {
          // Check for DO NOT INDEX marker
          if (shouldSkipConversation(file)) {
            indexState.holdArchive(file, readState, fileState(file), new Error(NOTHING_TO_INDEX));
            continue; // Skip indexing but file is already copied
          }

          const project = path.basename(path.dirname(file));
          const exchanges = await parseConversation(file, project, file, { archiveRoot: destDir });

          const rebuilding = pendingRebuild.has(file);
          // Skip oversize single messages BEFORE embedding — a foreign
          // summarizer's pasted transcript is noise, and embedding it is the
          // expensive waste (#139).
          const candidates = (rebuilding ? exchanges : getExchangesNeedingIndex(db, file, exchanges)).filter(exchange => {
            if (!isOversizeExchange(exchange, maxMessageBytes)) return true;
            oversizeSkipped++;
            return false;
          });
          // One scanner screens every stored field of this conversation in native batches.
          const admitted = await admitExchanges(candidates, exclusions);

          if (rebuilding) {
            // The replaced archive's rows address lines it no longer has: embed every
            // exchange first, then swap all of its rows in one transaction.
            const prepared: Array<{
              exchange: typeof admitted[number];
              embedding: Awaited<ReturnType<typeof generateExchangeEmbedding>>;
              toolNames?: string[];
            }> = [];
            for (const exchange of admitted) {
              const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
              prepared.push({ exchange, toolNames, embedding: await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames) });
            }
            db.transaction(() => {
              for (const { id } of archiveRows.all(file) as Array<{ id: string }>) deleteExchange(db, id);
              for (const entry of prepared) insertExchange(db, entry.exchange, entry.embedding, entry.toolNames, { admitted: true });
            })();
            indexState.release('rebuild', file);
          } else {
            for (const exchange of admitted) {
              const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
              const embedding = await generateExchangeEmbedding(
                exchange.userMessage,
                exchange.assistantMessage,
                toolNames
              );
              insertExchange(db, exchange, embedding, toolNames, { admitted: true });
            }
          }

          result.indexed++;
          // Without a hold, an archive that still has no rows would be parsed again on every run.
          if (indexState.indexed(file)) indexState.release('index', file);
          else indexState.holdArchive(file, readState, fileState(file), new Error(NOTHING_TO_INDEX));
        } catch (error) {
          // Held or not, a stop on new content fails this run once, like any indexing error.
          if (countHold(result, error)) indexState.holdArchive(file, readState, fileState(file), error as Error);
          result.errors.push({
            file,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (oversizeSkipped > 0) {
        console.log(`  Skipped ${oversizeSkipped} oversize exchange(s) (> ${maxMessageBytes} bytes; set EPISODIC_MEMORY_MAX_MESSAGE_BYTES to change) — likely embedded-transcript payloads (#139)`);
      }

      db.close();
    }
  }

  // Generate summaries for files that need them
  if (!options.skipSummaries && filesToSummarize.length > 0) {
    const { parseConversation } = await import('./parser.js');
    const { summarizeConversation, isAuthFailure } = await import('./summarizer.js');

    const toSummarize = filesToSummarize;
    const remaining = summariesOutstanding;

    console.log(`Generating summaries for ${toSummarize.length} conversation(s)...`);
    if (remaining > 0) {
      console.log(`  (${remaining} more need summaries - will process on next sync)`);
    }

    // A global failure (expired Claude CLI OAuth, #138) is not per-file. After
    // the first, skip the rest of this batch with
    // error sentinels so we don't burn minutes re-billing doomed calls or spam the
    // same message per file. The skipped files re-queue on the next sync.
    let stopBatch = false;
    let stopBatchMessage = '';

    for (const { path: filePath, sessionId } of toSummarize) {
      if (stopBatch) {
        try {
          const summaryPath = filePath.replace('.jsonl', '-summary.txt');
          fs.writeFileSync(summaryPath, formatErrorSentinel(new Error(stopBatchMessage)), 'utf-8');
        } catch {}
        result.errors.push({
          file: filePath,
          error: `Summary generation skipped: ${stopBatchMessage}`,
        });
        continue;
      }

      try {
        const project = path.basename(path.dirname(filePath));
        const exchanges = await parseConversation(filePath, project, filePath);

        if (exchanges.length === 0) {
          // Skip empty conversations — write an empty -summary.txt sentinel so they aren't re-queued forever
          const summaryPath = filePath.replace('.jsonl', '-summary.txt');
          fs.writeFileSync(summaryPath, '', 'utf-8');
          continue;
        }

        console.log(`  Summarizing ${path.basename(filePath)} (${exchanges.length} exchanges)...`);
        const summary = await summarizeConversation(exchanges, sessionId);

        const summaryPath = filePath.replace('.jsonl', '-summary.txt');
        fs.writeFileSync(summaryPath, summary, 'utf-8');
        result.summarized++;
      } catch (error) {
        // Write a structured error sentinel (#96): distinct from the empty
        // zero-exchange sentinel so a stale failure can self-heal on the next
        // sync run past the retry threshold. The marker also keeps the error
        // text on disk for post-hoc diagnosis. Best-effort — if the sentinel
        // write itself fails, fall through and surface the original error.
        try {
          const summaryPath = filePath.replace('.jsonl', '-summary.txt');
          fs.writeFileSync(summaryPath, formatErrorSentinel(error), 'utf-8');
        } catch {}
        result.errors.push({
          file: filePath,
          error: `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`
        });

        // Stop the batch on a global failure (expired auth).
        if (isAuthFailure(error)) {
          stopBatch = true;
          stopBatchMessage =
            'Claude CLI authentication failed — run `claude` and re-authenticate; summaries will retry on the next sync.';
          console.error(`  ${stopBatchMessage}`);
        }
      }
    }
  }

  return result;
}
