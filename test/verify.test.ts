import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyIndex, repairIndex, VerificationResult } from '../src/verify.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'node:crypto';
import { initDatabase, insertExchange } from '../src/db.js';
import { ConversationExchange } from '../src/types.js';
import { summarizeConversation } from '../src/summarizer.js';

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: vi.fn(async () => new Array(384).fill(0.1))
}));

vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: vi.fn(async () => 'Mock summary')
}));

// Suppress console output for clean test runs
const restoreConsole = suppressConsole();

describe('verifyIndex', () => {
  const testDir = path.join(os.tmpdir(), 'conversation-search-test-' + Date.now());
  const projectsDir = path.join(testDir, '.claude', 'projects');
  const archiveDir = path.join(testDir, '.config', 'superpowers', 'conversation-archive');
  const dbPath = path.join(testDir, '.config', 'superpowers', 'conversation-index', 'db.sqlite');

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(path.join(testDir, '.config', 'superpowers', 'conversation-index'), { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    // Override environment paths for testing
    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = dbPath;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = path.join(testDir, '.config', 'superpowers');
  });

  afterEach(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
  });

  it('should skip excluded projects', async () => {
    // Create two projects in archive
    const projectA = path.join(archiveDir, 'project-a');
    const projectB = path.join(archiveDir, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    // Create conversations (missing summaries to trigger detection)
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(path.join(projectA, 'conv1.jsonl'), messages.join('\n'));
    fs.writeFileSync(path.join(projectB, 'conv2.jsonl'), messages.join('\n'));

    // Exclude project-a
    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'project-a';
    const result = await verifyIndex();
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;

    // Only project-b should be checked (missing summary)
    expect(result.missing.length).toBe(1);
    expect(result.missing[0].path).toContain('project-b');
  });

  it('detects missing summaries', async () => {
    // Create a test conversation file without a summary
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'test-conversation.jsonl');

    // Create proper JSONL format (one JSON object per line)
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi there!' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));

    const result = await verifyIndex();

    expect(result.missing.length).toBe(1);
    expect(result.missing[0].path).toBe(conversationPath);
    expect(result.missing[0].reason).toBe('No summary file');
  });

  it('flags conversations with an error sentinel as missing so repair re-attempts them (#96)', async () => {
    const { formatErrorSentinel } = await import('../src/summary-sentinel.js');
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'errored-conversation.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hi' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hello' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    fs.writeFileSync(summaryPath, formatErrorSentinel(new Error('Transient outage')), 'utf-8');

    const result = await verifyIndex();
    expect(result.missing.length).toBe(1);
    expect(result.missing[0].path).toBe(conversationPath);
    expect(result.missing[0].reason).toMatch(/error sentinel/i);
  });

  it('does not flag conversations with real summaries as missing', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'summarized.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hi' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hello' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    fs.writeFileSync(summaryPath, 'A real summary of the conversation.', 'utf-8');

    const result = await verifyIndex();
    expect(result.missing.length).toBe(0);
  });

  it('detects orphaned database entries', async () => {
    // Initialize database
    const db = initDatabase();

    // Create an exchange in the database
    const exchange: ConversationExchange = {
      id: 'orphan-id-1',
      project: 'deleted-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'This conversation was deleted',
      assistantMessage: 'But still in database',
      archivePath: path.join(archiveDir, 'deleted-project', 'deleted.jsonl'),
      lineStart: 1,
      lineEnd: 2
    };

    const embedding = new Array(384).fill(0.1);
    insertExchange(db, exchange, embedding);
    db.close();

    // Verify detects orphaned entry (file doesn't exist)
    const result = await verifyIndex();

    expect(result.orphaned.length).toBe(1);
    expect(result.orphaned[0].uuid).toBe('orphan-id-1');
    expect(result.orphaned[0].path).toBe(exchange.archivePath);
  });

  it('detects outdated files (file modified after last_indexed)', async () => {
    // Create conversation file with summary
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'updated-conversation.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');

    // Create initial conversation
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi there!' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    fs.writeFileSync(summaryPath, 'Test summary');

    // Index it
    const db = initDatabase();
    const exchange: ConversationExchange = {
      id: 'updated-id-1',
      project: 'test-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello',
      assistantMessage: 'Hi there!',
      archivePath: conversationPath,
      lineStart: 1,
      lineEnd: 2
    };

    const embedding = new Array(384).fill(0.1);
    insertExchange(db, exchange, embedding);

    // Get the last_indexed timestamp
    const row = db.prepare(`SELECT last_indexed FROM exchanges WHERE id = ?`).get('updated-id-1') as any;
    const lastIndexed = row.last_indexed;
    db.close();

    // Wait a bit, then modify the file
    await new Promise(resolve => setTimeout(resolve, 10));

    // Update the conversation file
    const updatedMessages = [
      ...messages,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'New message' }, timestamp: '2024-01-01T00:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'New response' }, timestamp: '2024-01-01T00:00:03Z' })
    ];
    fs.writeFileSync(conversationPath, updatedMessages.join('\n'));

    // Verify detects outdated file
    const result = await verifyIndex();

    expect(result.outdated.length).toBe(1);
    expect(result.outdated[0].path).toBe(conversationPath);
    expect(result.outdated[0].dbTime).toBe(lastIndexed);
    expect(result.outdated[0].fileTime).toBeGreaterThan(lastIndexed);
  });

  it('reports an mtime-only archive refresh without calling it an index delta', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'refreshed.jsonl');
    fs.writeFileSync(conversationPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' }, timestamp: '2024-01-01T00:00:01Z' })
    ].join('\n'));
    fs.writeFileSync(conversationPath.replace('.jsonl', '-summary.txt'), 'Existing summary');
    const db = initDatabase();
    insertExchange(db, { id: 'refreshed', project: 'test-project', timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello', assistantMessage: 'Hi', archivePath: conversationPath, lineStart: 1, lineEnd: 2 }, new Array(384).fill(0.1));
    db.close();
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(conversationPath, future, future);

    const result = await verifyIndex();
    expect(result.outdated).toEqual([]);
    expect(result.archiveRefreshes.map(item => item.path)).toEqual([conversationPath]);
    expect(result.checkedFiles).toBe(1);
    expect(result.parsedFiles).toBe(1);
  });

  it('reports both a missing summary and a true appended exchange', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'appended.jsonl');
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' }, timestamp: '2024-01-01T00:00:01Z' }),
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    const db = initDatabase();
    insertExchange(db, { id: 'original', project: 'test-project', timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello', assistantMessage: 'Hi', archivePath: conversationPath, lineStart: 1, lineEnd: 2 }, new Array(384).fill(0.1));
    const lastIndexed = (db.prepare('SELECT last_indexed FROM exchanges WHERE id = ?').get('original') as { last_indexed: number }).last_indexed;
    db.close();
    fs.appendFileSync(conversationPath, '\n' + [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Later' }, timestamp: '2024-01-01T00:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Done' }, timestamp: '2024-01-01T00:00:03Z' }),
    ].join('\n'));
    const future = new Date(lastIndexed + 10_000);
    fs.utimesSync(conversationPath, future, future);

    const result = await verifyIndex();
    expect(result.missing.map(item => item.path)).toEqual([conversationPath]);
    expect(result.outdated.map(item => item.path)).toEqual([conversationPath]);
    expect(result.parsedFiles).toBe(1);
  });

  it('distinguishes an unindexed archive from an existing indexed external source', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const archivePath = path.join(projectArchive, 'unindexed.jsonl');
    const sourcePath = path.join(testDir, 'active.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' }, timestamp: '2024-01-01T00:00:01Z' }),
    ].join('\n');
    fs.writeFileSync(archivePath, lines);
    fs.writeFileSync(archivePath.replace('.jsonl', '-summary.txt'), 'Existing summary');
    fs.writeFileSync(sourcePath, lines);
    const db = initDatabase();
    insertExchange(db, { id: 'external', project: 'test-project', timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello', assistantMessage: 'Hi', archivePath: sourcePath, lineStart: 1, lineEnd: 2 }, new Array(384).fill(0.1));
    db.close();

    const result = await verifyIndex();
    expect(result.unindexed.map(item => item.path)).toEqual([archivePath]);
    expect(result.orphaned).toEqual([]);
    expect(result.checkedFiles).toBe(1);
    expect(result.parsedFiles).toBe(0);
  });

  it.each(['rejected', 'unavailable'] as const)('classifies a %s record screener separately from corruption', async outcome => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'screened.jsonl');
    fs.writeFileSync(conversationPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' }, timestamp: '2024-01-01T00:00:01Z' })
    ].join('\n'));
    fs.writeFileSync(conversationPath.replace('.jsonl', '-summary.txt'), 'Existing summary');
    const db = initDatabase();
    insertExchange(db, { id: 'screened', project: 'test-project', timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello', assistantMessage: 'Hi', archivePath: conversationPath, lineStart: 1, lineEnd: 2 }, new Array(384).fill(0.1));
    db.close();
    const scanner = path.join(testDir, 'scanner');
    fs.writeFileSync(scanner, `#!${process.execPath}\nprocess.stdout.write('[{"RuleID":"fixture"}]'); process.exit(10);\n`, { mode: 0o700 });
    const sha256 = outcome === 'rejected'
      ? crypto.createHash('sha256').update(fs.readFileSync(scanner)).digest('hex') : '0'.repeat(64);
    fs.writeFileSync(path.join(testDir, '.config', 'superpowers', 'record-exclusions.json'), JSON.stringify({
      version: 1, exchanges: [], tool_calls: [], screening: {
        engine: 'gitleaks', executable: fs.realpathSync(scanner), sha256, timeout_ms: 2000, max_record_bytes: 1_048_576,
      },
    }));
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(conversationPath, future, future);

    const result = await verifyIndex();
    expect(result.corrupted).toEqual([]);
    expect(result.screeningRejected.length).toBe(outcome === 'rejected' ? 1 : 0);
    expect(result.screeningUnavailable.length).toBe(outcome === 'unavailable' ? 1 : 0);
  });

  // Note: Parser is resilient to malformed JSON - it skips bad lines
  // Corruption detection would require file system errors or permission issues
  // which are harder to test. Skipping for now as missing summaries is the
  // primary use case for verification.
});

