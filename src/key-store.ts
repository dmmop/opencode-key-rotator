import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { getAuthPaths } from "./opencode-runtime-paths.js"
import { KeyStoreError } from "./errors.js"

export type JsonObject = Record<string, unknown>

export type Fingerprint = {
  hash: string
  type: "oauth" | "api" | "wellknown" | "unknown"
  stability: "stable" | "unstable"
}

export type ActiveProvider = {
  alias: string
  fingerprint: Fingerprint
  updatedAt: string
}

export type ActiveState = {
  providers: Record<string, ActiveProvider>
}

export type KeyAlias = {
  providerID: string
  alias: string
  file: string
  fingerprint: Fingerprint
}

export type KeyStatus = {
  providerID: string
  activeAlias?: string
  aliases: string[]
  authWarning?: string
  synced?: boolean
}

export type SwitchResult = {
  providerID: string
  previousAlias?: string
  activeAlias: string
}

export type SaveResult = KeyAlias & {
  replaced: boolean
  fingerprintChanged: boolean
}

export type KeyStore = ReturnType<typeof createKeyStore>

const MAX_AUTH_BACKUPS = 10
const LOCK_TTL_MS = 30_000
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function createKeyStore(dataDir: string) {
  const paths = createKeyStorePaths(dataDir)

  function ensureKeysDir(): void {
    fs.mkdirSync(paths.keysDir, { recursive: true, mode: 0o700 })
    chmodIfExists(paths.keysDir, 0o700)
  }

  function readAuth(): JsonObject {
    const content = readAuthFileSync()
    if (content === null) return {}
    if (!isJsonObject(content)) throw new KeyStoreError("OpenCode auth file must contain a JSON object")
    return content
  }

  function readActiveState(): ActiveState {
    if (!fs.existsSync(paths.activeFile)) return { providers: {} }
    const active = readJsonObject(paths.activeFile, "active key file")
    if (!isJsonObject(active.providers)) throw new KeyStoreError("active key file must contain a providers object")

    const providers: Record<string, ActiveProvider> = {}
    for (const [providerID, value] of Object.entries(active.providers)) {
      validateProviderID(providerID)
      if (!isJsonObject(value) || typeof value.alias !== "string" || typeof value.updatedAt !== "string") {
        throw new KeyStoreError(`Invalid active metadata for provider '${providerID}'`)
      }
      validateAlias(value.alias)
      if (!isFingerprint(value.fingerprint)) {
        throw new KeyStoreError(`Invalid fingerprint metadata for provider '${providerID}'`)
      }
      providers[providerID] = {
        alias: value.alias,
        fingerprint: value.fingerprint,
        updatedAt: value.updatedAt,
      }
    }

    return { providers }
  }

  function readActiveAliases(): Record<string, string> {
    const active = readActiveState()
    return Object.fromEntries(Object.entries(active.providers).map(([providerID, provider]) => [providerID, provider.alias]))
  }

  function listKeys(providerID?: string): KeyAlias[] {
    ensureKeysDir()
    const providerIDs = fs.readdirSync(paths.keysDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "backups")
      .map((entry) => entry.name)
      .filter((entry) => providerID === undefined || entry === providerID)

    return providerIDs.flatMap((currentProviderID) => listProviderKeys(currentProviderID))
      .sort((left, right) => `${left.providerID}/${left.alias}`.localeCompare(`${right.providerID}/${right.alias}`))
  }

  function listProviderIDs(): string[] {
    const auth = readAuth()
    const active = readActiveState()
    const fromKeys = listKeys().map((entry) => entry.providerID)
    return [...new Set([...Object.keys(auth), ...Object.keys(active.providers), ...fromKeys])].sort()
  }

  function getStatuses(): KeyStatus[] {
    const active = readActiveState()
    const keys = listKeys()
    const aliasesByProvider = new Map<string, string[]>()
    for (const key of keys) {
      const aliases = aliasesByProvider.get(key.providerID) ?? []
      aliases.push(key.alias)
      aliasesByProvider.set(key.providerID, aliases)
    }

    let auth: JsonObject = {}
    let authWarning: string | undefined
    try {
      auth = readAuth()
    } catch (error) {
      authWarning = error instanceof Error ? error.message : String(error)
    }

    const providers = new Set([...Object.keys(active.providers), ...aliasesByProvider.keys(), ...Object.keys(auth)])
    return [...providers].sort().map((providerID) => {
      const activeProvider = active.providers[providerID]
      const currentCredential = auth[providerID]
      const synced = activeProvider && isJsonObject(currentCredential)
        ? sameFingerprint(calculateFingerprint(currentCredential), activeProvider.fingerprint)
        : undefined
      return {
        providerID,
        activeAlias: activeProvider?.alias,
        aliases: aliasesByProvider.get(providerID) ?? [],
        authWarning,
        synced,
      }
    })
  }

  function saveCurrentProviderKey(providerID: string, alias: string, markActive: boolean): SaveResult {
    validateProviderID(providerID)
    validateAlias(alias)
    const auth = readAuth()
    const credential = auth[providerID]
    if (!isJsonObject(credential)) {
      throw new KeyStoreError(`Provider '${providerID}' was not found in auth.json`)
    }

    return withLock(() => {
      const file = keyFilePath(providerID, alias)
      const currentFingerprint = calculateFingerprint(credential)
      const previous = fs.existsSync(file) ? readJsonObject(file, `key '${providerID}/${alias}'`) : undefined
      const previousFingerprint = previous ? calculateFingerprint(previous) : undefined

      ensureProviderDir(providerID)
      writeJsonAtomic(file, credential)

      if (markActive) {
        const active = readActiveState()
        active.providers[providerID] = activeProvider(alias, currentFingerprint)
        writeJsonAtomic(paths.activeFile, active)
      }

      return {
        providerID,
        alias,
        file,
        fingerprint: currentFingerprint,
        replaced: previous !== undefined,
        fingerprintChanged: previousFingerprint !== undefined && !sameFingerprint(previousFingerprint, currentFingerprint),
      }
    })
  }

  function previewCurrentProviderKey(providerID: string, alias: string): { exists: boolean; fingerprintChanged: boolean; fingerprint: Fingerprint; existingFingerprint?: Fingerprint } {
    validateProviderID(providerID)
    validateAlias(alias)
    const auth = readAuth()
    const credential = auth[providerID]
    if (!isJsonObject(credential)) {
      throw new KeyStoreError(`Provider '${providerID}' was not found in auth.json`)
    }
    const fingerprint = calculateFingerprint(credential)
    const file = keyFilePath(providerID, alias)
    if (!fs.existsSync(file)) return { exists: false, fingerprintChanged: false, fingerprint }
    const existingFingerprint = calculateFingerprint(readJsonObject(file, `key '${providerID}/${alias}'`))
    return { exists: true, fingerprintChanged: !sameFingerprint(fingerprint, existingFingerprint), fingerprint, existingFingerprint }
  }

  function switchProviderKey(providerID: string, alias: string, reason = "key-switch"): SwitchResult {
    validateProviderID(providerID)
    validateAlias(alias)
    return withLock(() => switchProviderKeyUnlocked(providerID, alias, reason, true))
  }

  function rotateProviderKey(providerID: string): SwitchResult | undefined {
    validateProviderID(providerID)
    return withLock(() => {
      const keys = listKeys(providerID)
      if (keys.length < 2) return undefined

      const active = readActiveState()
      const currentAlias = active.providers[providerID]?.alias
      const currentIndex = currentAlias ? keys.findIndex((entry) => entry.alias === currentAlias) : -1
      const next = keys[(currentIndex + 1 + keys.length) % keys.length]
      return switchProviderKeyUnlocked(providerID, next.alias, "auto-rotate", false)
    })
  }

  function hasAlternativeKey(providerID: string): boolean {
    return listKeys(providerID).length >= 2
  }

  function keyExists(providerID: string, alias: string): boolean {
    validateProviderID(providerID)
    validateAlias(alias)
    return fs.existsSync(keyFilePath(providerID, alias))
  }

  function backupAuth(reason: string): string {
    ensureKeysDir()
    fs.mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 })
    chmodIfExists(paths.backupsDir, 0o700)

    if (!fs.existsSync(paths.authFile)) {
      throw new KeyStoreError("Cannot back up auth.json because it does not exist")
    }

    const safeReason = reason.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "auth-write"
    const backupFile = path.join(paths.backupsDir, `auth-${timestampForFile()}-${safeReason}.json`)
    fs.copyFileSync(paths.authFile, backupFile, fs.constants.COPYFILE_EXCL)
    chmodIfExists(backupFile, 0o600)
    return backupFile
  }

  function pruneAuthBackups(maxBackups = MAX_AUTH_BACKUPS): void {
    if (!fs.existsSync(paths.backupsDir)) return
    const backups = fs.readdirSync(paths.backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^auth-.*\.json$/.test(entry.name))
      .map((entry) => {
        const file = path.join(paths.backupsDir, entry.name)
        return { file, mtimeMs: fs.statSync(file).mtimeMs }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)

    for (const backup of backups.slice(maxBackups)) {
      fs.rmSync(backup.file, { force: true })
    }
  }

  function switchProviderKeyUnlocked(providerID: string, alias: string, reason: string, persistCurrent: boolean): SwitchResult {
    const active = readActiveState()
    const previous = active.providers[providerID]
    const previousAlias = previous?.alias

    if (previous) {
      const auth = readAuth()
      const currentCredential = auth[providerID]
      if (!isJsonObject(currentCredential)) throw new KeyStoreError(`Provider '${providerID}' was not found in auth.json`)
      const currentFingerprint = calculateFingerprint(currentCredential)
      if (!sameFingerprint(currentFingerprint, previous.fingerprint)) {
        throw new KeyStoreError(`Active ${providerID} credentials no longer match alias '${previous.alias}'. Run /key-save before switching.`)
      }
      if (persistCurrent) {
        writeJsonAtomic(keyFilePath(providerID, previous.alias), currentCredential)
      }
    }

    const next = readJsonObject(keyFilePath(providerID, alias), `key '${providerID}/${alias}'`)
    const nextFingerprint = calculateFingerprint(next)
    const auth = readAuth()
    backupAuth(reason)
    auth[providerID] = next
    writeJsonAtomic(paths.authFile, auth)

    active.providers[providerID] = activeProvider(alias, nextFingerprint)
    writeJsonAtomic(paths.activeFile, active)
    pruneAuthBackups()

    return { providerID, previousAlias, activeAlias: alias }
  }

  function listProviderKeys(providerID: string): KeyAlias[] {
    validateProviderID(providerID)
    const providerDir = path.join(paths.keysDir, providerID)
    if (!fs.existsSync(providerDir)) return []
    return fs.readdirSync(providerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const alias = entry.name.slice(0, -".json".length)
        if (!SAFE_SEGMENT.test(alias)) return undefined
        const file = path.join(providerDir, entry.name)
        return { providerID, alias, file, fingerprint: calculateFingerprint(readJsonObject(file, `key '${providerID}/${alias}'`)) }
      })
      .filter((entry): entry is KeyAlias => entry !== undefined)
  }

  function keyFilePath(providerID: string, alias: string): string {
    validateProviderID(providerID)
    validateAlias(alias)
    return path.join(paths.keysDir, providerID, `${alias}.json`)
  }

  function ensureProviderDir(providerID: string): void {
    validateProviderID(providerID)
    ensureKeysDir()
    const providerDir = path.join(paths.keysDir, providerID)
    fs.mkdirSync(providerDir, { recursive: true, mode: 0o700 })
    chmodIfExists(providerDir, 0o700)
  }

  function withLock<T>(operation: () => T): T {
    ensureKeysDir()
    const lockFile = paths.lockFile
    const now = Date.now()
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() }), { flag: "wx", mode: 0o600 })
    } catch (error) {
      if (!isStaleLock(lockFile, now)) throw new KeyStoreError("Key store is busy. Try again in a moment.")
      fs.rmSync(lockFile, { force: true })
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() }), { flag: "wx", mode: 0o600 })
    }

    try {
      return operation()
    } finally {
      fs.rmSync(lockFile, { force: true })
    }
  }

  function writeJsonAtomic(file: string, value: JsonObject): void {
    const directory = path.dirname(file)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, file)
    chmodIfExists(file, 0o600)
  }

  return {
    paths,
    ensureKeysDir,
    readAuth,
    readActiveState,
    readActiveAliases,
    listKeys,
    listProviderIDs,
    getStatuses,
    saveCurrentProviderKey,
    previewCurrentProviderKey,
    switchProviderKey,
    rotateProviderKey,
    hasAlternativeKey,
    keyExists,
    backupAuth,
    pruneAuthBackups,
    calculateFingerprint,
  }
}

