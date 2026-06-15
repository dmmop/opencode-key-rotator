export type JsonObject = Record<string, unknown>;
export type Fingerprint = {
    hash: string;
    type: "oauth" | "api" | "wellknown" | "unknown";
    stability: "stable" | "unstable";
};
export type ActiveProvider = {
    alias: string;
    fingerprint: Fingerprint;
    updatedAt: string;
};
export type ActiveState = {
    providers: Record<string, ActiveProvider>;
};
export type KeyAlias = {
    providerID: string;
    alias: string;
    file: string;
    fingerprint: Fingerprint;
};
export type KeyStatus = {
    providerID: string;
    activeAlias?: string;
    aliases: string[];
    authWarning?: string;
    synced?: boolean;
};
export type SwitchResult = {
    providerID: string;
    previousAlias?: string;
    activeAlias: string;
};
export type SaveResult = KeyAlias & {
    replaced: boolean;
    fingerprintChanged: boolean;
};
export type KeyStore = ReturnType<typeof createKeyStore>;
export declare function createKeyStore(dataDir: string): {
    paths: {
        dataDir: string;
        authFile: string;
        keysDir: string;
        activeFile: string;
        backupsDir: string;
        lockFile: string;
        rotationLogFile: string;
    };
    ensureKeysDir: () => void;
    readAuth: () => JsonObject;
    readActiveState: () => ActiveState;
    readActiveAliases: () => Record<string, string>;
    listKeys: (providerID?: string) => KeyAlias[];
    listProviderIDs: () => string[];
    getStatuses: () => KeyStatus[];
    saveCurrentProviderKey: (providerID: string, alias: string, markActive: boolean) => SaveResult;
    previewCurrentProviderKey: (providerID: string, alias: string) => {
        exists: boolean;
        fingerprintChanged: boolean;
        fingerprint: Fingerprint;
        existingFingerprint?: Fingerprint;
    };
    switchProviderKey: (providerID: string, alias: string, reason?: string) => SwitchResult;
    rotateProviderKey: (providerID: string) => SwitchResult | undefined;
    hasAlternativeKey: (providerID: string) => boolean;
    keyExists: (providerID: string, alias: string) => boolean;
    backupAuth: (reason: string) => string;
    pruneAuthBackups: (maxBackups?: number) => void;
    calculateFingerprint: typeof calculateFingerprint;
};
declare function calculateFingerprint(credential: JsonObject): Fingerprint;
export {};