describe('repairIndex', () => {
  const testDir = path.join(os.tmpdir(), 'conversation-repair-test-' + Date.now());
  const projectsDir = path.join(testDir, '.claude', 'projects');
  const archiveDir = path.join(testDir, '.config', 'superpowers', 'conversation-archive');
  const dbPath = path.join(testDir, '.config', 'superpowers', 'conversation-index', 'db.sqlite');

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(path.join(testDir, '.config', 'superpowers', 'conversation-index'), { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    // Override environment paths for testing
    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
  });

  it('deletes orphaned database entries during repair', async () => {
    // Initialize database with orphaned entry
    const db = initDatabase();

    const exchange: ConversationExchange = {
      id: 'orphan-repair-1',
      project: 'deleted-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'This conversation was deleted',
      assistantMessage: 'But still in database',
      archivePath: path.join(archiveDir, 'deleted-project', 'deleted.jsonl'),
      lineStart: 1,
      lineEnd: 2
    };

    const embedding = new Array(384).fill(0.1);
    insertExchange(db, exchange, embedding);
    db.close();

    // Verify it's there
    const dbBefore = initDatabase();
    const beforeCount = dbBefore.prepare(`SELECT COUNT(*) as count FROM exchanges WHERE id = ?`).get('orphan-repair-1') as { count: number };
    expect(beforeCount.count).toBe(1);
    dbBefore.close();

    // Run repair
    const issues = await verifyIndex();
    expect(issues.orphaned.length).toBe(1);
    await repairIndex(issues);

    // Verify it's gone
    const dbAfter = initDatabase();
    const afterCount = dbAfter.prepare(`SELECT COUNT(*) as count FROM exchanges WHERE id = ?`).get('orphan-repair-1') as { count: number };
    expect(afterCount.count).toBe(0);
    dbAfter.close();
  });

  it('rejects a failed repair instead of reporting completion', async () => {
    const input = path.join(archiveDir, 'not-a-transcript');
    fs.mkdirSync(input, { recursive: true });
    await expect(repairIndex({ missing: [{ path: input, reason: 'synthetic invalid source' }],
      outdated: [], orphaned: [], corrupted: [] })).rejects.toThrow(/regular non-symlink file/);
  });

  it('processes a file reported as both missing and outdated only once', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'duplicate.jsonl');
    fs.writeFileSync(conversationPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' }, timestamp: '2024-01-01T00:00:01Z' })
    ].join('\n'));
    vi.mocked(summarizeConversation).mockClear();

    await repairIndex({ missing: [{ path: conversationPath, reason: 'No summary file' }],
      outdated: [{ path: conversationPath, fileTime: 2, dbTime: 1 }], orphaned: [], corrupted: [] });

    expect(summarizeConversation).toHaveBeenCalledTimes(1);
  });

  it('re-indexes outdated files during repair', { timeout: 30000 }, async () => {
    // Create conversation file with summary
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'outdated-repair.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');

    // Create initial conversation
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi there!' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    fs.writeFileSync(summaryPath, 'Old summary');

    // Index it
    const db = initDatabase();
    const exchange: ConversationExchange = {
      id: 'outdated-repair-1',
      project: 'test-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello',
      assistantMessage: 'Hi there!',
      archivePath: conversationPath,
      lineStart: 1,
      lineEnd: 2
    };

    const embedding = new Array(384).fill(0.1);
    insertExchange(db, exchange, embedding);

    // Get the last_indexed timestamp
    const beforeRow = db.prepare(`SELECT last_indexed FROM exchanges WHERE id = ?`).get('outdated-repair-1') as any;
    const beforeIndexed = beforeRow.last_indexed;
    db.close();

    // Wait a bit, then modify the file
    await new Promise(resolve => setTimeout(resolve, 10));

    // Update the conversation file (add new exchange)
    const updatedMessages = [
      ...messages,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'New message' }, timestamp: '2024-01-01T00:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'New response' }, timestamp: '2024-01-01T00:00:03Z' })
    ];
    fs.writeFileSync(conversationPath, updatedMessages.join('\n'));

    // Verify detects outdated
    const issues = await verifyIndex();
    expect(issues.outdated.length).toBe(1);

    // Wait a bit to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    // Run repair
    await repairIndex(issues);

    // Verify it was re-indexed with new timestamp
    const dbAfter = initDatabase();
    const afterRow = dbAfter.prepare(`SELECT MAX(last_indexed) as last_indexed FROM exchanges WHERE archive_path = ?`).get(conversationPath) as any;
    expect(afterRow.last_indexed).toBeGreaterThan(beforeIndexed);

    // Verify no longer outdated
    const verifyAfter = await verifyIndex();
    expect(verifyAfter.outdated.length).toBe(0);

    dbAfter.close();
  });
});
