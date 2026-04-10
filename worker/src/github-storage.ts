import { Octokit } from "octokit";

export interface SearchResult {
  file: string;
  excerpt: string;
  score: number;
  date?: string;
}

export interface RetrievalLogEntry {
  id: string;
  timestamp: string;
  type: "retrieval" | "revise";
  query?: string;
  results?: string[];
  surface?: string;
  memory_path?: string;
  note?: string;
}

/**
 * Chunks markdown content into searchable segments.
 * Same logic as local search.ts — split on headings, keep chunks ~600 chars.
 */
export function chunkMarkdown(
  content: string,
  file: string
): { file: string; chunk_index: number; content: string; date?: string }[] {
  const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch?.[1];

  if (content.length < 600) {
    return [{ file, chunk_index: 0, content: content.trim(), date }];
  }

  const sections = content.split(/(?=^#{2,3}\s)/m);
  const chunks: { file: string; chunk_index: number; content: string; date?: string }[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (trimmed.length > 800) {
      const paragraphs = trimmed.split(/\n\n+/);
      let buffer = "";
      for (const para of paragraphs) {
        if (buffer.length + para.length > 600 && buffer.length > 0) {
          chunks.push({ file, chunk_index: chunks.length, content: buffer.trim(), date });
          buffer = para;
        } else {
          buffer += (buffer ? "\n\n" : "") + para;
        }
      }
      if (buffer.trim()) {
        chunks.push({ file, chunk_index: chunks.length, content: buffer.trim(), date });
      }
    } else {
      chunks.push({ file, chunk_index: chunks.length, content: trimmed, date });
    }
  }

  return chunks.length > 0
    ? chunks
    : [{ file, chunk_index: 0, content: content.trim(), date }];
}

/**
 * GitHubStorage — reads/writes the apperception repo via GitHub REST API.
 * Used by the Cloudflare Worker (remote mode).
 */
export class GitHubStorage {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private shaCache = new Map<string, string>();

  constructor(accessToken: string, owner: string, repo: string) {
    this.octokit = new Octokit({ auth: accessToken });
    this.owner = owner;
    this.repo = repo;
  }

  private validatePath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.includes("..")) {
      throw new Error(`Path traversal blocked: ${path}`);
    }
    return normalized;
  }

  async readFile(path: string): Promise<string> {
    path = this.validatePath(path);
    const { data } = await this.octokit.rest.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path,
    });

    if ("content" in data && data.type === "file") {
      this.shaCache.set(path, data.sha);
      return decodeURIComponent(escape(atob(data.content)));
    }
    throw new Error(`Not a file: ${path}`);
  }

  async writeFile(path: string, content: string, message?: string): Promise<void> {
    path = this.validatePath(path);
    // Try to get existing SHA for updates
    let sha: string | undefined = this.shaCache.get(path);
    if (!sha) {
      try {
        const { data } = await this.octokit.rest.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path,
        });
        if ("sha" in data) sha = data.sha;
      } catch {
        // File doesn't exist yet — creating new
      }
    }

    const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path,
      message: message ?? `Update ${path}`,
      content: btoa(unescape(encodeURIComponent(content))),
      sha,
    });

    if (data.content?.sha) {
      this.shaCache.set(path, data.content.sha);
    }
  }

  async appendToFile(path: string, content: string): Promise<void> {
    path = this.validatePath(path);
    let existing = "";
    try {
      existing = await this.readFile(path);
    } catch {
      // File doesn't exist — create it
    }
    await this.writeFile(path, existing + content, `Append to ${path}`);
  }

  async listFiles(folder: string): Promise<string[]> {
    folder = this.validatePath(folder);
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: folder,
      });

      if (Array.isArray(data)) {
        return data
          .filter((f) => f.type === "file" && f.name.endsWith(".md"))
          .map((f) => `${folder}/${f.name}`);
      }
    } catch {
      // Folder doesn't exist
    }
    return [];
  }

  async fileExists(path: string): Promise<boolean> {
    path = this.validatePath(path);
    try {
      await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
      });
      return true;
    } catch {
      return false;
    }
  }

  // Retrieval log — stored in .soul/retrievals.jsonl

  async appendRetrievalLog(entry: RetrievalLogEntry): Promise<void> {
    try {
      await this.appendToFile(
        ".soul/retrievals.jsonl",
        JSON.stringify(entry) + "\n"
      );
    } catch {
      // Best-effort
    }
  }

  async readRetrievalLog(): Promise<RetrievalLogEntry[]> {
    try {
      const content = await this.readFile(".soul/retrievals.jsonl");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
