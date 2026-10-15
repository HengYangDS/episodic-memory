import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
  FLAGGED, ago, bump, codexLines, createSyncFixture, rollout, screenedRecords, session, stampedCopy, writePolicy,
  type SyncFixture,
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

import { syncConversations } from '../src/sync.js';
import { archiveAdmittedConversation } from '../src/record-admission.js';
import { parseConversation } from '../src/parser.js';

let prior: NodeJS.ProcessEnv;
let fixture: SyncFixture;
let day: string;
let archiveDay: string;

const sync = () => syncConversations(fixture.sourceDir, fixture.destDir, { skipSummaries: true });
const pause = () => new Promise(resolve => setTimeout(resolve, 20));

function holdRows(stage = 'admission'): number {
  const db = new Database(process.env.EPISODIC_MEMORY_DB_PATH!, { readonly: true });
  try { return (db.prepare('SELECT COUNT(*) AS count FROM sync_holds WHERE stage = ?').get(stage) as { count: number }).count; }
  finally { db.close(); }
}

/** An archive copied before the current policy existed, as releases before admission wrote them. */
function legacyCopy(source: string): string {
  const archive = path.join(archiveDay, path.basename(source));
  fs.mkdirSync(archiveDay, { recursive: true });
  fs.copyFileSync(source, archive);
  return archive;
}

async function fullAdmission(source: string): Promise<string> {
  const fresh = path.join(fixture.root, 'reference', crypto.randomUUID(), path.basename(source));
  fs.mkdirSync(path.dirname(fresh), { recursive: true });
  await archiveAdmittedConversation(source, fresh);
  return fs.readFileSync(fresh, 'utf8');
}

beforeEach(() => {
  prior = { ...process.env };
  fixture = createSyncFixture('sync-holds-');
  day = path.join(fixture.sourceDir, '2026', '10', '15');
  archiveDay = path.join(fixture.destDir, '2026', '10', '15');
  embedSpy.mockClear();
});

