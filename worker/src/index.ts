import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import { GitHubStorage, chunkMarkdown } from "./github-storage";
import type { RetrievalLogEntry } from "./github-storage";

type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
};

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function randomId(): string {
  return crypto.randomUUID();
}

export class ApperceptionMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "apperception",
    version: "0.1.0",
  });

  private getStorage(): GitHubStorage {
    return new GitHubStorage(
      this.props!.accessToken,
      this.env.GITHUB_REPO_OWNER,
      this.env.GITHUB_REPO_NAME,
    );
  }

  async init() {
    const env = this.env;

    // ─── soul_context ───────────────────────────────────────────

    this.server.tool(
      "soul_context",
      "Load identity files and recent daily logs for session bootstrap.",
      {
        surface: z
          .enum(["code", "desktop", "cowork", "web", "mobile"])
          .describe("Which Claude surface is requesting"),
      },
      async ({ surface }) => {
        const storage = this.getStorage();
        const files: Record<string, string> = {};

        // Load identity files
        for (const f of ["SOUL.md", "IDENTITY.md", "USER.md", "STYLE.md", "MEMORY.md"]) {
          try {
            files[f] = await storage.readFile(f);
          } catch {
            // skip missing files
          }
        }

        // Load today's and yesterday's daily logs
        const todayStr = today();
        const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

        for (const date of [todayStr, yesterday]) {
          for (const s of ["code", "desktop", "cowork", "web", "mobile"]) {
            const path = `daily/${date}-${s}.md`;
            try {
              files[path] = await storage.readFile(path);
            } catch {
              // skip
            }
          }
        }

        const output = Object.entries(files)
          .map(([name, content]) => `--- ${name} ---\n${content}`)
          .join("\n\n");

        return {
          content: [{ type: "text" as const, text: output || "No files loaded." }],
        };
      }
    );

    // ─── soul_append ────────────────────────────────────────────

    this.server.tool(
      "soul_append",
      "Append an entry to today's daily log. Primary write operation.",
      {
        content: z.string().describe("The memory, observation, or decision to record"),
        surface: z
          .enum(["code", "desktop", "cowork", "web", "mobile"])
          .describe("Which surface is writing"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
      },
      async ({ content, surface, tags }) => {
        const storage = this.getStorage();
        const date = today();
        const path = `daily/${date}-${surface}.md`;
        const timestamp = new Date().toISOString().split("T")[1].split(".")[0];

        let entry = `\n### ${timestamp}`;
        if (tags?.length) entry += ` [${tags.join(", ")}]`;
        entry += `\n${content}\n`;

        // Create file with header if needed
        const exists = await storage.fileExists(path);
        if (!exists) {
          const header = `# Daily Log — ${date} (${surface})\n`;
          await storage.writeFile(path, header + entry, `Create daily log ${date}-${surface}`);
        } else {
          await storage.appendToFile(path, entry);
        }

        return { content: [{ type: "text" as const, text: `Appended to ${path}` }] };
      }
    );

    // ─── soul_remember ──────────────────────────────────────────

    this.server.tool(
      "soul_remember",
      "Search across all memory layers. Uses D1 FTS + Vectorize hybrid search.",
      {
        query: z.string().describe("Natural language or keyword query"),
        limit: z.number().optional().default(10).describe("Max results"),
        scope: z
          .array(z.enum(["memory", "daily", "dreams"]))
          .optional()
          .describe("Folders to search"),
      },
      async ({ query, limit, scope }) => {
        // Hybrid search: FTS from D1 + vector from Vectorize
        const ftsResults = await this.ftsSearch(query, scope, limit);
        const vecResults = await this.vectorSearch(query, scope, limit);

        // Merge and deduplicate, preferring higher scores
        const merged = new Map<string, { file: string; excerpt: string; score: number; date?: string }>();

        for (const r of ftsResults) {
          merged.set(`${r.file}:${r.excerpt.slice(0, 50)}`, r);
        }
        for (const r of vecResults) {
          const key = `${r.file}:${r.excerpt.slice(0, 50)}`;
          const existing = merged.get(key);
          if (!existing || r.score > existing.score) {
            merged.set(key, r);
          }
        }

        const results = [...merged.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        // Passive retrieval logging
        const storage = this.getStorage();
        const entry: RetrievalLogEntry = {
          id: randomId(),
          timestamp: new Date().toISOString(),
          type: "retrieval",
          query,
          results: results.map((r) => r.file),
        };
        storage.appendRetrievalLog(entry).catch(() => {});

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No results found for: "${query}"` }] };
        }

        const formatted = results
          .map(
            (r) =>
              `**${r.file}** (score: ${r.score.toFixed(2)}${r.date ? `, date: ${r.date}` : ""})\n${r.excerpt}\n`
          )
          .join("\n---\n\n");

        return {
          content: [{ type: "text" as const, text: `Found ${results.length} results for "${query}":\n\n${formatted}` }],
        };
      }
    );

    // ─── soul_read ──────────────────────────────────────────────

    this.server.tool(
      "soul_read",
      "Read a specific file from the soul repo.",
      {
        path: z.string().describe("Relative path (e.g. 'memory/project_dali.md')"),
      },
      async ({ path }) => {
        const storage = this.getStorage();
        try {
          const content = await storage.readFile(path);
          return { content: [{ type: "text" as const, text: `--- ${path} ---\n${content}` }] };
        } catch {
          return { content: [{ type: "text" as const, text: `File not found: ${path}` }] };
        }
      }
    );

    // ─── soul_write ─────────────────────────────────────────────

    this.server.tool(
      "soul_write",
      "Create or update a curated memory file. Auto-commits via GitHub API.",
      {
        path: z.string().describe("Relative path (e.g. 'memory/project_dali.md')"),
        content: z.string().describe("Full file content"),
        message: z.string().optional().describe("Commit message"),
      },
      async ({ path, content, message }) => {
        const storage = this.getStorage();
        await storage.writeFile(path, content, message ?? `Update ${path}`);

        // Re-index the file in D1 + Vectorize
        await this.indexFile(path, content);

        return { content: [{ type: "text" as const, text: `Written and committed: ${path}` }] };
      }
    );

    // ─── soul_revise ────────────────────────────────────────────

    this.server.tool(
      "soul_revise",
      "Flag that a retrieved memory needs updating. The dream cron will reconsolidate it.",
      {
        memory_path: z.string().describe("Which memory file to revise"),
        note: z.string().describe("What changed and why"),
      },
      async ({ memory_path, note }) => {
        const storage = this.getStorage();
        const entry: RetrievalLogEntry = {
          id: randomId(),
          timestamp: new Date().toISOString(),
          type: "revise",
          memory_path,
          note,
        };
        await storage.appendRetrievalLog(entry);

        return {
          content: [{ type: "text" as const, text: `Flagged for reconsolidation: ${memory_path}\nNote: ${note}` }],
        };
      }
    );

    // ─── soul_status ────────────────────────────────────────────

    this.server.tool(
      "soul_status",
      "Report on the health of the memory system.",
      {},
      async () => {
        const storage = this.getStorage();
        const memoryFiles = await storage.listFiles("memory");
        const dailyFiles = await storage.listFiles("daily");
        const dreamFiles = await storage.listFiles("dreams");
        const retrievalLog = await storage.readRetrievalLog();

        const revisions = retrievalLog.filter((e) => e.type === "revise");
        const retrievals = retrievalLog.filter((e) => e.type === "retrieval");
        const sortedDreams = dreamFiles.sort().reverse();

        // D1 index stats
        const indexStats = await env.DB.prepare(
          "SELECT COUNT(*) as files FROM file_meta"
        ).first<{ files: number }>();
        const chunkStats = await env.DB.prepare(
          "SELECT COUNT(*) as chunks FROM chunks"
        ).first<{ chunks: number }>();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "## Apperception Status (Remote)",
                `- Curated memories: ${memoryFiles.length}`,
                `- Daily logs: ${dailyFiles.length}`,
                `- Dream logs: ${dreamFiles.length}`,
                `- Last dream: ${sortedDreams[0] ?? "none"}`,
                `- Retrievals since last dream: ${retrievals.length}`,
                `- Pending revisions: ${revisions.length}`,
                `- Search index: ${indexStats?.files ?? 0} files, ${chunkStats?.chunks ?? 0} chunks`,
              ].join("\n"),
            },
          ],
        };
      }
    );

    // ─── soul_index ─────────────────────────────────────────────

    this.server.tool(
      "soul_index",
      "Rebuild search index (D1 FTS + Vectorize embeddings).",
      {
        full: z.boolean().optional().default(false).describe("Full rebuild"),
      },
      async ({ full }) => {
        const storage = this.getStorage();
        const start = Date.now();
        let indexed = 0;

        // Index all folders
        for (const folder of ["memory", "daily", "dreams"]) {
          const files = await storage.listFiles(folder);
          for (const file of files) {
            try {
              const content = await storage.readFile(file);
              await this.indexFile(file, content);
              indexed++;
            } catch {
              // skip
            }
          }
        }

        // Index identity files
        for (const file of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
          try {
            const content = await storage.readFile(file);
            await this.indexFile(file, content);
            indexed++;
          } catch {
            // skip
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `## Index rebuilt`,
                `- Files indexed: ${indexed}`,
                `- Duration: ${Date.now() - start}ms`,
              ].join("\n"),
            },
          ],
        };
      }
    );
  }

  // ─── Search helpers ─────────────────────────────────────────

  private async ftsSearch(
    query: string,
    scope?: string[],
    limit = 10
  ): Promise<{ file: string; excerpt: string; score: number; date?: string }[]> {
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term.replace(/"/g, '""')}"*`)
      .join(" OR ");

    if (!ftsQuery) return [];

    try {
      let sql = `
        SELECT c.file, c.content AS excerpt, c.date, rank AS score
        FROM chunks_fts fts
        JOIN chunks c ON c.id = fts.rowid
        WHERE chunks_fts MATCH ?1
      `;
      const params: string[] = [ftsQuery];

      if (scope?.length) {
        const conditions = scope.map((_, i) => `c.file LIKE ?${i + 2}`).join(" OR ");
        sql += ` AND (${conditions})`;
        for (const s of scope) {
          params.push(`${s}/%`);
        }
      }

      sql += ` ORDER BY rank LIMIT ?${params.length + 1}`;
      params.push(String(limit));

      const stmt = this.env.DB.prepare(sql);
      const { results } = await stmt.bind(...params).all<{
        file: string;
        excerpt: string;
        date: string | null;
        score: number;
      }>();

      return (results ?? []).map((r: { file: string; excerpt: string; date: string | null; score: number }) => ({
        file: r.file,
        excerpt: r.excerpt.length > 400 ? r.excerpt.slice(0, 400) + "..." : r.excerpt,
        score: Math.abs(r.score),
        date: r.date ?? undefined,
      }));
    } catch {
      return [];
    }
  }

  private async vectorSearch(
    query: string,
    scope?: string[],
    limit = 10
  ): Promise<{ file: string; excerpt: string; score: number; date?: string }[]> {
    try {
      // Generate embedding for the query
      const embeddingResponse = await this.env.AI.run(
        "@cf/baai/bge-base-en-v1.5",
        { text: [query] }
      ) as { data?: number[][] };
      const queryVector = embeddingResponse.data![0];

      // Query Vectorize
      const vectorResults = await this.env.VECTORIZE.query(queryVector, {
        topK: limit,
        returnMetadata: "all",
        ...(scope?.length
          ? {
              filter: {
                folder: { $in: scope },
              },
            }
          : {}),
      });

      return vectorResults.matches.map((match: any) => ({
        file: (match.metadata?.file as string) ?? "unknown",
        excerpt: (match.metadata?.content as string)?.slice(0, 400) ?? "",
        score: match.score,
        date: (match.metadata?.date as string) ?? undefined,
      }));
    } catch {
      return [];
    }
  }

  // ─── Indexing ─────────────────────────────────────────────────

  private async indexFile(path: string, content: string): Promise<void> {
    const chunks = chunkMarkdown(content, path);
    const folder = path.split("/")[0] || "root";

    // Clear old chunks from D1
    // Clear old FTS entries before deleting chunks
    const oldChunks = await this.env.DB.prepare("SELECT id FROM chunks WHERE file = ?").bind(path).all<{ id: number }>();
    for (const old of oldChunks.results ?? []) {
      await this.env.DB.prepare("DELETE FROM chunks_fts WHERE rowid = ?").bind(old.id).run();
    }
    await this.env.DB.prepare("DELETE FROM chunks WHERE file = ?").bind(path).run();

    // Insert new chunks into D1
    for (const chunk of chunks) {
      const result = await this.env.DB.prepare(
        "INSERT INTO chunks (file, chunk_index, content, date, mtime) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(chunk.file, chunk.chunk_index, chunk.content, chunk.date ?? null, Date.now())
        .run();

      // Insert into FTS
      if (result.meta.last_row_id) {
        await this.env.DB.prepare(
          "INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)"
        )
          .bind(result.meta.last_row_id, chunk.content)
          .run();
      }
    }

    // Update file_meta
    await this.env.DB.prepare(
      "INSERT OR REPLACE INTO file_meta (file, mtime, chunk_count) VALUES (?, ?, ?)"
    )
      .bind(path, Date.now(), chunks.length)
      .run();

    // Generate embeddings and upsert to Vectorize
    try {
      const texts = chunks.map((c) => c.content);
      const embeddingResponse = await this.env.AI.run(
        "@cf/baai/bge-base-en-v1.5",
        { text: texts }
      ) as { data?: number[][] };

      const vectors = chunks.map((chunk, i) => ({
        id: `${chunk.file}:${chunk.chunk_index}`,
        values: embeddingResponse.data![i],
        metadata: {
          file: chunk.file,
          chunk_index: chunk.chunk_index,
          content: chunk.content.slice(0, 500),
          date: chunk.date ?? "",
          folder,
        },
      }));

      await this.env.VECTORIZE.upsert(vectors);
    } catch {
      // Vector indexing is best-effort
    }
  }
}

const provider = new OAuthProvider({
  apiHandler: ApperceptionMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: "/token",
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const ip = request.headers.get("CF-Connecting-IP");
    const path = new URL(request.url).pathname;
    console.log(`[apperception] ${request.method} ${path} from ${ip}`);
    return provider.fetch(request, env, ctx);
  },
};
