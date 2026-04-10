#!/usr/bin/env node
// CLI entry point for soul_context — used by SessionStart hook.
// Shares the same logic as the MCP tool.

import { LocalStorage } from "./storage.js";
import { loadSoulContext } from "./context.js";
import { resolve } from "path";

const repoPath = process.env.SOUL_REPO_PATH ?? process.argv[2];

if (!repoPath) {
  console.error("Usage: soul-context <repo-path> [surface]");
  console.error("  Or set SOUL_REPO_PATH environment variable");
  process.exit(1);
}

const surface = process.env.SOUL_SURFACE ?? process.argv[3] ?? "code";

const storage = new LocalStorage(repoPath);
const output = await loadSoulContext(storage, surface);
process.stdout.write(output);
