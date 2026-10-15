import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MARKER, ago, bump, codexLines, createSyncFixture, rollout, screenedRecords, session, stampedCopy, writePolicy,
  zstdAvailable, type SyncFixture,
} from './sync-screening-fixture.js';

// No model loads; calls are counted (see test/sync-incremental-and-marker.test.ts).
const embedSpy = vi.fn(async () => new Array(384).fill(0));
vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: embedSpy,
  generateQueryEmbedding: vi.fn(),
  generateEmbedding: vi.fn(),
  initEmbeddingsFailed: false,
}));

import { syncConversations, createSyncBudget } from '../src/sync.js';
import { archiveAdmittedConversation } from '../src/record-admission.js';
import { parseConversation } from '../src/parser.js';

let prior: NodeJS.ProcessEnv;
let fixture: SyncFixture;
let root: string;
let sourceDir: string;
let destDir: string;

async function fullAdmission(source: string): Promise<string> {
  const fresh = path.join(root, 'reference', crypto.randomUUID(), path.basename(source).replace(/\.zst$/, ''));
  fs.mkdirSync(path.dirname(fresh), { recursive: true });
  await archiveAdmittedConversation(source, fresh);
  return fs.readFileSync(fresh, 'utf8');
}

beforeEach(() => {
  prior = { ...process.env };
  fixture = createSyncFixture('sync-bounded-admission-');
  ({ root, sourceDir, destDir } = fixture);
  embedSpy.mockClear();
});

afterEach(() => {
  process.env = prior;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('archive currency with a record policy', () => {
  it('neither re-reads nor re-screens an unchanged archive', async () => {
    writePolicy(fixture);
    rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 2), ago(60));
    const first = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(first.copied).toBe(1);
    const screened = screenedRecords(fixture);
    expect(screened).toBeGreaterThan(0);

    const second = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(second.copied).toBe(0);
    expect(screenedRecords(fixture)).toBe(screened);
  });

  it('re-admits an archive that a newer policy names', async () => {
    writePolicy(fixture);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 2), ago(60));
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    const archive = path.join(destDir, '2026', '10', '15', path.basename(source));
    // The stamped archive stays current for its source; only the policy is newer.
    await new Promise(resolve => setTimeout(resolve, 20));

    writePolicy(fixture, { exchanges: [{ session_id: session(1), transcript: path.basename(source), line_start: 2, line_end: 3 }] });
    const second = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(second.copied).toBe(1);
    const lines = fs.readFileSync(archive, 'utf8').split('\n');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('');
    expect(lines[3]).toContain('question 2');
  });

  it('indexes a current archive that has no index rows', async () => {
    writePolicy(fixture);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 2), ago(60));
    stampedCopy(source, path.join(destDir, '2026', '10', '15', path.basename(source)));

    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(result.copied).toBe(0);
    expect(result.indexed).toBe(1);
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });

  it('screens a transcript outside the archive root when parsing it', async () => {
    writePolicy(fixture);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 2), ago(60));
    await parseConversation(source, 'fixture', source, { archiveRoot: destDir });
    // Harness detection screens the first record once more on its own cursor.
    expect(screenedRecords(fixture)).toBeGreaterThanOrEqual(5);
  });

  it('does not screen an archive again when it was admitted under the current policy', async () => {
    writePolicy(fixture);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 2), ago(60));
    await syncConversations(sourceDir, destDir, { skipSummaries: true, skipIndex: true });
    const admitted = screenedRecords(fixture);
    const archive = path.join(destDir, '2026', '10', '15', path.basename(source));
    await parseConversation(archive, 'fixture', archive, { archiveRoot: destDir });
    expect(screenedRecords(fixture)).toBe(admitted);
  });
});

