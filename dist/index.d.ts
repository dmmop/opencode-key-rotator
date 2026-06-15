declare const pluginModule: {
    id: string;
    server: import("@opencode-ai/plugin").Plugin;
};
export default pluginModule;
export { server } from "./server.js";
