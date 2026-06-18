import type { Plugin } from "@opencode-ai/plugin";
import { resolveOpencodeDataDir } from "./opencode-runtime-paths.js";
import { KeyStoreError } from "./errors.js";
import { createKeyStore, type KeyStore } from "./key-store.js";
import { sanitizeMessage, sanitizeRateLimitHeaders, writeRotationLog, type RotationLogEntry } from "./rotation-log.js";
import { loadConfig, type KeyRotatorConfig } from "./config.js";

type ErrorInfo = {
  name?: string;
  providerID?: string;
  providerSource?: ProviderSource;
  statusCode?: number;
  message?: string;
  headers?: Record<string, string>;
};

type ProviderSource = "error" | "session_message_assistant" | "session_message_user" | "config_model";

type InferredProvider = {
  providerID: string;
  source: ProviderSource;
};

type RotationRequest = {
  sessionID?: string;
  store?: KeyStore;
  info: ErrorInfo;
  timestamp: string;
  decision: Extract<RotationLogEntry["decision"], "rotated" | "rotated_on_retry">;
  unknownProviderReason: string;
  toastOnSkip: boolean;
};

// Track sessions for which we have already rotated a key, so we do not rotate
// again when the final session.error arrives after retries.
const rotatedSessions = new Map<string, number>();
const CLIENT_CALL_TIMEOUT_MS = 1_000;
const FAILED_ALIAS_COOLDOWN_MS = 2 * 60 * 1_000;
const failedAliasCooldowns = new Map<string, Map<string, number>>();

export const server: Plugin = async ({ client }) => {
  const config = await loadConfigForClient(client);
  if (!config.rotation.enabled) {
    return { event: async () => {} };
  }

  return {
    event: async ({ event }) => {
      const genericEvent = event as { type: string; properties?: Record<string, unknown> };

      if (genericEvent.type === "session.next.retried") {
        await handleSessionNextRetried(client, config, genericEvent.properties);
        return;
      }

      if (genericEvent.type !== "session.error") return;

      await handleSessionError(client, config, genericEvent.properties);
    },
  };
};

async function handleSessionNextRetried(
  client: Parameters<Plugin>[0]["client"],
  config: KeyRotatorConfig,
  properties: Record<string, unknown> | undefined,
): Promise<void> {
  const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
  const attempt = typeof properties?.attempt === "number" ? properties.attempt : undefined;
  const error = properties?.error;
  const message = isRecord(error) && typeof error.message === "string" ? error.message : undefined;

  if (!sessionID || attempt !== 1) return;
  if (!message || !isRotatableMessage(message, config)) return;
  if (wasRotatedRecently(config, sessionID)) return;

  const timestamp = new Date().toISOString();

  await rotateKeyForEvent(client, config, {
    sessionID,
    info: { message },
    timestamp,
    decision: "rotated_on_retry",
    unknownProviderReason: "rotatable_retry_without_provider_id",
    toastOnSkip: false,
  });
}

async function handleSessionError(
  client: Parameters<Plugin>[0]["client"],
  config: KeyRotatorConfig,
  properties: Record<string, unknown> | undefined,
): Promise<void> {
  const error = properties?.error;
  const info = normalizeError(error);
  const timestamp = new Date().toISOString();
  const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;

  const store = await createStoreForClient(client, config);
  if (!store) {
    await showToast(client, config, "Key rotation skipped", "OpenCode data path is unavailable.", "warning");
    return;
  }

  if (info.name === "MessageAbortedError") {
    writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "ignored", reason: "manual_abort" });
    return;
  }

  if (!isRotatableError(info, config)) {
    writeRotationLog(store, {
      ...baseLogEntry(info, timestamp),
      decision: "not_rotatable",
      reason: "error_did_not_match_rotation_patterns",
    });
    return;
  }

  await rotateKeyForEvent(client, config, {
    sessionID,
    store,
    info,
    timestamp,
    decision: "rotated",
    unknownProviderReason: "rotatable_error_without_provider_id",
    toastOnSkip: true,
  });
}

