import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { parseConversation } from './parser.js';
import { getAllExchanges, getExchangesNeedingIndex } from './db.js';
import { getArchiveDir, getDbPath, getExcludedProjects, findJsonlFiles, statIfExists } from './paths.js';
import { isErroredSentinel } from './summary-sentinel.js';
import { readRecordExclusions } from './record-admission.js';
import { getMaxMessageBytes, isOversizeExchange } from './message-size.js';
function positiveLimit(value, name) {
    if (value === undefined)
        return Infinity;
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`Invalid ${name} limit`);
    return value;
}
export async function verifyIndex(options = {}) {
    readRecordExclusions();
    const result = {
        missing: [],
        unindexed: [],
        orphaned: [],
        outdated: [],
        archiveRefreshes: [],
        screeningRejected: [],
        screeningUnavailable: [],
        corrupted: [],
        deferred: [],
        visitedFiles: 0,
        totalFiles: 0,
        nextCursor: null,
        complete: true
    };
    const archiveDir = getArchiveDir();
    // Track all files we find
    const foundFiles = new Set();
    // Find all conversation files
    if (!fs.existsSync(archiveDir)) {
        return result;
    }
    // Verification must not create or migrate the index it is measuring.
    const dbPath = getDbPath();
    const db = fs.existsSync(dbPath) ? new Database(dbPath, { readonly: true, fileMustExist: true }) : null;
    const indexState = db?.prepare(`
    SELECT MAX(line_end) AS maxLineEnd, MAX(last_indexed) AS lastIndexed
    FROM exchanges WHERE archive_path = ?
  `);
    const maxFiles = positiveLimit(options.maxFiles, 'maxFiles');
    const maxFileBytes = positiveLimit(options.maxFileBytes, 'maxFileBytes');
    const maxParseBytes = positiveLimit(options.maxParseBytes, 'maxParseBytes');
    const maxMessageBytes = getMaxMessageBytes();
    const projects = fs.readdirSync(archiveDir).sort();
    const excludedProjects = getExcludedProjects();
    const excludedDirSet = new Set(excludedProjects);
    const filesToCheck = [];
    for (const project of projects) {
        if (excludedProjects.includes(project)) {
            if (!options.quiet)
                console.log("\nSkipping excluded project: " + project);
            continue;
        }
        const projectPath = path.join(archiveDir, project);
        const stat = statIfExists(projectPath);
        if (!stat?.isDirectory())
            continue;
        for (const file of findJsonlFiles(projectPath, excludedDirSet).sort()) {
            filesToCheck.push({ project, path: path.join(projectPath, file) });
        }
    }
    for (const file of filesToCheck)
        foundFiles.add(file.path);
    result.totalFiles = filesToCheck.length;
    let start = 0;
    if (options.afterPath !== undefined) {
        const cursorIndex = filesToCheck.findIndex(file => file.path === options.afterPath);
        if (cursorIndex < 0) {
            db?.close();
            throw new Error('Invalid verification cursor: archive file no longer exists');
        }
        start = cursorIndex + 1;
    }
    let parsedBytes = 0;
    let lastVisited = null;
    for (let index = start; index < filesToCheck.length; index++) {
        if (result.visitedFiles >= maxFiles) {
            result.nextCursor = lastVisited;
            break;
        }
        const { project, path: conversationPath } = filesToCheck[index];
        const fileStat = statIfExists(conversationPath);
        if (!fileStat?.isFile()) {
            result.corrupted.push({ path: conversationPath, error: 'Archive file disappeared during verification' });
            result.visitedFiles++;
            lastVisited = conversationPath;
            continue;
        }
        if (fileStat.size <= maxFileBytes && fileStat.size <= maxParseBytes &&
            parsedBytes + fileStat.size > maxParseBytes) {
            result.nextCursor = lastVisited;
            break;
        }
        result.visitedFiles++;
        lastVisited = conversationPath;
        if (!options.quiet && result.visitedFiles % 100 === 0) {
            console.log(`  Checked ${result.visitedFiles} conversations...`);
        }
        const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
        // Check for missing or errored summary. An error sentinel (#96) means a
        // previous summarization failed — verify treats it as "missing" so repair
        // re-attempts it rather than reporting the conversation as healthy.
        if (!fs.existsSync(summaryPath)) {
            result.missing.push({ path: conversationPath, reason: 'No summary file' });
        }
        else if (isErroredSentinel(fs.readFileSync(summaryPath, 'utf-8'))) {
            result.missing.push({ path: conversationPath, reason: 'Previous summarization failed (error sentinel)' });
        }
        if (fileStat.size > maxFileBytes || fileStat.size > maxParseBytes) {
            result.deferred.push({
                path: conversationPath,
                size: fileStat.size,
                reason: fileStat.size > maxFileBytes ? 'File exceeds maxFileBytes' : 'File exceeds maxParseBytes'
            });
            continue;
        }
        parsedBytes += fileStat.size;
        const state = indexState?.get(conversationPath);
        const maxLineEnd = state?.maxLineEnd ?? null;
        // Parse independently of summary state and mtime. A previously indexed
        // exchange can extend without starting past the file's high-water line.
        try {
            const exchanges = await parseConversation(conversationPath, project, conversationPath);
            if (maxLineEnd === null) {
                if (exchanges.some(exchange => !isOversizeExchange(exchange, maxMessageBytes))) {
                    result.unindexed.push({ path: conversationPath });
                }
            }
            else {
                const fileTime = fileStat.mtimeMs;
                const dbTime = state?.lastIndexed ?? 0;
                const pending = getExchangesNeedingIndex(db, conversationPath, exchanges);
                if (pending.some(exchange => !isOversizeExchange(exchange, maxMessageBytes))) {
                    result.outdated.push({ path: conversationPath, fileTime, dbTime });
                }
                else if (state?.lastIndexed != null && fileTime > state.lastIndexed) {
                    result.archiveRefreshes.push({ path: conversationPath, fileTime, dbTime });
                }
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === 'Record content rejected by screening' ||
                message === 'Record screening byte limit exceeded' ||
                message === 'Record screening nesting limit exceeded') {
                result.screeningRejected.push({ path: conversationPath });
            }
            else if (message === 'Record screening unavailable') {
                result.screeningUnavailable.push({ path: conversationPath });
            }
            else {
                result.corrupted.push({ path: conversationPath, error: message });
            }
        }
    }
    result.complete = options.afterPath === undefined && result.nextCursor === null &&
        result.deferred.length === 0 && result.visitedFiles === result.totalFiles;
    if (!options.quiet)
        console.log(`Verified ${result.visitedFiles} of ${result.totalFiles} conversations.`);
    // Check for orphaned database entries
    const dbExchanges = db ? getAllExchanges(db) : [];
    db?.close();
    for (const exchange of dbExchanges) {
        if (!foundFiles.has(exchange.archivePath) && !statIfExists(exchange.archivePath)?.isFile()) {
            result.orphaned.push({
                uuid: exchange.id,
                path: exchange.archivePath
            });
        }
    }
    return result;
}
export async function repairIndex(issues) {
    if (issues.complete !== true) {
        throw new Error('Cannot repair from incomplete verification');
    }
    if (issues.screeningRejected.length + issues.screeningUnavailable.length > 0) {
        throw new Error('Resolve record screening failures before repair');
    }
    readRecordExclusions();
    console.log('Repairing index...');
    // To avoid circular dependencies, we import the indexer functions dynamically
    const { initDatabase, insertExchange, deleteExchange } = await import('./db.js');
    const { parseConversation } = await import('./parser.js');
    const { initEmbeddings, generateExchangeEmbedding } = await import('./embeddings.js');
    const { summarizeConversation } = await import('./summarizer.js');
    const db = initDatabase();
    await initEmbeddings();
    // Remove orphaned entries first
    for (const orphan of issues.orphaned) {
        console.log(`Removing orphaned entry: ${orphan.uuid}`);
        deleteExchange(db, orphan.uuid);
    }
    // Re-index missing and outdated conversations
    const toReindex = [...new Set([
            ...issues.missing.map(m => m.path),
            ...issues.outdated.map(o => o.path)
        ])];
    for (const conversationPath of toReindex) {
        console.log(`Re-indexing: ${conversationPath}`);
        try {
            // Extract project name from path
            const archiveDir = getArchiveDir();
            const relativePath = conversationPath.replace(archiveDir + path.sep, '');
            const project = relativePath.split(path.sep)[0];
            // Parse conversation
            const exchanges = await parseConversation(conversationPath, project, conversationPath);
            if (exchanges.length === 0) {
                console.log(`  Skipped (no exchanges)`);
                continue;
            }
            // Generate/update summary
            const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
            const summary = await summarizeConversation(exchanges);
            fs.writeFileSync(summaryPath, summary, 'utf-8');
            console.log(`  Created summary: ${summary.split(/\s+/).length} words`);
            // Index exchanges
            for (const exchange of exchanges) {
                const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                insertExchange(db, exchange, embedding, toolNames);
            }
            console.log(`  Indexed ${exchanges.length} exchanges`);
        }
        catch (error) {
            console.error(`Failed to re-index ${conversationPath}:`, error);
            db.close();
            throw error;
        }
    }
    db.close();
    // Report corrupted files (manual intervention needed)
    if (issues.corrupted.length > 0) {
        console.log('\n⚠️  Corrupted files (manual review needed):');
        issues.corrupted.forEach(c => console.log(`  ${c.path}: ${c.error}`));
    }
    console.log('✅ Repair complete.');
}
