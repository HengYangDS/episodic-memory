import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { getSuperpowersDir } from './paths.js';
const EXCLUSION_MARKERS = [
    '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
    'Only use NO_INSIGHTS_FOUND',
    SUMMARIZER_CONTEXT_MARKER,
];
const MARKER_SCAN_CHUNK_BYTES = 1 << 20; // 1 MiB
const SCREENING_BATCH_RECORDS = 1024;
const SCREENING_BATCH_BYTES = 8 * 1024 * 1024;
const SCREENING_PARALLELISM = 4;
// spawnSync blocks the event loop, so at most one synchronous scanner can run
// in this process. Keep one slot for it while async scans use the other slots.
const ASYNC_SCREENING_PARALLELISM = SCREENING_PARALLELISM - 1;
const SCANNER_OUTPUT_LIMIT = 1_048_576;
let availableScannerSlots = ASYNC_SCREENING_PARALLELISM;
const scannerWaiters = [];
function releaseScannerSlot() {
    const waiter = scannerWaiters.shift();
    if (waiter) {
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.resolve(releaseScannerSlot);
    }
    else {
        availableScannerSlots++;
    }
}
function acquireScannerSlot(signal) {
    if (signal.aborted)
        return Promise.reject(new Error('Record screening unavailable'));
    if (availableScannerSlots > 0 && scannerWaiters.length === 0) {
        availableScannerSlots--;
        return Promise.resolve(releaseScannerSlot);
    }
    return new Promise((resolve, reject) => {
        const waiter = {
            resolve, reject, signal,
            abort: () => {
                const index = scannerWaiters.indexOf(waiter);
                if (index >= 0)
                    scannerWaiters.splice(index, 1);
                reject(new Error('Record screening unavailable'));
            },
        };
        scannerWaiters.push(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
    });
}
/** Scan decoded instruction records without retaining the whole transcript. */
export function shouldSkipConversation(filePath) {
    // A compressed transcript's raw bytes cannot carry a readable marker, so this
    // synchronous scan fails closed; use conversationHasExclusionMarker instead.
    if (isCompressedConversation(filePath))
        return true;
    let fd;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const initial = fs.fstatSync(fd);
        const excluded = descriptorHasExclusionMarker(fd);
        assertUnchangedInput(filePath, initial);
        return excluded;
    }
    catch {
        return true;
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
/** Codex archives finished rollouts as zstd-compressed JSONL. */
export function isCompressedConversation(file) {
    return file.endsWith('.jsonl.zst');
}
/** Exclusions and archives name a compressed rollout by its uncompressed transcript. */
export function conversationTranscriptName(file) {
    return path.basename(file).replace(/\.zst$/, '');
}
/** Read a transcript's bytes, decompressed for a compressed rollout, from a pinned descriptor. */
function conversationByteStream(file, fd, compressed, start = 0, end = Infinity) {
    // autoClose with a no-op close emits 'close' without closing the caller's descriptor.
    const raw = fs.createReadStream(file, {
        fd, autoClose: true, start, ...(end === Infinity ? {} : { end: end - 1 }), highWaterMark: MARKER_SCAN_CHUNK_BYTES,
        fs: { read: fs.read, close: (_fd, done) => done(null) },
    });
    const rawClosed = new Promise(resolve => raw.once('close', () => resolve()));
    if (!compressed)
        return { stream: raw, close: async () => { raw.destroy(); await rawClosed; } };
    const create = zlib.createZstdDecompress;
    if (!create) {
        raw.destroy();
        throw new Error('Compressed conversations require Node.js zstd support');
    }
    const output = create();
    raw.on('error', error => output.destroy(error));
    raw.pipe(output);
    return { stream: output, close: async () => { output.destroy(); raw.destroy(); await rawClosed; } };
}
/** Same fail-closed marker scan as shouldSkipConversation, for compressed transcripts too. */
export async function conversationHasExclusionMarker(file) {
    if (!isCompressedConversation(file))
        return shouldSkipConversation(file);
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const initial = fs.fstatSync(fd);
        if (!initial.isFile())
            return true;
        const excluded = await decompressedHasExclusionMarker(file, fd);
        assertUnchangedInput(file, initial);
        return excluded;
    }
    catch {
        return true;
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
/** Decoded physical lines of a plain or compressed transcript, without retaining the whole file. */
export async function* conversationLines(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let reader;
    try {
        reader = conversationByteStream(file, fd, isCompressedConversation(file));
        const decoder = new TextDecoder('utf-8');
        let pending = Buffer.alloc(0);
        for await (const chunk of reader.stream) {
            pending = Buffer.concat([pending, chunk]);
            let from = 0;
            let newline;
            while ((newline = pending.indexOf(10, from)) !== -1) {
                yield decoder.decode(pending.subarray(from, newline));
                from = newline + 1;
            }
            pending = pending.subarray(from);
            if (pending.length > 64 * 1024 * 1024)
                throw new Error('Conversation record exceeds admission byte limit');
        }
        if (pending.length)
            yield decoder.decode(pending);
    }
    finally {
        await reader?.close();
        fs.closeSync(fd);
    }
}
async function decompressedHasExclusionMarker(file, fd) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = Buffer.alloc(0);
    const reader = conversationByteStream(file, fd, true);
    try {
        for await (const chunk of reader.stream) {
            pending = Buffer.concat([pending, chunk]);
            let newline;
            while ((newline = pending.indexOf(10)) !== -1) {
                if (lineHasExclusionMarker(decoder.decode(pending.subarray(0, newline))))
                    return true;
                pending = pending.subarray(newline + 1);
            }
            if (pending.length > 64 * 1024 * 1024)
                throw new Error('Conversation record exceeds admission byte limit');
        }
        return pending.length > 0 && lineHasExclusionMarker(decoder.decode(pending));
    }
    finally {
        await reader.close();
    }
}
function lineHasExclusionMarker(line) {
    let text;
    try {
        text = instructionText(JSON.parse(line));
    }
    catch {
        text = line;
    } // Preserve conservative handling of legacy raw transcripts.
    return EXCLUSION_MARKERS.some(marker => text.includes(marker));
}
function instructionText(record) {
    if (!object(record))
        return '';
    // Codex records both the response item and its user-message event.
    if (record.type === 'event_msg' && object(record.payload)) {
        return record.payload.type === 'user_message' && typeof record.payload.message === 'string'
            ? record.payload.message : '';
    }
    const message = record.type === 'response_item' ? record.payload : record.message;
    if (!object(message) || (message.role ?? record.role) !== 'user')
        return '';
    const content = record.type === 'opencode_message' ? record.parts : message.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    // Claude tool results are wrapped in a user envelope, but are not instructions.
    return content.filter(part => object(part) && ['text', 'input_text'].includes(String(part.type))
        && typeof part.text === 'string').map(part => part.text).join('\n');
}
function descriptorHasExclusionMarker(fd, byteLimit = Infinity, digest, start = 0) {
    if (!fs.fstatSync(fd).isFile())
        throw new Error('Conversation input must be a regular file');
    const buffer = Buffer.allocUnsafe(MARKER_SCAN_CHUNK_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = Buffer.alloc(0);
    let position = start;
    const excluded = (bytes) => lineHasExclusionMarker(decoder.decode(bytes));
    let count;
    while (position < byteLimit && (count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, byteLimit - position), position)) > 0) {
        position += count;
        digest?.update(buffer.subarray(0, count));
        pending = Buffer.concat([pending, buffer.subarray(0, count)]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1) {
            if (newline > 64 * 1024 * 1024)
                throw new Error('Conversation record exceeds admission byte limit');
            if (excluded(pending.subarray(0, newline)))
                return true;
            pending = pending.subarray(newline + 1);
        }
        if (pending.length > 64 * 1024 * 1024)
            throw new Error('Conversation record exceeds admission byte limit');
    }
    if (position < byteLimit && byteLimit !== Infinity)
        throw new Error('Conversation changed during record admission');
    return pending.length > 0 && excluded(pending);
}
function assertUnchangedInput(file, initial) {
    const current = fs.lstatSync(file);
    if (!current.isFile() || initial.dev !== current.dev || initial.ino !== current.ino ||
        initial.size !== current.size || initial.mtimeMs !== current.mtimeMs || initial.ctimeMs !== current.ctimeMs) {
        throw new Error('Conversation changed during record admission');
    }
}
/** A live transcript may grow while it is admitted; its admitted bytes must not change. */
function assertGrownInput(file, initial, end) {
    const current = fs.lstatSync(file);
    if (!current.isFile() || initial.dev !== current.dev || initial.ino !== current.ino || current.size < end) {
        throw new Error('Conversation changed during record admission');
    }
}
/** Appends cannot be told from rewrites by metadata, so re-read the admitted byte range. */
function assertUnchangedRange(fd, start, end, expected) {
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(MARKER_SCAN_CHUNK_BYTES);
    let position = start;
    let count;
    while (position < end && (count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position)) > 0) {
        digest.update(buffer.subarray(0, count));
        position += count;
    }
    if (position !== end || digest.digest('hex') !== expected)
        throw new Error('Conversation changed during record admission');
}
function assertUnchangedSearchPrefix(file, initial, expectedDigest) {
    // A live transcript may grow after the search snapshot. Rehash the pinned
    // prefix only when metadata changes, so appended bytes cannot hide a rewrite.
    const changed = () => new Error('Conversation changed during record admission');
    let current;
    try {
        current = fs.lstatSync(file);
    }
    catch {
        throw changed();
    }
    if (!current.isFile() || initial.dev !== current.dev || initial.ino !== current.ino || current.size < initial.size) {
        throw changed();
    }
    if (current.size === initial.size && current.mtimeMs === initial.mtimeMs && current.ctimeMs === initial.ctimeMs)
        return;
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size < initial.size)
            throw changed();
        const digest = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(MARKER_SCAN_CHUNK_BYTES);
        let position = 0;
        while (position < initial.size) {
            const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - position), position);
            if (count <= 0)
                throw changed();
            digest.update(buffer.subarray(0, count));
            position += count;
        }
        if (digest.digest('hex') !== expectedDigest)
            throw changed();
        current = fs.lstatSync(file);
        if (!current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino || current.size < initial.size)
            throw changed();
    }
    catch {
        throw changed();
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
function policyGuard(expected) {
    const file = path.join(getSuperpowersDir(), 'record-exclusions.json');
    const changed = () => new Error('Record exclusion policy changed during record admission');
    let identity;
    try {
        identity = fs.lstatSync(file);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw changed();
    }
    if (JSON.stringify(readRecordExclusions()) !== expected)
        throw changed();
    const guard = () => {
        let current;
        try {
            current = fs.lstatSync(file);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw changed();
        }
        if (!identity && !current)
            return;
        if (!identity || !current || !current.isFile() || current.isSymbolicLink() ||
            identity.dev !== current.dev || identity.ino !== current.ino || identity.size !== current.size ||
            identity.mtimeMs !== current.mtimeMs || identity.ctimeMs !== current.ctimeMs ||
            identity.uid !== current.uid || identity.mode !== current.mode)
            throw changed();
    };
    guard();
    return guard;
}
function assertUnchangedPolicy(expected) {
    policyGuard(expected)();
}
function prepareArchiveParent(directory) {
    try {
        const info = fs.lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error('Archive parent must be a non-symlink directory');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        const parent = path.dirname(directory);
        if (parent === directory)
            throw error;
        prepareArchiveParent(parent);
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    return fs.realpathSync(directory);
}
const POLICY_ERROR = 'Invalid or unreadable record exclusion policy';
const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/ig;
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value, expected) {
    return Object.keys(value).length === expected.length && expected.every(key => key in value);
}
function transcriptName(value) {
    return identity(value) && !/[\\/]/.test(value) && value.endsWith('.jsonl') && value !== '.jsonl';
}
function identity(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
}
/** Keep scanner inputs local to one record, including JSON-escaped text. */
function screeningText(value, depth = 0) {
    if (depth > 24)
        throw new Error('Record screening nesting limit exceeded');
    if (typeof value === 'string') {
        let decoded;
        try {
            decoded = JSON.parse(value);
        }
        catch {
            return value;
        }
        if (typeof decoded === 'string' || object(decoded) || Array.isArray(decoded)) {
            return screeningText(decoded, depth + 1);
        }
        return value;
    }
    if (Array.isArray(value))
        return value.map(item => screeningText(item, depth + 1)).join('\n');
    if (object(value)) {
        // Generic credential rules need an assignment delimiter, not just a nearby
        // keyword. Decode nested text without destroying its key/value relation.
        return Object.entries(value).map(([key, item]) => `${key} = ${screeningText(item, depth + 1)}`).join('\n');
    }
    return value == null ? '' : String(value);
}
/** Package independent record members with the existing locked TAR library. */
async function packScreeningRecords(inputs) {
    const tar = createRequire(import.meta.url)('tar-stream');
    const names = inputs.map((_, index) => `${index.toString().padStart(8, '0')}.txt`);
    const maximumBytes = SCREENING_BATCH_BYTES + SCREENING_BATCH_RECORDS * 1024 + 1024;
    const pack = tar.pack();
    const chunks = [];
    let total = 0;
    const packed = new Promise((resolve, reject) => {
        pack.on('data', (chunk) => {
            total += chunk.length;
            if (total > maximumBytes)
                pack.destroy(new Error('Record screening byte limit exceeded'));
            else
                chunks.push(chunk);
        });
        pack.on('error', reject);
        pack.on('end', () => resolve(Buffer.concat(chunks)));
    });
    for (let index = 0; index < inputs.length; index++) {
        const data = Buffer.from(inputs[index]);
        pack.entry({ name: names[index], size: data.length, type: 'file', mode: 0o600,
            uid: 0, gid: 0, mtime: new Date(0) }, data);
    }
    pack.finalize();
    const bytes = await packed;
    // The JS extractor skips zero headers; the native scanner stops at the first
    // TAR end marker. Require canonical framing as well as decoded member data.
    let offset = 0;
    for (let index = 0; index < inputs.length; index++) {
        const header = bytes.subarray(offset, offset + 512);
        const name = Buffer.alloc(100);
        name.write(names[index]);
        if (header.length !== 512 || !header.subarray(0, 100).equals(name) ||
            header[156] !== 48 || !header.subarray(157, 257).equals(Buffer.alloc(100)) ||
            !header.subarray(345, 500).equals(Buffer.alloc(155))) {
            throw new Error('Record screening unavailable');
        }
        offset += 512 + Math.ceil(Buffer.byteLength(inputs[index]) / 512) * 512;
    }
    if (bytes.length !== offset + 1024 || !bytes.subarray(offset).equals(Buffer.alloc(1024))) {
        throw new Error('Record screening unavailable');
    }
    // Validate the complete serialized container before the native scanner sees
    // it. An early TAR terminator must not turn omitted records into clean input.
    const extract = tar.extract();
    let index = 0;
    await new Promise((resolve, reject) => {
        extract.on('entry', (header, stream, next) => {
            const expected = inputs[index];
            if (expected === undefined || header.name !== names[index] || header.type !== 'file' ||
                header.mode !== 0o600 || header.size !== Buffer.byteLength(expected)) {
                stream.resume();
                extract.destroy(new Error('Record screening unavailable'));
                return;
            }
            const data = [];
            stream.on('data', (chunk) => data.push(chunk));
            stream.on('error', reject);
            stream.on('end', () => {
                if (!Buffer.concat(data).equals(Buffer.from(expected))) {
                    extract.destroy(new Error('Record screening unavailable'));
                    return;
                }
                index++;
                next();
            });
        });
        extract.on('error', reject);
        extract.on('finish', () => {
            if (index !== inputs.length)
                reject(new Error('Record screening unavailable'));
            else
                resolve();
        });
        extract.end(bytes);
    });
    return { bytes, names };
}
/** One pinned, short-lived local scanner context; no secret-bearing cache. */
function createRecordScreener(policy, checkAdmission = () => { }) {
    const config = policy?.screening;
    if (!config)
        return { scan() { }, async scanMany() { }, close() { } };
    const unavailable = () => new Error('Record screening unavailable');
    let initial;
    let fd;
    try {
        if (fs.realpathSync(config.executable) !== config.executable)
            throw unavailable();
        fd = fs.openSync(config.executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        initial = fs.fstatSync(fd);
        if (!initial.isFile() || initial.size < 1 || initial.size > 134_217_728 ||
            (initial.mode & 0o022) !== 0 ||
            (typeof process.getuid === 'function' && initial.uid !== 0 && initial.uid !== process.getuid())) {
            throw unavailable();
        }
        fs.accessSync(config.executable, fs.constants.X_OK);
        const digest = crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
        if (digest !== config.sha256)
            throw unavailable();
    }
    catch {
        throw unavailable();
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
    let directory;
    try {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-screen-'));
        fs.chmodSync(directory, 0o700);
    }
    catch {
        throw unavailable();
    }
    const unchanged = () => {
        try {
            const current = fs.lstatSync(config.executable);
            if (!current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino ||
                current.size !== initial.size || current.mtimeMs !== initial.mtimeMs ||
                current.ctimeMs !== initial.ctimeMs)
                throw unavailable();
        }
        catch {
            throw unavailable();
        }
    };
    const args = [
        'stdin', '--redact', '--no-banner', '--log-level', 'error',
        '--ignore-gitleaks-allow', '--exit-code', '10', '--report-format', 'json', '--report-path', '-',
    ];
    const environment = {
        HOME: directory, USERPROFILE: directory, PATH: path.dirname(config.executable), GOMAXPROCS: '1',
    };
    const prepare = (value) => {
        const raw = typeof value === 'string' ? value : JSON.stringify(value);
        if (raw === undefined)
            return null;
        if (Buffer.byteLength(raw) > config.max_record_bytes)
            throw new Error('Record screening byte limit exceeded');
        const input = screeningText(value);
        if (Buffer.byteLength(input) > config.max_record_bytes)
            throw new Error('Record screening byte limit exceeded');
        return input.trim() ? input : null;
    };
    const validate = (status, signal, stdout, failed, files) => {
        if (failed || signal || ![0, 10].includes(status ?? -1))
            throw unavailable();
        let report;
        try {
            report = JSON.parse(stdout);
        }
        catch {
            throw unavailable();
        }
        if (!Array.isArray(report) || (status === 0 && report.length !== 0) ||
            (status === 10 && (report.length === 0 || !report.every(item => object(item) && typeof item.RuleID === 'string')))) {
            throw unavailable();
        }
        if (files && report.some(item => !object(item) || typeof item.File !== 'string' || !files.has(item.File))) {
            throw unavailable();
        }
        if (status === 10)
            throw new Error('Record content rejected by screening');
    };
    const scanInput = (input) => {
        unchanged();
        const result = spawnSync(config.executable, args, {
            input, encoding: 'utf8', cwd: directory, shell: false, env: environment,
            timeout: config.timeout_ms, killSignal: 'SIGKILL', maxBuffer: SCANNER_OUTPUT_LIMIT,
            windowsHide: true,
        });
        unchanged();
        validate(result.status, result.signal, result.stdout, !!result.error);
    };
    const scanInputAsync = async (inputs, signal) => {
        checkAdmission();
        const { bytes, names } = await packScreeningRecords(inputs);
        checkAdmission();
        const archive = path.join(directory, 'batch.tar');
        fs.writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' });
        const initialArchive = fs.lstatSync(archive);
        return new Promise((resolve, reject) => {
            const assertRecords = () => {
                try {
                    const current = fs.lstatSync(archive);
                    const initial = initialArchive;
                    if (fs.readdirSync(directory).join('\n') !== 'batch.tar' || !current.isFile() ||
                        current.isSymbolicLink() || (current.mode & 0o777) !== 0o600 ||
                        current.uid !== initial.uid || current.gid !== initial.gid ||
                        current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size ||
                        current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs ||
                        !fs.readFileSync(archive).equals(bytes))
                        throw unavailable();
                }
                catch {
                    throw unavailable();
                }
            };
            assertRecords();
            unchanged();
            const directoryArgs = ['dir', ...args.slice(1), '--max-archive-depth', '1', 'batch.tar'];
            directoryArgs[directoryArgs.indexOf('--log-level') + 1] = 'warn';
            const child = spawn(config.executable, directoryArgs, {
                cwd: directory, shell: false, env: environment,
                killSignal: 'SIGKILL', signal, windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let failed = false;
            let timerKilled = false;
            const deadline = setTimeout(() => {
                if (!failed && !signal.aborted && child.exitCode === null && child.signalCode === null) {
                    timerKilled = child.kill('SIGKILL');
                }
            }, config.timeout_ms);
            child.once('exit', () => clearTimeout(deadline));
            child.stdout.on('data', (chunk) => {
                stdoutBytes += chunk.length;
                if (stdoutBytes > SCANNER_OUTPUT_LIMIT) {
                    failed = true;
                    child.kill('SIGKILL');
                }
                else {
                    stdout += chunk.toString('utf8');
                }
            });
            child.stderr.on('data', (chunk) => {
                stderrBytes += chunk.length;
                if (stderrBytes > SCANNER_OUTPUT_LIMIT) {
                    failed = true;
                    child.kill('SIGKILL');
                }
            });
            child.stdin.on('error', () => { failed = true; child.kill('SIGKILL'); });
            child.on('error', () => { failed = true; });
            child.on('close', (status, closedSignal) => {
                clearTimeout(deadline);
                try {
                    unchanged();
                    assertRecords();
                    checkAdmission();
                    if (timerKilled && closedSignal === 'SIGKILL' && !failed && !signal.aborted &&
                        stdoutBytes === 0 && stderrBytes === 0) {
                        reject(scannerTimeout);
                        return;
                    }
                    // The native directory walker can skip a failed input with a warning.
                    // A clean report with diagnostics is not a complete clean batch.
                    if (status === 0 && stderrBytes !== 0)
                        throw unavailable();
                    validate(status, closedSignal, stdout, failed, new Set(names.map(name => `batch.tar!${name}`)));
                    resolve();
                }
                catch (error) {
                    reject(error);
                }
                finally {
                    fs.rmSync(archive, { force: true });
                }
            });
            child.stdin.end();
        });
    };
    const scannerTimeout = Symbol('scanner timeout');
    const scanWithTimeoutRecovery = async (inputs, signal) => {
        try {
            await scanInputAsync(inputs, signal);
        }
        catch (error) {
            if (error !== scannerTimeout)
                throw error;
            if (inputs.length < 2)
                throw unavailable();
            // A smaller container changes the timed-out work, not record boundaries.
            // Both halves stay inside the caller's slot and must pass independently.
            const midpoint = Math.floor(inputs.length / 2);
            await scanWithTimeoutRecovery(inputs.slice(0, midpoint), signal);
            await scanWithTimeoutRecovery(inputs.slice(midpoint), signal);
        }
    };
    return {
        scan(value) {
            const input = prepare(value);
            if (input !== null)
                scanInput(input);
        },
        async scanMany(values) {
            const inputs = values.map(prepare).filter((input) => input !== null);
            const cancellation = new AbortController();
            let batch = [];
            let bytes = 0;
            const flush = async () => {
                if (batch.length === 0)
                    return;
                const release = await acquireScannerSlot(cancellation.signal);
                try {
                    await scanWithTimeoutRecovery(batch, cancellation.signal);
                }
                finally {
                    release();
                }
                batch = [];
                bytes = 0;
            };
            for (const input of inputs) {
                const size = Buffer.byteLength(input);
                if (batch.length > 0 && (bytes + size > SCREENING_BATCH_BYTES || batch.length === SCREENING_BATCH_RECORDS)) {
                    await flush();
                }
                batch.push(input);
                bytes += size;
            }
            await flush();
        },
        close() { fs.rmSync(directory, { recursive: true, force: true }); },
    };
}
export function readRecordExclusions() {
    const file = path.join(getSuperpowersDir(), 'record-exclusions.json');
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > 4 * 1024 * 1024)
            throw new Error(POLICY_ERROR);
        const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (!object(value) || !keys(value, 'screening' in value
            ? ['version', 'exchanges', 'tool_calls', 'screening'] : ['version', 'exchanges', 'tool_calls']) || value.version !== 1 ||
            !Array.isArray(value.exchanges) || !Array.isArray(value.tool_calls))
            throw new Error(POLICY_ERROR);
        if ('screening' in value) {
            const s = value.screening;
            if (!object(s) || !keys(s, ['engine', 'executable', 'sha256', 'timeout_ms', 'max_record_bytes']) ||
                s.engine !== 'gitleaks' || typeof s.executable !== 'string' || !path.isAbsolute(s.executable) ||
                /[\x00-\x1f]/.test(s.executable) || typeof s.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.sha256) ||
                !Number.isSafeInteger(s.timeout_ms) || Number(s.timeout_ms) < 50 || Number(s.timeout_ms) > 30_000 ||
                !Number.isSafeInteger(s.max_record_bytes) || Number(s.max_record_bytes) < 1 || Number(s.max_record_bytes) > 8_388_608) {
                throw new Error(POLICY_ERROR);
            }
        }
        for (const row of value.exchanges) {
            if (!object(row) || !keys(row, ['session_id', 'transcript', 'line_start', 'line_end']) || !identity(row.session_id) || !transcriptName(row.transcript) ||
                !Number.isSafeInteger(row.line_start) || !Number.isSafeInteger(row.line_end) ||
                row.line_start < 1 || row.line_end < row.line_start)
                throw new Error(POLICY_ERROR);
        }
        for (const row of value.tool_calls) {
            if (!object(row) || !keys(row, ['session_id', 'transcript', 'call_id']) || !identity(row.session_id) || !transcriptName(row.transcript) || !identity(row.call_id))
                throw new Error(POLICY_ERROR);
        }
        return value;
    }
    catch (error) {
        if (fd === undefined && error.code === 'ENOENT')
            return null;
        throw new Error(POLICY_ERROR);
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
export function excludedSession(policy, sessionId) {
    return !!sessionId && !!policy && (policy.exchanges.some(x => x.session_id === sessionId) ||
        policy.tool_calls.some(x => x.session_id === sessionId));
}
function sessionFromPath(file) {
    return path.basename(file).match(UUID)?.at(-1);
}
function sessionFromRecord(value) {
    if (value?.type === 'session_meta')
        return value.payload?.id;
    if (value?.type === 'session')
        return value.id;
    if (value?.type === 'opencode_session')
        return value.session?.id;
    return value?.sessionId ?? value?.sessionID ?? value?.message?.sessionID;
}
function blockedCall(policy, sessionId, transcript, callId) {
    return typeof callId === 'string' && policy.tool_calls.some(x => x.session_id === sessionId && x.transcript === transcript && x.call_id === callId);
}
function filterRecord(line, number, policy, transcript, sessionId) {
    if (!policy || !sessionId)
        return line;
    if (policy.exchanges.some(x => x.session_id === sessionId && x.transcript === transcript && number >= x.line_start && number <= x.line_end))
        return '';
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        return line;
    }
    if (blockedCall(policy, sessionId, transcript, value?.payload?.call_id) || blockedCall(policy, sessionId, transcript, value?.call_id))
        return '';
    // Claude and Cursor may combine safe text and tool payloads in one physical record.
    // Preserve the record and safe blocks rather than excluding the entire exchange.
    const content = value?.message?.content;
    if (Array.isArray(content)) {
        const kept = content.filter(block => !blockedCall(policy, sessionId, transcript, block?.id ?? block?.tool_use_id));
        if (kept.length !== content.length) {
            return JSON.stringify({ ...value, message: { ...value.message, content: kept } });
        }
    }
    if (Array.isArray(value?.parts)) {
        const kept = value.parts.filter((part) => !blockedCall(policy, sessionId, transcript, part?.callID ?? part?.id));
        if (kept.length !== value.parts.length)
            return JSON.stringify({ ...value, parts: kept });
    }
    return line;
}
function observeRecordIdentity(line, identity, policy) {
    if (identity.identitySeen)
        return;
    let recordSession;
    try {
        recordSession = sessionFromRecord(JSON.parse(line));
    }
    catch { /* Parser owns malformed records. */ }
    if (!recordSession)
        return;
    if (identity.sessionId && recordSession !== identity.sessionId &&
        (excludedSession(policy, identity.sessionId) || excludedSession(policy, recordSession))) {
        throw new Error('Record exclusion session identity mismatch');
    }
    identity.sessionId = recordSession;
    identity.identitySeen = true;
}
/** Own one marker preflight, descriptor, policy and scanner across sequential cursors. */
function openRecordAdmission(file, policy, options = {}) {
    const compressed = isCompressedConversation(file);
    if (compressed && (options.resume || options.snapshot))
        throw new Error('Compressed conversations are admitted whole');
    const transcript = conversationTranscriptName(file);
    const start = options.resume?.offset ?? 0;
    const policySnapshot = JSON.stringify(policy);
    const checkPolicy = policyGuard(policySnapshot);
    const input = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let initial;
    let end = Infinity;
    // A compressed rollout is decompressed for its marker preflight when reading starts.
    let excluded;
    // A snapshot tolerates appends, so the preflight and the stream must read identical bytes.
    let preflightDigest;
    let screener;
    const checkInput = () => options.snapshot ? assertGrownInput(file, initial, end) : assertUnchangedInput(file, initial);
    try {
        initial = fs.fstatSync(input);
        if (options.snapshot) {
            end = initial.size;
            options.onSnapshot?.(end);
        }
        if (options.resume && (options.resume.dev !== initial.dev || options.resume.ino !== initial.ino || start > initial.size)) {
            throw new Error('Conversation changed during record admission');
        }
        if (!compressed) {
            const digest = options.snapshot ? crypto.createHash('sha256') : undefined;
            excluded = descriptorHasExclusionMarker(input, end, digest, start);
            if (digest && !excluded)
                preflightDigest = digest.digest('hex');
        }
        checkInput();
        checkPolicy();
        if (!excluded && !options.skipScreening)
            screener = createRecordScreener(policy, () => {
                checkInput();
                checkPolicy();
            });
    }
    catch (error) {
        fs.closeSync(input);
        throw error;
    }
    let active;
    let closed = false;
    let closing;
    const records = (startLine = 1, endLine = Infinity, batchRecords = SCREENING_BATCH_RECORDS) => {
        let cursor;
        cursor = (async function* () {
            if (!Number.isSafeInteger(batchRecords) || batchRecords < 1 || batchRecords > SCREENING_BATCH_RECORDS) {
                throw new Error('Invalid record screening batch size');
            }
            if (closed || active)
                throw new Error('Conversation admission is closed or already in use');
            active = cursor;
            let reader;
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let pending = Buffer.alloc(0);
            const identity = options.resume
                ? { ...options.resume.identity }
                : { sessionId: sessionFromPath(file), identitySeen: false };
            let number = options.resume?.line ?? 0;
            const range = options.snapshot ? crypto.createHash('sha256') : undefined;
            const batch = [];
            const batchLimit = policy?.screening ? batchRecords : 1;
            let batchBytes = 0;
            const admit = (bytes, terminated) => {
                number++;
                const crlf = terminated && bytes.at(-1) === 13;
                const line = decoder.decode(crlf ? bytes.subarray(0, -1) : bytes);
                observeRecordIdentity(line, identity, policy);
                const filtered = number >= startLine && number <= endLine
                    ? filterRecord(line, number, policy, transcript, identity.sessionId) : '';
                return { line: filtered, ending: terminated ? (crlf ? '\r\n' : '\n') : '' };
            };
            const flush = async function* () {
                if (batch.length === 0)
                    return;
                if (policy?.screening && screener) {
                    await screener?.scanMany(batch.map(record => record.line));
                    checkInput();
                    checkPolicy();
                }
                for (const record of batch)
                    yield record;
                batch.length = 0;
                batchBytes = 0;
            };
            try {
                checkInput();
                checkPolicy();
                if (excluded === undefined)
                    excluded = await decompressedHasExclusionMarker(file, input);
                if (excluded)
                    return;
                if (start >= end)
                    return;
                // A cursor destroys its stream, but only this context closes the pinned
                // descriptor. Native stream close waits for any pending read to finish.
                reader = conversationByteStream(file, input, compressed, start, end);
                for await (const chunk of reader.stream) {
                    checkInput();
                    checkPolicy();
                    range?.update(chunk);
                    pending = Buffer.concat([pending, chunk]);
                    let newline;
                    while ((newline = pending.indexOf(10)) !== -1) {
                        const bytes = pending.subarray(0, newline);
                        if (batch.length > 0 && batchBytes + bytes.length > SCREENING_BATCH_BYTES)
                            yield* flush();
                        const record = admit(bytes, true);
                        batch.push(record);
                        batchBytes += Buffer.byteLength(record.line) + Buffer.byteLength(record.ending);
                        pending = pending.subarray(newline + 1);
                        if (batch.length === batchLimit || batchBytes >= SCREENING_BATCH_BYTES)
                            yield* flush();
                    }
                    if (pending.length > 64 * 1024 * 1024)
                        throw new Error('Conversation record exceeds admission byte limit');
                }
                if (pending.length) {
                    if (batch.length > 0 && batchBytes + pending.length > SCREENING_BATCH_BYTES)
                        yield* flush();
                    const record = admit(pending, false);
                    batch.push(record);
                    batchBytes += Buffer.byteLength(record.line);
                }
                yield* flush();
                checkInput();
                checkPolicy();
                if (range) {
                    const streamed = range.digest('hex');
                    if (preflightDigest !== undefined && streamed !== preflightDigest) {
                        throw new Error('Conversation changed during record admission');
                    }
                    assertUnchangedRange(input, start, end, streamed);
                }
            }
            finally {
                await reader?.close();
                active = undefined;
            }
        })();
        return cursor;
    };
    return {
        records,
        close() {
            if (!closing) {
                closed = true;
                closing = (async () => {
                    try {
                        await active?.return(undefined);
                    }
                    finally {
                        try {
                            screener?.close();
                        }
                        finally {
                            fs.closeSync(input);
                        }
                    }
                })();
            }
            return closing;
        },
    };
}
/** Keep byte delimiters and physical line coordinates stable in derived copies. */
async function* admittedRecords(file, policy, startLine = 1, endLine = Infinity, batchRecords = SCREENING_BATCH_RECORDS, options = {}) {
    const admission = openRecordAdmission(file, policy, options);
    try {
        yield* admission.records(startLine, endLine, batchRecords);
    }
    finally {
        await admission.close();
    }
}
/** Give detection and parsing rewound, admitted cursors without caching their prefix. */
export function openConversationAdmission(file, policy = readRecordExclusions(), options = {}) {
    if (!fs.lstatSync(file).isFile())
        throw new Error('Conversation input must be a regular non-symlink file');
    const admission = openRecordAdmission(file, policy, { skipScreening: options.skipScreening });
    return {
        async *lines(batchRecords = SCREENING_BATCH_RECORDS) {
            for await (const record of admission.records(1, Infinity, batchRecords))
                yield record.line;
        },
        close: admission.close,
    };
}
/** Read original inputs without mutation, preserving their physical line numbers. */
export async function* admittedConversationLines(file, policy = readRecordExclusions(), batchRecords = SCREENING_BATCH_RECORDS) {
    if (!fs.lstatSync(file).isFile())
        throw new Error('Conversation input must be a regular non-symlink file');
    for await (const record of admittedRecords(file, policy, 1, Infinity, batchRecords))
        yield record.line;
}
/** Read the admitted display input without changing original physical coordinates. */
export async function readAdmittedConversation(file, startLine = 1, endLine = Infinity) {
    if (!Number.isSafeInteger(startLine) || startLine < 1 ||
        (endLine !== Infinity && (!Number.isSafeInteger(endLine) || endLine < startLine))) {
        throw new Error('Invalid conversation line range');
    }
    const lines = [];
    for await (const record of admittedRecords(file, readRecordExclusions(), startLine, endLine))
        lines.push(record.line);
    return lines.join('\n');
}
/** Enforce the same rule for direct callers that bypass transcript parsing. */
export function admitExchange(exchange, policy = readRecordExclusions()) {
    if (!policy)
        return exchange;
    // Historical Codex rows may carry a fork ancestor's ID. Neither that metadata
    // nor the filename may override a denial bound to the other known identity.
    const sessionIds = [exchange.sessionId, sessionFromPath(exchange.archivePath)].filter((id) => !!id);
    const transcript = path.basename(exchange.archivePath);
    if (policy.exchanges.some(x => sessionIds.includes(x.session_id) && x.transcript === transcript && exchange.lineStart <= x.line_end && exchange.lineEnd >= x.line_start))
        return null;
    const kept = exchange.toolCalls?.filter(call => !sessionIds.some(id => blockedCall(policy, id, transcript, call.id)));
    const admitted = kept && kept.length !== exchange.toolCalls?.length ? { ...exchange, toolCalls: kept } : exchange;
    const screener = createRecordScreener(policy);
    try {
        // These are separate original records, not one keyword-prefilter fragment.
        screener.scan(admitted.userMessage);
        screener.scan(admitted.assistantMessage);
        for (const call of admitted.toolCalls ?? [])
            screener.scan(call);
        const { userMessage, assistantMessage, toolCalls, ...metadata } = admitted;
        screener.scan(metadata);
        return admitted;
    }
    finally {
        screener.close();
    }
}
/**
 * When the record policy file last changed; 0 when there is none. The change
 * time also covers a replacement that kept an older modification time.
 */
export function recordExclusionsChangedMs() {
    try {
        const info = fs.lstatSync(path.join(getSuperpowersDir(), 'record-exclusions.json'));
        return Math.max(info.mtimeMs, info.ctimeMs);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return 0;
        throw error;
    }
}
/** Deterministic refusals of a conversation's current bytes under the current policy. */
const SCREENING_REFUSALS = new Set([
    'Record content rejected by screening',
    'Record screening byte limit exceeded',
    'Record screening nesting limit exceeded',
]);
/** True when admission refused the content itself, so retrying unchanged bytes cannot succeed. */
export function isScreeningRefusal(error) {
    return error instanceof Error && SCREENING_REFUSALS.has(error.message);
}
/** Exclusions bind a session and transcript; either identity of a source counts as named. */
function policyNamesConversation(policy, source) {
    const transcript = conversationTranscriptName(source);
    const session = sessionFromPath(source);
    const named = (row) => row.transcript === transcript || row.session_id === session;
    return policy.exchanges.some(named) || policy.tool_calls.some(named);
}
/**
 * An archive reflects the current policy's filtering when it was written after
 * the policy last changed, or when that policy names neither of its identities.
 * Admission renames and re-times the archive, refreshing a ctime that utimes
 * cannot set back. Search output is screened again at the read boundary in every case.
 */
function admittedUnderPolicy(archive, source, policy, policyChangedMs) {
    return !policy || archive.ctimeMs >= policyChangedMs || !policyNamesConversation(policy, source);
}
/**
 * Admission stamps an archive with its source's mtime, rounded up to a whole
 * millisecond. An ordinary write keeps a sub-millisecond part, so the stamp
 * also tells an admitted archive from one written by anything else.
 */
function carriesAdmissionStamp(archive, original) {
    return Math.abs(archive.mtimeMs - Math.ceil(original.mtimeMs)) < 0.001;
}
/**
 * True when every record of an archive was screened under the current policy.
 * Only admission stamps an archive after it changed, and every admission that
 * stamps it has screened each of its records under the policy it snapshotted;
 * an archive written before the policy last changed may never have been screened.
 */
function screenedUnderPolicy(archive, policy, policyChangedMs) {
    return !policy?.screening || (archive.ctimeMs >= policyChangedMs && Number.isInteger(archive.mtimeMs));
}
/** True when an existing archive already holds the admitted form of the source's current bytes. */
export function archiveIsCurrent(source, destination, policy = readRecordExclusions(), policyChangedMs = recordExclusionsChangedMs()) {
    try {
        if (path.resolve(source) === path.resolve(destination))
            return false;
        const original = fs.lstatSync(source);
        const archive = fs.lstatSync(destination);
        if (!original.isFile() || !archive.isFile() || original.dev === archive.dev && original.ino === archive.ino)
            return false;
        // Any other archive time means the source changed or something else wrote the archive.
        if (!carriesAdmissionStamp(archive, original))
            return false;
        // Without a policy an uncompressed archive is an exact copy of its source.
        if (!policy && !isCompressedConversation(source))
            return archive.size === original.size;
        return admittedUnderPolicy(archive, source, policy, policyChangedMs);
    }
    catch {
        return false;
    }
}
/**
 * True when every record of this archive copy was screened under the current
 * policy. Readers that index such an archive need not screen it again; search
 * output is still screened at the read boundary.
 */
export function archiveScreenedUnderPolicy(archive, archiveRoot, policy = readRecordExclusions(), policyChangedMs = recordExclusionsChangedMs()) {
    try {
        const relative = path.relative(fs.realpathSync(archiveRoot), fs.realpathSync(archive));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            return false;
        const info = fs.lstatSync(archive);
        return info.isFile() && screenedUnderPolicy(info, policy, policyChangedMs);
    }
    catch {
        return false;
    }
}
async function* physicalLines(file, fd) {
    const reader = conversationByteStream(file, fd, false);
    let pending = Buffer.alloc(0);
    try {
        for await (const chunk of reader.stream) {
            pending = Buffer.concat([pending, chunk]);
            let from = 0;
            let newline;
            while ((newline = pending.indexOf(10, from)) !== -1) {
                yield { bytes: pending.subarray(from, newline), terminated: true, length: newline + 1 - from };
                from = newline + 1;
            }
            pending = pending.subarray(from);
            if (pending.length > 64 * 1024 * 1024)
                throw new Error('Conversation record exceeds admission byte limit');
        }
        if (pending.length)
            yield { bytes: pending, terminated: false, length: pending.length };
    }
    finally {
        await reader.close();
    }
}
/**
 * Confirm that an archive is the admitted form of its source's leading lines.
 * The archive was screened under the current policy, so a byte-identical line
 * was screened when it was admitted; any other line must equal the current
 * filtering of its record and carry no opt-out marker. An unterminated archive
 * tail is admitted again from the source.
 */
async function verifyAdmittedPrefix(source, archive, policy) {
    const transcript = conversationTranscriptName(source);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const identity = { sessionId: sessionFromPath(source), identitySeen: false };
    let sourceFd;
    let archiveFd;
    try {
        sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        archiveFd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const sourceStats = fs.fstatSync(sourceFd);
        if (!sourceStats.isFile() || !fs.fstatSync(archiveFd).isFile())
            return undefined;
        const originals = physicalLines(source, sourceFd);
        let line = 0;
        let offset = 0;
        let archiveOffset = 0;
        try {
            for await (const archived of physicalLines(archive, archiveFd)) {
                if (!archived.terminated)
                    break;
                const next = await originals.next();
                if (next.done || !next.value.terminated)
                    return undefined;
                const original = next.value;
                line++;
                const crlf = original.bytes.at(-1) === 13;
                const text = decoder.decode(crlf ? original.bytes.subarray(0, -1) : original.bytes);
                observeRecordIdentity(text, identity, policy);
                if (!original.bytes.equals(archived.bytes)) {
                    const expected = Buffer.from(filterRecord(text, line, policy, transcript, identity.sessionId) + (crlf ? '\r' : ''));
                    if (!expected.equals(archived.bytes) || lineHasExclusionMarker(text))
                        return undefined;
                }
                offset += original.length;
                archiveOffset += archived.length;
            }
        }
        finally {
            await originals.return(undefined);
        }
        return { archiveOffset, resume: { offset, line, identity, dev: sourceStats.dev, ino: sourceStats.ino } };
    }
    catch (error) {
        if (error instanceof Error && error.message === 'Record exclusion session identity mismatch')
            throw error;
        // Unreadable or undecodable input is left to full admission, which reports it.
        return undefined;
    }
    finally {
        if (sourceFd !== undefined)
            fs.closeSync(sourceFd);
        if (archiveFd !== undefined)
            fs.closeSync(archiveFd);
    }
}
function suffixHasExclusionMarker(source, offset) {
    let fd;
    try {
        fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        return descriptorHasExclusionMarker(fd, Infinity, undefined, offset);
    }
    catch {
        return true;
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
/** Admit only what an append-only source added after its verified archive prefix. */
async function appendAdmittedConversation(source, destination, policy, policySnapshot) {
    const prefix = await verifyAdmittedPrefix(source, destination, policy);
    if (!prefix)
        return undefined;
    const initial = fs.statSync(source);
    const archive = fs.lstatSync(destination);
    if (initial.dev !== prefix.resume.dev || initial.ino !== prefix.resume.ino)
        return undefined;
    if (prefix.resume.offset === initial.size && prefix.archiveOffset === archive.size) {
        // Nothing was appended; record that the archive reflects these bytes.
        fs.utimesSync(destination, initial.atimeMs / 1000, Math.ceil(initial.mtimeMs) / 1000);
        return false;
    }
    // An opt-out marker anywhere excludes the whole conversation; keep the previous archive.
    if (suffixHasExclusionMarker(source, prefix.resume.offset))
        return false;
    const parent = prepareArchiveParent(path.dirname(path.resolve(destination)));
    const parentIdentity = fs.statSync(parent);
    destination = path.join(parent, path.basename(destination));
    const temp = destination + '.tmp.' + process.pid + '.' + crypto.randomUUID();
    // The clone holds only already-admitted bytes; every appended record is screened first.
    fs.copyFileSync(destination, temp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    try {
        fs.chmodSync(temp, 0o600);
        fs.truncateSync(temp, prefix.archiveOffset);
        let admittedEnd = Infinity;
        const fd = fs.openSync(temp, 'a');
        try {
            for await (const record of admittedRecords(source, policy, 1, Infinity, SCREENING_BATCH_RECORDS, { resume: prefix.resume, snapshot: true, onSnapshot: end => { admittedEnd = end; } })) {
                fs.writeFileSync(fd, Buffer.from(record.line + record.ending));
            }
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        assertUnchangedPolicy(policySnapshot);
        // Records appended during admission are left for the next admission, unless one opts out.
        if (suffixHasExclusionMarker(source, admittedEnd))
            throw new Error('Conversation changed during record admission');
        const current = fs.lstatSync(destination);
        if (!current.isFile() || current.dev !== archive.dev || current.ino !== archive.ino || current.size !== archive.size) {
            throw new Error('Archive changed during record admission');
        }
        const currentParent = fs.lstatSync(parent);
        if (!currentParent.isDirectory() || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) {
            throw new Error('Archive parent changed during record admission');
        }
        fs.renameSync(temp, destination);
        fs.utimesSync(destination, initial.atimeMs / 1000, Math.ceil(initial.mtimeMs) / 1000);
        return true;
    }
    finally {
        if (fs.existsSync(temp))
            fs.unlinkSync(temp);
    }
}
/** Publish only admitted bytes. Never write an unfiltered temporary copy. */
export async function archiveAdmittedConversation(source, destination, policy = readRecordExclusions()) {
    const policySnapshot = JSON.stringify(policy);
    assertUnchangedPolicy(policySnapshot);
    // An unchanged archive needs neither a marker scan nor screening.
    const policyChangedMs = recordExclusionsChangedMs();
    if (archiveIsCurrent(source, destination, policy, policyChangedMs))
        return false;
    const compressed = isCompressedConversation(source);
    if (!compressed && path.resolve(source) !== path.resolve(destination)) {
        let eligible = false;
        try {
            const original = fs.lstatSync(source);
            const archive = fs.lstatSync(destination);
            // Only a prefix already screened under this policy may be kept without screening it again.
            eligible = original.isFile() && archive.isFile() && (original.dev !== archive.dev || original.ino !== archive.ino) &&
                admittedUnderPolicy(archive, source, policy, policyChangedMs) && screenedUnderPolicy(archive, policy, policyChangedMs);
        }
        catch { /* A missing or irregular archive is admitted whole. */ }
        if (eligible) {
            const appended = await appendAdmittedConversation(source, destination, policy, policySnapshot);
            if (appended !== undefined)
                return appended;
        }
    }
    if (await conversationHasExclusionMarker(source))
        return false;
    if (path.resolve(source) === path.resolve(destination))
        throw new Error('Source and derived archive must be distinct');
    const original = fs.lstatSync(source);
    if (!original.isFile())
        throw new Error('Conversation source must be a regular non-symlink file');
    let target;
    if (fs.existsSync(destination)) {
        target = fs.lstatSync(destination);
        if (!target.isFile() || target.dev === original.dev && target.ino === original.ino) {
            throw new Error('Source and derived archive must be distinct regular files');
        }
    }
    const initial = fs.statSync(source);
    const parent = prepareArchiveParent(path.dirname(path.resolve(destination)));
    const parentIdentity = fs.statSync(parent);
    destination = path.join(parent, path.basename(destination));
    const temp = destination + '.tmp.' + process.pid + '.' + crypto.randomUUID();
    const fd = fs.openSync(temp, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let admittedEnd = Infinity;
    try {
        // A live transcript is admitted up to its size at open; later appends follow next time.
        for await (const record of admittedRecords(source, policy, 1, Infinity, SCREENING_BATCH_RECORDS, { snapshot: !compressed, onSnapshot: end => { admittedEnd = end; } })) {
            const bytes = Buffer.from(record.line + record.ending);
            hash.update(bytes);
            fs.writeFileSync(fd, bytes);
        }
        fs.fsyncSync(fd);
    }
    catch (error) {
        fs.closeSync(fd);
        fs.unlinkSync(temp);
        throw error;
    }
    fs.closeSync(fd);
    try {
        const final = fs.statSync(source);
        if (initial.dev !== final.dev || initial.ino !== final.ino ||
            (compressed ? initial.size !== final.size || initial.mtimeMs !== final.mtimeMs : final.size < initial.size)) {
            throw new Error('Conversation changed during record admission');
        }
        if (fs.existsSync(destination)) {
            const existing = crypto.createHash('sha256');
            for await (const chunk of fs.createReadStream(destination))
                existing.update(chunk);
            if (existing.digest('hex') === hash.digest('hex')) {
                // Same admitted bytes: record that the archive reflects this source and policy.
                fs.utimesSync(destination, initial.atimeMs / 1000, Math.ceil(initial.mtimeMs) / 1000);
                return false;
            }
        }
        if (compressed)
            assertUnchangedInput(source, original);
        else {
            assertGrownInput(source, original, original.size);
            // Records appended during admission are left for the next admission, unless one opts out.
            if (suffixHasExclusionMarker(source, admittedEnd))
                throw new Error('Conversation changed during record admission');
        }
        assertUnchangedPolicy(policySnapshot);
        const currentParent = fs.lstatSync(parent);
        if (!currentParent.isDirectory() || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) {
            throw new Error('Archive parent changed during record admission');
        }
        fs.renameSync(temp, destination);
        fs.utimesSync(destination, initial.atimeMs / 1000, Math.ceil(initial.mtimeMs) / 1000);
        return true;
    }
    finally {
        if (fs.existsSync(temp))
            fs.unlinkSync(temp);
    }
}
/** Request-local admission: retained search rows are not trusted merely because they were indexed. */
export function createSearchAdmission() {
    const policy = readRecordExclusions();
    const policySnapshot = JSON.stringify(policy);
    const files = new Map();
    const checkFile = (file) => {
        assertUnchangedPolicy(policySnapshot);
        const cached = files.get(file);
        if (cached)
            return !cached.excluded;
        let fd;
        try {
            let pathInfo;
            try {
                pathInfo = fs.lstatSync(file);
            }
            catch (error) {
                // A transcript removed since indexing has nothing left to verify or expose:
                // withhold its retained rows instead of failing the whole search.
                if (error.code !== 'ENOENT')
                    throw error;
                files.set(file, { excluded: true });
                return false;
            }
            if (!pathInfo.isFile())
                throw new Error('Conversation changed during record admission');
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const initial = fs.fstatSync(fd);
            if (!initial.isFile() || initial.dev !== pathInfo.dev || initial.ino !== pathInfo.ino ||
                !Number.isSafeInteger(initial.size))
                throw new Error('Conversation changed during record admission');
            const hash = crypto.createHash('sha256');
            // The observed size is this request's snapshot boundary. Records appended
            // later are admitted by the next request, including conversation opt-outs.
            const excluded = descriptorHasExclusionMarker(fd, initial.size, hash);
            files.set(file, { initial, excluded, digest: excluded ? undefined : hash.digest('hex') });
            return !excluded;
        }
        catch {
            throw new Error('Conversation changed during record admission');
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
    };
    return {
        admit(exchange) {
            if (!checkFile(exchange.archivePath))
                return null;
            const admitted = admitExchange(exchange, policy);
            assertUnchangedPolicy(policySnapshot);
            return admitted;
        },
        summary(exchange, text) {
            // An old summary has no record-level provenance. A filtered source may have
            // contributed any of its text, so do not expose that derived summary.
            const ids = [exchange.sessionId, sessionFromPath(exchange.archivePath)];
            const transcript = path.basename(exchange.archivePath);
            if (policy && [...policy.exchanges, ...policy.tool_calls].some(row => row.transcript === transcript && ids.includes(row.session_id)))
                return undefined;
            return admitExchange({ ...exchange, userMessage: text, assistantMessage: '', toolCalls: [] }, policy)
                ? text : undefined;
        },
        verify() {
            assertUnchangedPolicy(policySnapshot);
            for (const [file, { initial, digest }] of files) {
                if (initial !== undefined && digest !== undefined)
                    assertUnchangedSearchPrefix(file, initial, digest);
            }
            assertUnchangedPolicy(policySnapshot);
        },
    };
}
