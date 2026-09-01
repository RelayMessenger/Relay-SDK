import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { relayChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(relayChannelPlugin);
