import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  admitExchange,
  archiveAdmittedConversation,
  readAdmittedConversation,
  readRecordExclusions,
} from '../src/record-admission.js';
import { initDatabase, insertExchange } from '../src/db.js';
import { searchConversations } from '../src/search.js';
import type { ConversationExchange } from '../src/types.js';

const session = '00000000-1111-4222-8333-444444444444';
// Deliberately public nonfunctional fixture, never a production credential.
const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const scannerName = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
const scannerPath = process.env.TEST_GITLEAKS_PATH || (process.env.PATH || '').split(path.delimiter)
  .map(directory => path.join(directory, scannerName)).find(file => fs.existsSync(file));
if (!scannerPath) throw new Error('Install Gitleaks or set TEST_GITLEAKS_PATH; screening acceptance cannot be skipped');
const scanner = fs.realpathSync(scannerPath);
const digest = crypto.createHash('sha256').update(fs.readFileSync(scanner)).digest('hex');
let root: string;
let prior: NodeJS.ProcessEnv;
let source: string;
let destination: string;

function policy(overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(root, 'record-exclusions.json'), JSON.stringify({
    version: 1,
    exchanges: [],
    tool_calls: [],
    screening: {
      engine: 'gitleaks', executable: scanner, sha256: digest,
      timeout_ms: 2000, max_record_bytes: 1_048_576, ...overrides,
    },
  }), { mode: 0o600 });
}

function exchange(text = 'ordinary safe explanation'): ConversationExchange {
  return {
    id: 'fixture-exchange', project: 'fixture', timestamp: '2026-01-01T00:00:00Z',
    userMessage: text, assistantMessage: 'safe answer', archivePath: source,
    lineStart: 2, lineEnd: 3, sessionId: session, harness: 'codex',
  };
}

function transcript(text: string): string {
  return [
    { type: 'session_meta', payload: { id: session, cwd: '/synthetic' } },
    { type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'safe answer' }] } },
  ].map(JSON.stringify).join('\n') + '\n';
}

