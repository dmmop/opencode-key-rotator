import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { resolveOpencodeDataDir } from "./opencode-runtime-paths.js"
import { KeyStoreError } from "./errors.js"
import { createKeyStore, type KeyStatus, type KeyStore } from "./key-store.js"
import { readLastRotationDecision } from "./rotation-log.js"

const id = "opencode-key-rotator"

const tui: TuiPlugin = async (api) => {
  registerSlashCommand(api, "key-save", "Save current provider key", () => openSaveKey(api))
  registerSlashCommand(api, "key-switch", "Switch active provider key", () => openKeySwitch(api))
  registerSlashCommand(api, "key-status", "Show key rotation status", () => openKeyStatus(api))
}

function registerSlashCommand(api: TuiPluginApi, name: string, title: string, run: () => void): void {
  const legacyCommand = api.command
  if (legacyCommand) {
    legacyCommand.register(() => [{ title, value: name, category: "Key Rotator", slash: { name }, onSelect: run }])
    return
  }

  const keymap = api.keymap as unknown as {
    registerLayer?: (input: { commands: Array<Record<string, unknown>> }) => void
  }
  keymap.registerLayer?.({
    commands: [
      {
        namespace: "key-rotator",
        name,
        title,
        category: "Key Rotator",
        slashName: name,
        run,
      },
    ],
  })
}

function openSaveKey(api: TuiPluginApi): void {
  const store = getStore(api)
  if (!store) return
  const providers = safeCall(() => store.listProviderIDs(), api)
  if (!providers || providers.length === 0) {
    showAlert(api, "No providers", "No providers were found in auth.json or saved keys.")
    return
  }

  api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
    title: "Save provider key",
    placeholder: "Choose provider",
    options: providers.map((providerID) => ({ title: providerID, value: providerID })),
    onSelect: (option) => askAlias(api, store, option.value),
  }))
}

function askAlias(api: TuiPluginApi, store: KeyStore, providerID: string): void {
  api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: `Alias for ${providerID}`,
    placeholder: "personal, work, backup...",
    onCancel: () => api.ui.dialog.clear(),
    onConfirm: (alias) => {
      const cleanAlias = alias.trim()
      if (!cleanAlias) {
        showAlert(api, "Missing alias", "Alias cannot be empty.")
        return
      }

      const preview = safeCall(() => store.previewCurrentProviderKey(providerID, cleanAlias), api)
      if (!preview) return
      if (preview.exists && preview.fingerprintChanged) {
        confirmFingerprintOverwrite(api, store, providerID, cleanAlias, preview.fingerprint.stability)
        return
      }
      if (preview.exists) {
        confirmOverwrite(api, store, providerID, cleanAlias)
        return
      }
      saveKey(api, store, providerID, cleanAlias)
    },
  }))
}

function confirmFingerprintOverwrite(api: TuiPluginApi, store: KeyStore, providerID: string, alias: string, stability: string): void {
  api.ui.dialog.replace(() => api.ui.DialogConfirm({
    title: "Fingerprint changed",
    message: `${providerID}/${alias} already exists, but the current credentials have a different ${stability} fingerprint. Overwrite the saved alias?`,
    onCancel: () => api.ui.dialog.clear(),
    onConfirm: () => saveKey(api, store, providerID, alias),
  }))
}

function confirmOverwrite(api: TuiPluginApi, store: KeyStore, providerID: string, alias: string): void {
  api.ui.dialog.replace(() => api.ui.DialogConfirm({
    title: "Overwrite saved key?",
    message: `${providerID}/${alias} already exists. Overwrite it with the currently active credentials?`,
    onCancel: () => api.ui.dialog.clear(),
    onConfirm: () => saveKey(api, store, providerID, alias),
  }))
}

function saveKey(api: TuiPluginApi, store: KeyStore, providerID: string, alias: string): void {
  const saved = safeCall(() => store.saveCurrentProviderKey(providerID, alias, true), api)
  if (!saved) return
  api.ui.dialog.clear()
  api.ui.toast({ variant: "success", title: "Key saved", message: `${providerID}/${alias} saved as active.` })
}

function openKeySwitch(api: TuiPluginApi): void {
  const store = getStore(api)
  if (!store) return
  const providers = safeCall(() => store.getStatuses().filter((status) => status.aliases.length > 0), api)
  if (!providers || providers.length === 0) {
    showAlert(api, "No saved keys", "No provider keys are available to switch.")
    return
  }

  api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
    title: "Switch provider key",
    placeholder: "Choose provider",
    options: providers.map((status) => ({
      title: status.providerID,
      value: status.providerID,
      description: status.activeAlias ? `active: ${status.activeAlias}` : "no active alias",
    })),
    onSelect: (option) => chooseAlias(api, store, option.value),
  }))
}

