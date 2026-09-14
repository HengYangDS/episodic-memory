import type { ConversationExchange } from './types.js';
/**
 * Stream and scan for any exclusion marker, carrying an overlap between
 * chunks so a marker split across a boundary is still found. A single
 * fs.readFileSync(path, 'utf-8') throws ERR_STRING_TOO_LONG above Node's
 * ~512 MB max string length; the old catch returned false (fail OPEN),
 * silently indexing a file whose DO NOT INDEX marker we never read (#152).
 * Streaming confirms cleanliness at any size, and a real read error now
 * fails CLOSED (skip) rather than open.
 */
export declare function shouldSkipConversation(filePath: string): boolean;
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
}
export declare function readRecordExclusions(): RecordExclusions | null;
export declare function excludedSession(policy: RecordExclusions | null, sessionId?: string): boolean;
/** Read original inputs without mutation, preserving their physical line numbers. */
export declare function admittedConversationLines(file: string, policy?: RecordExclusions | null): AsyncGenerator<string>;
/** Read the admitted display input without changing original physical coordinates. */
export declare function readAdmittedConversation(file: string): Promise<string>;
/** Enforce the same rule for direct callers that bypass transcript parsing. */
export declare function admitExchange(exchange: ConversationExchange, policy?: RecordExclusions | null): ConversationExchange | null;
/** Publish only admitted bytes. Never write an unfiltered temporary copy. */
export declare function archiveAdmittedConversation(source: string, destination: string, policy?: RecordExclusions | null): Promise<boolean>;
export {};
