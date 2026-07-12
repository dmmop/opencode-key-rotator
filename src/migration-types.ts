import * as crypto from "node:crypto";
import type { CredentialValue } from "./opencode-credential-db.js";
export type JsonObject = Record<string, unknown>;
export function calculateFingerprintForCredential(value: CredentialValue | JsonObject): { hash: string } {
  const record = value as JsonObject;
  const type = String(record.type);
  const material =
    type === "key"
      ? `${type}\0${String(record.key ?? "")}`
      : `${type}\0${String(record.methodID ?? "")}\0${String((record.metadata as JsonObject | undefined)?.accountID ?? record.refresh ?? "")}\0${String(record.access ?? "")}`;
  return { hash: crypto.createHash("sha256").update(material).digest("hex") };
}
