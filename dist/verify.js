import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { parseConversation } from './parser.js';
import { getAllExchanges } from './db.js';
import { getArchiveDir, getDbPath, getExcludedProjects, findJsonlFiles, statIfExists } from './paths.js';
import { isErroredSentinel } from './summary-sentinel.js';
import { readRecordExclusions } from './record-admission.js';
export async function verifyIndex() {
    const result = {
        checkedFiles: 0,
        parsedFiles: 0,
        missing: [],
        unindexed: [],
        orphaned: [],
        outdated: [],
        archiveRefreshes: [],
        screeningRejected: [],
        screeningUnavailable: [],
        corrupted: []
    };
    const archiveDir = getArchiveDir();
    // Track all files we find
    const foundFiles = new Set();
    // Find all conversation files
    if (!fs.existsSync(archiveDir)) {
        return result;
    }
    // Verification is read-only, including when the index does not yet exist.
    const dbPath = getDbPath();
    const db = fs.existsSync(dbPath) ? new Database(dbPath, { readonly: true, fileMustExist: true }) : null;
    const indexStateRows = db?.prepare(`
    SELECT archive_path AS archivePath, MAX(line_end) AS maxLineEnd, MAX(last_indexed) AS lastIndexed
    FROM exchanges GROUP BY archive_path
  `).all();
    const indexState = new Map(indexStateRows?.map(row => [row.archivePath, row]) ?? []);
    const projects = fs.readdirSync(archiveDir);
    const excludedProjects = getExcludedProjects();
    const excludedDirSet = new Set(excludedProjects);
    try {
        for (const project of projects) {
            if (excludedProjects.includes(project)) {
                console.log("\nSkipping excluded project: " + project);
                continue;
            }
            const projectPath = path.join(archiveDir, project);
            const stat = statIfExists(projectPath);
            if (!stat?.isDirectory())
                continue;
            const files = findJsonlFiles(projectPath, excludedDirSet);
            for (const file of files) {
                result.checkedFiles++;
                if (result.checkedFiles % 100 === 0) {
                    console.log(`  Checked ${result.checkedFiles} conversations...`);
                }
                const conversationPath = path.join(projectPath, file);
                foundFiles.add(conversationPath);
                const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
                const summaryMissing = !fs.existsSync(summaryPath)
                    ? 'No summary file'
                    : isErroredSentinel(fs.readFileSync(summaryPath, 'utf-8'))
                        ? 'Previous summarization failed (error sentinel)' : null;
                if (summaryMissing)
                    result.missing.push({ path: conversationPath, reason: summaryMissing });
                const state = indexState.get(conversationPath);
                if (!state) {
                    result.unindexed.push({ path: conversationPath });
                    continue;
                }
                const fileTime = fs.statSync(conversationPath).mtimeMs;
                // Routine verification parses only timestamp-divergent archives. This
                // keeps high-water classification bounded on large historical corpora.
                if (state.lastIndexed !== null && fileTime <= state.lastIndexed)
                    continue;
                result.parsedFiles++;
                try {
                    const exchanges = await parseConversation(conversationPath, project, conversationPath);
                    if (exchanges.some(exchange => exchange.lineEnd > state.maxLineEnd)) {
                        result.outdated.push({ path: conversationPath, fileTime, dbTime: state.lastIndexed ?? 0 });
                    }
                    else if (state.lastIndexed !== null && fileTime > state.lastIndexed) {
                        result.archiveRefreshes.push({ path: conversationPath, fileTime, dbTime: state.lastIndexed });
                    }
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (message === 'Record content rejected by screening' || message === 'Record screening byte limit exceeded') {
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
        }
        console.log(`Checked ${result.checkedFiles} conversations; parsed ${result.parsedFiles} changed archives.`);
        // Rows may refer directly to active or archived source sessions. They are
        // orphaned only when their source is absent, not when it is outside the archive.
        for (const exchange of db ? getAllExchanges(db) : []) {
            if (!foundFiles.has(exchange.archivePath) && !statIfExists(exchange.archivePath)?.isFile()) {
                result.orphaned.push({
                    uuid: exchange.id,
                    path: exchange.archivePath
                });
            }
        }
    }
    finally {
        db?.close();
    }
    return result;
}
export async function repairIndex(issues) {
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