describe('whole-operation sync budget', () => {
  it('admits the newest sources first and defers the rest', async () => {
    const day = path.join(sourceDir, '2026', '10', '15');
    rollout(day, 1, codexLines(session(1), 1), ago(300));
    const newest = rollout(day, 2, codexLines(session(2), 1), ago(10));
    rollout(day, 3, codexLines(session(3), 1), ago(200));

    const budget = createSyncBudget({ maxFiles: 1 });
    const first = await syncConversations(sourceDir, destDir, { skipSummaries: true, budget });
    expect(first.copied).toBe(1);
    expect(first.deferred).toBe(2);
    expect(fs.existsSync(path.join(destDir, '2026', '10', '15', path.basename(newest)))).toBe(true);

    const second = await syncConversations(sourceDir, destDir, { skipSummaries: true, budget: createSyncBudget({ maxFiles: 1 }) });
    expect(second.copied).toBe(1);
    expect(second.deferred).toBe(1);
  });

  it('defers an oversize source and admits the others', async () => {
    const day = path.join(sourceDir, '2026', '10', '15');
    const big = rollout(day, 1, codexLines(session(1), 200), ago(20));
    rollout(day, 2, codexLines(session(2), 1), ago(10));

    const result = await syncConversations(sourceDir, destDir, {
      skipSummaries: true, budget: createSyncBudget({ maxFileBytes: 4096 }),
    });
    expect(result.copied).toBe(1);
    expect(result.deferredOversize).toBe(1);
    expect(fs.existsSync(path.join(destDir, '2026', '10', '15', path.basename(big)))).toBe(false);
  });

  it('shares the byte budget across source directories', async () => {
    const day = path.join(sourceDir, '2026', '10', '15');
    rollout(day, 1, codexLines(session(1), 3), ago(10));
    const size = fs.statSync(fs.readdirSync(day).map(name => path.join(day, name))[0]).size;
    const otherDir = path.join(root, 'claude');
    rollout(path.join(otherDir, 'project'), 2, codexLines(session(2), 3), ago(10));

    const budget = createSyncBudget({ maxBytes: size });
    const first = await syncConversations(sourceDir, destDir, { skipSummaries: true, budget });
    const second = await syncConversations(otherDir, destDir, { skipSummaries: true, budget });
    expect(first.copied).toBe(1);
    expect(second.copied).toBe(0);
    expect(second.deferred).toBe(1);
  });

  it('starts no admission after the deadline', async () => {
    rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 1), ago(10));
    const result = await syncConversations(sourceDir, destDir, {
      skipSummaries: true, budget: createSyncBudget({ deadlineMs: Date.now() - 1 }),
    });
    expect(result.copied).toBe(0);
    expect(result.deferred).toBe(1);
  });

  it('keeps indexing admitted archives after the admission deadline', async () => {
    const day = path.join(sourceDir, '2026', '10', '15');
    const admitted = rollout(day, 1, codexLines(session(1), 1), ago(20));
    await syncConversations(sourceDir, destDir, { skipSummaries: true, skipIndex: true });
    rollout(day, 2, codexLines(session(2), 1), ago(10));

    const result = await syncConversations(sourceDir, destDir, {
      skipSummaries: true,
      budget: createSyncBudget({ admissionDeadlineMs: Date.now() - 1, deadlineMs: Date.now() + 60_000 }),
    });
    expect(result).toMatchObject({ copied: 0, deferred: 1, indexed: 1 });
    expect(fs.existsSync(path.join(destDir, '2026', '10', '15', path.basename(admitted)))).toBe(true);
  });
});

