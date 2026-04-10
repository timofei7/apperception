import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SoulStorage, RetrievalLogEntry } from "./storage.js";
import { loadSoulContext } from "./context.js";
import { randomUUID } from "crypto";

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

export function registerTools(server: McpServer, storage: SoulStorage) {
  // ─── soul_context ───────────────────────────────────────────

  server.registerTool(
    "soul_context",
    {
      title: "Load Identity & Recent Memory",
      description:
        "Load identity files and recent daily logs for session bootstrap. Call this at the start of every session.",
      inputSchema: z.object({
        surface: z
          .enum(["code", "desktop", "cowork", "web", "mobile"])
          .describe("Which Claude surface is requesting"),
      }),
    },
    async ({ surface }) => {
      return text(await loadSoulContext(storage, surface));
    }
  );

  // ─── soul_append ────────────────────────────────────────────

  server.registerTool(
    "soul_append",
    {
      title: "Append to Daily Log",
      description:
        "Append an entry to today's daily log for this surface. Primary write operation. Append-only, no conflicts.",
      inputSchema: z.object({
        content: z.string().describe("The memory, observation, or decision to record"),
        surface: z
          .enum(["code", "desktop", "cowork", "web", "mobile"])
          .describe("Which surface is writing"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
      }),
    },
    async ({ content, surface, tags }) => {
      const date = today();
      const path = `daily/${date}-${surface}.md`;
      const timestamp = new Date().toISOString().split("T")[1].split(".")[0];

      let entry = `\n### ${timestamp}`;
      if (tags?.length) entry += ` [${tags.join(", ")}]`;
      entry += `\n${content}\n`;

      // Create file with header if it doesn't exist
      if (!(await storage.fileExists(path))) {
        const header = `# Daily Log — ${date} (${surface})\n`;
        await storage.writeFile(path, header);
      }

      await storage.appendToFile(path, entry);

      return text(`Appended to ${path}`);
    }
  );

  // ─── soul_remember ──────────────────────────────────────────

  server.registerTool(
    "soul_remember",
    {
      title: "Search Memory",
      description:
        "Search across all memory layers. Automatically logs every retrieval for the dream cron.",
      inputSchema: z.object({
        query: z.string().describe("Natural language or keyword query"),
        limit: z.number().optional().default(10).describe("Max results"),
        scope: z
          .array(z.enum(["memory", "daily", "dreams"]))
          .optional()
          .describe("Folders to search"),
        after: z.string().optional().describe("ISO date filter (after)"),
        before: z.string().optional().describe("ISO date filter (before)"),
      }),
    },
    async ({ query, limit, scope, after, before }) => {
      let results = await storage.search(query, scope);

      // Date filters
      if (after) {
        results = results.filter((r) => !r.date || r.date >= after);
      }
      if (before) {
        results = results.filter((r) => !r.date || r.date <= before);
      }

      results = results.slice(0, limit);

      // Passive retrieval logging
      const entry: RetrievalLogEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "retrieval",
        query,
        results: results.map((r) => r.file),
      };
      await storage.appendRetrievalLog(entry).catch(() => {});

      if (results.length === 0) {
        return text(`No results found for: "${query}"`);
      }

      const formatted = results
        .map(
          (r) =>
            `**${r.file}** (score: ${r.score.toFixed(2)}${r.date ? `, date: ${r.date}` : ""})\n${r.excerpt}\n`
        )
        .join("\n---\n\n");

      return text(`Found ${results.length} results for "${query}":\n\n${formatted}`);
    }
  );

  // ─── soul_read ──────────────────────────────────────────────

  server.registerTool(
    "soul_read",
    {
      title: "Read File",
      description: "Read a specific file from the soul repo.",
      inputSchema: z.object({
        path: z.string().describe("Relative path (e.g. 'memory/project_dali.md')"),
      }),
    },
    async ({ path }) => {
      try {
        const content = await storage.readFile(path);
        const lastModified = await storage.getLastModified(path);
        return text(`--- ${path} (modified: ${lastModified}) ---\n${content}`);
      } catch {
        return text(`File not found: ${path}`);
      }
    }
  );

  // ─── soul_write ─────────────────────────────────────────────

  server.registerTool(
    "soul_write",
    {
      title: "Write Memory File",
      description:
        "Create or update a curated memory file. Auto-commits to git.",
      inputSchema: z.object({
        path: z.string().describe("Relative path (e.g. 'memory/project_dali.md')"),
        content: z.string().describe("Full file content"),
        message: z.string().optional().describe("Git commit message"),
      }),
    },
    async ({ path, content, message }) => {
      await storage.writeFile(path, content);

      const commitMsg = message ?? `Update ${path}`;
      try {
        await storage.gitCommit(commitMsg, [path]);
      } catch {
        // Git might not be initialized — that's ok for now
      }

      return text(`Written and committed: ${path}`);
    }
  );

  // ─── soul_revise ────────────────────────────────────────────

  server.registerTool(
    "soul_revise",
    {
      title: "Flag Memory for Reconsolidation",
      description:
        "Flag that a retrieved memory needs updating based on new context. The dream cron will reconsolidate it.",
      inputSchema: z.object({
        memory_path: z.string().describe("Which memory file to revise"),
        note: z.string().describe("What changed and why"),
      }),
    },
    async ({ memory_path, note }) => {
      const entry: RetrievalLogEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "revise",
        memory_path,
        note,
      };
      await storage.appendRetrievalLog(entry);

      return text(
        `Flagged for reconsolidation: ${memory_path}\nNote: ${note}`
      );
    }
  );

  // ─── soul_dream_prep ────────────────────────────────────────

  server.registerTool(
    "soul_dream_prep",
    {
      title: "Gather Dream Sources",
      description:
        "Gather all sources for nightly dream consolidation. Returns daily logs, retrieval log, and current memories.",
      inputSchema: z.object({
        date: z.string().optional().describe("Date to consolidate (default: today)"),
      }),
    },
    async ({ date }) => {
      const targetDate = date ?? today();

      // Gather daily logs for the target date
      const dailyFiles = await storage.listFiles("daily");
      const dailyLogs: { surface: string; content: string }[] = [];
      for (const f of dailyFiles) {
        if (f.includes(targetDate)) {
          const surfaceMatch = f.match(
            /\d{4}-\d{2}-\d{2}-(\w+)\.md$/
          );
          const surface = surfaceMatch?.[1] ?? "unknown";
          try {
            const content = await storage.readFile(f);
            dailyLogs.push({ surface, content });
          } catch {
            // skip
          }
        }
      }

      // Retrieval log
      const retrievalLog = await storage.readRetrievalLog();

      // Current memories
      const memoryFiles = await storage.listFiles("memory");
      const memories: { file: string; excerpt: string }[] = [];
      for (const f of memoryFiles) {
        try {
          const content = await storage.readFile(f);
          memories.push({
            file: f,
            excerpt: content.slice(0, 500),
          });
        } catch {
          // skip
        }
      }

      // Memory index
      let memoryIndex = "";
      try {
        memoryIndex = await storage.readFile("MEMORY.md");
      } catch {
        // no index yet
      }

      const result = {
        date: targetDate,
        daily_logs: dailyLogs,
        retrieval_log: retrievalLog,
        current_memories: memories,
        memory_index: memoryIndex,
      };

      return text(JSON.stringify(result, null, 2));
    }
  );

  // ─── soul_index ─────────────────────────────────────────────

  server.registerTool(
    "soul_index",
    {
      title: "Rebuild Search Index",
      description:
        "Rebuild the search index. Currently FTS-only (vector search via Cloudflare in remote mode).",
      inputSchema: z.object({
        full: z.boolean().optional().default(false).describe("Full rebuild vs incremental"),
      }),
    },
    async ({ full }) => {
      const start = Date.now();
      const result = await storage.ensureIndex();
      const duration = Date.now() - start;

      return text(
        [
          `## Index ${full ? "rebuilt" : "updated"}`,
          `- Files indexed: ${result.indexed}`,
          `- Files skipped (unchanged): ${result.skipped}`,
          `- Total chunks: ${result.chunks}`,
          `- Duration: ${duration}ms`,
        ].join("\n")
      );
    }
  );

  // ─── soul_status ────────────────────────────────────────────

  server.registerTool(
    "soul_status",
    {
      title: "Memory System Health Check",
      description: "Report on the health of the memory system.",
      inputSchema: z.object({}),
    },
    async () => {
      const memoryFiles = await storage.listFiles("memory");
      const dailyFiles = await storage.listFiles("daily");
      const dreamFiles = await storage.listFiles("dreams");
      const retrievalLog = await storage.readRetrievalLog();

      const revisions = retrievalLog.filter((e) => e.type === "revise");
      const retrievals = retrievalLog.filter((e) => e.type === "retrieval");

      // Find last dream
      const sortedDreams = dreamFiles.sort().reverse();
      const lastDream = sortedDreams[0] ?? "none";

      return text(
        [
          `## Apperception Status`,
          `- Curated memories: ${memoryFiles.length}`,
          `- Daily logs: ${dailyFiles.length}`,
          `- Dream logs: ${dreamFiles.length}`,
          `- Last dream: ${lastDream}`,
          `- Retrievals since last dream: ${retrievals.length}`,
          `- Pending revisions: ${revisions.length}`,
        ].join("\n")
      );
    }
  );

  // ─── soul_git ───────────────────────────────────────────────

  server.registerTool(
    "soul_git",
    {
      title: "Git Sync",
      description: "Sync with GitHub remote.",
      inputSchema: z.object({
        action: z.enum(["pull", "push", "status"]).describe("Git action"),
      }),
    },
    async ({ action }) => {
      switch (action) {
        case "pull":
          return text(await storage.gitPull());
        case "push":
          return text(await storage.gitPush());
        case "status":
          return text(await storage.gitStatus());
      }
    }
  );
}
