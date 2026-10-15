import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const MARKER = '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>';
/** Text the scanner fixture reports as a finding. */
export const FLAGGED = 'FLAG-ME';
export const zstdAvailable = typeof (zlib as any).zstdCompressSync === 'function';

/** One isolated configuration, source tree, archive and scanner log per test. */
export interface SyncFixture {
  root: string;
  sourceDir: string;
  destDir: string;
  scanLog: string;
}

export function createSyncFixture(prefix: string): SyncFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = root;
  process.env.EPISODIC_MEMORY_DB_PATH = path.join(root, 'test.sqlite');
  return {
    root,
    sourceDir: path.join(root, 'sessions'),
    destDir: path.join(root, 'archive'),
    scanLog: path.join(root, 'scan.log'),
  };
}

// A digest-pinned scanner fixture that logs how many non-empty records each
// invocation screened and reports records containing FLAGGED, like test/record-screening.
function installScanner(fixture: SyncFixture): { executable: string; sha256: string } {
  const executable = path.join(fixture.root, 'scanner-fixture');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const target = process.argv[2] === 'dir' ? process.argv.at(-1) : null;
const records = [];
if (!target) records.push({ name: '', text: fs.readFileSync(0, 'utf8') });
else {
  const bytes = fs.readFileSync(target);
  let offset = 0;
  while (offset + 512 <= bytes.length && bytes[offset] !== 0) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').split('\\0')[0];
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\\0/g, '').trim(), 8);
    records.push({ name, text: bytes.subarray(offset + 512, offset + 512 + size).toString('utf8') });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}
fs.appendFileSync(${JSON.stringify(fixture.scanLog)}, (target ? 'batch ' : 'single ') + records.filter(record => record.text.length > 0).length + '\\n');
const found = records.find(record => record.text.includes(${JSON.stringify(FLAGGED)}));
process.stdout.write(found ? JSON.stringify([{ RuleID: 'fixture', File: target ? target + '!' + found.name : '' }]) : '[]');
process.exit(found ? 10 : 0);
`, { mode: 0o700 });
  const real = fs.realpathSync(executable);
  return { executable: real, sha256: crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex') };
}

export function writePolicy(fixture: SyncFixture, rows: { exchanges?: unknown[]; tool_calls?: unknown[] } = {}): void {
  const { executable, sha256 } = installScanner(fixture);
  fs.writeFileSync(path.join(fixture.root, 'record-exclusions.json'), JSON.stringify({
    version: 1, exchanges: rows.exchanges ?? [], tool_calls: rows.tool_calls ?? [],
    screening: { engine: 'gitleaks', executable, sha256, timeout_ms: 10_000, max_record_bytes: 1_048_576 },
  }), { mode: 0o600 });
}

// Records screened in native batches, which admission, archive parsing and the
// indexing of stored exchange fields use; a direct single-record scan is not counted.
export function screenedRecords(fixture: SyncFixture): number {
  if (!fs.existsSync(fixture.scanLog)) return 0;
  return fs.readFileSync(fixture.scanLog, 'utf8').split('\n').filter(line => line.startsWith('batch '))
    .reduce((sum, line) => sum + Number(line.slice('batch '.length)), 0);
}

export function codexLines(session: string, turns: number, from = 1, answer = 'answer'): string {
  const lines: string[] = [];
  if (from === 1) lines.push(JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: '/synthetic' } }));
  for (let turn = from; turn < from + turns; turn++) {
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: `question ${turn}` }] } }));
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: `${answer} ${turn}` }] } }));
  }
  return lines.join('\n') + '\n';
}

export function session(n: number): string {
  return `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export function rollout(dir: string, n: number, content: string, when?: Date, compressed = false): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-15T10-00-0${n}-${session(n)}.jsonl${compressed ? '.zst' : ''}`);
  fs.writeFileSync(file, compressed ? (zlib as any).zstdCompressSync(Buffer.from(content)) : content);
  if (when) fs.utimesSync(file, when, when);
  return file;
}

export function ago(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

export function bump(file: string, seconds = 5): void {
  const future = new Date(Date.now() + seconds * 1000);
  fs.utimesSync(file, future, future);
}

/** Write an archive copy the way admission stamps it, without screening its records. */
export function stampedCopy(source: string, archive: string): void {
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.copyFileSync(source, archive);
  const stamp = Math.ceil(fs.statSync(source).mtimeMs) / 1000;
  fs.utimesSync(archive, stamp, stamp);
}
