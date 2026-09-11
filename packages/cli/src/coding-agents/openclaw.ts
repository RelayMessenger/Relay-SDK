import type { CodingAgent } from "../coding-agents.js";
import { platformPath, openclawHome } from "./shared.js";

const agent: CodingAgent =
  {
    id: "openclaw",
    label: "OpenClaw",
    aliases: ["open-claw"],
    command: "openclaw",
    installedIf: (paths) => [openclawHome(paths.home, paths.platform), platformPath(paths.platform).join(paths.home, ".clawdbot"), platformPath(paths.platform).join(paths.home, ".moltbot")],
    connect: { kind: "openclaw-plugin" },
    detectedAs: [],
  };

export default agent;
