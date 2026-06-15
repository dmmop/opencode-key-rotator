export type InstallerAction = "init" | "remove";
export type ConfigEditResult = {
    kind: "opencode" | "tui";
    path: string;
    existed: boolean;
    changed: boolean;
    message: string;
};
export type InstallOptions = {
    action: InstallerAction;
    spec: string;
    configDir?: string;
};
export declare function updateOpenCodeConfigs(options: InstallOptions): ConfigEditResult[];
export declare function defaultPluginSpec(): string;
