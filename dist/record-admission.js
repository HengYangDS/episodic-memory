import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { getSuperpowersDir } from './paths.js';
const EXCLUSION_MARKERS = [
    '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
    'Only use NO_INSIGHTS_FOUND',
    SUMMARIZER_CONTEXT_MARKER,
];
const MARKER_SCAN_CHUNK_BYTES = 1 << 20; // 1 MiB
/**
 * Stream and scan for any exclusion marker, carrying an overlap between
 * chunks so a marker split across a boundary is still found. A single
 * fs.readFileSync(path, 'utf-8') throws ERR_STRING_TOO_LONG above Node's
 * ~512 MB max string length; the old catch returned false (fail OPEN),
 * silently indexing a file whose DO NOT INDEX marker we never read (#152).
 * Streaming confirms cleanliness at any size, and a real read error now
 * fails CLOSED (skip) rather than open.
 */
export function shouldSkipConversation(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        return descriptorHasExclusionMarker(fd);
    }
    catch {
        return true; // fail closed (#152)
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
    }
}
function descriptorHasExclusionMarker(fd) {
    if (!fs.fstatSync(fd).isFile())
        throw new Error('Conversation input must be a regular file');
    const maxMarkerLen = Math.max(...EXCLUSION_MARKERS.map(m => m.length));
    const buf = Buffer.allocUnsafe(MARKER_SCAN_CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let position = 0;
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, position)) > 0) {
        position += bytesRead;
        const window = carry + decoder.write(buf.subarray(0, bytesRead));
        if (EXCLUSION_MARKERS.some(marker => window.includes(marker)))
            return true;
        carry = window.slice(Math.max(0, window.length - (maxMarkerLen - 1)));
    }
    const tail = carry + decoder.end();
    return EXCLUSION_MARKERS.some(marker => tail.includes(marker));
}
function assertUnchangedInput(file, initial) {
    const current = fs.lstatSync(file);
    if (!current.isFile() || initial.dev !== current.dev || initial.ino !== current.ino ||
        initial.size !== current.size || initial.mtimeMs !== current.mtimeMs || initial.ctimeMs !== current.ctimeMs) {
        throw new Error('Conversation changed during record admission');
    }
}
function assertUnchangedPolicy(expected) {
    if (JSON.stringify(readRecordExclusions()) !== expected) {
        throw new Error('Record exclusion policy changed during record admission');
    }
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
export function readRecordExclusions() {
    const file = path.join(getSuperpowersDir(), 'record-exclusions.json');
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > 4 * 1024 * 1024)
            throw new Error(POLICY_ERROR);
        const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (!object(value) || !keys(value, ['version', 'exchanges', 'tool_calls']) || value.version !== 1 ||
            !Array.isArray(value.exchanges) || !Array.isArray(value.tool_calls))
            throw new Error(POLICY_ERROR);
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
/** Keep byte delimiters and physical line coordinates stable in derived copies. */
async function* admittedRecords(file, policy) {
    const policySnapshot = JSON.stringify(policy);
    assertUnchangedPolicy(policySnapshot);
    const input = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const initial = fs.fstatSync(input);
    let stream;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = Buffer.alloc(0);
    let sessionId = sessionFromPath(file);
    let primaryIdentitySeen = false;
    let number = 0;
    const admit = (bytes, terminated) => {
        number++;
        const crlf = terminated && bytes.at(-1) === 13;
        const line = decoder.decode(crlf ? bytes.subarray(0, -1) : bytes);
        let recordSession;
        try {
            recordSession = sessionFromRecord(JSON.parse(line));
        }
        catch { /* Parser owns malformed records. */ }
        if (recordSession && !primaryIdentitySeen) {
            if (sessionId && recordSession !== sessionId && (excludedSession(policy, sessionId) || excludedSession(policy, recordSession))) {
                throw new Error('Record exclusion session identity mismatch');
            }
            sessionId = recordSession;
            primaryIdentitySeen = true;
        }
        return { line: filterRecord(line, number, policy, path.basename(file), sessionId), ending: terminated ? (crlf ? '\r\n' : '\n') : '' };
    };
    try {
        // The marker scan and record stream share one descriptor and identity.
        // A path replacement cannot substitute a different unscanned transcript.
        if (descriptorHasExclusionMarker(input))
            return;
        assertUnchangedInput(file, initial);
        stream = fs.createReadStream(file, { fd: input, autoClose: true, start: 0 });
        for await (const chunk of stream) {
            assertUnchangedInput(file, initial);
            assertUnchangedPolicy(policySnapshot);
            pending = Buffer.concat([pending, chunk]);
            let newline;
            while ((newline = pending.indexOf(10)) !== -1) {
                yield admit(pending.subarray(0, newline), true);
                pending = pending.subarray(newline + 1);
            }
            if (pending.length > 64 * 1024 * 1024)
                throw new Error('Conversation record exceeds admission byte limit');
        }
        if (pending.length)
            yield admit(pending, false);
        assertUnchangedInput(file, initial);
        assertUnchangedPolicy(policySnapshot);
    }
    finally {
        if (stream)
            stream.destroy();
        else
            fs.closeSync(input);
    }
}
/** Read original inputs without mutation, preserving their physical line numbers. */
export async function* admittedConversationLines(file, policy = readRecordExclusions()) {
    if (!fs.lstatSync(file).isFile())
        throw new Error('Conversation input must be a regular non-symlink file');
    if (shouldSkipConversation(file))
        return;
    for await (const record of admittedRecords(file, policy))
        yield record.line;
}
/** Read the admitted display input without changing original physical coordinates. */
export async function readAdmittedConversation(file) {
    const lines = [];
    for await (const line of admittedConversationLines(file))
        lines.push(line);
    return lines.join('\n');
}
/** Enforce the same rule for direct callers that bypass transcript parsing. */
export function admitExchange(exchange, policy = readRecordExclusions()) {
    if (!policy)
        return exchange;
    // Historical Codex rows may carry a fork ancestor's ID. Neither that metadata
    // nor the filename may override a denial bound to the other known identity.
    const sessionIds = [exchange.sessionId, sessionFromPath(exchange.archivePath)].filter((id) => !!id);
    if (!sessionIds.length)
        return exchange;
    const transcript = path.basename(exchange.archivePath);
    if (policy.exchanges.some(x => sessionIds.includes(x.session_id) && x.transcript === transcript && exchange.lineStart <= x.line_end && exchange.lineEnd >= x.line_start))
        return null;
    const kept = exchange.toolCalls?.filter(call => !sessionIds.some(id => blockedCall(policy, id, transcript, call.id)));
    return kept && kept.length !== exchange.toolCalls?.length ? { ...exchange, toolCalls: kept } : exchange;
}
/** Publish only admitted bytes. Never write an unfiltered temporary copy. */
export async function archiveAdmittedConversation(source, destination, policy = readRecordExclusions()) {
    const policySnapshot = JSON.stringify(policy);
    assertUnchangedPolicy(policySnapshot);
    if (shouldSkipConversation(source))
        return false;
    if (path.resolve(source) === path.resolve(destination))
        throw new Error('Source and derived archive must be distinct');
    const original = fs.lstatSync(source);
    if (!original.isFile())
        throw new Error('Conversation source must be a regular non-symlink file');
    if (fs.existsSync(destination)) {
        const target = fs.lstatSync(destination);
        if (!target.isFile() || target.dev === original.dev && target.ino === original.ino) {
            throw new Error('Source and derived archive must be distinct regular files');
        }
    }
    if (!policy && fs.existsSync(destination) && fs.statSync(destination).mtimeMs >= original.mtimeMs)
        return false;
    const initial = fs.statSync(source);
    const parent = prepareArchiveParent(path.dirname(path.resolve(destination)));
    const parentIdentity = fs.statSync(parent);
    destination = path.join(parent, path.basename(destination));
    const temp = destination + '.tmp.' + process.pid + '.' + crypto.randomUUID();
    const fd = fs.openSync(temp, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    try {
        for await (const record of admittedRecords(source, policy)) {
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
        if (initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size || initial.mtimeMs !== final.mtimeMs) {
            throw new Error('Conversation changed during record admission');
        }
        if (fs.existsSync(destination)) {
            const existing = crypto.createHash('sha256');
            for await (const chunk of fs.createReadStream(destination))
                existing.update(chunk);
            if (existing.digest('hex') === hash.digest('hex'))
                return false;
        }
        assertUnchangedInput(source, original);
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
