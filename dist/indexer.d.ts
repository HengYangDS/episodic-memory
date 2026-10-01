/** Index one native source transcript without scanning sibling files or generating a summary. */
export declare function indexExactPath(filePath: string, maxFileBytes?: number): Promise<void>;
export declare function indexConversations(limitToProject?: string, maxConversations?: number, concurrency?: number, noSummaries?: boolean): Promise<void>;
export declare function indexSession(sessionId: string, concurrency?: number, noSummaries?: boolean): Promise<void>;
export declare function indexUnprocessed(concurrency?: number, noSummaries?: boolean): Promise<void>;
