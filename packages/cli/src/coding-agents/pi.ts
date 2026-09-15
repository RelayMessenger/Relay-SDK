import type { CodingAgent } from "../coding-agents.js";
import { piHome } from "./shared.js";

const agent: CodingAgent = {
  id: "pi",
  label: "Pi",
  aliases: ["pi-coding-agent"],
  installedIf: (paths) => [piHome(paths.home, paths.platform)],
  // Pi's native headless boundary is RPC. The Relay Pi package consumes
  // Relay's WebSocket and drives Pi over this process.
  connect: { kind: "pi-channel" },
  start: {
    kind: "pi-bridge",
    command: "pi",
    prompt: "Answer Relay messages with Pi from this folder?",
  },
  detectedAs: ["pi"],
};

export default agent;
