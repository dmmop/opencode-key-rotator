export type KeyStoreErrorCode = "FINGERPRINT_MISMATCH" | "BUSY" | "AUTH_MISSING" | "AUTH_INVALID" | "LOCK_RACE" | "INVALID_INPUT";

export class KeyStoreError extends Error {
  constructor(
    public readonly code: KeyStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KeyStoreError";
  }
}
