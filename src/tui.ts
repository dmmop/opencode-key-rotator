import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { resolveOpencodeDataDir } from "./opencode-runtime-paths.js";
import { KeyStoreError } from "./errors.js";
import { createKeyStore, type KeyStatus, type KeyStore } from "./key-store.js";
import { readLastRotationDecision } from "./rotation-log.js";

const id = "opencode-key-rotator";
const TOAST_DURATION_MS = 11_000;

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "key_rotator.save",
        title: "Save current provider key",
        category: "Key Rotator",
        slashName: "key-save",
        run: () => openSaveKey(api),
      },
      {
        namespace: "palette",
        name: "key_rotator.switch",
        title: "Switch active provider key",
        category: "Key Rotator",
        slashName: "key-switch",
        run: () => openKeySwitch(api),
      },
      {
        namespace: "palette",
        name: "key_rotator.status",
        title: "Show key rotation status",
        category: "Key Rotator",
        slashName: "key-status",
        run: () => openKeyStatus(api),
      },
    ],
  });
};

function openSaveKey(api: TuiPluginApi): void {
  const store = getStore(api);
  if (!store) return;
  const providers = safeCall(() => store.listProviderIDs(), api);
  if (!providers || providers.length === 0) {
    showAlert(api, "No providers", "No active provider credentials or saved keys were found.");
    return;
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<string>({
      title: "Save provider key",
      placeholder: "Choose provider",
      options: providers.map((providerID) => ({ title: providerID, value: providerID })),
      onSelect: (option) => askAlias(api, store, option.value),
    }),
  );
}

function askAlias(api: TuiPluginApi, store: KeyStore, providerID: string): void {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: `Alias for ${providerID}`,
      placeholder: "personal, work, backup...",
      onCancel: () => api.ui.dialog.clear(),
      onConfirm: (alias) => {
        const cleanAlias = alias.trim();
        if (!cleanAlias) {
          showAlert(api, "Missing alias", "Alias cannot be empty.");
          return;
        }

        const exists = safeCall(() => store.listKeys(providerID).some((key) => key.alias === cleanAlias), api);
        if (exists === undefined) return;
        if (exists) {
          confirmOverwrite(api, store, providerID, cleanAlias);
          return;
        }
        saveKey(api, store, providerID, cleanAlias);
      },
    }),
  );
}

function confirmOverwrite(api: TuiPluginApi, store: KeyStore, providerID: string, alias: string): void {
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "Overwrite saved key?",
      message: `${providerID}/${alias} already exists. Overwrite it with the currently active credentials?`,
      onCancel: () => api.ui.dialog.clear(),
      onConfirm: () => saveKey(api, store, providerID, alias),
    }),
  );
}

function saveKey(api: TuiPluginApi, store: KeyStore, providerID: string, alias: string): void {
  const saved = safeCall(() => store.saveCurrentProviderKey(providerID, alias, true), api);
  if (!saved) return;
  api.ui.dialog.clear();
  api.ui.toast({
    variant: "success",
    title: "Key saved",
    message: `${providerID}/${alias} saved as active.`,
    duration: TOAST_DURATION_MS,
  });
}

function openKeySwitch(api: TuiPluginApi): void {
  const store = getStore(api);
  if (!store) return;
  const providers = safeCall(
    () => store.getStatuses().filter((status) => status.aliases.some((alias) => alias !== status.activeAlias)),
    api,
  );
  if (!providers || providers.length === 0) {
    showAlert(api, "No saved keys", "No provider has multiple saved keys to switch between.");
    return;
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<KeyStatus>({
      title: "Switch provider key",
      placeholder: "Choose provider",
      options: providers.map((status) => ({
        title: status.providerID,
        value: status,
        description: status.activeAlias ? `active: ${status.activeAlias}` : "no active alias",
      })),
      onSelect: (option) => chooseAlias(api, store, option.value.providerID, option.value.activeAlias),
    }),
  );
}

function chooseAlias(api: TuiPluginApi, store: KeyStore, providerID: string, activeAlias?: string): void {
  const keys = safeCall(() => store.listKeys(providerID), api);
  const switchableKeys = keys?.filter((key) => key.alias !== activeAlias);
  if (!switchableKeys || switchableKeys.length === 0) {
    showAlert(api, "No alternative keys", `${providerID} has no alternative saved keys.`);
    return;
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<string>({
      title: `Switch ${providerID}`,
      placeholder: "Choose alias",
      options: switchableKeys.map((key) => ({ title: key.alias, value: key.alias })),
      onSelect: (option) => {
        const result = safeCall(() => store.switchProviderKey(providerID, option.value), api);
        if (!result) return;
        api.ui.dialog.clear();
        api.ui.toast({
          variant: "success",
          title: "Key switched",
          message: `${providerID}: ${result.previousAlias ?? "unknown"} -> ${result.activeAlias}`,
          duration: TOAST_DURATION_MS,
        });
      },
    }),
  );
}