describe.skipIf(!zstdAvailable)('compressed Codex sources', () => {
  it('archives a .jsonl.zst rollout as its plain admitted transcript', async () => {
    writePolicy(fixture);
    const content = codexLines(session(1), 2);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, content, ago(60), true);
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(result.copied).toBe(1);
    expect(result.indexed).toBe(1);
    const archive = path.join(destDir, '2026', '10', '15', path.basename(source).replace(/\.zst$/, ''));
    expect(fs.readFileSync(archive, 'utf8')).toBe(content);
  });

  it('maps a flat archived_sessions rollout to its dated archive path', async () => {
    const archived = path.join(root, 'archived_sessions');
    const source = rollout(archived, 1, codexLines(session(1), 1), ago(60), true);
    const result = await syncConversations(archived, destDir, { skipSummaries: true });
    expect(result.copied).toBe(1);
    expect(fs.existsSync(path.join(destDir, '2026', '10', '15', path.basename(source).replace(/\.zst$/, '')))).toBe(true);
  });

  it('applies exclusions named for the uncompressed transcript', async () => {
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 2), ago(60), true);
    const transcript = path.basename(source).replace(/\.zst$/, '');
    writePolicy(fixture, { exchanges: [{ session_id: session(1), transcript, line_start: 2, line_end: 3 }] });
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    const lines = fs.readFileSync(path.join(destDir, '2026', '10', '15', transcript), 'utf8').split('\n');
    expect(lines[1]).toBe('');
    expect(lines[3]).toContain('question 2');
  });

  it('honours an opt-out marker inside a compressed rollout', async () => {
    const content = codexLines(session(1), 1) + JSON.stringify({ type: 'response_item', payload: { type: 'message',
      role: 'user', content: [{ type: 'input_text', text: MARKER }] } }) + '\n';
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, content, ago(60), true);
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(result.copied).toBe(0);
    expect(fs.existsSync(path.join(destDir, '2026', '10', '15', path.basename(source).replace(/\.zst$/, '')))).toBe(false);
  });
});

describe('append-only growth', () => {
  it('screens only the appended records and matches a full admission', async () => {
    writePolicy(fixture);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 3), ago(60));
    // Without indexing, every screened record is an admission record.
    await syncConversations(sourceDir, destDir, { skipSummaries: true, skipIndex: true });
    const before = screenedRecords(fixture);

    fs.appendFileSync(source, codexLines(session(1), 1, 4));
    bump(source);
    const second = await syncConversations(sourceDir, destDir, { skipSummaries: true, skipIndex: true });
    expect(second.copied).toBe(1);
    expect(screenedRecords(fixture) - before).toBe(2);
    const archive = path.join(destDir, '2026', '10', '15', path.basename(source));
    expect(fs.readFileSync(archive, 'utf8')).toBe(await fullAdmission(source));
  });

  it('falls back to a full admission when the prefix of an unindexed archive was rewritten', async () => {
    writePolicy(fixture);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 2), ago(60));
    await syncConversations(sourceDir, destDir, { skipSummaries: true, skipIndex: true });
    fs.writeFileSync(source, codexLines(session(1), 2).replace('question 1', 'question one') + codexLines(session(1), 1, 3));
    bump(source);
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    const archive = path.join(destDir, '2026', '10', '15', path.basename(source));
    expect(fs.readFileSync(archive, 'utf8')).toBe(await fullAdmission(source));
  });

  it('completes a line that was unterminated at the previous admission', async () => {
    writePolicy(fixture);
    const content = codexLines(session(1), 2);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, content.slice(0, -10), ago(60));
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    fs.appendFileSync(source, content.slice(-10) + codexLines(session(1), 1, 3));
    bump(source);
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    const archive = path.join(destDir, '2026', '10', '15', path.basename(source));
    expect(fs.readFileSync(archive, 'utf8')).toBe(await fullAdmission(source));
  });

  it('keeps the previous archive when an opt-out marker is appended', async () => {
    writePolicy(fixture);
    const source = rollout(path.join(sourceDir, '2026', '10', '15'), 1, codexLines(session(1), 1), ago(60));
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    const archive = path.join(destDir, '2026', '10', '15', path.basename(source));
    const previous = fs.readFileSync(archive, 'utf8');
    fs.appendFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: MARKER }] } }) + '\n');
    bump(source);
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(result.copied).toBe(0);
    expect(fs.readFileSync(archive, 'utf8')).toBe(previous);
  });
});
