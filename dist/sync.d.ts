export { shouldSkipConversation } from './record-admission.js';
export interface SyncResult {
    copied: number;
    skipped: number;
    indexed: number;
    summarized: number;
    /** Changed transcripts left for a later run by the whole-operation budget. */
    deferred: number;
    /** Changed transcripts whose single admission would exceed the per-file byte limit. */
    deferredOversize: number;
    /**
     * Transcripts whose current bytes the record policy refuses. The run that
     * first sees a refusal also reports it as an error; later runs hold the
     * unchanged file until it or the policy changes.
     */
    refused: number;
    /** Rewritten transcripts whose indexed archive is kept, because index rows address its lines; reported like refusals. */
    diverged: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
}
/**
 * Bounds for one whole sync operation. Admission screens every new record, so
 * an unbounded run over a large backlog can occupy the scanner for hours.
 * Unset limits are unbounded, which preserves the previous behavior.
 */
export interface SyncLimits {
    /** Transcripts admitted (copied or extended) in this run. */
    maxFiles?: number;
    /** Estimated transcript bytes admitted in this run. */
    maxBytes?: number;
    /** Defer any transcript whose own admission would read more than this. */
    maxFileBytes?: number;
    /** Epoch milliseconds after which no new admission or indexing starts. */
    deadlineMs?: number;
    /**
     * Epoch milliseconds after which no new admission starts, so the rest of the
     * window indexes what was admitted. Defaults to `deadlineMs`.
     */
    admissionDeadlineMs?: number;
}
/** One budget shared by every source directory of a sync run. */
export interface SyncBudget {
    readonly limits: SyncLimits;
    files: number;
    bytes: number;
}
export declare function createSyncBudget(limits?: SyncLimits): SyncBudget;
export interface SyncOptions {
    skipIndex?: boolean;
    skipSummaries?: boolean;
    summaryLimit?: number;
    budget?: SyncBudget;
    /**
     * Replace an indexed archive whose source was rewritten after the archive was
     * written with the admitted rewrite, and rebuild its rows from scratch. A
     * rebuild interrupted after the archive was replaced is finished by the next
     * indexing run.
     */
    replaceDiverged?: boolean;
}
/**
 * Derive sync options from the process environment.
 *
 * `EPISODIC_MEMORY_SKIP_SUMMARIES=1` turns the summarization pass off.
 * Only the exact string '1' enables the switch — unset, '0', 'true',
 * and anything else leave summarization on, so a stray value can't
 * silently disable a feature the user still expects.
 *
 * Why anyone wants this: summaries are display-only. search.ts reads
 * the `-summary.txt` sidecar solely to decorate result output; summary
 * text is never embedded and never searched, so skipping it leaves
 * recall untouched. The summarizer, by contrast, resumes each
 * conversation through the Claude Agent SDK, which spends the user's
 * Claude quota and can stall on a permission prompt.
 */
export declare function buildSyncOptionsFromEnv(env: NodeJS.ProcessEnv): SyncOptions;
export declare function extractSessionIdFromPath(filePath: string): string | null;
export declare function syncConversations(sourceDir: string, destDir: string, options?: SyncOptions): Promise<SyncResult>;
