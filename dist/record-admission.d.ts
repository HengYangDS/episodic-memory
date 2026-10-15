import type { ConversationExchange } from './types.js';
/** Scan decoded instruction records without retaining the whole transcript. */
export declare function shouldSkipConversation(filePath: string): boolean;
/** Codex archives finished rollouts as zstd-compressed JSONL. */
export declare function isCompressedConversation(file: string): boolean;
/** Exclusions and archives name a compressed rollout by its uncompressed transcript. */
export declare function conversationTranscriptName(file: string): string;
/** Same fail-closed marker scan as shouldSkipConversation, for compressed transcripts too. */
export declare function conversationHasExclusionMarker(file: string): Promise<boolean>;
/** Decoded physical lines of a plain or compressed transcript, without retaining the whole file. */
export declare function conversationLines(file: string): AsyncGenerator<string>;
interface ExchangeExclusion {
    session_id: string;
    transcript: string;
    line_start: number;
    line_end: number;
}
interface ToolExclusion {
    session_id: string;
    transcript: string;
    call_id: string;
}
export interface RecordExclusions {
    version: 1;
    exchanges: ExchangeExclusion[];
    tool_calls: ToolExclusion[];
    screening?: {
        engine: 'gitleaks';
        executable: string;
        sha256: string;
        timeout_ms: number;
        max_record_bytes: number;
    };
}
export declare function readRecordExclusions(): RecordExclusions | null;
export declare function excludedSession(policy: RecordExclusions | null, sessionId?: string): boolean;
/** Give detection and parsing rewound, admitted cursors without caching their prefix. */
export declare function openConversationAdmission(file: string, policy?: RecordExclusions | null, options?: {
    skipScreening?: boolean;
}): {
    lines(batchRecords?: number): AsyncGenerator<string>;
    close(): Promise<void>;
};
/** Read original inputs without mutation, preserving their physical line numbers. */
export declare function admittedConversationLines(file: string, policy?: RecordExclusions | null, batchRecords?: number): AsyncGenerator<string>;
/** Read the admitted display input without changing original physical coordinates. */
export declare function readAdmittedConversation(file: string, startLine?: number, endLine?: number): Promise<string>;
/** Enforce the same rule for direct callers that bypass transcript parsing. */
export declare function admitExchange(exchange: ConversationExchange, policy?: RecordExclusions | null): ConversationExchange | null;
/**
 * When the record policy file last changed; 0 when there is none. The change
 * time also covers a replacement that kept an older modification time.
 */
export declare function recordExclusionsChangedMs(): number;
/** True when admission refused the content itself, so retrying unchanged bytes cannot succeed. */
export declare function isScreeningRefusal(error: unknown): boolean;
/** True when an existing archive already holds the admitted form of the source's current bytes. */
export declare function archiveIsCurrent(source: string, destination: string, policy?: RecordExclusions | null, policyChangedMs?: number): boolean;
/**
 * True when every record of this archive copy was screened under the current
 * policy. Readers that index such an archive need not screen it again; search
 * output is still screened at the read boundary.
 */
export declare function archiveScreenedUnderPolicy(archive: string, archiveRoot: string, policy?: RecordExclusions | null, policyChangedMs?: number): boolean;
/** Publish only admitted bytes. Never write an unfiltered temporary copy. */
export declare function archiveAdmittedConversation(source: string, destination: string, policy?: RecordExclusions | null): Promise<boolean>;
/** Request-local admission: retained search rows are not trusted merely because they were indexed. */
export declare function createSearchAdmission(): {
    admit(exchange: ConversationExchange): ConversationExchange | null;
    summary(exchange: ConversationExchange, text: string): string | undefined;
    verify(): void;
};
export {};
