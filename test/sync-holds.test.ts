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

let prior: NodeJS.ProcessEnv;
let fixture: SyncFixture;
let day: string;
let archiveDay: string;

const sync = () => syncConversations(fixture.sourceDir, fixture.destDir, { skipSummaries: true });
const pause = () => new Promise(resolve => setTimeout(resolve, 20));

function holdRows(): number {
  const db = new Database(process.env.EPISODIC_MEMORY_DB_PATH!, { readonly: true });
  try { return (db.prepare('SELECT COUNT(*) AS count FROM sync_holds').get() as { count: number }).count; }
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

    const result = await sync();
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
    expect(screenedRecords(fixture)).toBe(5);

    const second = await sync();
    expect(second.indexed).toBe(0);
    expect(screenedRecords(fixture)).toBe(5);
  });
});

describe('refusal memory', () => {
  it('does not screen refused content again until the source changes', async () => {
    writePolicy(fixture);
    const source = rollout(day, 1, codexLines(session(1), 2, 1, FLAGGED), ago(60));

    const first = await sync();
    expect(first).toMatchObject({ copied: 0, refused: 1, errors: [] });
    expect(fs.existsSync(path.join(archiveDay, path.basename(source)))).toBe(false);
    const screened = screenedRecords(fixture);
    expect(screened).toBeGreaterThan(0);

    const second = await sync();
    expect(second).toMatchObject({ refused: 1, errors: [] });
    expect(screenedRecords(fixture)).toBe(screened);

    fs.appendFileSync(source, codexLines(session(1), 1, 3));
    bump(source);
    const third = await sync();
    expect(third.refused).toBe(1);
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

  it('remembers an archive whose indexing screening refuses', async () => {
    const source = rollout(day, 1, codexLines(session(1), 2, 1, FLAGGED), ago(60));
    stampedCopy(source, path.join(archiveDay, path.basename(source)));
    await pause();
    writePolicy(fixture);

    const first = await sync();
    expect(first).toMatchObject({ copied: 0, indexed: 0, refused: 1, errors: [] });
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
    expect(first).toMatchObject({ copied: 0, diverged: 1, errors: [] });
    expect(fs.readFileSync(archive, 'utf8')).toBe(previous);
    expect(screenedRecords(fixture)).toBe(screened);
    expect(holdRows()).toBe(1);

    expect((await sync()).diverged).toBe(1);
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
});