afterEach(() => {
  process.env = prior;
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe('archives written before the current policy', () => {
  it('screens every record again rather than extending an unscreened prefix', async () => {
    const source = rollout(day, 1, codexLines(session(1), 3), ago(60));
    const archive = legacyCopy(source);
    await pause();
    writePolicy(fixture);
    fs.appendFileSync(source, codexLines(session(1), 1, 4));
    bump(source);

    const result = await syncConversations(fixture.sourceDir, fixture.destDir, { skipSummaries: true, skipIndex: true });
    expect(result.copied).toBe(1);
    // One session record and four turns: nine records, not only the two appended ones.
    expect(screenedRecords(fixture)).toBe(9);
    expect(fs.readFileSync(archive, 'utf8')).toBe(await fullAdmission(source));
  });

  it('confirms an unchanged copy only by screening it, then indexes and leaves it current', async () => {
    const source = rollout(day, 1, codexLines(session(1), 2), ago(60));
    legacyCopy(source);
    await pause();
    writePolicy(fixture);

    const first = await sync();
    expect(first.copied).toBe(0);
    expect(first.indexed).toBe(1);
    // Admission screens the five records; indexing screens each stored exchange's
    // two messages and metadata, six fields, in one batch.
    expect(screenedRecords(fixture)).toBe(5 + 6);

    const second = await sync();
    expect(second.indexed).toBe(0);
    expect(screenedRecords(fixture)).toBe(5 + 6);
  });
});

describe('refusal memory', () => {
  it('holds refused content while the source only grows, and retries a rewrite', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 2, 1, FLAGGED), ago(60));

    const first = await sync();
    expect(first).toMatchObject({ copied: 0, refused: 1 });
    expect(first.errors.map(entry => entry.error)).toEqual(['Record content rejected by screening']);
    expect(fs.existsSync(path.join(archiveDay, path.basename(source)))).toBe(false);
    const screened = screenedRecords(fixture);
    expect(screened).toBeGreaterThan(0);

    const second = await sync();
    expect(second).toMatchObject({ refused: 1, errors: [] });
    expect(screenedRecords(fixture)).toBe(screened);

    // The refused records are still the source's first bytes, so a live conversation stays held.
    fs.appendFileSync(source, codexLines(session(1), 1, 3));
    bump(source);
    expect(await sync()).toMatchObject({ refused: 1, errors: [] });
    expect(screenedRecords(fixture)).toBe(screened);

    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('question 1', 'question one'));
    bump(source, 10);
    const rewritten = await sync();
    expect(rewritten.refused).toBe(1);
    expect(rewritten.errors).toHaveLength(1);
    expect(screenedRecords(fixture)).toBeGreaterThan(screened);
  });

  it('retries a refusal under a changed policy and forgets it once admitted', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 2, 1, FLAGGED), ago(60));
    await sync();
    expect(holdRows()).toBe(1);

    await pause();
    writePolicy(fixture, { exchanges: [{ session_id: session(1), transcript: path.basename(source), line_start: 2, line_end: 5 }] });
    const result = await sync();
    expect(result).toMatchObject({ copied: 1, refused: 0, errors: [] });
    expect(fs.readFileSync(path.join(archiveDay, path.basename(source)), 'utf8')).not.toContain(FLAGGED);
    expect(holdRows()).toBe(0);
  });

  it('stores no field of an archive when indexing screening rejects one, in batch scans only', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 2, 1, FLAGGED), ago(60));
    const archive = path.join(archiveDay, path.basename(source));
    // A copy stamped after the policy reads as screened, so only indexing screens its exchanges.
    stampedCopy(source, archive);

    const first = await sync();
    expect(first).toMatchObject({ indexed: 0, refused: 1 });
    expect(first.errors.map(entry => entry.error)).toEqual(['Record content rejected by screening']);
    const db = new Database(process.env.EPISODIC_MEMORY_DB_PATH!, { readonly: true });
    try { expect((db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE archive_path = ?').get(archive) as { n: number }).n).toBe(0); }
    finally { db.close(); }
    expect(fs.readFileSync(fixture.scanLog, 'utf8').trim().split('\n').every(line => line.startsWith('batch '))).toBe(true);
  });

  it('remembers an archive whose indexing screening refuses', async () => {
    const source = rollout(day, 1, codexLines(session(1), 2, 1, FLAGGED), ago(60));
    stampedCopy(source, path.join(archiveDay, path.basename(source)));
    await pause();
    writePolicy(fixture);

    const first = await sync();
    expect(first).toMatchObject({ copied: 0, indexed: 0, refused: 1 });
    expect(first.errors).toHaveLength(1);
    expect(holdRows('index')).toBe(1);
    const screened = screenedRecords(fixture);

    const second = await sync();
    expect(second).toMatchObject({ indexed: 0, refused: 1, errors: [] });
    expect(screenedRecords(fixture)).toBe(screened);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('forgets a refusal whose file no longer exists', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 1, 1, FLAGGED), ago(60));
    await sync();
    expect(holdRows()).toBe(1);
    fs.rmSync(source);
    await sync();
    expect(holdRows()).toBe(0);
  });

  it('does not parse an unchanged archive without indexable exchanges again', async () => {
    const unanswered = JSON.stringify({ type: 'session_meta', payload: { id: session(1), cwd: '/synthetic' } }) + '\n' +
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'unanswered question' }] } }) + '\n';
    const source = rollout(day, 1, unanswered, ago(60));
    expect((await sync()).indexed).toBe(1);
    expect(holdRows('index')).toBe(1);
    expect((await sync()).indexed).toBe(0);

    fs.appendFileSync(source, codexLines(session(1), 1, 2));
    bump(source);
    expect((await sync()).indexed).toBe(1);
    expect(embedSpy).toHaveBeenCalled();
    expect(holdRows('index')).toBe(0);
  });
});

