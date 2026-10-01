#!/usr/bin/env node
import { verifyIndex, repairIndex } from './verify.js';
import { indexExactPath, indexSession, indexUnprocessed, indexConversations } from './indexer.js';
import { getDbPath, getArchiveDir, statIfExists } from './paths.js';
import fs from 'fs';
import path from 'path';
import { getSyncLockPath } from './logging.js';
import { acquireFileLock, readLockHolder, releaseFileLock } from './file-lock.js';
const command = process.argv[2];
const PAGE_DEFAULTS = {
    maxFiles: 100,
    maxFileBytes: 8 * 1024 * 1024,
    maxParseBytes: 64 * 1024 * 1024
};
function parseVerifyPageArgs(args) {
    const options = {
        ...PAGE_DEFAULTS,
        quiet: true
    };
    const names = {
        '--after-path': 'afterPath',
        '--max-files': 'maxFiles',
        '--max-file-bytes': 'maxFileBytes',
        '--max-parse-bytes': 'maxParseBytes'
    };
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const name = names[flag];
        if (!name || seen.has(flag))
            throw new Error(`Invalid verification option: ${flag}`);
        seen.add(flag);
        const value = args[index + 1];
        if (value === undefined)
            throw new Error(`Missing value for ${flag}`);
        if (name === 'afterPath') {
            if (!path.isAbsolute(value))
                throw new Error('Invalid --after-path: expected an absolute archive path');
            options.afterPath = value;
        }
        else {
            if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
                throw new Error(`Invalid ${flag}: expected a positive safe integer`);
            }
            options[name] = Number(value);
        }
    }
    return options;
}
function hasVerificationIssues(issues) {
    return issues.missing.length + issues.unindexed.length + issues.orphaned.length + issues.outdated.length +
        issues.screeningRejected.length + issues.screeningUnavailable.length + issues.corrupted.length > 0;
}
// Serialize the whole CLI with `sync-cli`: writers mutate the index/archive,
// and verification must not claim a consistent result while one is active.
const syncLockPath = getSyncLockPath();
const syncLock = acquireFileLock(syncLockPath);
if (!syncLock) {
    const holder = readLockHolder(syncLockPath);
    const holderLabel = holder !== null ? `pid ${holder}` : 'another process';
    // A skipped write may be retried by a hook; a skipped verifier is not a result.
    console.error(`episodic-memory: sync already running (${holderLabel}); skipping`);
    process.exit(command === 'verify' || command === 'verify-page' || command === 'index-path' ? 2 : 0);
}
const releaseSyncLockOnce = () => {
    if (releaseSyncLockOnce.done)
        return;
    releaseSyncLockOnce.done = true;
    releaseFileLock(syncLock);
};
process.on('exit', releaseSyncLockOnce);
process.on('SIGINT', () => { releaseSyncLockOnce(); process.exit(130); });
process.on('SIGTERM', () => { releaseSyncLockOnce(); process.exit(143); });
process.on('SIGHUP', () => { releaseSyncLockOnce(); process.exit(129); });
// Parse --concurrency flag from remaining args
function getConcurrency() {
    const concurrencyIndex = process.argv.findIndex(arg => arg === '--concurrency' || arg === '-c');
    if (concurrencyIndex !== -1 && process.argv[concurrencyIndex + 1]) {
        const value = parseInt(process.argv[concurrencyIndex + 1], 10);
        if (value >= 1 && value <= 16)
            return value;
    }
    return 1; // default
}
// Parse --no-summaries flag
function getNoSummaries() {
    return process.argv.includes('--no-summaries');
}
const concurrency = getConcurrency();
const noSummaries = getNoSummaries();
async function main() {
    try {
        switch (command) {
            case 'index-session':
                const sessionId = process.argv[3];
                if (!sessionId) {
                    console.error('Usage: index-cli index-session <session-id>');
                    process.exit(1);
                }
                await indexSession(sessionId, concurrency, noSummaries);
                break;
            case 'index-path': {
                const filePath = process.argv[3];
                const remaining = process.argv.slice(4).filter(arg => arg !== '--no-summaries');
                const bounded = remaining.length === 2 && remaining[0] === '--max-file-bytes' &&
                    /^[1-9]\d*$/.test(remaining[1]) && Number.isSafeInteger(Number(remaining[1]));
                if (!filePath || (remaining.length > 0 && !bounded)) {
                    console.error('Usage: index-cli index-path <absolute-transcript.jsonl> [--max-file-bytes N]');
                    process.exit(1);
                }
                await indexExactPath(filePath, bounded ? Number(remaining[1]) : undefined);
                break;
            }
            case 'index-cleanup':
                await indexUnprocessed(concurrency, noSummaries);
                break;
            case 'verify':
                console.log('Verifying conversation index...');
                const issues = await verifyIndex();
                console.log('\n=== Verification Results ===');
                console.log(`Missing summaries: ${issues.missing.length}`);
                console.log(`Unindexed archives: ${issues.unindexed.length}`);
                console.log(`Orphaned entries: ${issues.orphaned.length}`);
                console.log(`Outdated files: ${issues.outdated.length}`);
                console.log(`Archive refreshes (no new exchanges): ${issues.archiveRefreshes.length}`);
                console.log(`Screening-rejected archives: ${issues.screeningRejected.length}`);
                console.log(`Screening-unavailable archives: ${issues.screeningUnavailable.length}`);
                console.log(`Corrupted files: ${issues.corrupted.length}`);
                console.log(`Deferred files: ${issues.deferred.length}`);
                if (!issues.complete) {
                    console.error('Verification is incomplete; no healthy verdict is available.');
                    process.exitCode = 2;
                    break;
                }
                if (issues.missing.length > 0) {
                    console.log('\nMissing summaries:');
                    issues.missing.forEach(m => console.log(`  ${m.path}`));
                }
                if (issues.unindexed.length > 0) {
                    console.log('\nUnindexed archives:');
                    issues.unindexed.forEach(item => console.log(`  ${item.path}`));
                }
                if (issues.outdated.length > 0) {
                    console.log('\nArchives with appended exchanges:');
                    issues.outdated.forEach(item => console.log(`  ${item.path}`));
                }
                if (hasVerificationIssues(issues)) {
                    console.log('\nReview exact candidates before repair; --repair may regenerate summaries and embeddings.');
                    process.exit(1);
                }
                else {
                    console.log('\n✅ Index is healthy!');
                }
                break;
            case 'verify-page': {
                const page = await verifyIndex(parseVerifyPageArgs(process.argv.slice(3)));
                console.log(JSON.stringify(page));
                process.exitCode = !page.complete ? 2 : hasVerificationIssues(page) ? 1 : 0;
                break;
            }
            case 'repair':
                console.log('Verifying conversation index...');
                const repairIssues = await verifyIndex();
                if (!repairIssues.complete) {
                    console.error('Verification is incomplete; repair was not started.');
                    process.exitCode = 2;
                    break;
                }
                if (repairIssues.screeningRejected.length + repairIssues.screeningUnavailable.length > 0) {
                    console.error('Record screening failures require review; repair was not started.');
                    process.exitCode = 1;
                    break;
                }
                if (repairIssues.unindexed.length > 0) {
                    console.log(`${repairIssues.unindexed.length} unindexed archive(s) require separate review; --repair does not select them by this status alone.`);
                    process.exitCode = 1;
                }
                if (repairIssues.missing.length + repairIssues.orphaned.length + repairIssues.outdated.length > 0) {
                    await repairIndex(repairIssues);
                }
                else if (repairIssues.unindexed.length === 0) {
                    console.log('✅ No issues to repair!');
                }
                break;
            case 'rebuild':
                console.log('Rebuilding entire index...');
                // Delete database
                const dbPath = getDbPath();
                if (fs.existsSync(dbPath)) {
                    fs.unlinkSync(dbPath);
                    console.log('Deleted existing database');
                }
                // Delete all summary files
                const archiveDir = getArchiveDir();
                if (fs.existsSync(archiveDir)) {
                    const projects = fs.readdirSync(archiveDir);
                    for (const project of projects) {
                        const projectPath = path.join(archiveDir, project);
                        if (!statIfExists(projectPath)?.isDirectory())
                            continue;
                        const summaries = fs.readdirSync(projectPath).filter(f => f.endsWith('-summary.txt'));
                        for (const summary of summaries) {
                            fs.unlinkSync(path.join(projectPath, summary));
                        }
                    }
                    console.log('Deleted all summary files');
                }
                // Re-index everything
                console.log('Re-indexing all conversations...');
                await indexConversations(undefined, undefined, concurrency, noSummaries);
                break;
            case 'index-all':
            default:
                await indexConversations(undefined, undefined, concurrency, noSummaries);
                break;
        }
    }
    catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}
main();
