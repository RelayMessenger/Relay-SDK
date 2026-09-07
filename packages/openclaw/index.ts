import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { relayChannelPlugin } from "./src/channel.js";
import { setRelayRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "relay",
  name: "Relay",
  description: "Native Relay channel plugin for OpenClaw.",
  plugin: relayChannelPlugin,
  setRuntime: setRelayRuntime,
});