function chooseAlias(api: TuiPluginApi, store: KeyStore, providerID: string): void {
  const keys = safeCall(() => store.listKeys(providerID), api)
  if (!keys || keys.length === 0) {
    showAlert(api, "No saved keys", `${providerID} has no saved keys.`)
    return
  }

  api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
    title: `Switch ${providerID}`,
    placeholder: "Choose alias",
    options: keys.map((key) => ({ title: key.alias, value: key.alias })),
    onSelect: (option) => {
      const result = safeCall(() => store.switchProviderKey(providerID, option.value), api)
      if (!result) return
      api.ui.dialog.clear()
      api.ui.toast({
        variant: "success",
        title: "Key switched",
        message: `${providerID}: ${result.previousAlias ?? "unknown"} -> ${result.activeAlias}`,
      })
    },
  }))
}

function openKeyStatus(api: TuiPluginApi): void {
  const store = getStore(api)
  if (!store) return
  const statuses = safeCall(() => store.getStatuses(), api)
  if (!statuses) return
  const lastDecision = readLastRotationDecision(store)

  const lines = statuses.length === 0
    ? ["No provider keys saved yet.", "", "Use /key-save after /connect to save the current provider credentials."]
    : formatStatusTable(statuses)

  const authWarnings = [...new Set(statuses.map((status) => status.authWarning).filter((warning): warning is string => Boolean(warning)))]
  if (authWarnings.length > 0) {
    lines.push("", "Warnings", "--------", ...authWarnings)
  }

  if (lastDecision) {
    lines.push("")
    lines.push("Last rotation")
    lines.push("-------------")
    lines.push(`provider : ${lastDecision.providerID ?? "-"}`)
    lines.push(`trigger  : ${formatRotationReason(lastDecision.reason)}`)
  }

  showAlert(api, "Key rotation status", lines.join("\n"))
}

function formatStatusTable(statuses: KeyStatus[]): string[] {
  const rows = statuses.map((status) => ({
    provider: status.providerID,
    active: status.activeAlias ?? "-",
    saved: String(status.aliases.length),
    status: formatProviderHealth(status),
    aliases: status.aliases.length > 0 ? status.aliases.join(", ") : "-",
  }))
  const widths = {
    provider: Math.max("Provider".length, ...rows.map((row) => row.provider.length)),
    active: Math.max("Active".length, ...rows.map((row) => row.active.length)),
    saved: Math.max("Saved".length, ...rows.map((row) => row.saved.length)),
    status: Math.max("Status".length, ...rows.map((row) => row.status.length)),
  }
  const header = `${pad("Provider", widths.provider)}  ${pad("Active", widths.active)}  ${pad("Saved", widths.saved)}  ${pad("Status", widths.status)}  Aliases`
  const divider = `${"-".repeat(widths.provider)}  ${"-".repeat(widths.active)}  ${"-".repeat(widths.saved)}  ${"-".repeat(widths.status)}  -------`
  return [
    header,
    divider,
    ...rows.map((row) => `${pad(row.provider, widths.provider)}  ${pad(row.active, widths.active)}  ${pad(row.saved, widths.saved)}  ${pad(row.status, widths.status)}  ${row.aliases}`),
  ]
}

function formatProviderHealth(status: KeyStatus): string {
  if (status.aliases.length === 0) return "-"
  if (!status.activeAlias) return "no active alias"
  if (status.synced === false) return "active credentials changed outside key rotator"
  if (status.synced === undefined) return "saved keys available"
  return "ready"
}

function formatRotationReason(reason: string): string {
  if (reason === "matched_rotation_patterns") return "Rate limit detected"
  if (reason === "provider_has_less_than_two_saved_keys") return "No alternative key available"
  if (reason === "rotatable_error_without_provider_id" || reason === "rotatable_retry_without_provider_id") return "Provider could not be determined"
  if (reason === "active_credentials_changed_outside_plugin") return "Active credentials changed outside key rotator"
  if (reason === "key_store_error") return "Key store error"
  if (reason === "unexpected_rotation_error") return "Unexpected rotation error"
  return reason.replace(/_/g, " ")
}

function getStore(api: TuiPluginApi): KeyStore | undefined {
  if (!api.state.path.state) {
    api.ui.toast({ variant: "error", title: "Key rotator", message: "OpenCode runtime path is unavailable." })
    return undefined
  }
  return createKeyStore(resolveOpencodeDataDir(api.state.path))
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ")
}

function showAlert(api: TuiPluginApi, title: string, message: string): void {
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message, onConfirm: () => api.ui.dialog.clear() }))
}

function safeCall<T>(operation: () => T, api: TuiPluginApi): T | undefined {
  try {
    return operation()
  } catch (error) {
    const message = error instanceof KeyStoreError || error instanceof Error ? error.message : String(error)
    api.ui.toast({ variant: "error", title: "Key rotator", message })
    return undefined
  }
}

const pluginModule = {
  id,
  tui,
}

export default pluginModule
