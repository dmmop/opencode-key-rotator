import type { Plugin } from "@opencode-ai/plugin"
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js"
import { KeyStoreError } from "./errors.js"
import { createKeyStore, type KeyStore } from "./key-store.js"
import { sanitizeMessage, sanitizeRateLimitHeaders, writeRotationLog, type RotationLogEntry } from "./rotation-log.js"

type ErrorInfo = {
  name?: string
  providerID?: string
  providerSource?: ProviderSource
  statusCode?: number
  message?: string
  headers?: Record<string, string>
}

type ProviderSource = "error" | "session_message_assistant" | "session_message_user" | "config_model"

type InferredProvider = {
  providerID: string
  source: ProviderSource
}

const ROTATABLE_MESSAGE_PATTERNS = [
  /\b429\b/i,
  /rate\s*limit/i,
  /too many requests/i,
  /quota/i,
  /resource exhausted/i,
  /usage limit/i,
  /requests per minute/i,
  /tokens per minute/i,
  /insufficient quota/i,
]

const ROTATION_DEDUP_TTL_MS = 5 * 60 * 1000

// Track sessions for which we have already rotated a key, so we do not rotate
// again when the final session.error arrives after retries.
const rotatedSessions = new Map<string, number>()

export const server: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      const genericEvent = event as { type: string; properties?: Record<string, unknown> }

      if (genericEvent.type === "session.next.retried") {
        await handleSessionNextRetried(client, genericEvent.properties)
        return
      }

      if (genericEvent.type !== "session.error") return

      await handleSessionError(client, genericEvent.properties)
    },
  }
}

async function handleSessionNextRetried(
  client: Parameters<Plugin>[0]["client"],
  properties: Record<string, unknown> | undefined,
): Promise<void> {
  const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined
  const attempt = typeof properties?.attempt === "number" ? properties.attempt : undefined
  const error = properties?.error
  const message = isRecord(error) && typeof error.message === "string" ? error.message : undefined

  if (!sessionID || attempt !== 1) return
  if (!message || !isRotatableMessage(message)) return
  if (wasRotatedRecently(sessionID)) return

  const dataDir = await resolveDataDir(client)
  if (!dataDir) return
  const store = createKeyStore(dataDir)
  const timestamp = new Date().toISOString()

  const inferred = await inferProvider(client, sessionID)
  if (!inferred) {
    writeRotationLog(store, {
      timestamp,
      message,
      decision: "provider_unknown",
      reason: "rotatable_retry_without_provider_id",
    })
    return
  }

  if (!store.hasAlternativeKey(inferred.providerID)) {
    writeRotationLog(store, {
      timestamp,
      providerID: inferred.providerID,
      providerSource: inferred.source,
      message,
      decision: "no_alternative",
      reason: "provider_has_less_than_two_saved_keys",
    })
    return
  }

  try {
    const result = store.rotateProviderKey(inferred.providerID)
    if (!result) return

    markRotated(sessionID)
    writeRotationLog(store, {
      timestamp,
      providerID: inferred.providerID,
      providerSource: inferred.source,
      message,
      decision: "rotated_on_retry",
      reason: "matched_rotation_patterns",
      activeAlias: result.previousAlias,
      nextAlias: result.activeAlias,
    })
    await showToast(client, "Key rotated", `${inferred.providerID}: ${result.previousAlias ?? "unknown"} -> ${result.activeAlias}`, "success")
  } catch (rotationError) {
    await logRotationError(client, store, inferred.providerID, inferred.source, message, timestamp, rotationError)
  }
}


async function handleSessionError(
  client: Parameters<Plugin>[0]["client"],
  properties: Record<string, unknown> | undefined,
): Promise<void> {
  const error = properties?.error
  const info = normalizeError(error)
  const timestamp = new Date().toISOString()
  const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined

  const dataDir = await resolveDataDir(client)
  if (!dataDir) {
    await showToast(client, "Key rotation skipped", "OpenCode data path is unavailable.", "warning")
    return
  }
  const store = createKeyStore(dataDir)

  if (sessionID && wasRotatedRecently(sessionID)) {
    // Already rotated during a retry; nothing more to do.
    return
  }

  if (info.name === "MessageAbortedError") {
    writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "ignored", reason: "manual_abort" })
    return
  }

  if (!isRotatableError(info)) {
    writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "not_rotatable", reason: "error_did_not_match_rotation_patterns" })
    return
  }

  if (!info.providerID) {
    const inferred = await inferProvider(client, sessionID)
    if (inferred) {
      info.providerID = inferred.providerID
      info.providerSource = inferred.source
    }
  }

  if (!info.providerID) {
    writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "provider_unknown", reason: "rotatable_error_without_provider_id" })
    await showToast(client, "Key rotation skipped", "Provider could not be determined.", "warning")
    return
  }

  if (!store.hasAlternativeKey(info.providerID)) {
    writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "no_alternative", reason: "provider_has_less_than_two_saved_keys" })
    await showToast(client, "Key rotation skipped", `${info.providerID} has no alternative key.`, "warning")
    return
  }

  try {
    const result = store.rotateProviderKey(info.providerID)
    if (!result) return

    if (sessionID) markRotated(sessionID)
    writeRotationLog(store, {
      ...baseLogEntry(info, timestamp),
      decision: "rotated",
      reason: "matched_rotation_patterns",
      activeAlias: result.previousAlias,
      nextAlias: result.activeAlias,
    })
    await showToast(client, "Key rotated", `${info.providerID}: ${result.previousAlias ?? "unknown"} -> ${result.activeAlias}`, "success")
  } catch (rotationError) {
    await logRotationError(client, store, info.providerID, info.providerSource, info.message, timestamp, rotationError)
  }
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
  }
}

