export type KeyStoreErrorCode =
  | "BUSY"
  | "INVALID_INPUT"
  | "DB_INVALID"
  | "DB_SCHEMA"
  | "DB_ERROR"
  | "CREDENTIAL_INVALID"
  | "NOT_CONNECTED"
  | "ACTIVE_ALIAS"
  | "ALIAS_COLLISION";

export class KeyStoreError extends Error {
  constructor(
    public readonly code: KeyStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KeyStoreError";
  }
}