async function rotateKeyForEvent(
  client: Parameters<Plugin>[0]["client"],
  config: KeyRotatorConfig,
  request: RotationRequest,
): Promise<void> {
  const store = request.store ?? (await createStoreForClient(client, config));
  if (!store) {
    if (request.toastOnSkip) await showToast(client, config, "Key rotation skipped", "OpenCode data path is unavailable.", "warning");
    return;
  }

  if (request.sessionID && wasRotatedRecently(config, request.sessionID)) return;

  if (!request.info.providerID) {
    const inferred = await inferProvider(client, request.sessionID);
    if (inferred) {
      request.info.providerID = inferred.providerID;
      request.info.providerSource = inferred.source;
    }
  }

  if (!request.info.providerID) {
    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: "provider_unknown",
      reason: request.unknownProviderReason,
    });
    if (request.toastOnSkip) await showToast(client, config, "Key rotation skipped", "Provider could not be determined.", "warning");
    return;
  }

  const providerID = request.info.providerID;
  const keys = store.listKeys(providerID);
  if (keys.length < 2) {
    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: "no_alternative",
      reason: "provider_has_less_than_two_saved_keys",
    });
    if (request.toastOnSkip) await showToast(client, config, "Key rotation skipped", `${providerID} has no alternative key.`, "warning");
    return;
  }

  const currentAlias = store.readActiveAliases()[providerID];
  if (currentAlias) markAliasCoolingDown(providerID, currentAlias);

  const nextAlias = nextAvailableAlias(
    providerID,
    keys.map((key) => key.alias),
    currentAlias,
  );
  if (!nextAlias) {
    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: "all_keys_cooling_down",
      reason: "all_saved_keys_are_cooling_down",
      activeAlias: currentAlias,
    });
    if (request.toastOnSkip)
      await showToast(client, config, "Key rotation skipped", `${providerID} has no available key outside cooldown.`, "warning");
    return;
  }

  try {
    const result = store.switchProviderKey(providerID, nextAlias, "auto-rotate");

    if (request.sessionID) markRotated(config, request.sessionID);
    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: request.decision,
      reason: "matched_rotation_patterns",
      activeAlias: result.previousAlias,
      nextAlias: result.activeAlias,
    });
    await showToast(
      client,
      config,
      "Key rotated",
      `${providerID}: ${result.previousAlias ?? "unknown"} -> ${result.activeAlias}`,
      "success",
    );
  } catch (rotationError) {
    await logRotationError(
      client,
      config,
      store,
      request.info.providerID,
      request.info.providerSource,
      request.info.message,
      request.timestamp,
      rotationError,
    );
  }
}

function markAliasCoolingDown(providerID: string, alias: string): void {
  let providerCooldowns = failedAliasCooldowns.get(providerID);
  if (!providerCooldowns) {
    providerCooldowns = new Map<string, number>();
    failedAliasCooldowns.set(providerID, providerCooldowns);
  }
  providerCooldowns.set(alias, Date.now() + FAILED_ALIAS_COOLDOWN_MS);
}

function nextAvailableAlias(providerID: string, aliases: string[], currentAlias: string | undefined): string | undefined {
  const providerCooldowns = failedAliasCooldowns.get(providerID);
  const now = Date.now();
  if (providerCooldowns) {
    for (const [alias, cooldownUntil] of providerCooldowns) {
      if (cooldownUntil <= now) providerCooldowns.delete(alias);
    }
    if (providerCooldowns.size === 0) failedAliasCooldowns.delete(providerID);
  }

  const currentIndex = currentAlias ? aliases.indexOf(currentAlias) : -1;
  for (let offset = 1; offset <= aliases.length; offset += 1) {
    const alias = aliases[(currentIndex + offset + aliases.length) % aliases.length];
    if (alias !== currentAlias && !providerCooldowns?.has(alias)) return alias;
  }
  return undefined;
}

function baseLogEntry(info: ErrorInfo, timestamp: string): Omit<RotationLogEntry, "decision" | "reason"> {
  return {
    timestamp,
    providerID: info.providerID,
    providerSource: info.providerSource,
    errorName: info.name,
    statusCode: info.statusCode,
    message: info.message,
    rateLimitHeaders: sanitizeRateLimitHeaders(info.headers),
  };
}

async function logRotationError(
  client: Parameters<Plugin>[0]["client"],
  config: KeyRotatorConfig,
  store: KeyStore,
  providerID: string,
  providerSource: ProviderSource | undefined,
  message: string | undefined,
  timestamp: string,
  rotationError: unknown,
): Promise<void> {
  const errorMessage = rotationError instanceof Error ? rotationError.message : String(rotationError);
  const activeAlias = readActiveAliasSafely(store, providerID);
  const fingerprintMismatch = errorMessage.includes("no longer match alias");
  writeRotationLog(store, {
    timestamp,
    providerID,
    providerSource,
    message: `${message ?? ""}\nrotation_error=${errorMessage}`,
    decision: fingerprintMismatch ? "fingerprint_mismatch" : "error",
    reason: fingerprintMismatch
      ? "active_credentials_changed_outside_plugin"
      : rotationError instanceof KeyStoreError
        ? "key_store_error"
        : "unexpected_rotation_error",
    activeAlias,
  });
  await showToast(client, config, "Key rotation failed", sanitizeMessage(errorMessage) ?? "Unknown error", "error");
}

