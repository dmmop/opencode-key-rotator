export type KeyStoreErrorCode =
  | "FINGERPRINT_MISMATCH"
  | "BUSY"
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "LOCK_RACE"
  | "INVALID_INPUT"
  | "DB_INVALID"
  | "DB_SCHEMA"
  | "DB_ERROR"
  | "CREDENTIAL_INVALID"
  | "NOT_CONNECTED"
  | "ACTIVE_ALIAS"
  | "ALIAS_COLLISION"
  | "STALE_METADATA"
  | "MIGRATION_EMPTY";

export class KeyStoreError extends Error {
  constructor(
    public readonly code: KeyStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KeyStoreError";
  }
}