async function logRotationError(
  client: Parameters<Plugin>[0]["client"],
  store: KeyStore,
  providerID: string,
  providerSource: ProviderSource | undefined,
  message: string | undefined,
  timestamp: string,
  rotationError: unknown,
): Promise<void> {
  const errorMessage = rotationError instanceof Error ? rotationError.message : String(rotationError)
  const activeAlias = readActiveAliasSafely(store, providerID)
  const fingerprintMismatch = errorMessage.includes("no longer match alias")
  writeRotationLog(store, {
    timestamp,
    providerID,
    providerSource,
    message: `${message ?? ""}\nrotation_error=${errorMessage}`,
    decision: fingerprintMismatch ? "fingerprint_mismatch" : "error",
    reason: fingerprintMismatch ? "active_credentials_changed_outside_plugin" : rotationError instanceof KeyStoreError ? "key_store_error" : "unexpected_rotation_error",
    activeAlias,
  })
  await showToast(client, "Key rotation failed", sanitizeMessage(errorMessage) ?? "Unknown error", "error")
}

function normalizeError(error: unknown): ErrorInfo {
  if (!error || typeof error !== "object") return { message: String(error) }
  const record = error as Record<string, unknown>
  const name = typeof record.name === "string" ? record.name : undefined
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined

  return {
    name,
    providerID: typeof data?.providerID === "string" ? data.providerID : undefined,
    providerSource: typeof data?.providerID === "string" ? "error" : undefined,
    statusCode: typeof data?.statusCode === "number" ? data.statusCode : undefined,
    message: typeof data?.message === "string" ? data.message : errorToMessage(error),
    headers: data?.responseHeaders && typeof data.responseHeaders === "object" ? data.responseHeaders as Record<string, string> : undefined,
  }
}

async function inferProvider(client: Parameters<Plugin>[0]["client"], sessionID: string | undefined): Promise<InferredProvider | undefined> {
  const fromSession = sessionID ? await inferProviderFromMessages(client, sessionID) : undefined
  if (fromSession) return fromSession
  return inferProviderFromConfig(client)
}

async function inferProviderFromMessages(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string,
): Promise<InferredProvider | undefined> {
  try {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { limit: 10 },
    })
    const messages = extractData(response)
    if (!Array.isArray(messages)) return undefined

    for (const entry of [...messages].reverse()) {
      const message = isRecord(entry) && isRecord(entry.info) ? entry.info : entry
      if (!isRecord(message)) continue
      if (message.role === "assistant" && typeof message.providerID === "string") {
        return { providerID: message.providerID, source: "session_message_assistant" }
      }
      if (message.role === "user" && isRecord(message.model) && typeof message.model.providerID === "string") {
        return { providerID: message.model.providerID, source: "session_message_user" }
      }
    }
  } catch {
    // Fall back to config model below.
  }
  return undefined
}

async function inferProviderFromConfig(client: Parameters<Plugin>[0]["client"]): Promise<InferredProvider | undefined> {
  try {
    const config = extractData(await client.config.get())
    if (!isRecord(config) || typeof config.model !== "string") return undefined
    const providerID = config.model.split("/")[0]
    return providerID ? { providerID, source: "config_model" } : undefined
  } catch {
    return undefined
  }
}

async function resolveDataDir(client: Parameters<Plugin>[0]["client"]): Promise<string | undefined> {
  try {
    const pathResponse = extractData(await client.path.get())
    if (!isRecord(pathResponse) || typeof pathResponse.state !== "string") return undefined
    // Validate that OpenCode runtime paths are available, then derive the data
    // directory using the same XDG logic OpenCode uses.
    return getOpencodeRuntimeDirs().dataDir
  } catch {
    return undefined
  }
}

function readActiveAliasSafely(store: KeyStore, providerID: string | undefined): string | undefined {
  if (!providerID) return undefined
  try {
    return store.readActiveAliases()[providerID]
  } catch {
    return undefined
  }
}

function extractData(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isRotatableError(info: ErrorInfo): boolean {
  if (info.name === "MessageOutputLengthError") return false
  if (info.statusCode === 429) return true
  return isRotatableMessage(info.message)
}

function isRotatableMessage(message: string | undefined): boolean {
  if (!message) return false
  return ROTATABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
}

function errorToMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return undefined
  }
}

async function showToast(
  client: Parameters<Plugin>[0]["client"],
  title: string,
  message: string,
  variant: "info" | "success" | "warning" | "error",
): Promise<void> {
  try {
    await client.tui.showToast({
      body: { title, message, variant, duration: 8_000 },
    })
  } catch {
    console.warn(`[opencode-key-rotator] ${title}: ${message}`)
  }
}

function markRotated(sessionID: string): void {
  rotatedSessions.set(sessionID, Date.now())
  cleanupRotatedSessions()
}

function wasRotatedRecently(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  const timestamp = rotatedSessions.get(sessionID)
  if (!timestamp) return false
  if (Date.now() - timestamp > ROTATION_DEDUP_TTL_MS) {
    rotatedSessions.delete(sessionID)
    return false
  }
  return true
}

function cleanupRotatedSessions(): void {
  const now = Date.now()
  for (const [sessionID, timestamp] of rotatedSessions) {
    if (now - timestamp > ROTATION_DEDUP_TTL_MS) rotatedSessions.delete(sessionID)
  }
}