function createKeyStorePaths(dataDir: string) {
  const resolvedDataDir = path.resolve(dataDir)
  const keysDir = path.join(resolvedDataDir, "keys")
  return {
    dataDir: resolvedDataDir,
    authFile: path.join(resolvedDataDir, "auth.json"),
    keysDir,
    activeFile: path.join(keysDir, "active.json"),
    backupsDir: path.join(keysDir, "backups"),
    lockFile: path.join(keysDir, ".lock"),
    rotationLogFile: path.join(keysDir, "rotation.log.jsonl"),
  }
}

function calculateFingerprint(credential: JsonObject): Fingerprint {
  const type = typeof credential.type === "string" ? credential.type : "unknown"
  if (type === "oauth") {
    const accountId = stringValue(credential.accountId)
    const enterpriseUrl = stringValue(credential.enterpriseUrl)
    if (accountId) return fingerprint("oauth", "stable", [type, accountId, enterpriseUrl])
    if (enterpriseUrl) return fingerprint("oauth", "stable", [type, enterpriseUrl])
    return fingerprint("oauth", "unstable", [type, stringValue(credential.refresh), stringValue(credential.access)])
  }
  if (type === "api") return fingerprint("api", "stable", [type, stringValue(credential.key)])
  if (type === "wellknown") return fingerprint("wellknown", "unstable", [type, stringValue(credential.key), stringValue(credential.token)])
  return fingerprint("unknown", "unstable", [JSON.stringify(redactCredentialShape(credential))])
}

