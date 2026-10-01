import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import {
  admitExchange,
  admittedConversationLines,
  archiveAdmittedConversation,
  readAdmittedConversation,
  readRecordExclusions,
} from '../src/record-admission.js';
import { initDatabase, insertExchange } from '../src/db.js';
import { searchConversations } from '../src/search.js';
import { verifyIndex } from '../src/verify.js';
import { parseConversation } from '../src/parser.js';
import type { ConversationExchange } from '../src/types.js';

const session = '00000000-1111-4222-8333-444444444444';
// Deliberately public nonfunctional fixture, never a production credential.
const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const scannerName = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
const realScannerPath = process.env.TEST_GITLEAKS_PATH || (process.env.PATH || '').split(path.delimiter)
  .map(directory => path.join(directory, scannerName)).find(file => fs.existsSync(file));
let scanner: string;
let digest: string;
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
      timeout_ms: 10_000, max_record_bytes: 1_048_576, ...overrides,
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

function archivedTranscript(text: string, withSummary = false): string {
  const archiveDir = path.join(root, 'archive');
  const projectDir = path.join(archiveDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  process.env.TEST_ARCHIVE_DIR = archiveDir;
  const file = path.join(projectDir, path.basename(source));
  fs.writeFileSync(file, transcript(text));
  if (withSummary) fs.writeFileSync(file.replace('.jsonl', '-summary.txt'), 'Existing summary');
  return file;
}

// Decode only the controlled test TAR; production packing uses tar-stream.
const batchProbeReader = `
const target = process.argv[2] === 'dir' ? process.argv.at(-1) : null;
function recordsForProbe() {
  if (!target) return [{ name: '', text: fs.readFileSync(0, 'utf8'), mode: 0o600 }];
  const bytes = fs.readFileSync(target);
  const records = [];
  let offset = 0;
  while (offset + 512 <= bytes.length && bytes[offset] !== 0) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').split('\\0')[0];
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\\0/g, '').trim(), 8);
    const mode = parseInt(header.subarray(100, 108).toString('ascii').replace(/\\0/g, '').trim(), 8);
    records.push({ name, mode, text: bytes.subarray(offset + 512, offset + 512 + size).toString('utf8') });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return records;
}
`;

// Contract probes are executable and digest-pinned without requiring Gitleaks
// on every CI host. A separate optional integration test exercises Gitleaks.
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
  scanner = path.join(root, 'scanner-fixture');
  fs.writeFileSync(scanner, `#!${process.execPath}
const fs = require('node:fs');
${batchProbeReader}
const foundRecord = recordsForProbe().find(record => {
  const input = record.text;
  return input.includes('ghp_') || /api_key\\s*=\\s*\\S{20}/i.test(input) ||
    (input.includes('Sourcegraph') && /[a-f0-9]{40}/i.test(input));
});
const found = foundRecord !== undefined;
process.stdout.write(found ? JSON.stringify([{ RuleID: 'fixture', File: target ? target + '!' + foundRecord.name : '' }]) : '[]');
process.exit(found ? 10 : 0);
`, { mode: 0o700 });
  scanner = fs.realpathSync(scanner);
  digest = crypto.createHash('sha256').update(fs.readFileSync(scanner)).digest('hex');
  source = path.join(root, `rollout-${session}.jsonl`);
  destination = path.join(root, 'archive', path.basename(source));
  fs.writeFileSync(source, transcript('safe question'));
  policy();
});

