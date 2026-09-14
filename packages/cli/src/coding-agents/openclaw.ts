import type { CodingAgent } from "../coding-agents.js";
import { platformPath, openclawHome } from "./shared.js";

const agent: CodingAgent =
  {
    id: "openclaw",
    label: "OpenClaw",
    aliases: ["open-claw"],
    command: "openclaw",
    installedIf: (paths) => [openclawHome(paths.home, paths.platform), platformPath(paths.platform).join(paths.home, ".clawdbot"), platformPath(paths.platform).join(paths.home, ".moltbot")],
    // Our plugin, then OpenClaw's own `channels add relay --token --base-url`:
    // the plugin ships OpenClaw's native setup contract, so the token lives in
    // OpenClaw's own channel store and Relay writes no OpenClaw file.
    connect: { kind: "openclaw-plugin" },
    start: {
      kind: "command",
      command: "openclaw",
      args: ["gateway"],
      prompt: "Start OpenClaw with Relay now?",
    },
    detectedAs: [],
  };

export default agent;
