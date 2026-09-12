#!/usr/bin/env node
import { runCLI } from "./program.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`Relay needs Node 22 or newer. You have ${process.versions.node}.`);
  process.exit(1);
}

process.exitCode = await runCLI(process.argv.slice(2));
