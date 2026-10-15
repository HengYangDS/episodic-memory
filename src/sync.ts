import fs from 'fs';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
  archiveAdmittedConversation,
  archiveIsCurrent,
  conversationLines,
  isCompressedConversation,
  isArchiveDivergence,
  isScreeningRefusal,
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
  /** Transcripts whose current bytes screening refuses; retried once they or the policy change. */
  refused: number;
  /** Rewritten transcripts whose indexed archive is kept, because index rows address its lines. */
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

export interface SyncOptions {
  skipIndex?: boolean;
  skipSummaries?: boolean;
  summaryLimit?: number; // Max summaries to generate per run (default: 10)
  budget?: SyncBudget;
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

type SyncStage = 'admission' | 'index';

/** Identity, size and time of a regular file; any write or replacement changes it. */
function fileState(file: string): string | undefined {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` : undefined;
  } catch {
    return undefined;
  }
}

/** Admission reads a source against its existing archive, so either changing ends a hold. */
function admissionState(source: string, archive: string): string | undefined {
  const sourceState = fileState(source);
  return sourceState === undefined ? undefined : `${sourceState}|${fileState(archive) ?? ''}`;
}

/** Index lookups and holds over one index connection. */
interface SyncState {
  indexed(archive: string): boolean;
  /** Why a stage stopped on this file in exactly this state under this policy, if it did. */
  held(stage: SyncStage, file: string, state: string | undefined): string | undefined;
  /** Hold a file only when it still has the state the stopped stage read. */
  hold(stage: SyncStage, file: string, readState: string | undefined, currentState: string | undefined, error: Error): void;
  release(stage: SyncStage, file: string): void;
}

function createSyncState(db: Database.Database, policyDigest: string): SyncState {
  const indexed = db.prepare('SELECT 1 FROM exchanges WHERE archive_path = ? LIMIT 1');
  const find = db.prepare('SELECT state, policy, reason FROM sync_holds WHERE stage = ? AND path = ?');
  const record = db.prepare(
    'INSERT OR REPLACE INTO sync_holds (stage, path, state, policy, reason, held_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const forget = db.prepare('DELETE FROM sync_holds WHERE stage = ? AND path = ?');
  return {
    indexed: archive => indexed.get(archive) !== undefined,
    held(stage, file, state) {
      const row = find.get(stage, file) as { state: string; policy: string; reason: string } | undefined;
      return row !== undefined && state !== undefined && row.policy === policyDigest && row.state === state
        ? row.reason : undefined;
    },
    hold(stage, file, readState, currentState, error) {
      if (readState !== undefined && readState === currentState) {
        record.run(stage, file, readState, policyDigest, error.message, Date.now());
      }
    },
    release(stage, file) {
      forget.run(stage, file);
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
  if (isScreeningRefusal(error)) result.refused++;
  else if (isArchiveDivergence(error)) result.diverged++;
  else return false;
  return true;
}

function countHeld(result: SyncResult, reason: string): void {
  if (isArchiveDivergence(new Error(reason))) result.diverged++;
  else result.refused++;
}

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
          const heldFor = state?.held('admission', srcFile, admissionState(srcFile, destFile));
          if (heldFor !== undefined) {
            countHeld(result, heldFor);
            continue;
          }
          const cost = admissionCost(candidate);
          if (maxFileBytes !== undefined && cost > maxFileBytes) {
            result.deferredOversize++;
            continue;
          }
          if (pastDeadline(budget) || (maxFiles !== undefined && budget.files >= maxFiles) ||
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
          const readState = admissionState(srcFile, destFile);
          // Index rows address archive lines, so an indexed archive keeps its coordinates.
          const keepCoordinates = state !== undefined && statIfExists(destFile)?.isFile() === true && state.indexed(destFile);
          let wasCopied: boolean;
          try {
            wasCopied = await archiveAdmittedConversation(srcFile, destFile, exclusions, { keepCoordinates });
          } catch (error) {
            if (!countHold(result, error)) throw error;
            state?.hold('admission', srcFile, readState, admissionState(srcFile, destFile), error as Error);
            continue;
          }
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
      const { getExchangesNeedingIndex, initDatabase, insertExchange } = await import('./db.js');
      const { generateExchangeEmbedding } = embeddings;

      const db = initDatabase();
      const indexState = createSyncState(db, policyDigest);

      const maxMessageBytes = getMaxMessageBytes();
      let oversizeSkipped = 0;

      for (const file of filesToIndex) {
        // An archive left unindexed at the deadline has no rows and is indexed next run.
        if (pastDeadline(budget)) {
          result.deferred++;
          continue;
        }
        const readState = fileState(file);
        const heldFor = indexState.held('index', file, readState);
        if (heldFor !== undefined) {
          countHeld(result, heldFor);
          continue;
        }
        try {
          // Check for DO NOT INDEX marker
          if (shouldSkipConversation(file)) {
            continue; // Skip indexing but file is already copied
          }

          const project = path.basename(path.dirname(file));
          const exchanges = await parseConversation(file, project, file, { archiveRoot: destDir });
          const newExchanges = getExchangesNeedingIndex(db, file, exchanges);

          for (const exchange of newExchanges) {
            // Skip oversize single messages BEFORE embedding — a foreign
            // summarizer's pasted transcript is noise, and embedding it is the
            // expensive waste (#139).
            if (isOversizeExchange(exchange, maxMessageBytes)) {
              oversizeSkipped++;
              continue;
            }
            const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
            const embedding = await generateExchangeEmbedding(
              exchange.userMessage,
              exchange.assistantMessage,
              toolNames
            );
            insertExchange(db, exchange, embedding, toolNames);
          }

          result.indexed++;
          indexState.release('index', file);
        } catch (error) {
          if (countHold(result, error)) {
            indexState.hold('index', file, readState, fileState(file), error as Error);
            continue;
          }
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