function normalizeError(error: unknown): ErrorInfo {
  if (!error || typeof error !== "object") return { message: String(error) };
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined;

  return {
    name,
    providerID: typeof data?.providerID === "string" ? data.providerID : undefined,
    providerSource: typeof data?.providerID === "string" ? "error" : undefined,
    statusCode: typeof data?.statusCode === "number" ? data.statusCode : undefined,
    message: typeof data?.message === "string" ? data.message : errorToMessage(error),
    headers:
      data?.responseHeaders && typeof data.responseHeaders === "object" ? (data.responseHeaders as Record<string, string>) : undefined,
  };
}

async function inferProvider(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string | undefined,
): Promise<InferredProvider | undefined> {
  const fromSession = sessionID ? await inferProviderFromMessages(client, sessionID) : undefined;
  if (fromSession) return fromSession;
  return inferProviderFromConfig(client);
}

async function inferProviderFromMessages(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string,
): Promise<InferredProvider | undefined> {
  try {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { limit: 10 },
    });
    const messages = extractData(response);
    if (!Array.isArray(messages)) return undefined;

    for (const entry of [...messages].reverse()) {
      const message = isRecord(entry) && isRecord(entry.info) ? entry.info : entry;
      if (!isRecord(message)) continue;
      if (message.role === "assistant" && typeof message.providerID === "string") {
        return { providerID: message.providerID, source: "session_message_assistant" };
      }
      if (message.role === "user" && isRecord(message.model) && typeof message.model.providerID === "string") {
        return { providerID: message.model.providerID, source: "session_message_user" };
      }
    }
  } catch {
    // Fall back to config model below.
  }
  return undefined;
}

async function inferProviderFromConfig(client: Parameters<Plugin>[0]["client"]): Promise<InferredProvider | undefined> {
  try {
    const config = extractData(await client.config.get());
    if (!isRecord(config) || typeof config.model !== "string") return undefined;
    const providerID = config.model.split("/")[0];
    return providerID ? { providerID, source: "config_model" } : undefined;
  } catch {
    return undefined;
  }
}

async function loadConfigForClient(client: Parameters<Plugin>[0]["client"]): Promise<KeyRotatorConfig> {
  try {
    const pathResponse = extractData(await withTimeout(client.path.get(), CLIENT_CALL_TIMEOUT_MS));
    const configDir = isRecord(pathResponse) && typeof pathResponse.config === "string" ? pathResponse.config : undefined;
    return loadConfig(configDir ? { configDir } : undefined);
  } catch {
    return loadConfig();
  }
}

async function createStoreForClient(client: Parameters<Plugin>[0]["client"], config: KeyRotatorConfig): Promise<KeyStore | undefined> {
  try {
    const pathResponse = extractData(await withTimeout(client.path.get(), CLIENT_CALL_TIMEOUT_MS));
    if (!isRecord(pathResponse) || typeof pathResponse.state !== "string") return undefined;
    return createKeyStore(resolveOpencodeDataDir(pathResponse), config);
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("client call timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readActiveAliasSafely(store: KeyStore, providerID: string | undefined): string | undefined {
  if (!providerID) return undefined;
  try {
    return store.readActiveAliases()[providerID];
  } catch {
    return undefined;
  }
}

function extractData(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRotatableError(info: ErrorInfo, config: KeyRotatorConfig): boolean {
  if (info.name === "MessageOutputLengthError") return false;
  if (info.statusCode === 429) return true;
  return isRotatableMessage(info.message, config);
}

function isRotatableMessage(message: string | undefined, config: KeyRotatorConfig): boolean {
  if (!message) return false;
  return config.rotation.patterns.some((pattern) => pattern.test(message));
}

function errorToMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return undefined;
  }
}

async function showToast(
  client: Parameters<Plugin>[0]["client"],
  config: KeyRotatorConfig,
  title: string,
  message: string,
  variant: "info" | "success" | "warning" | "error",
): Promise<void> {
  try {
    await client.tui.showToast({
      body: { title, message, variant, duration: config.ui.toastDurationMs },
    });
  } catch {
    console.warn(`[opencode-key-rotator] ${title}: ${message}`);
  }
}

function markRotated(config: KeyRotatorConfig, sessionID: string): void {
  rotatedSessions.set(sessionID, Date.now());
  cleanupRotatedSessions(config);
}

function wasRotatedRecently(config: KeyRotatorConfig, sessionID: string | undefined): boolean {
  if (!sessionID) return false;
  const timestamp = rotatedSessions.get(sessionID);
  if (!timestamp) return false;
  if (Date.now() - timestamp > config.rotation.dedupTtlMs) {
    rotatedSessions.delete(sessionID);
    return false;
  }
  return true;
}

function cleanupRotatedSessions(config: KeyRotatorConfig): void {
  const now = Date.now();
  for (const [sessionID, timestamp] of rotatedSessions) {
    if (now - timestamp > config.rotation.dedupTtlMs) rotatedSessions.delete(sessionID);
  }
}
