import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getExchangesNeedingIndex, initDatabase, migrateSchema, insertExchange } from '../src/db.js';
import { ConversationExchange } from '../src/types.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import crypto from 'crypto';

// Suppress console output for clean test runs
const restoreConsole = suppressConsole();

describe('database migration', () => {
  const testDir = path.join(os.tmpdir(), 'db-migration-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('adds last_indexed column to existing database', () => {
    // Create a database with old schema (no last_indexed)
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE exchanges (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL,
        assistant_message TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        embedding BLOB
      )
    `);

    // Verify column doesn't exist
    const columnsBefore = db.prepare(`PRAGMA table_info(exchanges)`).all();
    const hasLastIndexedBefore = columnsBefore.some((col: any) => col.name === 'last_indexed');
    expect(hasLastIndexedBefore).toBe(false);

    db.close();

    // Run migration
    const migratedDb = initDatabase();

    // Verify column now exists
    const columnsAfter = migratedDb.prepare(`PRAGMA table_info(exchanges)`).all();
    const hasLastIndexedAfter = columnsAfter.some((col: any) => col.name === 'last_indexed');
    expect(hasLastIndexedAfter).toBe(true);

    migratedDb.close();
  });

  it('handles existing last_indexed column gracefully', () => {
    // Create database with migration already applied
    const db = initDatabase();

    // Run migration again - should not error
    expect(() => migrateSchema(db)).not.toThrow();

    db.close();
  });
});

describe('insertExchange with last_indexed', () => {
  const testDir = path.join(os.tmpdir(), 'insert-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('sets last_indexed timestamp when inserting exchange', () => {
    const db = initDatabase();

    const exchange: ConversationExchange = {
      id: 'test-id-1',
      project: 'test-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello',
      assistantMessage: 'Hi there!',
      archivePath: '/test/path.jsonl',
      lineStart: 1,
      lineEnd: 2
    };

    const beforeInsert = Date.now();
    // Create proper 384-dimensional embedding
    const embedding = new Array(384).fill(0.1);
    insertExchange(db, exchange, embedding);
    const afterInsert = Date.now();

    // Query the exchange
    const row = db.prepare(`SELECT last_indexed FROM exchanges WHERE id = ?`).get('test-id-1') as any;

    expect(row.last_indexed).toBeDefined();
    expect(row.last_indexed).toBeGreaterThanOrEqual(beforeInsert);
    expect(row.last_indexed).toBeLessThanOrEqual(afterInsert);

    db.close();
  });

  it('replaces a superseded line span and its vector without leaving duplicates', () => {
    const db = initDatabase();
    const first: ConversationExchange = {
      id: 'span-1', project: 'test-project', timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Question', assistantMessage: 'Initial answer',
      archivePath: '/test/continued.jsonl', lineStart: 1, lineEnd: 2,
    };
    insertExchange(db, first, new Array(384).fill(0.1));
    insertExchange(db, { ...first, id: 'span-2', assistantMessage: 'Continued answer', lineEnd: 3 }, new Array(384).fill(0.2));

    expect(db.prepare('SELECT id FROM exchanges').all()).toEqual([{ id: 'span-2' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM vec_exchanges').get()).toEqual({ count: 1 });
    db.close();
  });

  it('keeps the previous indexed span when a replacement vector fails', () => {
    const db = initDatabase();
    const first: ConversationExchange = {
      id: 'span-1', project: 'test-project', timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Question', assistantMessage: 'Initial answer',
      archivePath: '/test/continued.jsonl', lineStart: 1, lineEnd: 2,
    };
    insertExchange(db, first, new Array(384).fill(0.1));

    expect(() => insertExchange(db, { ...first, id: 'span-2', lineEnd: 3 }, [0.2])).toThrow();
    expect(db.prepare('SELECT id FROM exchanges').all()).toEqual([{ id: 'span-1' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM vec_exchanges').get()).toEqual({ count: 1 });
    db.close();
  });

  it('refuses a contracted source span rather than replacing indexed history', () => {
    const db = initDatabase();
    const first: ConversationExchange = {
      id: 'span-long', project: 'test-project', timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Question', assistantMessage: 'Long answer',
      archivePath: '/test/continued.jsonl', lineStart: 1, lineEnd: 3,
    };
    insertExchange(db, first, new Array(384).fill(0.1));

    expect(() => getExchangesNeedingIndex(db, first.archivePath, [{ ...first, id: 'span-short', lineEnd: 2 }]))
      .toThrow('Conversation exchange span regressed');
    expect(db.prepare('SELECT id FROM exchanges').all()).toEqual([{ id: 'span-long' }]);
    db.close();
  });
});

describe('explicit excluded-terminal projection replacement', () => {
  let testDir: string;
  let db: Database.Database;
  let previousConfigDir: string | undefined;
  let previousDbPath: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-projection-repair-'));
    previousConfigDir = process.env.EPISODIC_MEMORY_CONFIG_DIR;
    previousDbPath = process.env.TEST_DB_PATH;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = path.join(testDir, 'config');
    process.env.TEST_DB_PATH = path.join(testDir, 'index.sqlite');
    fs.mkdirSync(process.env.EPISODIC_MEMORY_CONFIG_DIR, { recursive: true });
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    if (previousConfigDir === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    else process.env.EPISODIC_MEMORY_CONFIG_DIR = previousConfigDir;
    if (previousDbPath === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = previousDbPath;
    fs.rmSync(testDir, { recursive: true, force: true });
    expect(fs.existsSync(testDir)).toBe(false);
  });

  function projectionFixture(): { original: ConversationExchange; replacement: ConversationExchange; unrelated: ConversationExchange } {
    const sessionId = '00000000-1111-4222-8333-444444444444';
    const archivePath = path.join(testDir, `rollout-${sessionId}.jsonl`);
    const id = (start: number, end: number) => crypto.createHash('md5').update(`${archivePath}:${start}-${end}`).digest('hex');
    const original: ConversationExchange = {
      id: id(1, 4), project: 'synthetic-project', timestamp: '2026-01-01T00:00:00Z',
      userMessage: 'Safe question', assistantMessage: 'Safe answer',
      archivePath, lineStart: 1, lineEnd: 4,
      parentUuid: 'preserved-parent', isSidechain: true, harness: 'codex',
      sessionId: '00000000-aaaa-4bbb-8ccc-dddddddddddd', cwd: '/synthetic/project',
      gitBranch: 'feature/projection', claudeVersion: '2.0.0', agentVersion: '0.1.0',
      model: 'fixture-model', modelProvider: 'fixture-provider', thinkingLevel: 'low',
      thinkingDisabled: true, thinkingTriggers: JSON.stringify(['fixture-trigger']),
      toolCalls: [
        { id: 'allowed-tool', exchangeId: id(1, 4), toolName: 'Read',
          toolInput: { file: '/synthetic/allowed.txt' }, toolResult: 'Allowed result',
          isError: false, timestamp: '2026-01-01T00:00:01Z' },
        { id: 'denied-terminal-tool', exchangeId: id(1, 4), toolName: 'Write',
          toolInput: { value: 'Excluded fixture tool' }, toolResult: 'Excluded result',
          isError: true, timestamp: '2026-01-01T00:00:02Z' },
      ],
    };
    const unrelated: ConversationExchange = {
      ...original, id: id(10, 11), lineStart: 10, lineEnd: 11,
      userMessage: 'Unrelated question', assistantMessage: 'Unrelated answer',
      toolCalls: [{ id: 'unrelated-tool', exchangeId: id(10, 11), toolName: 'Bash',
        toolInput: { command: 'fixture-command' }, toolResult: 'Unrelated result',
        isError: false, timestamp: '2026-01-01T00:00:03Z' }],
    };
    insertExchange(db, original, new Array(384).fill(0.1));
    insertExchange(db, unrelated, new Array(384).fill(0.3));
    fs.writeFileSync(path.join(process.env.EPISODIC_MEMORY_CONFIG_DIR!, 'record-exclusions.json'), JSON.stringify({
      version: 1, exchanges: [],
      tool_calls: [{ session_id: sessionId, transcript: path.basename(archivePath), call_id: 'denied-terminal-tool' }],
    }));
    const replacement: ConversationExchange = {
      ...original, id: id(1, 3), lineEnd: 3,
      toolCalls: original.toolCalls!.filter(tool => tool.id !== 'denied-terminal-tool')
        .map(tool => ({ ...tool, exchangeId: id(1, 3) })),
    };
    return { original, replacement, unrelated };
  }

  it('replaces an excluded-terminal shorter span while preserving metadata and neighboring associations', () => {
    const { original, replacement, unrelated } = projectionFixture();
    const rowBefore = db.prepare('SELECT * FROM exchanges WHERE id = ?').get(original.id) as Record<string, unknown>;
    const allowedBefore = db.prepare('SELECT * FROM tool_calls WHERE id = ?').get('allowed-tool');
    const unrelatedBefore = db.prepare('SELECT * FROM exchanges WHERE id = ?').get(unrelated.id);
    const unrelatedVectorBefore = db.prepare('SELECT * FROM vec_exchanges WHERE id = ?').get(unrelated.id);
    const unrelatedToolBefore = db.prepare('SELECT * FROM tool_calls WHERE id = ?').get('unrelated-tool');

    // Explicit replacement does not weaken incremental admission of arbitrary shrinks.
    expect(() => getExchangesNeedingIndex(db, original.archivePath, [replacement]))
      .toThrow('Conversation exchange span regressed');
    const vector = new Array(384).fill(0.2);
    insertExchange(db, replacement, vector);

    expect(db.prepare('SELECT * FROM exchanges WHERE id = ?').get(replacement.id)).toEqual({
      ...rowBefore, id: replacement.id, line_end: 3, last_indexed: expect.any(Number),
    });
    expect(db.prepare('SELECT embedding FROM vec_exchanges WHERE id = ?').get(replacement.id)).toEqual({
      embedding: Buffer.from(new Float32Array(vector).buffer),
    });
    expect(db.prepare('SELECT * FROM tool_calls WHERE id = ?').get('allowed-tool')).toEqual({
      ...(allowedBefore as Record<string, unknown>), exchange_id: replacement.id,
    });
    expect(db.prepare('SELECT id FROM exchanges WHERE id = ?').get(original.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM vec_exchanges WHERE id = ?').get(original.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM tool_calls WHERE id = ?').get('denied-terminal-tool')).toBeUndefined();
    expect(db.prepare('SELECT * FROM exchanges WHERE id = ?').get(unrelated.id)).toEqual(unrelatedBefore);
    expect(db.prepare('SELECT * FROM vec_exchanges WHERE id = ?').get(unrelated.id)).toEqual(unrelatedVectorBefore);
    expect(db.prepare('SELECT * FROM tool_calls WHERE id = ?').get('unrelated-tool')).toEqual(unrelatedToolBefore);
    expect(db.prepare('SELECT COUNT(*) AS count FROM exchanges').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM vec_exchanges').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back a shortened replacement and all associations when its vector is invalid', () => {
    const { original, replacement } = projectionFixture();
    const rowsBefore = db.prepare('SELECT * FROM exchanges ORDER BY id').all();
    const vectorsBefore = db.prepare('SELECT * FROM vec_exchanges ORDER BY id').all();
    const toolsBefore = db.prepare('SELECT * FROM tool_calls ORDER BY id').all();

    expect(() => insertExchange(db, replacement, [0.2])).toThrow();

    expect(db.prepare('SELECT * FROM exchanges ORDER BY id').all()).toEqual(rowsBefore);
    expect(db.prepare('SELECT * FROM vec_exchanges ORDER BY id').all()).toEqual(vectorsBefore);
    expect(db.prepare('SELECT * FROM tool_calls ORDER BY id').all()).toEqual(toolsBefore);
    expect(db.prepare('SELECT id FROM exchanges WHERE id = ?').get(replacement.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM vec_exchanges WHERE id = ?').get(replacement.id)).toBeUndefined();
    expect(() => getExchangesNeedingIndex(db, original.archivePath, [replacement]))
      .toThrow('Conversation exchange span regressed');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
