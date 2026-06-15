import { server } from "./server.js"

const pluginModule = {
  id: "opencode-key-rotator",
  server,
}

export default pluginModule
export { server } from "./server.js"
