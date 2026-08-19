// Lightweight setup entry: loaded instead of the full entry while the channel
// is disabled/unconfigured, so status/config surfaces avoid runtime imports.
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { relayChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(relayChannelPlugin);
