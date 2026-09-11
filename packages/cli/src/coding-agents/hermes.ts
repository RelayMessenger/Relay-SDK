import type { CodingAgent } from "../coding-agents.js";
import { hermesHome } from "./shared.js";

const agent: CodingAgent =
  {
    id: "hermes",
    label: "Hermes",
    aliases: [],
    command: "hermes",
    installedIf: (paths) => [hermesHome(paths.env, paths.home, paths.platform)],
    connect: { kind: "hermes-plugin" },
    detectedAs: [],
  };

export default agent;
