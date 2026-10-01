#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_HOOK_BYTES = 64 * 1024;
const indexCli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index-cli.js');

async function readHookInput() {
  const parts = [];
  let bytes = 0;
  for await (const part of process.stdin) {
    bytes += part.length;
    if (bytes > MAX_HOOK_BYTES) throw new Error('Hook input exceeds byte limit');
    parts.push(part);
  }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hook input');
  return value;
}

async function main() {
  const event = await readHookInput();
  const transcriptPath = event.transcript_path;
  if (transcriptPath == null) {
    process.stdout.write('{}\n');
    return;
  }
  if (typeof transcriptPath !== 'string') throw new Error('Invalid transcript path');
  const maxFileBytes = process.env.EPISODIC_MEMORY_HOOK_MAX_FILE_BYTES;
  if (!maxFileBytes || !/^[1-9]\d*$/.test(maxFileBytes) || !Number.isSafeInteger(Number(maxFileBytes))) {
    throw new Error('A positive exact-index byte budget is required');
  }

  const child = spawn(process.execPath, [indexCli, 'index-path', transcriptPath, '--max-file-bytes', maxFileBytes], {
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => child.kill(signal));
  }
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (status.code !== 0 || status.signal) throw new Error('Exact transcript indexing did not complete');
  process.stdout.write('{}\n');
}

main().catch(() => {
  process.stderr.write('episodic-memory: transcript hook indexing failed\n');
  process.exitCode = 1;
});
