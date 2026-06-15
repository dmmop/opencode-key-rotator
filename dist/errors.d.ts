export type KeyStoreErrorCode = "FINGERPRINT_MISMATCH" | "BUSY" | "AUTH_MISSING" | "AUTH_INVALID" | "BACKUP_FAILED" | "LOCK_RACE" | "INVALID_INPUT";
export declare class KeyStoreError extends Error {
    readonly code: KeyStoreErrorCode;
    constructor(code: KeyStoreErrorCode, message: string);
}