describe('rewritten sources', () => {
  // A harness migration that rewrites every record, like Codex adding record ordinals.
  function rewrite(source: string, extraTurns: number): void {
    const lines = fs.readFileSync(source, 'utf8').trimEnd().split('\n')
      .map((line, ordinal) => JSON.stringify({ ordinal, ...JSON.parse(line) }));
    fs.writeFileSync(source, lines.join('\n') + '\n' + codexLines(session(1), extraTurns, 3));
    bump(source);
  }

  it('keeps an indexed archive whose source was rewritten, without screening the rewrite', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 2), ago(60));
    const archive = path.join(archiveDay, path.basename(source));
    expect((await sync()).indexed).toBe(1);
    const previous = fs.readFileSync(archive, 'utf8');
    const screened = screenedRecords(fixture);

    rewrite(source, 1);
    const first = await sync();
    expect(first).toMatchObject({ copied: 0, diverged: 1 });
    expect(first.errors.map(entry => entry.error)).toEqual(['Conversation source no longer holds its archived lines']);
    expect(fs.readFileSync(archive, 'utf8')).toBe(previous);
    expect(screenedRecords(fixture)).toBe(screened);
    expect(holdRows()).toBe(1);

    expect(await sync()).toMatchObject({ diverged: 1, errors: [] });

    // A rewritten live session that keeps growing stays held without another report.
    fs.appendFileSync(source, codexLines(session(1), 1, 4));
    bump(source, 10);
    expect(await sync()).toMatchObject({ diverged: 1, errors: [] });
    expect(fs.readFileSync(archive, 'utf8')).toBe(previous);
  });

  it('replaces a rewritten archive that no index rows reference', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 2), ago(60));
    await syncConversations(fixture.sourceDir, fixture.destDir, { skipSummaries: true, skipIndex: true });

    rewrite(source, 1);
    const result = await sync();
    expect(result).toMatchObject({ copied: 1, indexed: 1, diverged: 0, errors: [] });
    expect(fs.readFileSync(path.join(archiveDay, path.basename(source)), 'utf8')).toBe(await fullAdmission(source));
  });

  /** Line ranges of an archive's rows, and of the exchanges its current bytes hold. */
  async function ranges(archive: string): Promise<{ rows: number[][]; parsed: number[][] }> {
    const db = new Database(process.env.EPISODIC_MEMORY_DB_PATH!, { readonly: true });
    try {
      const rows = (db.prepare('SELECT line_start, line_end FROM exchanges WHERE archive_path = ? ORDER BY line_start')
        .all(archive) as Array<{ line_start: number; line_end: number }>).map(row => [row.line_start, row.line_end]);
      const parsed = (await parseConversation(archive, 'fixture', archive)).map(exchange => [exchange.lineStart, exchange.lineEnd]);
      return { rows, parsed };
    } finally { db.close(); }
  }

  it('replaces a rewritten indexed archive and rebuilds its rows when asked', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 2), ago(60));
    const archive = path.join(archiveDay, path.basename(source));
    await sync();
    rewrite(source, 1);
    expect((await sync()).diverged).toBe(1);

    const result = await syncConversations(fixture.sourceDir, fixture.destDir, { skipSummaries: true, replaceDiverged: true });
    expect(result).toMatchObject({ copied: 1, diverged: 0, errors: [] });
    expect(fs.readFileSync(archive, 'utf8')).toBe(await fullAdmission(source));
    const { rows, parsed } = await ranges(archive);
    expect(rows).toEqual(parsed);
    expect(holdRows()).toBe(0);
    expect(holdRows('rebuild')).toBe(0);
  });

  it('finishes a rebuild that an interruption left pending', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 2), ago(60));
    const archive = path.join(archiveDay, path.basename(source));
    await sync();
    rewrite(source, 1);
    await sync();

    embedSpy.mockRejectedValueOnce(new Error('embedding backend stopped'));
    const interrupted = await syncConversations(fixture.sourceDir, fixture.destDir, { skipSummaries: true, replaceDiverged: true });
    expect(interrupted.copied).toBe(1);
    expect(interrupted.errors.map(entry => entry.error)).toEqual(['embedding backend stopped']);
    expect(holdRows('rebuild')).toBe(1);

    // A plain later run finishes the rebuild of the already replaced archive.
    expect((await sync()).errors).toEqual([]);
    const { rows, parsed } = await ranges(archive);
    expect(rows).toEqual(parsed);
    expect(holdRows('rebuild')).toBe(0);
  });
});
