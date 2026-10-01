import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConversation } from '../src/parser.js';

const session = '00000000-1111-4222-8333-444444444444';
let root: string;
let source: string;
let policyFile: string;
let previousConfig: string | undefined;

function transcript(): string {
  return [
    { type: 'session_meta', payload: { id: session, cwd: '/synthetic/project' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:00Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'safe question' }] } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:01Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'safe answer' }] } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n';
}

beforeEach(() => {
  previousConfig = process.env.EPISODIC_MEMORY_CONFIG_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-admission-context-'));
  process.env.EPISODIC_MEMORY_CONFIG_DIR = root;
  source = path.join(root, `rollout-${session}.jsonl`);
  policyFile = path.join(root, 'record-exclusions.json');
  fs.writeFileSync(source, transcript());
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousConfig === undefined) delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
  else process.env.EPISODIC_MEMORY_CONFIG_DIR = previousConfig;
  fs.rmSync(root, { recursive: true, force: true });
  expect(fs.existsSync(root)).toBe(false);
});

describe('one pinned admission context per parse', () => {
  it('opens the transcript once and reads one whole-file marker preflight', async () => {
    const open = fs.openSync;
    const read = fs.readSync;
    const descriptors = new Set<number>();
    let inputOpens = 0;
    let markerBytes = 0;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
      const fd = (open as any)(file, ...args);
      if (file === source) { descriptors.add(fd); inputOpens++; }
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...args: any[]) => {
      const count = (read as any)(fd, ...args);
      if (descriptors.has(fd)) markerBytes += count;
      return count;
    }) as typeof fs.readSync);

    const exchanges = await parseConversation(source, 'fixture', source);

    expect(exchanges).toMatchObject([{ userMessage: 'safe question', assistantMessage: 'safe answer',
      lineStart: 2, lineEnd: 3, harness: 'codex', sessionId: session }]);
    expect(inputOpens).toBe(1);
    expect(markerBytes).toBe(Buffer.byteLength(transcript()));
    for (const fd of descriptors) expect(() => fs.fstatSync(fd)).toThrow();
  });

  it('rewinds detection noise without dropping Cursor messages or physical coordinates', async () => {
    const rows = [
      '',
      '{invalid json',
      JSON.stringify({ type: 'status', role: 'user', timestamp: '2026-01-01T00:00:00Z',
        message: { content: 'prelude question' } }),
      JSON.stringify({ role: 'assistant', timestamp: '2026-01-01T00:00:01Z',
        message: { content: 'prelude answer' } }),
    ];
    const bytes = rows.join('\r\n');
    fs.writeFileSync(source, bytes);

    const exchanges = await parseConversation(source, 'fixture', source);

    expect(exchanges).toMatchObject([{ userMessage: 'prelude question', assistantMessage: 'prelude answer',
      lineStart: 3, lineEnd: 4, harness: 'cursor' }]);
    expect(fs.readFileSync(source, 'utf8')).toBe(bytes);
  });

  it('retains physical lines after a detection prefix longer than the screening batch', async () => {
    fs.writeFileSync(source, '\n'.repeat(1100) + transcript());

    const exchanges = await parseConversation(source, 'fixture', source);

    expect(exchanges).toMatchObject([{ userMessage: 'safe question', assistantMessage: 'safe answer',
      lineStart: 1102, lineEnd: 1103, harness: 'codex' }]);
  });

  it.each(['replace', 'rewrite', 'append'] as const)
  ('rejects a source %s between detection and parsing rather than reopening it', async mutation => {
    const create = fs.createReadStream;
    let cursors = 0;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((file: any, options: any) => {
      const stream = create(file, options);
      if (file === source && ++cursors === 1) {
        stream.once('close', () => {
          if (mutation === 'replace') {
            fs.renameSync(source, source + '.previous');
            fs.writeFileSync(source, transcript());
          } else if (mutation === 'rewrite') {
            fs.writeFileSync(source, transcript().replace('safe question', 'changed question'));
          } else {
            fs.appendFileSync(source, JSON.stringify({ type: 'event_msg', payload: { message: 'new record' } }) + '\n');
          }
        });
      }
      return stream;
    }) as typeof fs.createReadStream);

    await expect(parseConversation(source, 'fixture', source)).rejects.toThrow(/changed during record admission/);
  });

  it.each(['replace', 'appear', 'disappear'] as const)
  ('rejects a policy %s between detection and parsing instead of accepting a new snapshot', async mutation => {
    const policy = JSON.stringify({ version: 1, exchanges: [], tool_calls: [] });
    if (mutation !== 'appear') fs.writeFileSync(policyFile, policy);
    const create = fs.createReadStream;
    let cursors = 0;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((file: any, options: any) => {
      const stream = create(file, options);
      if (file === source && ++cursors === 1) {
        stream.once('close', () => {
          if (mutation === 'replace') {
            fs.renameSync(policyFile, policyFile + '.previous');
            fs.writeFileSync(policyFile, policy);
          } else if (mutation === 'appear') fs.writeFileSync(policyFile, policy);
          else fs.unlinkSync(policyFile);
        });
      }
      return stream;
    }) as typeof fs.createReadStream);

    await expect(parseConversation(source, 'fixture', source)).rejects.toThrow(/policy changed during record admission/);
  });

  it('honors a decoded whole-file opt-out at EOF before starting either cursor', async () => {
    const marker = '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>';
    fs.appendFileSync(source, JSON.stringify({ type: 'event_msg',
      payload: { type: 'user_message', message: marker } }));
    const create = vi.spyOn(fs, 'createReadStream');

    expect(await parseConversation(source, 'fixture', source)).toEqual([]);
    expect(create.mock.calls.filter(([file]) => file === source)).toHaveLength(0);
  });
});
