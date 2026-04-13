import { readFile, writeFile, appendFile, readdir, stat, mkdir } from "fs/promises";
import { join, relative, dirname, resolve } from "path";
import { existsSync } from "fs";
import { simpleGit, SimpleGit } from "simple-git";
import { SearchIndex } from "./search.js";

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

export interface SearchResult {
  file: string;
  excerpt: string;
  score: number;
  date?: string;
}

export interface SoulStorage {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendToFile(path: string, content: string): Promise<void>;
  listFiles(folder: string): Promise<string[]>;
  fileExists(path: string): Promise<boolean>;
  getLastModified(path: string): Promise<string>;
  search(query: string, scope?: string[]): Promise<SearchResult[]>;
  gitPull(): Promise<string>;
  gitPush(): Promise<string>;
  gitStatus(): Promise<string>;
  gitCommit(message: string, files?: string[]): Promise<void>;
  appendRetrievalLog(entry: RetrievalLogEntry): Promise<void>;
  readRetrievalLog(): Promise<RetrievalLogEntry[]>;
  clearRetrievalLog(): Promise<void>;
  ensureIndex(): Promise<{ indexed: number; skipped: number; chunks: number }>;
  getSearchStats(): { files: number; chunks: number };
}

export class LocalStorage implements SoulStorage {
  private repoPath: string;
  private git: SimpleGit;
  private searchIndex: SearchIndex;
  private indexReady = false;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
    this.searchIndex = new SearchIndex(repoPath);
  }

  /** Ensure the search index is up-to-date. Lazy — runs once per session. */
  async ensureIndex(): Promise<{ indexed: number; skipped: number; chunks: number }> {
    const result = await this.searchIndex.indexAll();
    this.indexReady = true;
    return result;
  }

  private resolve(path: string): string {
    if (!path) throw new Error("Path cannot be empty");
    const resolved = resolve(this.repoPath, path);
    if (!resolved.startsWith(this.repoPath + "/")) {
      throw new Error(`Path traversal blocked: ${path}`);
    }
    return resolved;
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.resolve(path), "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = this.resolve(path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, content, "utf-8");
  }

  async appendToFile(path: string, content: string): Promise<void> {
    const fullPath = this.resolve(path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await appendFile(fullPath, content, "utf-8");
  }

  async listFiles(folder: string): Promise<string[]> {
    const fullPath = this.resolve(folder);
    if (!existsSync(fullPath)) return [];
    const entries = await readdir(fullPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(folder, e.name));
  }

  async fileExists(path: string): Promise<boolean> {
    return existsSync(this.resolve(path));
  }

  async getLastModified(path: string): Promise<string> {
    const s = await stat(this.resolve(path));
    return s.mtime.toISOString();
  }

  async search(query: string, scope?: string[]): Promise<SearchResult[]> {
    // Ensure index is fresh
    if (!this.indexReady) {
      await this.ensureIndex();
    }

    const hits = this.searchIndex.search(query, scope);
    return hits.map((h) => ({
      file: h.file,
      excerpt: h.excerpt,
      score: h.score,
      date: h.date,
    }));
  }

  /** Get search index stats */
  getSearchStats(): { files: number; chunks: number } {
    return this.searchIndex.stats();
  }

  // Git operations

  async gitPull(): Promise<string> {
    try {
      const result = await this.git.pull();
      return result.summary.changes
        ? `Pulled: ${result.summary.changes} changes`
        : "Already up to date";
    } catch (e: any) {
      return `Pull failed: ${e.message}`;
    }
  }

  async gitPush(): Promise<string> {
    try {
      await this.git.push();
      return "Pushed successfully";
    } catch (e: any) {
      return `Push failed: ${e.message}`;
    }
  }

  async gitStatus(): Promise<string> {
    const status = await this.git.status();
    if (status.isClean()) return "Clean — no changes";
    const parts: string[] = [];
    if (status.modified.length) parts.push(`Modified: ${status.modified.join(", ")}`);
    if (status.not_added.length) parts.push(`Untracked: ${status.not_added.join(", ")}`);
    if (status.created.length) parts.push(`New: ${status.created.join(", ")}`);
    return parts.join("\n");
  }

  async gitCommit(message: string, files?: string[]): Promise<void> {
    if (files?.length) {
      await this.git.add(files);
    } else {
      await this.git.add(".");
    }
    await this.git.commit(message);
  }

  // Retrieval log

  private get retrievalLogPath(): string {
    return this.resolve(".soul/retrievals.jsonl");
  }

  async appendRetrievalLog(entry: RetrievalLogEntry): Promise<void> {
    const dir = dirname(this.retrievalLogPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await appendFile(this.retrievalLogPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  async readRetrievalLog(): Promise<RetrievalLogEntry[]> {
    if (!existsSync(this.retrievalLogPath)) return [];
    const content = await readFile(this.retrievalLogPath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async clearRetrievalLog(): Promise<void> {
    await writeFile(this.retrievalLogPath, "", "utf-8");
  }
}
