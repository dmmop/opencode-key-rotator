import type { KeyStore } from "./key-store.js";
export type RotationDecision = "rotated" | "not_rotatable" | "no_alternative" | "provider_unknown" | "ignored" | "error" | "fingerprint_mismatch";
export type RotationLogEntry = {
    timestamp: string;
    providerID?: string;
    providerSource?: string;
    errorName?: string;
    statusCode?: number;
    message?: string;
    rateLimitHeaders?: Record<string, string>;
    decision: RotationDecision;
    reason: string;
    activeAlias?: string;
    nextAlias?: string;
};
export declare function writeRotationLog(store: KeyStore, entry: RotationLogEntry): void;
export declare function readLastRotationDecision(store: KeyStore): RotationLogEntry | undefined;
export declare function sanitizeMessage(message: string | undefined): string | undefined;
export declare function sanitizeRateLimitHeaders(headers: unknown): Record<string, string> | undefined;
