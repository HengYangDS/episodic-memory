import { buildSyncOptionsFromEnv, createSyncBudget, syncConversations, type SyncLimits } from './sync.js';
import {
  ConversationSourceHarness,
  getArchiveDir,
  getConversationSourceDirs,
  getIndexDir,
} from './paths.js';
import { shouldSkipReentrantSync } from './summarizer.js';
import { initDatabase } from './db.js';
import { generateExchangeEmbedding, initEmbeddings } from './embeddings.js';
import { runMigrationBatch, countStale } from './embedding-migration.js';
import { exportOpencodeSessions } from './opencode-sync.js';
import { spawn } from 'child_process';
import fs from 'fs';
import { formatLogLine, getSyncLogPath, getSyncLockPath } from './logging.js';
import { acquireFileLock, readLockHolder, releaseFileLock } from './file-lock.js';

const args = process.argv.slice(2);

// Reentrancy guard (#87): if this sync was triggered by a SessionStart hook
// inside a Claude subprocess that the summarizer just spawned, exit silently.
// Without this, summarization spawns a Claude subprocess which fires
// SessionStart which runs sync which spawns more summarization — cascading
// fanout that pegs CPU and burns API quota.
if (shouldSkipReentrantSync()) {
  // stderr keeps the message out of any stdout consumers (e.g., MCP)
  // while still being visible in hook logs.
  console.error('episodic-memory: skipping sync inside summarizer-spawned subprocess (#87)');
  process.exit(0);
}