function openKeyStatus(api: TuiPluginApi): void {
  const store = getStore(api);
  if (!store) return;
  const statuses = safeCall(() => store.getStatuses(), api);
  if (!statuses) return;
  const lastDecision = readLastRotationDecision(store);

  const lines =
    statuses.length === 0
      ? ["No provider keys saved yet.", "", "Use /key-save after /connect to save the current provider credentials."]
      : formatStatusTable(statuses);

  if (lastDecision) {
    lines.push("");
    lines.push("Last rotation");
    lines.push("-------------");
    lines.push(`provider : ${lastDecision.providerID ?? "-"}`);
    lines.push(`trigger  : ${formatRotationReason(lastDecision.reason)}`);
  }

  showAlert(api, "Key rotation status", lines.join("\n"));
}

function formatStatusTable(statuses: KeyStatus[]): string[] {
  const rows = statuses.map((status) => ({
    provider: status.providerID,
    active: status.activeAlias ?? "-",
    saved: String(status.aliases.length),
    status: formatProviderHealth(status),
    aliases: status.aliases.length > 0 ? status.aliases.join(", ") : "-",
  }));
  const widths = {
    provider: Math.max("Provider".length, ...rows.map((row) => row.provider.length)),
    active: Math.max("Active".length, ...rows.map((row) => row.active.length)),
    saved: Math.max("Saved".length, ...rows.map((row) => row.saved.length)),
    status: Math.max("Status".length, ...rows.map((row) => row.status.length)),
  };
  const header = `${pad("Provider", widths.provider)}  ${pad("Active", widths.active)}  ${pad("Saved", widths.saved)}  ${pad("Status", widths.status)}  Aliases`;
  const divider = `${"-".repeat(widths.provider)}  ${"-".repeat(widths.active)}  ${"-".repeat(widths.saved)}  ${"-".repeat(widths.status)}  -------`;
  return [
    header,
    divider,
    ...rows.map(
      (row) =>
        `${pad(row.provider, widths.provider)}  ${pad(row.active, widths.active)}  ${pad(row.saved, widths.saved)}  ${pad(row.status, widths.status)}  ${row.aliases}`,
    ),
  ];
}

function formatProviderHealth(status: KeyStatus): string {
  if (status.aliases.length === 0) return "-";
  if (!status.activeAlias) return "no active alias";
  if (status.synced === false) return "active credentials changed outside key rotator";
  if (status.synced === undefined) return "saved keys available";
  return "ready";
}

function formatRotationReason(reason: string): string {
  if (reason === "matched_rotation_patterns") return "Rate limit";
  if (reason === "provider_has_less_than_two_saved_keys") return "No fallback key";
  if (reason === "rotatable_error_without_provider_id" || reason === "rotatable_retry_without_provider_id") return "Provider unknown";
  if (reason === "active_credentials_changed_outside_plugin") return "Credential mismatch";
  if (reason === "all_saved_keys_are_cooling_down") return "All keys cooling down";
  if (reason === "key_store_error") return "Key store error";
  if (reason === "unexpected_rotation_error") return "Rotation error";
  return reason.replace(/_/g, " ");
}

function getStore(api: TuiPluginApi): KeyStore | undefined {
  if (!api.state.path.state) {
    api.ui.toast({
      variant: "error",
      title: "Key rotator",
      message: "OpenCode runtime path is unavailable.",
      duration: TOAST_DURATION_MS,
    });
    return undefined;
  }
  return createKeyStore(resolveOpencodeDataDir(api.state.path));
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function showAlert(api: TuiPluginApi, title: string, message: string): void {
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message, onConfirm: () => api.ui.dialog.clear() }));
}

function safeCall<T>(operation: () => T, api: TuiPluginApi): T | undefined {
  try {
    return operation();
  } catch (error) {
    const message = error instanceof KeyStoreError || error instanceof Error ? error.message : String(error);
    api.ui.toast({ variant: "error", title: "Key rotator", message, duration: TOAST_DURATION_MS });
    return undefined;
  }
}

const pluginModule: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default pluginModule;
