import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalStorage } from "./storage.js";
import { registerTools } from "./tools.js";
import { resolve } from "path";

// Determine repo path: env var or CLI arg (required)
const repoPath = process.env.SOUL_REPO_PATH ?? process.argv[2];

if (!repoPath) {
  console.error("Usage: apperception <repo-path>");
  console.error("  Or set SOUL_REPO_PATH environment variable");
  process.exit(1);
}

const storage = new LocalStorage(repoPath);
const server = new McpServer(
  { name: "apperception", version: "0.1.0" },
  {
    capabilities: { logging: {} },
    instructions:
      "Apperception is a unified memory system. " +
      "Call soul_context at session start. " +
      "Call soul_remember to search memories. " +
      "Call soul_revise when a retrieved memory needs updating. " +
      "Call soul_append at session end with a summary.",
  }
);

registerTools(server, storage);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Apperception MCP server running (repo: ${repoPath})`);
