import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from '../src/db.js';
import { EMBEDDING_VERSION } from '../src/embedding-migration.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_CLI = path.join(REPO_ROOT, 'dist', 'sync-cli.js');
const SESSION = '1111aaaa-1111-1111-1111-000000000001';

describe('sync-cli background defaults', () => {
  let testDir: string;
  let env: NodeJS.ProcessEnv;
  let summary: string;
  let prior: NodeJS.ProcessEnv;

  beforeEach(() => {
    prior = { ...process.env };
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-memory-background-defaults-'));
    const source = path.join(testDir, 'projects', 'project-a', `${SESSION}.jsonl`);
    const archive = path.join(testDir, 'archive', 'project-a', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'config'), { recursive: true });
    // A lone user message parses to zero exchanges, so a queued summary writes
    // an empty sentinel without calling a summarizer.
    fs.writeFileSync(source, JSON.stringify({
      type: 'user', sessionId: SESSION, uuid: 'u1', timestamp: '2026-10-15T00:00:00Z',
      message: { role: 'user', content: 'unanswered question' },
    }) + '\n');
    // A current, already indexed archive leaves only the summary decision to the run.
    fs.copyFileSync(source, archive);
    const stamp = Math.ceil(fs.statSync(source).mtimeMs) / 1000;
    fs.utimesSync(archive, stamp, stamp);
    summary = archive.replace('.jsonl', '-summary.txt');

    env = {
      ...process.env,
      TEST_PROJECTS_DIR: path.join(testDir, 'projects'),
      TEST_ARCHIVE_DIR: path.join(testDir, 'archive'),
      TEST_DB_PATH: path.join(testDir, 'test.db'),
      EPISODIC_MEMORY_DB_PATH: path.join(testDir, 'test.db'),
      EPISODIC_MEMORY_CONFIG_DIR: path.join(testDir, 'config'),
      EPISODIC_MEMORY_OPENCODE_DB_PATH: path.join(testDir, 'opencode-missing.db'),
      EPISODIC_MEMORY_OPENCODE_TRANSCRIPT_DIR: path.join(testDir, 'opencode-transcripts'),
      EPISODIC_MEMORY_SUMMARIZER_GUARD: undefined,
      EPISODIC_MEMORY_SKIP_SUMMARIES: undefined,
    };
    process.env.EPISODIC_MEMORY_DB_PATH = env.EPISODIC_MEMORY_DB_PATH;
    const db = initDatabase();
    db.prepare(`INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path,
      line_start, line_end, embedding_version) VALUES ('x1', 'project-a', '2026-10-15T00:00:00Z', 'q', 'a', ?, 1, 1, ?)`)
      .run(archive, EMBEDDING_VERSION);
    db.close();
  });

  afterEach(() => {
    process.env = prior;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function run(extra: NodeJS.ProcessEnv): string {
    const result = spawnSync(process.execPath, [SYNC_CLI], {
      env: { ...env, ...extra }, timeout: 30_000, encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  it('generates no summaries in a hook-launched run unless a limit is given', () => {
    run({ EPISODIC_MEMORY_BACKGROUND_SYNC: '1' });
    expect(fs.existsSync(summary)).toBe(false);
  });

  it('keeps summarizing in a foreground run', () => {
    run({});
    expect(fs.readFileSync(summary, 'utf8')).toBe('');
  });
});
