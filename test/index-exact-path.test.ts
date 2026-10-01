import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../src/db.js';
import * as indexer from '../src/indexer.js';

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: vi.fn(async () => new Array(384).fill(0)),
}));
vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: vi.fn(async () => { throw new Error('A no-summary index path called the summarizer'); }),
}));

const SESSION = '00000000-1111-4222-8333-444444444444';
let root: string;
let source: string;
let archive: string;
let previous: NodeJS.ProcessEnv;

function transcript(text: string): string {
  return [
    { type: 'session_meta', payload: { id: SESSION, cwd: '/synthetic/project' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: `answer to ${text}` }] } },
  ].map(JSON.stringify).join('\n') + '\n';
}

async function indexExactPath(file: string, maxFileBytes?: number): Promise<void> {
  const operation = (indexer as typeof indexer & {
    indexExactPath: (sourcePath: string, maxFileBytes?: number) => Promise<void>
  }).indexExactPath;
  await operation(file, maxFileBytes);
}

beforeEach(() => {
  previous = { ...process.env };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-exact-path-'));
  source = path.join(root, 'source');
  archive = path.join(root, 'archive');
  fs.mkdirSync(path.join(source, '2026'), { recursive: true });
  process.env.TEST_PROJECTS_DIR = source;
  process.env.TEST_ARCHIVE_DIR = archive;
  process.env.TEST_DB_PATH = path.join(root, 'index.sqlite');
  process.env.EPISODIC_MEMORY_CONFIG_DIR = path.join(root, 'config');
});

afterEach(() => {
  process.env = previous;
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('exact transcript indexing', () => {
  it('indexes only the selected file and never creates an AI summary', async () => {
    const selected = path.join(source, '2026', `rollout-${SESSION}.jsonl`);
    const sibling = path.join(source, '2026', `agent-${SESSION}.jsonl`);
    fs.writeFileSync(selected, transcript('selected question'));
    fs.writeFileSync(sibling, transcript('sibling question'));

    await indexExactPath(selected);

    const selectedArchive = path.join(archive, '2026', path.basename(selected));
    expect(fs.readFileSync(selectedArchive, 'utf8')).toBe(transcript('selected question'));
    expect(fs.existsSync(path.join(archive, '2026', path.basename(sibling)))).toBe(false);
    expect(fs.existsSync(selectedArchive.replace('.jsonl', '-summary.txt'))).toBe(false);
    const db = initDatabase();
    try {
      expect(db.prepare('SELECT archive_path, user_message FROM exchanges').all()).toEqual([
        expect.objectContaining({ archive_path: selectedArchive, user_message: 'selected question' }),
      ]);
    } finally { db.close(); }
  });

  it('rejects a transcript outside the configured source roots before any write', async () => {
    const outside = path.join(root, 'outside.jsonl');
    fs.writeFileSync(outside, transcript('outside question'));

    await expect(indexExactPath(outside)).rejects.toThrow(/source root/i);
    expect(fs.existsSync(archive)).toBe(false);
    expect(fs.existsSync(process.env.TEST_DB_PATH!)).toBe(false);
  });

  it('rejects a symlinked source path without archiving its target', async () => {
    const original = path.join(root, 'outside.jsonl');
    const linked = path.join(source, '2026', `rollout-${SESSION}.jsonl`);
    fs.writeFileSync(original, transcript('outside question'));
    fs.symlinkSync(original, linked);

    await expect(indexExactPath(linked)).rejects.toThrow(/regular non-symlink/i);
    expect(fs.existsSync(path.join(archive, '2026', path.basename(linked)))).toBe(false);
  });

  it('rejects an alias outside the configured source path even when it resolves inside', async () => {
    const nativePath = path.join(source, '2026', `rollout-${SESSION}.jsonl`);
    const aliasDir = path.join(root, 'outside-alias');
    fs.writeFileSync(nativePath, transcript('native question'));
    fs.symlinkSync(path.join(source, '2026'), aliasDir);

    await expect(indexExactPath(path.join(aliasDir, path.basename(nativePath)))).rejects.toThrow(/source root/i);
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('refuses a source larger than the caller budget before reading or archiving it', async () => {
    const selected = path.join(source, '2026', `rollout-${SESSION}.jsonl`);
    fs.writeFileSync(selected, transcript('budgeted question'));

    await expect(indexExactPath(selected, 16)).rejects.toThrow(/byte limit/i);
    expect(fs.existsSync(archive)).toBe(false);
    expect(fs.existsSync(process.env.TEST_DB_PATH!)).toBe(false);
  });
});
