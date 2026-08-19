// Injected plugin runtime store (qa-channel pattern): defineChannelPluginEntry
// calls setRelayRuntime, and gateway/inbound code reads it lazily.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setRelayRuntime, getRuntime: getRelayRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "relay",
    errorMessage: "Relay runtime not initialized",
  });

export { getRelayRuntime, setRelayRuntime };
export type { PluginRuntime };
