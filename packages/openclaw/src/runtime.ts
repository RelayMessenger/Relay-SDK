import {
  createPluginRuntimeStore,
  type PluginRuntime,
} from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setRelayRuntime, getRuntime: getRelayRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "relay",
    errorMessage: "Relay runtime not initialized",
  });

export { getRelayRuntime, setRelayRuntime };
export type { PluginRuntime };