// Auto-sync off switch (#163): EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1 stops the
// hook-launched background sync entirely, for users who want indexing paused
// without uninstalling. Only the exact string '1' enables it. It intentionally
// gates ONLY the --background (hook/auto) path so an explicit foreground
// `episodic-memory sync` a user runs by hand still works. Complements #159's
// EPISODIC_MEMORY_SKIP_SUMMARIES, which only skips the summary pass.
if (process.env.EPISODIC_MEMORY_DISABLE_AUTO_SYNC === '1' && args.includes('--background')) {
  console.error('episodic-memory: auto-sync disabled via EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1; skipping background sync (#163)');
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: episodic-memory sync [--background] [--only claude|codex|opencode] [--summary-limit N]
                            [--max-files N] [--max-bytes N] [--max-file-bytes N] [--max-seconds N]
                            [--replace-diverged]

Sync conversations from Claude Code, Codex, and opencode transcript sources to archive and index them.

This command:
1. Exports opencode sessions from its SQLite database when available
2. Copies new or updated .jsonl files (and Codex .jsonl.zst rollouts) to conversation archive
3. Generates embeddings for semantic search
4. Updates the search index

Only processes files that are new or have been modified since last sync, newest
first. An appended transcript is screened only for its new records. Bounds stop
starting new work; deferred transcripts are processed by the next sync.

OPTIONS:
  --background        Run sync in background (for hooks, returns immediately)
  --only <harness>    Limit sync to claude, codex, or opencode
  --summary-limit N   Max summaries to generate per source this run (default: 10; background default: 0)
  --max-files N       Max transcripts to admit this run (background default: 50)
  --max-bytes N       Max transcript bytes to admit this run (background default: 256 MiB)
  --max-file-bytes N  Defer a transcript whose admission exceeds N bytes (background default: 128 MiB)
  --max-seconds N     Start no new work after N seconds; admission stops after two thirds of them (background default: 300)
  --replace-diverged  Replace each indexed archive whose source was rewritten after it was written, and rebuild its rows

EXAMPLES:
  # Sync all new conversations
  episodic-memory sync

  # Sync in background (for hooks)
  episodic-memory sync --background

  # Sync only opencode conversations
  episodic-memory sync --only opencode

  # Use in Claude Code hook
  # In .claude/hooks/session-end:
  episodic-memory sync --background
`);
  process.exit(0);
}

// Check if running in background mode
const isBackground = args.includes('--background');

function parseOnlyHarness(): ConversationSourceHarness[] | undefined {
  const raw = (() => {
    const eq = args.find(arg => arg.startsWith('--only='));
    if (eq) return eq.slice('--only='.length);
    const idx = args.indexOf('--only');
    if (idx !== -1) {
      const value = args[idx + 1];
      if (!value || value.startsWith('--')) {
        console.error('Invalid --only value: expected claude, codex, or opencode.');
        process.exit(1);
      }
      return value;
    }
    return undefined;
  })();
  if (!raw) return undefined;

  const harnesses = raw.split(',').map(item => item.trim()).filter(Boolean);
  const valid = new Set(['claude', 'codex', 'opencode']);
  for (const harness of harnesses) {
    if (!valid.has(harness)) {
      console.error(`Invalid --only value: ${harness}. Expected claude, codex, or opencode.`);
      process.exit(1);
    }
  }
  return harnesses as ConversationSourceHarness[];
}

function parseNonNegativeOption(name: string): number | undefined {
  const raw = (() => {
    const eq = args.find(arg => arg.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx !== -1) {
      const value = args[idx + 1];
      if (!value || value.startsWith('--')) {
        console.error(`Invalid ${name} value: expected a non-negative integer.`);
        process.exit(1);
      }
      return value;
    }
    return undefined;
  })();
  if (!raw) return undefined;

  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    console.error(`Invalid ${name} value: ${raw}. Expected a non-negative integer.`);
    process.exit(1);
  }
  return parsed;
}

function parseSummaryLimit(): number | undefined {
  return parseNonNegativeOption('--summary-limit');
}

/**
 * Whole-operation bounds. A hook-launched background run is bounded by default
 * so a large backlog drains over several sessions instead of one unbounded run.
 */
function parseSyncLimits(background: boolean): SyncLimits {
  const maxFiles = parseNonNegativeOption('--max-files');
  const maxBytes = parseNonNegativeOption('--max-bytes');
  const maxFileBytes = parseNonNegativeOption('--max-file-bytes');
  const maxSeconds = parseNonNegativeOption('--max-seconds');
  const defaults: Partial<typeof BACKGROUND_SYNC_LIMITS> = background ? BACKGROUND_SYNC_LIMITS : {};
  const seconds = maxSeconds ?? defaults.maxSeconds;
  const start = Date.now();
  return {
    maxFiles: maxFiles ?? defaults.maxFiles,
    maxBytes: maxBytes ?? defaults.maxBytes,
    maxFileBytes: maxFileBytes ?? defaults.maxFileBytes,
    deadlineMs: seconds === undefined ? undefined : start + seconds * 1000,
    // Admission screens and indexing embeds; the last third of the window indexes what was admitted.
    admissionDeadlineMs: seconds === undefined ? undefined : start + Math.floor(seconds * 1000 * 2 / 3),
  };
}

const BACKGROUND_SYNC_LIMITS = {
  maxFiles: 50,
  maxBytes: 256 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxSeconds: 300,
};

const onlyHarnesses = parseOnlyHarness();
// The detached child of a hook launch is marked so it keeps the background defaults.
const backgroundRun = isBackground || process.env.EPISODIC_MEMORY_BACKGROUND_SYNC === '1';
// A hook-launched run spends no summarizer quota unless a limit is given explicitly.
const summaryLimit = parseSummaryLimit() ?? (backgroundRun ? 0 : undefined);
const syncLimits = parseSyncLimits(backgroundRun);

// If background mode, fork the process and exit immediately
if (isBackground) {
  const filteredArgs = args.filter(arg => arg !== '--background');
  const logPath = getSyncLogPath();
  const logFd = fs.openSync(logPath, 'a');
  fs.writeSync(logFd, formatLogLine('info', `Starting background sync from pid ${process.pid}`));

  // Spawn a detached process
  const child = spawn(process.execPath, [
    process.argv[1], // This script
    ...filteredArgs
  ], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, EPISODIC_MEMORY_BACKGROUND_SYNC: '1' },
  });

  child.unref(); // Allow parent to exit
  console.log(`Sync started in background. Log: ${logPath}`);
  process.exit(0);
}

if (!onlyHarnesses || onlyHarnesses.includes('opencode')) {
  const opencodeExport = exportOpencodeSessions();
  if (opencodeExport.exported > 0 || opencodeExport.skipped > 0) {
    console.log(`opencode export: ${opencodeExport.exported} exported, ${opencodeExport.skipped} skipped`);
  }
  if (opencodeExport.errors.length > 0) {
    console.log(`opencode export errors: ${opencodeExport.errors.length}`);
    opencodeExport.errors.forEach(err => {
      const label = err.sessionId ? `session ${err.sessionId}` : 'database';
      console.log(`  ${label}: ${err.error}`);
    });
  }
}

const sourceDirs = getConversationSourceDirs(onlyHarnesses);
const destDir = getArchiveDir();
const syncOptions = buildSyncOptionsFromEnv(process.env);

if (sourceDirs.length === 0) {
  console.log('⚠️  No conversation source directories found.');
  console.log('  Checked: ~/.claude/projects, ~/.claude/transcripts, ~/.codex/sessions, and generated opencode transcripts');
  if (process.env.CLAUDE_CONFIG_DIR) {
    console.log(`  CLAUDE_CONFIG_DIR is set to: ${process.env.CLAUDE_CONFIG_DIR}`);
  }
  process.exit(0);
}

// Single-instance lock (#97). Independent SessionStart events from multiple
// Claude Code sessions each fire `sync --background`; without a lock they race
// the SQLite write path and pile up Claude subprocesses for summarization. On
// Windows the latter exhausts the desktop heap and crashes the workers with
// STATUS_DLL_INIT_FAILED. Acquire after the source-dir check so help/version
// paths don't touch the filesystem unnecessarily, and release on every exit.
const syncLockPath = getSyncLockPath();
const syncLock = acquireFileLock(syncLockPath);
if (!syncLock) {
  const holder = readLockHolder(syncLockPath);
  const holderLabel = holder !== null ? `pid ${holder}` : 'another process';
  console.error(`episodic-memory: sync already running (${holderLabel}); skipping`);
  process.exit(0);
}
const releaseSyncLockOnce = () => {
  if ((releaseSyncLockOnce as any).done) return;
  (releaseSyncLockOnce as any).done = true;
  releaseFileLock(syncLock);
};
process.on('exit', releaseSyncLockOnce);
process.on('SIGINT', () => { releaseSyncLockOnce(); process.exit(130); });
process.on('SIGTERM', () => { releaseSyncLockOnce(); process.exit(143); });
process.on('SIGHUP', () => { releaseSyncLockOnce(); process.exit(129); });

console.log('Syncing conversations...');
console.log(`Sources: ${sourceDirs.join(', ')}`);
console.log(`Destination: ${destDir}\n`);

async function syncAll() {
  const totals = { copied: 0, skipped: 0, indexed: 0, summarized: 0, deferred: 0, deferredOversize: 0, refused: 0, diverged: 0, errors: [] as Array<{file: string; error: string}>, sourcesWithSummaryWork: 0, totalNeedingSummaries: 0 };
  const budget = createSyncBudget(syncLimits);

  for (const sourceDir of sourceDirs) {
    const result = await syncConversations(sourceDir, destDir, {
      ...syncOptions, summaryLimit, budget, replaceDiverged: args.includes('--replace-diverged'),
    });
    totals.copied += result.copied;
    totals.skipped += result.skipped;
    totals.indexed += result.indexed;
    totals.summarized += result.summarized;
    totals.deferred += result.deferred;
    totals.deferredOversize += result.deferredOversize;
    totals.refused += result.refused;
    totals.diverged += result.diverged;
    totals.errors.push(...result.errors);
  }

  // Re-embedding is further work, so a run past its deadline leaves it for the next sync.
  const pastDeadline = syncLimits.deadlineMs !== undefined && Date.now() >= syncLimits.deadlineMs;
  if (totals.errors.length === 0 && !pastDeadline) await runEmbeddingMigrationPhase();
  else if (totals.errors.length > 0) process.exitCode = 1;

  console.log(totals.errors.length > 0 ? '\n⚠️  Sync finished with errors.' : '\n✅ Sync complete!');
  console.log(`  Copied: ${totals.copied}`);
  console.log(`  Skipped: ${totals.skipped}`);
  console.log(`  Indexed: ${totals.indexed}`);
  if (totals.deferred > 0) {
    console.log(`  Deferred: ${totals.deferred} (whole-operation budget reached; the next sync continues)`);
  }
  if (totals.deferredOversize > 0) {
    console.log(`  Deferred oversize: ${totals.deferredOversize} (each exceeds --max-file-bytes; sync them with a larger limit)`);
  }
  if (totals.refused > 0) {
    console.log(`  Refused: ${totals.refused} (the record policy refuses their current content; retried when they or the policy change)`);
  }
  if (totals.diverged > 0) {
    console.log(`  Diverged: ${totals.diverged} (source rewritten under an indexed archive; archive and index rows kept)`);
  }
  if (syncOptions.skipSummaries) {
    console.log('  Summaries: skipped (EPISODIC_MEMORY_SKIP_SUMMARIES=1)');
  } else {
    console.log(`  Summarized: ${totals.summarized}`);
  }

  if (totals.errors.length > 0) {
    console.log(`\n⚠️  Errors: ${totals.errors.length}`);
    totals.errors.forEach(err => console.log(`  ${err.file}: ${err.error}`));

    // Help diagnose silent summarization failures (#70)
    const summaryErrors = totals.errors.filter(e => e.error.startsWith('Summary generation failed'));
    if (summaryErrors.length > 0 && totals.summarized === 0) {
      console.log(`\n💡 All ${summaryErrors.length} summarization attempts failed.`);
      console.log(`  Check your API configuration (EPISODIC_MEMORY_API_BASE_URL / ANTHROPIC_API_KEY).`);
    }
  }

}

const MIGRATION_BATCH_SIZE = parseInt(process.env.EPISODIC_MEMORY_MIGRATION_BATCH || '500', 10);

async function runEmbeddingMigrationPhase(): Promise<void> {
  const db = initDatabase();
  try {
    const stale = countStale(db);
    if (stale === 0) return;

    console.error(`\nepisodic-memory: ${stale} exchange(s) on the old embedding model — migrating up to ${MIGRATION_BATCH_SIZE} this run`);
    await initEmbeddings();
    const indexDir = getIndexDir();
    const done = await runMigrationBatch(db, indexDir, MIGRATION_BATCH_SIZE, generateExchangeEmbedding);
    if (done > 0) {
      const after = countStale(db);
      console.error(`episodic-memory: re-embedded ${done} (${after} still stale; will resume on next sync)`);
    }
  } catch (err) {
    console.error('episodic-memory: migration phase error:', err instanceof Error ? err.message : err);
    throw err;
  } finally {
    db.close();
  }
}

syncAll().catch(error => {
  console.error('Error syncing:', error);
  process.exit(1);
});
