import { resolve } from "node:path";
import { ENGINE_HELP, isEngineName, type EngineName } from "./engine/catalog.js";

export interface CliFlags {
  engine: EngineName;
  dir?: string;
  name?: string;
  rest: string[];
}

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { engine: "claude", rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--staging") {
      throw new Error("--staging is unavailable because Relay has no live staging API origin.");
    } else if (arg === "--engine") {
      const value = argv[++i];
      if (!isEngineName(value)) {
        throw new Error(`--engine must be one of ${ENGINE_HELP}, got ${value ?? "(nothing)"}`);
      }
      flags.engine = value;
    } else if (arg === "--dir") {
      const value = argv[++i];
      if (!value) throw new Error("--dir needs a path");
      flags.dir = resolve(value);
    } else if (arg === "--name") {
      const value = argv[++i];
      if (!value) throw new Error("--name needs a value");
      flags.name = value;
    } else flags.rest.push(arg);
  }
  return flags;
}
