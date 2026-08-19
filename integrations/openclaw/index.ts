// Relay channel plugin entrypoint registers the OpenClaw integration.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { relayChannelPlugin } from "./src/channel.js";
import { setRelayRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "relay",
  name: "Relay",
  description: "Relay channel plugin. Text your OpenClaw like a friend.",
  plugin: relayChannelPlugin,
  setRuntime: setRelayRuntime,
});
