import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repo, 'cli', 'index-hook-transcript.js');
let root: string;
let source: string;
let archive: string;

function runHook(payload: unknown, maxFileBytes = '1024') {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      TEST_PROJECTS_DIR: source,
      TEST_ARCHIVE_DIR: archive,
      TEST_DB_PATH: path.join(root, 'index.sqlite'),
      EPISODIC_MEMORY_CONFIG_DIR: path.join(root, 'config'),
      EPISODIC_MEMORY_OFFLINE: '1',
      EPISODIC_MEMORY_HOOK_MAX_FILE_BYTES: maxFileBytes,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-hook-exact-'));
  source = path.join(root, 'source');
  archive = path.join(root, 'archive');
  fs.mkdirSync(path.join(source, 'project'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('transcript-path hook adapter', () => {
  it('archives only the owner-supplied transcript path without a summary', () => {
    const selected = path.join(source, 'project', 'selected.jsonl');
    const sibling = path.join(source, 'project', 'sibling.jsonl');
    const line = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
    fs.writeFileSync(selected, line('selected'));
    fs.writeFileSync(sibling, line('sibling'));

    const result = runHook({ hook_event_name: 'Stop', session_id: 'synthetic', transcript_path: selected });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(fs.readFileSync(path.join(archive, 'project', 'selected.jsonl'), 'utf8')).toBe(line('selected'));
    expect(fs.existsSync(path.join(archive, 'project', 'sibling.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(archive, 'project', 'selected-summary.txt'))).toBe(false);
  });

  it('leaves native and derived state alone when no transcript path exists', () => {
    const result = runHook({ hook_event_name: 'Stop', session_id: 'synthetic', transcript_path: null });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('refuses an unbudgeted hook before touching its transcript', () => {
    const selected = path.join(source, 'project', 'selected.jsonl');
    fs.writeFileSync(selected, JSON.stringify({ type: 'user', message: { role: 'user', content: 'selected' } }) + '\n');

    const result = runHook({ transcript_path: selected }, '');

    expect(result.status).toBe(1);
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('refuses a transcript exceeding the configured byte ceiling', () => {
    const selected = path.join(source, 'project', 'selected.jsonl');
    fs.writeFileSync(selected, JSON.stringify({ type: 'user', message: { role: 'user', content: 'selected' } }) + '\n');

    const result = runHook({ transcript_path: selected }, '16');

    expect(result.status).toBe(1);
    expect(fs.existsSync(archive)).toBe(false);
  });
});