afterEach(() => {
  if (prior.TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prior.TMPDIR;
  process.env = prior;
  fs.rmSync(root, { recursive: true, force: true });
  expect(fs.existsSync(root)).toBe(false);
});

describe('pinned record-local screening at native admission', () => {
  it('fails verification on an invalid record policy even with no archived files', async () => {
    fs.writeFileSync(path.join(root, 'record-exclusions.json'), '{invalid');
    process.env.TEST_ARCHIVE_DIR = path.join(root, 'empty-archive');
    await expect(verifyIndex()).rejects.toThrow(/record exclusion policy/i);
  });

  it.each(['rejected', 'unavailable'] as const)('classifies %s screening independently from corruption and missing summary', async outcome => {
    const file = archivedTranscript(token);
    if (outcome === 'unavailable') policy({ sha256: '0'.repeat(64) });

    const result = await verifyIndex();
    expect(result.missing.map(item => item.path)).toContain(file);
    expect(result.corrupted).toEqual([]);
    expect(result.screeningRejected.map(item => item.path)).toEqual(outcome === 'rejected' ? [file] : []);
    expect(result.screeningUnavailable.map(item => item.path)).toEqual(outcome === 'unavailable' ? [file] : []);
  });

  it('does not report a green repair when configured screening rejects an archive', () => {
    archivedTranscript(token, true);
    const cli = path.join(import.meta.dirname, '..', 'dist', 'index-cli.js');
    const result = spawnSync(process.execPath, [cli, 'repair'], {
      env: process.env, encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('No issues to repair!');
    expect(result.stdout).not.toContain('Repair complete.');
  });

  it.skipIf(!realScannerPath)('rejects a synthetic token with the actual Gitleaks executable', () => {
    const executable = fs.realpathSync(realScannerPath!);
    policy({ executable, sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') });
    expect(() => admitExchange(exchange(token))).toThrow(/content rejected by screening/i);
  });

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

  it('screens a bounded batch in one process with private separate record files', async () => {
    const log = path.join(root, 'batch-records.jsonl');
    scannerProbe(`const fs = require('node:fs');
      ${batchProbeReader}
      const records = recordsForProbe();
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
        records: records.length, target,
        modes: records.map(record => record.mode),
        names: records.map(record => record.name),
        independent: records.every(record => (record.text.match(/safe record/g) || []).length === 1),
      }) + '\\n');
      process.stdout.write('[]');`);
    const lines = Array.from({ length: 24 }, (_, index) => JSON.stringify({
      type: 'event_msg', payload: { type: 'user_message', message: `safe record ${index}` },
    }));
    fs.writeFileSync(source, lines.join('\n') + '\n');

    expect(await readAdmittedConversation(source)).toBe(lines.join('\n'));
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ records: 24, target: 'batch.tar', independent: true });
    expect(calls[0].modes).toEqual(Array(24).fill(0o600));
    expect(calls[0].names.every((name: string) => /^\d{8}\.txt$/.test(name))).toBe(true);
  });

  it('uses one private TAR container without extracting each batch record to disk', async () => {
    const log = path.join(root, 'tar-contract');
    scannerProbe(`const fs = require('node:fs');
      const target = process.argv.at(-1);
      const input = fs.readFileSync(target);
      fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ target,
        files: fs.readdirSync('.'), mode: fs.statSync(target).mode & 0o777,
        archiveDepth: process.argv[process.argv.indexOf('--max-archive-depth') + 1],
        firstMember: input.subarray(0, 100).toString('utf8').replace(/\\0.*$/, ''),
      }));
      process.stdout.write('[]');`);
    expect(await readAdmittedConversation(source)).toContain('safe question');
    expect(JSON.parse(fs.readFileSync(log, 'utf8'))).toEqual({
      target: 'batch.tar', files: ['batch.tar'], mode: 0o600,
      archiveDepth: '1', firstMember: '00000000.txt',
    });
  });

  it.each(['early-end', 'extra-trailer'])('rejects a noncanonical %s TAR before invoking the scanner', async mutation => {
    const log = path.join(root, 'scanner-called');
    scannerProbe(`require('node:fs').writeFileSync(${JSON.stringify(log)}, 'called'); process.stdout.write('[]');`);
    const tar = createRequire(import.meta.url)('tar-stream');
    const original = tar.pack;
    const mocked = vi.spyOn(tar, 'pack').mockImplementation(() => {
      const packed = original();
      const output = new Readable({ read() {} }) as Readable & { entry: unknown; finalize: unknown };
      output.entry = packed.entry.bind(packed);
      output.finalize = packed.finalize.bind(packed);
      const chunks: Buffer[] = [];
      packed.on('data', (chunk: Buffer) => chunks.push(chunk));
      packed.on('error', (error: Error) => output.destroy(error));
      packed.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const firstSize = parseInt(bytes.subarray(124, 136).toString('ascii'), 8);
        const offset = 512 + Math.ceil(firstSize / 512) * 512;
        output.push(mutation === 'early-end'
          ? Buffer.concat([bytes.subarray(0, offset), Buffer.alloc(1024), bytes.subarray(offset)])
          : Buffer.concat([bytes, Buffer.alloc(512)]));
        output.push(null);
      });
      return output;
    });
    try {
      await expect(readAdmittedConversation(source)).rejects.toThrow(/screening unavailable/i);
      expect(fs.existsSync(log)).toBe(false);
    } finally { mocked.mockRestore(); }
  });

  it('screens separate records in one process without crossing a bounded process limit', async () => {
    const log = path.join(root, 'scanner-events.jsonl');
    scannerProbe(`const fs = require('node:fs');
      fs.readFileSync(0);
      const log = ${JSON.stringify(log)};
      fs.appendFileSync(log, JSON.stringify({ phase: 'start', time: process.hrtime.bigint().toString() }) + '\\n');
      setTimeout(() => {
        fs.appendFileSync(log, JSON.stringify({ phase: 'end', time: process.hrtime.bigint().toString() }) + '\\n');
        process.stdout.write('[]');
      }, 120);`);
    const lines = Array.from({ length: 8 }, (_, index) => JSON.stringify({
      type: 'event_msg', payload: { type: 'user_message', message: `safe record ${index}` },
    }));
    fs.writeFileSync(source, lines.join('\n') + '\n');

    expect(await readAdmittedConversation(source)).toBe(lines.join('\n'));
    const events = fs.readFileSync(log, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { phase: string; time: string })
      .sort((left, right) => Number(BigInt(left.time) - BigInt(right.time)));
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.phase === 'start' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    expect(events).toHaveLength(2);
    expect(active).toBe(0);
    expect(peak).toBe(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('bounds a directory process to 1024 record files', async () => {
    const log = path.join(root, 'batch-counts');
    scannerProbe(`const fs = require('node:fs');
      ${batchProbeReader}
      fs.appendFileSync(${JSON.stringify(log)}, recordsForProbe().length + '\\n');
      process.stdout.write('[]');`);
    const lines = Array.from({ length: 1025 }, (_, index) => JSON.stringify({ message: `safe ${index}` }));
    fs.writeFileSync(source, lines.join('\n') + '\n');
    expect(await readAdmittedConversation(source)).toBe(lines.join('\n'));
    expect(fs.readFileSync(log, 'utf8')).toBe('1024\n1\n');
  });

  it.each(['delete', 'replace', 'chmod', 'diagnostic', 'unknown-finding'])
  ('fails closed after a %s directory scanner result and removes staged records', async mode => {
    const privateTmp = path.join(root, 'scanner-tmp');
    fs.mkdirSync(privateTmp);
    process.env.TMPDIR = privateTmp;
    scannerProbe(`const fs = require('node:fs');
      const path = require('node:path');
      const target = process.argv.at(-1);
      const file = target;
      const mode = ${JSON.stringify(mode)};
      if (mode === 'delete') fs.unlinkSync(file);
      if (mode === 'replace') { const bytes = fs.readFileSync(file); fs.renameSync(file, file + '.old'); fs.writeFileSync(file, bytes); }
      if (mode === 'chmod') fs.chmodSync(file, 0o644);
      if (mode === 'diagnostic') process.stderr.write('private warning');
      process.stdout.write(mode === 'unknown-finding' ? '[{"RuleID":"fixture","File":"foreign.txt"}]' : '[]');
      process.exit(mode === 'unknown-finding' ? 10 : 0);`);
    await expect(readAdmittedConversation(source)).rejects.toThrow(/screening unavailable/i);
    expect(fs.readdirSync(privateTmp)).toEqual([]);
  });

  it.skipIf(!realScannerPath)('keeps real Gitleaks directory screening record-local', async () => {
    const executable = fs.realpathSync(realScannerPath!);
    policy({ executable, sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') });
    const lines = ['Sourcegraph', '0123456789abcdef0123456789abcdef01234567']
      .map(message => JSON.stringify({ type: 'event_msg', payload: { message } }));
    fs.writeFileSync(source, lines.join('\n') + '\n');
    expect(await readAdmittedConversation(source)).toBe(lines.join('\n'));
    fs.writeFileSync(source, transcript(token));
    await expect(readAdmittedConversation(source)).rejects.toThrow(/content rejected by screening/i);
  });

  it('flushes large screened records before the aggregate batch exceeds its byte cap', async () => {
    const log = path.join(root, 'large-scanner-events.jsonl');
    scannerProbe(`const fs = require('node:fs');
      fs.readFileSync(0);
      const log = ${JSON.stringify(log)};
      fs.appendFileSync(log, JSON.stringify({ phase: 'start', time: process.hrtime.bigint().toString() }) + '\\n');
      setTimeout(() => {
        fs.appendFileSync(log, JSON.stringify({ phase: 'end', time: process.hrtime.bigint().toString() }) + '\\n');
        process.stdout.write('[]');
      }, 120);`);
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, max_record_bytes: 8_388_608 });
    const lines = ['a', 'b'].map(letter => JSON.stringify({ message: letter.repeat(4_500_000) }));
    fs.writeFileSync(source, lines.join('\n') + '\n');

    expect((await readAdmittedConversation(source)).length).toBe(lines.join('\n').length);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { phase: string; time: string })
      .sort((left, right) => Number(BigInt(left.time) - BigInt(right.time)));
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.phase === 'start' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    expect(events).toHaveLength(4);
    expect(active).toBe(0);
    expect(peak).toBe(1);
  });

  it('caps scanner processes across concurrent transcript reads in one server', async () => {
    const log = path.join(root, 'shared-scanner-events.jsonl');
    scannerProbe(`const fs = require('node:fs');
      fs.readFileSync(0);
      const log = ${JSON.stringify(log)};
      fs.appendFileSync(log, JSON.stringify({ phase: 'start', time: process.hrtime.bigint().toString() }) + '\\n');
      setTimeout(() => {
        fs.appendFileSync(log, JSON.stringify({ phase: 'end', time: process.hrtime.bigint().toString() }) + '\\n');
        process.stdout.write('[]');
      }, 180);`);
    const lines = Array.from({ length: 8 }, (_, index) => JSON.stringify({ message: `safe ${index}` }));
    fs.writeFileSync(source, lines.join('\n') + '\n');

    const [first, second] = await Promise.all([readAdmittedConversation(source), readAdmittedConversation(source)]);
    expect(first).toBe(lines.join('\n'));
    expect(second).toBe(first);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { phase: string; time: string })
      .sort((left, right) => Number(BigInt(left.time) - BigInt(right.time)));
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.phase === 'start' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    expect(events).toHaveLength(4);
    expect(active).toBe(0);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('reserves capacity for synchronous admission during concurrent transcript reads', async () => {
    const log = path.join(root, 'mixed-scanner-events.jsonl');
    scannerProbe(`const fs = require('node:fs');
      fs.readFileSync(0);
      const log = ${JSON.stringify(log)};
      fs.appendFileSync(log, JSON.stringify({ phase: 'start', time: process.hrtime.bigint().toString() }) + '\\n');
      setTimeout(() => {
        fs.appendFileSync(log, JSON.stringify({ phase: 'end', time: process.hrtime.bigint().toString() }) + '\\n');
        process.stdout.write('[]');
      }, 500);`);
    const lines = Array.from({ length: 8 }, (_, index) => JSON.stringify({ message: `safe ${index}` }));
    fs.writeFileSync(source, lines.join('\n') + '\n');

    const pending = Promise.all(Array.from({ length: 3 }, () => readAdmittedConversation(source)));
    const deadline = performance.now() + 3000;
    while ((!fs.existsSync(log) || fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes('start')).length < 3) &&
      performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(log)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(admitExchange(exchange())).toEqual(exchange());
    expect(await pending).toEqual(Array(3).fill(lines.join('\n')));

    const events = fs.readFileSync(log, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { phase: string; time: string })
      .sort((left, right) => Number(BigInt(left.time) - BigInt(right.time)));
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.phase === 'start' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    expect(events).toHaveLength(12);
    expect(active).toBe(0);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('keeps concurrent screening record-local when separate records form a false match together', async () => {
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { message: 'Sourcegraph' } }),
      JSON.stringify({ type: 'event_msg', payload: { message: '0123456789abcdef0123456789abcdef01234567' } }),
    ];
    fs.writeFileSync(source, lines.join('\n') + '\n');
    await expect(readAdmittedConversation(source)).resolves.toBe(lines.join('\n'));
  });

  it('screens only the first admitted record during harness detection', async () => {
    const log = path.join(root, 'scanner-count');
    scannerProbe(`const fs = require('node:fs');
      fs.readFileSync(0);
      fs.appendFileSync(${JSON.stringify(log)}, 'x');
      process.stdout.write('[]');`);
    const lines = transcript('safe question').trimEnd().split('\n');
    while (lines.length < 20) lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'safe' } }));
    fs.writeFileSync(source, lines.join('\n') + '\n');

    await parseConversation(source, 'fixture', source);
    expect(fs.readFileSync(log, 'utf8').length).toBe(2);
  });

  it('removes a partial derived archive when a later screening batch rejects content', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify({
      type: 'event_msg', payload: { message: index === 17 ? token : `safe record ${index}` },
    }));
    fs.writeFileSync(source, lines.join('\n') + '\n');
    await expect(archiveAdmittedConversation(source, destination)).rejects.toThrow(/content rejected by screening/i);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(path.dirname(destination))).toEqual([]);
  });

  it('streams unscreened records before a later record-admission error', async () => {
    const barePolicy = {
      version: 1, exchanges: [{ session_id: session, transcript: path.basename(source), line_start: 2, line_end: 2 }],
      tool_calls: [],
    };
    fs.writeFileSync(path.join(root, 'record-exclusions.json'), JSON.stringify(barePolicy));
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'safe' } }),
      JSON.stringify({ type: 'session_meta', payload: { id: '11111111-2222-4333-8444-555555555555' } }),
    ];
    fs.writeFileSync(source, lines.join('\n') + '\n');
    const iterator = admittedConversationLines(source);
    expect((await iterator.next()).value).toBe(lines[0]);
    await expect(iterator.next()).rejects.toThrow(/session identity mismatch/i);
  });

  it('checks a stable unscreened policy per stream chunk rather than per record', async () => {
    const policyFile = path.join(root, 'record-exclusions.json');
    fs.writeFileSync(policyFile, JSON.stringify({ version: 1, exchanges: [], tool_calls: [] }));
    const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify({
      type: 'event_msg', payload: { message: `safe record ${index}` },
    }));
    fs.writeFileSync(source, lines.join('\n') + '\n');
    const opened = vi.spyOn(fs, 'openSync');
    try {
      expect(await readAdmittedConversation(source)).toBe(lines.join('\n'));
      const policyOpens = opened.mock.calls.filter(([file]) => file === policyFile).length;
      expect(policyOpens).toBeLessThanOrEqual(6);
    } finally {
      opened.mockRestore();
    }
  });

  it('reuses one validated policy snapshot across many unchanged stream chunks', async () => {
    const policyFile = path.join(root, 'record-exclusions.json');
    fs.writeFileSync(policyFile, JSON.stringify({ version: 1, exchanges: [], tool_calls: [] }));
    const lines = Array.from({ length: 300 }, (_, index) => JSON.stringify({
      type: 'event_msg', payload: { message: `safe ${index} ` + 'x'.repeat(4000) },
    }));
    fs.writeFileSync(source, lines.join('\n') + '\n');
    const opened = vi.spyOn(fs, 'openSync');
    try {
      expect(await readAdmittedConversation(source)).toBe(lines.join('\n'));
      expect(opened.mock.calls.filter(([file]) => file === policyFile).length).toBeLessThanOrEqual(6);
    } finally { opened.mockRestore(); }
  });

  it('rejects a directory batch without publishing its safe neighbors', async () => {
    scannerProbe(`const fs = require('node:fs');
      const path = require('node:path');
      ${batchProbeReader}
      const found = recordsForProbe().find(record => record.text.includes('reject-me'));
      if (found !== undefined) {
        process.stdout.write(JSON.stringify([{ RuleID: 'fixture', File: target ? target + '!' + found.name : '' }])); process.exit(10);
      }
      setInterval(() => {}, 1000);`);
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, timeout_ms: 1000 });
    const lines = Array.from({ length: 16 }, (_, index) => JSON.stringify({
      type: 'event_msg', payload: { message: index === 0 ? 'reject-me' : `safe ${index}` },
    }));
    fs.writeFileSync(source, lines.join('\n') + '\n');
    const start = performance.now();
    await expect(readAdmittedConversation(source)).rejects.toThrow(/content rejected by screening/i);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('screens decoded JSON strings rather than trusting escaped token spelling', async () => {
    fs.writeFileSync(source, transcript(token).replace('ghp_', '\\u0067hp_'));
    await expect(archiveAdmittedConversation(source, destination)).rejects.toThrow(/content rejected by screening/i);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('keeps separate user and assistant records from contaminating keyword screening', () => {
    const x = exchange('Sourcegraph');
    x.assistantMessage = ['01234567', '89abcdef', '01234567', '89abcdef', '01234567'].join('');
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
    const text = JSON.stringify({ api_key: ['rP8v2Ls7', 'Qm4Zx9Nc', '6Tb3Wy5H', 'd1Kf0Aj8'].join('') });
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

  it('terminates concurrently scheduled hung record scanners without exposing input', async () => {
    scannerProbe('require(\'node:fs\').readFileSync(0); setInterval(() => {}, 1000);');
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, timeout_ms: 100 });
    const start = performance.now();
    let message = '';
    try { await readAdmittedConversation(source); } catch (error) { message = String(error); }
    expect(message).toMatch(/screening unavailable/i);
    expect(message).not.toContain('safe question');
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('splits only a timed-out batch into sequential independent halves', async () => {
    const log = path.join(root, 'timeout-recovery-calls');
    const privateTmp = path.join(root, 'timeout-recovery-tmp');
    fs.mkdirSync(privateTmp);
    process.env.TMPDIR = privateTmp;
    scannerProbe(`const fs = require('node:fs');
      ${batchProbeReader}
      const records = recordsForProbe();
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(records.map(record =>
        record.text.match(/recovery record (\\d+)/)[1])) + '\\n');
      if (records.length > 2) setInterval(() => {}, 1000);
      else process.stdout.write('[]');`);
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, timeout_ms: 2000 });
    const lines = Array.from({ length: 4 }, (_, index) => JSON.stringify({ message: `recovery record ${index}` }));
    fs.writeFileSync(source, lines.join('\n') + '\n');

    expect(await readAdmittedConversation(source)).toBe(lines.join('\n'));
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
      .toEqual([['0', '1', '2', '3'], ['0', '1'], ['2', '3']]);
    expect(fs.readdirSync(privateTmp)).toEqual([]);
  });

  it('withholds safe neighbors when a timed-out batch has a rejected recovery half', async () => {
    const log = path.join(root, 'timeout-rejected-calls');
    const privateTmp = path.join(root, 'timeout-rejected-tmp');
    fs.mkdirSync(privateTmp);
    process.env.TMPDIR = privateTmp;
    scannerProbe(`const fs = require('node:fs');
      ${batchProbeReader}
      const records = recordsForProbe();
      fs.appendFileSync(${JSON.stringify(log)}, records.length + '\\n');
      if (records.length > 2) setInterval(() => {}, 1000);
      else {
        const rejected = records.find(record => record.text.includes('reject-me'));
        process.stdout.write(rejected ? JSON.stringify([{ RuleID: 'fixture', File: target + '!' + rejected.name }]) : '[]');
        process.exit(rejected ? 10 : 0);
      }`);
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, timeout_ms: 2000 });
    fs.writeFileSync(source, ['safe zero', 'safe one', 'safe two', 'reject-me']
      .map(message => JSON.stringify({ message })).join('\n') + '\n');
    const visible: string[] = [];

    await expect((async () => {
      for await (const line of admittedConversationLines(source)) visible.push(line);
    })()).rejects.toThrow('Record content rejected by screening');
    expect(visible).toEqual([]);
    expect(fs.readFileSync(log, 'utf8')).toBe('4\n2\n2\n');
    expect(fs.readdirSync(privateTmp)).toEqual([]);
  });

  it.each(['malformed', 'diagnostic', 'malformed-timeout', 'diagnostic-timeout', 'external-kill'])
  ('does not split a batch after a %s scanner failure', async failure => {
    const log = path.join(root, 'timeout-ineligible-calls');
    const privateTmp = path.join(root, 'timeout-ineligible-tmp');
    fs.mkdirSync(privateTmp);
    process.env.TMPDIR = privateTmp;
    scannerProbe(`const fs = require('node:fs');
      ${batchProbeReader}
      fs.appendFileSync(${JSON.stringify(log)}, recordsForProbe().length + '\\n');
      const failure = ${JSON.stringify(failure)};
      if (failure === 'external-kill') process.kill(process.pid, 'SIGKILL');
      else {
        if (failure.startsWith('malformed')) process.stdout.write('{');
        else process.stderr.write('private fixture diagnostic');
        if (failure.endsWith('-timeout')) setInterval(() => {}, 1000);
        else { if (failure === 'diagnostic') process.stdout.write('[]'); process.exit(0); }
      }`);
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, timeout_ms: 2000 });
    fs.writeFileSync(source, ['safe zero', 'safe one'].map(message => JSON.stringify({ message })).join('\n') + '\n');

    await expect(readAdmittedConversation(source)).rejects.toThrow('Record screening unavailable');
    expect(fs.readFileSync(log, 'utf8')).toBe('2\n');
    expect(fs.readdirSync(privateTmp)).toEqual([]);
  });

  it.each([1, 3])('stops at the first hung singleton in a %i-record timeout recovery', async count => {
    const log = path.join(root, 'timeout-hung-calls');
    const privateTmp = path.join(root, 'timeout-hung-tmp');
    fs.mkdirSync(privateTmp);
    process.env.TMPDIR = privateTmp;
    scannerProbe(`const fs = require('node:fs');
      ${batchProbeReader}
      fs.appendFileSync(${JSON.stringify(log)}, recordsForProbe().length + '\\n');
      setInterval(() => {}, 1000);`);
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, timeout_ms: 2000 });
    fs.writeFileSync(source, Array.from({ length: count }, (_, index) => JSON.stringify({ message: `safe ${index}` }))
      .join('\n') + '\n');
    const start = performance.now();

    await expect(readAdmittedConversation(source)).rejects.toThrow('Record screening unavailable');
    expect(fs.readFileSync(log, 'utf8')).toBe(count === 1 ? '1\n' : '3\n1\n');
    expect(performance.now() - start).toBeLessThan(6000);
    expect(fs.readdirSync(privateTmp)).toEqual([]);
  });

  it.each(['archive', 'scanner', 'source', 'policy'])
  ('does not recover a timed-out batch after %s mutation', async mutation => {
    const log = path.join(root, 'timeout-mutated-calls');
    const privateTmp = path.join(root, 'timeout-mutated-tmp');
    fs.mkdirSync(privateTmp);
    process.env.TMPDIR = privateTmp;
    const file = mutation === 'source' ? source : mutation === 'policy' ? path.join(root, 'record-exclusions.json') : null;
    scannerProbe(`const fs = require('node:fs');
      ${batchProbeReader}
      fs.appendFileSync(${JSON.stringify(log)}, recordsForProbe().length + '\\n');
      const mutation = ${JSON.stringify(mutation)};
      fs.appendFileSync(mutation === 'archive' ? target : mutation === 'scanner' ? __filename : ${JSON.stringify(file)}, '\\n');
      setInterval(() => {}, 1000);`);
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'record-exclusions.json'), 'utf8'));
    policy({ ...configured.screening, timeout_ms: 2000 });
    fs.writeFileSync(source, ['safe zero', 'safe one'].map(message => JSON.stringify({ message })).join('\n') + '\n');

    await expect(readAdmittedConversation(source)).rejects.toThrow(mutation === 'source'
      ? 'Conversation changed during record admission' : mutation === 'policy'
        ? 'Record exclusion policy changed during record admission' : 'Record screening unavailable');
    expect(fs.readFileSync(log, 'utf8')).toBe('2\n');
    expect(fs.readdirSync(privateTmp)).toEqual([]);
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
    const privateTmp = path.join(root, 'scanner-tmp');
    fs.mkdirSync(privateTmp);
    process.env.TMPDIR = privateTmp;
    scannerProbe("require('node:fs').appendFileSync(__filename, '\\n// changed'); process.stdout.write('[]');");
    expect(() => admitExchange(exchange())).toThrow(/screening unavailable/i);
    expect(fs.readdirSync(privateTmp)).toEqual([]);
  });
});
