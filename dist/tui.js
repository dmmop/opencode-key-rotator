import { resolveOpencodeDataDir } from "./opencode-runtime-paths.js";
import { KeyStoreError } from "./errors.js";
import { createKeyStore } from "./key-store.js";
import { readLastRotationDecision } from "./rotation-log.js";
const id = "opencode-key-rotator";
const tui = async (api) => {
    registerSlashCommand(api, "key-save", "Save current provider key", () => openSaveKey(api));
    registerSlashCommand(api, "key-list", "List saved provider keys", () => openKeyList(api));
    registerSlashCommand(api, "key-switch", "Switch active provider key", () => openKeySwitch(api));
    registerSlashCommand(api, "key-status", "Show key rotation status", () => openKeyStatus(api));
};
function registerSlashCommand(api, name, title, run) {
    const legacyCommand = api.command;
    if (legacyCommand) {
        legacyCommand.register(() => [{ title, value: name, category: "Key Rotator", slash: { name }, onSelect: run }]);
        return;
    }
    const keymap = api.keymap;
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
    });
}
function openSaveKey(api) {
    const store = getStore(api);
    if (!store)
        return;
    const providers = safeCall(() => store.listProviderIDs(), api);
    if (!providers || providers.length === 0) {
        showAlert(api, "No providers", "No providers were found in auth.json or saved keys.");
        return;
    }
    api.ui.dialog.replace(() => api.ui.DialogSelect({
        title: "Save provider key",
        placeholder: "Choose provider",
        options: providers.map((providerID) => ({ title: providerID, value: providerID })),
        onSelect: (option) => askAlias(api, store, option.value),
    }));
}
function askAlias(api, store, providerID) {
    api.ui.dialog.replace(() => api.ui.DialogPrompt({
        title: `Alias for ${providerID}`,
        placeholder: "personal, work, backup...",
        onCancel: () => api.ui.dialog.clear(),
        onConfirm: (alias) => {
            const cleanAlias = alias.trim();
            if (!cleanAlias) {
                showAlert(api, "Missing alias", "Alias cannot be empty.");
                return;
            }
            const preview = safeCall(() => store.previewCurrentProviderKey(providerID, cleanAlias), api);
            if (!preview)
                return;
            if (preview.exists && preview.fingerprintChanged) {
                confirmFingerprintOverwrite(api, store, providerID, cleanAlias, preview.fingerprint.stability);
                return;
            }
            if (preview.exists) {
                confirmOverwrite(api, store, providerID, cleanAlias);
                return;
            }
            saveKey(api, store, providerID, cleanAlias);
        },
    }));
}
function confirmFingerprintOverwrite(api, store, providerID, alias, stability) {
    api.ui.dialog.replace(() => api.ui.DialogConfirm({
        title: "Fingerprint changed",
        message: `${providerID}/${alias} already exists, but the current credentials have a different ${stability} fingerprint. Overwrite the saved alias?`,
        onCancel: () => api.ui.dialog.clear(),
        onConfirm: () => saveKey(api, store, providerID, alias),
    }));
}
function confirmOverwrite(api, store, providerID, alias) {
    api.ui.dialog.replace(() => api.ui.DialogConfirm({
        title: "Overwrite saved key?",
        message: `${providerID}/${alias} already exists. Overwrite it with the currently active credentials?`,
        onCancel: () => api.ui.dialog.clear(),
        onConfirm: () => saveKey(api, store, providerID, alias),
    }));
}
function saveKey(api, store, providerID, alias) {
    const saved = safeCall(() => store.saveCurrentProviderKey(providerID, alias, true), api);
    if (!saved)
        return;
    api.ui.dialog.clear();
    api.ui.toast({ variant: "success", title: "Key saved", message: `${providerID}/${alias} saved as active.` });
}
function openKeyList(api) {
    const store = getStore(api);
    if (!store)
        return;
    const keys = safeCall(() => store.listKeys(), api);
    if (!keys || keys.length === 0) {
        showAlert(api, "No saved keys", `No provider keys were found in:\n${store.paths.keysDir}\n\nUse /key-save after /connect.`);
        return;
    }
    api.ui.dialog.replace(() => api.ui.DialogSelect({
        title: "Saved provider keys",
        options: keys.map((key) => ({
            title: `${key.providerID}/${key.alias}`,
            value: `${key.providerID}/${key.alias}`,
            description: key.providerID,
        })),
        onSelect: () => undefined,
    }));
}
function openKeySwitch(api) {
    const store = getStore(api);
    if (!store)
        return;
    const providers = safeCall(() => store.getStatuses().filter((status) => status.aliases.length > 0), api);
    if (!providers || providers.length === 0) {
        showAlert(api, "No saved keys", "No provider keys are available to switch.");
        return;
    }
    api.ui.dialog.replace(() => api.ui.DialogSelect({
        title: "Switch provider key",
        placeholder: "Choose provider",
        options: providers.map((status) => ({
            title: status.providerID,
            value: status.providerID,
            description: status.activeAlias ? `active: ${status.activeAlias}` : "no active alias",
        })),
        onSelect: (option) => chooseAlias(api, store, option.value),
    }));
}
function chooseAlias(api, store, providerID) {
    const keys = safeCall(() => store.listKeys(providerID), api);
    if (!keys || keys.length === 0) {
        showAlert(api, "No saved keys", `${providerID} has no saved keys.`);
        return;
    }
    api.ui.dialog.replace(() => api.ui.DialogSelect({
        title: `Switch ${providerID}`,
        placeholder: "Choose alias",
        options: keys.map((key) => ({ title: key.alias, value: key.alias })),
        onSelect: (option) => {
            const result = safeCall(() => store.switchProviderKey(providerID, option.value), api);
            if (!result)
                return;
            api.ui.dialog.clear();
            api.ui.toast({
                variant: "success",
                title: "Key switched",
                message: `${providerID}: ${result.previousAlias ?? "unknown"} -> ${result.activeAlias}`,
            });
        },
    }));
}
function openKeyStatus(api) {
    const store = getStore(api);
    if (!store)
        return;
    const statuses = safeCall(() => store.getStatuses(), api);
    if (!statuses)
        return;
    const lastDecision = readLastRotationDecision(store);
    const lines = statuses.length === 0
        ? ["No saved keys found.", "", "Use /key-save after /connect to save the current provider credentials."]
        : formatStatusTable(statuses);
    lines.push("", "Paths", "-----", `data : ${store.paths.dataDir}`, `keys : ${store.paths.keysDir}`);
    const authWarnings = [...new Set(statuses.map((status) => status.authWarning).filter((warning) => Boolean(warning)))];
    if (authWarnings.length > 0) {
        lines.push("", "Warnings", "--------", ...authWarnings);
    }
    if (lastDecision) {
        lines.push("");
        lines.push("Last rotation");
        lines.push("-------------");
        lines.push(`decision : ${lastDecision.decision}`);
        lines.push(`reason   : ${lastDecision.reason}`);
        lines.push(`provider : ${lastDecision.providerID ?? "unknown"}`);
    }
    showAlert(api, "Key rotation status", lines.join("\n"));
}
function formatStatusTable(statuses) {
    const rows = statuses.map((status) => ({
        provider: status.providerID,
        active: status.activeAlias ?? "none",
        saved: String(status.aliases.length),
        sync: status.synced === undefined ? "unknown" : status.synced ? "yes" : "no",
        aliases: status.aliases.length > 0 ? status.aliases.join(", ") : "-",
    }));
    const widths = {
        provider: Math.max("Provider".length, ...rows.map((row) => row.provider.length)),
        active: Math.max("Active".length, ...rows.map((row) => row.active.length)),
        saved: Math.max("Saved".length, ...rows.map((row) => row.saved.length)),
        sync: Math.max("Sync".length, ...rows.map((row) => row.sync.length)),
    };
    const header = `${pad("Provider", widths.provider)}  ${pad("Active", widths.active)}  ${pad("Saved", widths.saved)}  ${pad("Sync", widths.sync)}  Aliases`;
    const divider = `${"-".repeat(widths.provider)}  ${"-".repeat(widths.active)}  ${"-".repeat(widths.saved)}  ${"-".repeat(widths.sync)}  -------`;
    return [
        header,
        divider,
        ...rows.map((row) => `${pad(row.provider, widths.provider)}  ${pad(row.active, widths.active)}  ${pad(row.saved, widths.saved)}  ${pad(row.sync, widths.sync)}  ${row.aliases}`),
    ];
}
function getStore(api) {
    if (!api.state.path.state) {
        api.ui.toast({ variant: "error", title: "Key rotator", message: "OpenCode runtime path is unavailable." });
        return undefined;
    }
    return createKeyStore(resolveOpencodeDataDir(api.state.path));
}
function pad(value, width) {
    return value.padEnd(width, " ");
}
function showAlert(api, title, message) {
    api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message, onConfirm: () => api.ui.dialog.clear() }));
}
function safeCall(operation, api) {
    try {
        return operation();
    }
    catch (error) {
        const message = error instanceof KeyStoreError || error instanceof Error ? error.message : String(error);
        api.ui.toast({ variant: "error", title: "Key rotator", message });
        return undefined;
    }
}
const pluginModule = {
    id,
    tui,
};
export default pluginModule;
//# sourceMappingURL=tui.js.map