function activeProvider(alias: string, fingerprintValue: Fingerprint): ActiveProvider {
  return {
    alias,
    fingerprint: fingerprintValue,
    updatedAt: new Date().toISOString(),
  }
}

function fingerprint(type: Fingerprint["type"], stability: Fingerprint["stability"], parts: Array<string | undefined>): Fingerprint {
  const material = parts.map((part) => part ?? "").join("\0")
  return { hash: `sha256:${crypto.createHash("sha256").update(material).digest("hex")}`, type, stability }
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.hash === right.hash && left.type === right.type && left.stability === right.stability
}

function validateProviderID(providerID: string): void {
  if (!SAFE_SEGMENT.test(providerID) || providerID.includes("..")) throw new KeyStoreError("Invalid provider ID")
}

function validateAlias(alias: string): void {
  if (!SAFE_SEGMENT.test(alias) || alias.includes("..")) {
    throw new KeyStoreError("Alias must contain only letters, numbers, dots, underscores, or dashes")
  }
}

function readJsonObject(file: string, label: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new KeyStoreError(`Failed to read ${label}: ${message}`)
  }
  if (!isJsonObject(parsed)) throw new KeyStoreError(`${label} must contain a JSON object`)
  return parsed
}

function isStaleLock(lockFile: string, now: number): boolean {
  try {
    return now - fs.statSync(lockFile).mtimeMs > LOCK_TTL_MS
  } catch {
    return true
  }
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

function chmodIfExists(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode)
  } catch {
    // Non-fatal on filesystems that do not support chmod.
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFingerprint(value: unknown): value is Fingerprint {
  return isJsonObject(value)
    && typeof value.hash === "string"
    && (value.type === "oauth" || value.type === "api" || value.type === "wellknown" || value.type === "unknown")
    && (value.stability === "stable" || value.stability === "unstable")
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function redactCredentialShape(credential: JsonObject): JsonObject {
  return Object.fromEntries(Object.keys(credential).sort().map((key) => [key, typeof credential[key]]))
}

/** Read the first readable auth.json candidate. Returns null if none exist. */
function readAuthFileSync(): unknown | null {
  for (const candidate of getAuthPaths()) {
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf-8"))
    } catch {
      // Try next candidate.
    }
  }
  return null
}