// Fault injection at the subprocess boundary, not a replacement for real
// Gitleaks acceptance above. Every probe is an actual pinned executable.
function scannerProbe(body: string): string {
  const file = path.join(root, 'scanner-probe');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  policy({ executable: fs.realpathSync(file),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  return file;
}

beforeEach(() => {
  prior = { ...process.env };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-screening-test-'));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = root;
  process.env.EPISODIC_MEMORY_DB_PATH = path.join(root, 'test.sqlite');
  source = path.join(root, `rollout-${session}.jsonl`);
  destination = path.join(root, 'archive', path.basename(source));
  fs.writeFileSync(source, transcript('safe question'));
  policy();
});

afterEach(() => {
  process.env = prior;
  fs.rmSync(root, { recursive: true, force: true });
  expect(fs.existsSync(root)).toBe(false);
});

describe('pinned record-local screening at native admission', () => {
  it('screens retained search content and summaries against the current pinned scanner', async () => {
    const db = initDatabase();
    insertExchange(db, exchange(), new Array(384).fill(0));
    db.prepare('UPDATE exchanges SET assistant_message = ?').run(token);
    db.close();
    await expect(searchConversations('ordinary', { mode: 'text' })).rejects.toThrow(/content rejected by screening/i);
    const repaired = initDatabase();
    repaired.prepare('UPDATE exchanges SET assistant_message = ?').run('safe answer');
    repaired.close();
    fs.writeFileSync(source.replace('.jsonl', '-summary.txt'), token);
    await expect(searchConversations('ordinary', { mode: 'text' })).rejects.toThrow(/content rejected by screening/i);
    fs.unlinkSync(source.replace('.jsonl', '-summary.txt'));
    policy({ sha256: '0'.repeat(64) });
    await expect(searchConversations('ordinary', { mode: 'text' })).rejects.toThrow(/screening unavailable/i);
  });

  it('accepts an explicitly configured scanner without changing exclusion identity', () => {
    expect(readRecordExclusions()).toMatchObject({ version: 1, screening: { engine: 'gitleaks' } });
    expect(admitExchange(exchange())).toEqual(exchange());
  });

  it('rejects a new synthetic token at direct database ingress without inserting rows', () => {
    const db = initDatabase();
    try {
      expect(() => insertExchange(db, exchange(token), new Array(384).fill(0)))
        .toThrow(/content rejected by screening/i);
      expect(db.prepare('SELECT count(*) AS n FROM exchanges').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM vec_exchanges').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('preserves original and previous archive when new content fails screening', async () => {
    const original = transcript(token);
    fs.writeFileSync(source, original);
    fs.mkdirSync(path.dirname(destination));
    fs.writeFileSync(destination, 'previous admitted bytes\n');
    await expect(archiveAdmittedConversation(source, destination)).rejects.toThrow(/content rejected by screening/i);
    expect(fs.readFileSync(source, 'utf8')).toBe(original);
    expect(fs.readFileSync(destination, 'utf8')).toBe('previous admitted bytes\n');
    expect(fs.readdirSync(path.dirname(destination))).toEqual([path.basename(destination)]);
  });

  it('does not expose newly detected content through native read', async () => {
    fs.writeFileSync(source, transcript(token));
    await expect(readAdmittedConversation(source)).rejects.toThrow(/content rejected by screening/i);
  });

  it('screens decoded JSON strings rather than trusting escaped token spelling', async () => {
    fs.writeFileSync(source, transcript(token).replace('ghp_', '\\u0067hp_'));
    await expect(archiveAdmittedConversation(source, destination)).rejects.toThrow(/content rejected by screening/i);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('keeps separate user and assistant records from contaminating keyword screening', () => {
    const x = exchange('Sourcegraph');
    x.assistantMessage = '0123456789abcdef0123456789abcdef01234567';
    expect(admitExchange(x)).toEqual(x);
  });

  it('rejects newly detected tool payloads without exposing their values in errors', () => {
    const x = exchange();
    x.toolCalls = [{ id: 'tool', exchangeId: x.id, toolName: 'fixture',
      toolInput: { value: token }, toolResult: 'safe result', timestamp: x.timestamp, isError: false }];
    let message = '';
    try { admitExchange(x); } catch (error) { message = String(error); }
    expect(message).toMatch(/content rejected by screening/i);
    expect(message).not.toContain(token);
  });

  it('applies exact known exclusions before scanning so safe neighboring records survive', async () => {
    const file = path.join(root, 'record-exclusions.json');
    const configured = JSON.parse(fs.readFileSync(file, 'utf8'));
    configured.exchanges = [{ session_id: session, transcript: path.basename(source), line_start: 2, line_end: 2 }];
    fs.writeFileSync(file, JSON.stringify(configured));
    fs.writeFileSync(source, transcript(token));
    expect(await archiveAdmittedConversation(source, destination)).toBe(true);
    const actual = fs.readFileSync(destination, 'utf8');
    expect(actual).not.toContain(token);
    expect(actual.split('\n')[1]).toBe('');
    expect(actual).toContain('safe answer');
  });

  it('fails closed when the scanner is unavailable or has the wrong digest', () => {
    policy({ executable: path.join(root, 'missing') });
    expect(() => admitExchange(exchange())).toThrow(/screening unavailable/i);
    policy({ sha256: '0'.repeat(64) });
    expect(() => admitExchange(exchange())).toThrow(/screening unavailable/i);
  });

  it('rejects oversized input before execution and never logs it', () => {
    policy({ max_record_bytes: 32 });
    expect(() => admitExchange(exchange('x'.repeat(33)))).toThrow(/screening byte limit/i);
  });

  it('cannot disable configured screening through ambient scanner config or allow comments', () => {
    process.env.GITLEAKS_CONFIG = '/nonexistent/ambient.toml';
    expect(() => admitExchange(exchange(token + ' # gitleaks:allow')))
      .toThrow(/content rejected by screening/i);
  });

  it('retains byte-identical safe archives and idempotent retry behavior', async () => {
    const raw = fs.readFileSync(source);
    expect(await archiveAdmittedConversation(source, destination)).toBe(true);
    expect(fs.readFileSync(destination)).toEqual(raw);
    expect(await archiveAdmittedConversation(source, destination)).toBe(false);
    expect(fs.readFileSync(source)).toEqual(raw);
  });

  it('retains key/value assignment syntax required by generic credential rules', () => {
    const text = JSON.stringify({ api_key: 'rP8v2Ls7Qm4Zx9Nc6Tb3Wy5Hd1Kf0Aj8' });
    expect(() => admitExchange(exchange(text))).toThrow(/content rejected by screening/i);
  });

  it('does not bypass screening when session identity is absent', () => {
    const x = exchange(token);
    delete x.sessionId;
    x.archivePath = path.join(root, 'anonymous.jsonl');
    expect(() => admitExchange(x)).toThrow(/content rejected by screening/i);
  });

  it.each([
    ['empty report', '', 0],
    ['malformed report', '{', 0],
    ['non-array report', '{}', 0],
    ['contradictory clean exit', '[{"RuleID":"fixture"}]', 0],
    ['empty detection', '[]', 10],
    ['invalid detection', '[{}]', 10],
    ['scanner failure', '[]', 2],
  ])('rejects %s without exposing subprocess output', (_name, stdout, status) => {
    scannerProbe(`process.stderr.write('private-probe-diagnostic');
      process.stdout.write(${JSON.stringify(stdout)}); process.exit(${status});`);
    let message = '';
    try { admitExchange(exchange()); } catch (error) { message = String(error); }
    expect(message).toMatch(/screening unavailable/i);
    expect(message).not.toContain('private-probe-diagnostic');
  });

  it('terminates a hung scanner within its bounded timeout', () => {
    scannerProbe('setInterval(() => {}, 1000);');
    const file = path.join(root, 'record-exclusions.json');
    const configured = JSON.parse(fs.readFileSync(file, 'utf8'));
    configured.screening.timeout_ms = 100;
    fs.writeFileSync(file, JSON.stringify(configured));
    const start = performance.now();
    expect(() => admitExchange(exchange())).toThrow(/screening unavailable/i);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('rejects non-executable and symlink scanner identities', () => {
    const file = scannerProbe("process.stdout.write('[]');");
    fs.chmodSync(file, 0o600);
    expect(() => admitExchange(exchange())).toThrow(/screening unavailable/i);
    fs.chmodSync(file, 0o700);
    const alias = path.join(root, 'scanner-link');
    fs.symlinkSync(file, alias);
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, executable: alias });
    expect(() => admitExchange(exchange())).toThrow(/screening unavailable/i);
  });

  it('rejects scanner mutation during execution and cleans private work directories', () => {
    const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('episodic-screen-')).sort();
    scannerProbe("require('node:fs').appendFileSync(__filename, '\\n// changed'); process.stdout.write('[]');");
    expect(() => admitExchange(exchange())).toThrow(/screening unavailable/i);
    expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('episodic-screen-')).sort()).toEqual(before);
  });
});
