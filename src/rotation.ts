import { KeyStoreError } from "./errors.js";
import type { KeyStore } from "./key-store.js";
import { writeRotationLog, type RotationLogEntry } from "./rotation-log.js";

const DEFAULT_COOLDOWN_MS = 2 * 60 * 1_000;
const cooldownsByProvider = new Map<string, Map<string, number>>();

type RotationEntry = Omit<
  RotationLogEntry,
  | "decision"
  | "reason"
  | "activeAlias"
  | "nextAlias"
  | "coolingDownAlias"
  | "cooldownEnteredAt"
  | "cooldownExpiresAt"
  | "cooldownMs"
  | "cooldownState"
>;

export function rotateProvider(
  store: KeyStore,
  providerID: string,
  entry: RotationEntry,
  decision: Extract<RotationLogEntry["decision"], "rotated" | "rotated_on_retry">,
): void {
  const aliases = store.listKeys(providerID).map((key) => key.alias);
  if (aliases.length < 2) {
    log(store, entry, "no_alternative", "provider_has_less_than_two_saved_keys");
    return;
  }

  const activeAlias = store.readActiveAliases()[providerID];
  const cooldownKey = `${store.paths.dataDir}\0${providerID}`;
  if (activeAlias) {
    const cooldownMs = computeCooldownMs(entry.rateLimitHeaders);
    const expiresAt = markCoolingDown(cooldownKey, activeAlias, cooldownMs);
    log(store, entry, "diagnostic", "alias_entered_cooldown", {
      coolingDownAlias: activeAlias,
      cooldownEnteredAt: new Date().toISOString(),
      cooldownExpiresAt: new Date(expiresAt).toISOString(),
      cooldownMs,
    });
  }

  const available = aliasesOutsideCooldown(cooldownKey, aliases, activeAlias);
  if (available.length === 0) {
    const state = [...(cooldownsByProvider.get(cooldownKey) ?? [])]
      .map(([alias, expiresAt]) => `${alias}: expires ${new Date(expiresAt).toISOString()}`)
      .join(", ");
    log(store, entry, "all_keys_cooling_down", "all_saved_keys_are_cooling_down", {
      activeAlias,
      cooldownState: state || undefined,
    });
    return;
  }

  try {
    const result = store.switchProviderKeyToNext(providerID, available, "auto-rotate");
    if (!result) {
      log(store, entry, "all_keys_cooling_down", "no_available_alias_after_concurrent_change", { activeAlias });
      return;
    }
    log(store, entry, decision, "matched_rotation_patterns", {
      activeAlias: result.previousAlias,
      nextAlias: result.activeAlias,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fingerprintMismatch = message.includes("no longer match alias");
    log(
      store,
      { ...entry, message: `${entry.message ?? ""}\nrotation_error=${message}` },
      fingerprintMismatch ? "fingerprint_mismatch" : "error",
      fingerprintMismatch
        ? "active_credentials_changed_outside_plugin"
        : error instanceof KeyStoreError
          ? "key_store_error"
          : "unexpected_rotation_error",
      { activeAlias: readActiveAlias(store, providerID) },
    );
  }
}

function computeCooldownMs(headers: Record<string, string> | undefined): number {
  const value = headers?.["retry-after"];
  if (!value) return DEFAULT_COOLDOWN_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(DEFAULT_COOLDOWN_MS, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? DEFAULT_COOLDOWN_MS : Math.max(DEFAULT_COOLDOWN_MS, date - Date.now());
}

function markCoolingDown(key: string, alias: string, duration: number): number {
  const provider = cooldownsByProvider.get(key) ?? new Map<string, number>();
  const expiresAt = Date.now() + duration;
  provider.set(alias, expiresAt);
  cooldownsByProvider.set(key, provider);
  return expiresAt;
}

function aliasesOutsideCooldown(key: string, aliases: string[], activeAlias: string | undefined): string[] {
  const provider = cooldownsByProvider.get(key);
  const now = Date.now();
  if (provider) {
    for (const [alias, expiresAt] of provider) if (expiresAt <= now) provider.delete(alias);
    if (provider.size === 0) cooldownsByProvider.delete(key);
  }
  return aliases.filter((alias) => alias !== activeAlias && !provider?.has(alias));
}

function readActiveAlias(store: KeyStore, providerID: string): string | undefined {
  try {
    return store.readActiveAliases()[providerID];
  } catch {
    return undefined;
  }
}

function log(
  store: KeyStore,
  entry: RotationEntry,
  decision: RotationLogEntry["decision"],
  reason: string,
  details: Partial<RotationLogEntry> = {},
): void {
  writeRotationLog(store, { ...entry, decision, reason, ...details });
}
