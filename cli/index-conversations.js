#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

function runScript(command, args, acceptedExitCodes = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, '../dist/index-cli.js'), command, ...args], {
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      if (acceptedExitCodes.includes(code)) {
        process.exitCode = code;
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run command: ${err.message}`));
    });
  });
}

function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

function showHelp() {
  console.log(`index-conversations - Index and manage conversation archives

USAGE:
  index-conversations [COMMAND] [OPTIONS]

COMMANDS:
  (default)      Index all conversations
  --cleanup      Process only unindexed conversations (may generate AI summaries)
  --session ID   Index specific session (used by hook)
  --path PATH    Index one exact native transcript path without AI summaries
  --verify       Check index health
  --verify-page  Run one read-only bounded verification page (JSON; never repairs)
  --repair       Broad repair (may re-embed and generate AI summaries)
  --rebuild      Delete DB and re-index everything (requires confirmation)

OPTIONS:
  --concurrency N    Parallel summarization (1-16, default: 1)
  -c N               Short form of --concurrency
  --no-summaries     Skip AI summary generation (no summary provider calls)
  --after-path PATH  Resume a verification page after an exact archive path
  --max-files N      Maximum archives visited in one page (default: 100)
  --max-file-bytes N Maximum bytes for --path; per-file parse limit for --verify-page (default: 8388608)
  --max-parse-bytes N Maximum total parsed bytes in one page (default: 67108864)
  --help, -h         Show this help

EXAMPLES:
  # Index all unprocessed (recommended for backfill)
  index-conversations --cleanup

  # Index with 8 parallel summarizations (8x faster)
  index-conversations --cleanup --concurrency 8

  # Index without AI summary provider calls
  index-conversations --cleanup --no-summaries

  # Check index health
  index-conversations --verify

  # Bounded page: status 2 means incomplete, even at the final cursor
  index-conversations --verify-page --max-files 100

  # Broad repair requires a separate scope and provider budget decision
  index-conversations --repair

  # Nuclear option (deletes everything, re-indexes)
  index-conversations --rebuild

WORKFLOW:
  1. Initial setup: index-conversations --cleanup
  2. Ongoing: Auto-indexed by sessionEnd hook
  3. Health check: index-conversations --verify (weekly)
  4. Recovery: review exact candidates before any repair

SEE ALSO:
  INDEXING.md - Setup and maintenance guide
  DEPLOYMENT.md - Production runbook`);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;

      case undefined:
        await runScript('index-all', args);
        break;

      case '--session':
        await runScript('index-session', args);
        break;

      case '--path':
        await runScript('index-path', args);
        break;

      case '--cleanup':
        await runScript('index-cleanup', args);
        break;

      case '--verify':
        await runScript('verify', args);
        break;

      case '--verify-page':
        await runScript('verify-page', args, [0, 1, 2]);
        break;

      case '--repair':
        await runScript('repair', args);
        break;

      case '--rebuild':
        console.log('⚠️  This will DELETE the entire database and re-index everything.');
        const confirmed = await askConfirmation('Are you sure? [yes/NO]: ');
        if (confirmed) {
          await runScript('rebuild', args);
        } else {
          console.log('Cancelled');
        }
        break;

      default:
        console.error(`Unknown index command: ${command}. Run --help for supported options.`);
        process.exitCode = 1;
        break;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
