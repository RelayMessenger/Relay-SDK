#!/usr/bin/env node
import { runCLI } from "./program.js";

process.exitCode = await runCLI(process.argv.slice(2));
