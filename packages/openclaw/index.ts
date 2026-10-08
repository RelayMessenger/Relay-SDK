import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { relayChannelPlugin } from "./src/channel.js";
import { setRelayRuntime } from "./src/runtime.js";
import { RELAY_TOOL_NAMES, relayToolFactory } from "./src/tools.js";

export default defineChannelPluginEntry({
  id: "relay",
  name: "Relay",
  description: "Native Relay channel plugin for OpenClaw.",
  plugin: relayChannelPlugin,
  setRuntime: setRelayRuntime,
  registerFull: (api) => {
    api.registerTool(relayToolFactory, { names: [...RELAY_TOOL_NAMES] });
  },
});
