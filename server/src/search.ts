import Database from "better-sqlite3";
import { readFile, readdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";

export interface Chunk {
  file: string;
  chunk_index: number;
  content: string;
  date?: string;
}

export interface SearchHit {
  file: string;
  excerpt: string;
  score: number;
  date?: string;
}

/**
 * Chunks a markdown file into searchable segments.
 * Strategy: split on headings (### or ##), keep chunks under ~500 chars.
 * Small files stay as a single chunk.
 */
export function chunkMarkdown(content: string, file: string): Chunk[] {
  const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch?.[1];

  // For small files, single chunk
  if (content.length < 600) {
    return [{ file, chunk_index: 0, content: content.trim(), date }];
  }

  // Split on markdown headings
  const sections = content.split(/(?=^#{2,3}\s)/m);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // If a section is still large, split on double newlines
    if (trimmed.length > 800) {
      const paragraphs = trimmed.split(/\n\n+/);
      let buffer = "";
      for (const para of paragraphs) {
        if (buffer.length + para.length > 600 && buffer.length > 0) {
          chunks.push({
            file,
            chunk_index: chunks.length,
            content: buffer.trim(),
            date,
          });
          buffer = para;
        } else {
          buffer += (buffer ? "\n\n" : "") + para;
        }
      }
      if (buffer.trim()) {
        chunks.push({
          file,
          chunk_index: chunks.length,
          content: buffer.trim(),
          date,
        });
      }
    } else {
      chunks.push({
        file,
        chunk_index: chunks.length,
        content: trimmed,
        date,
      });
    }
  }

  return chunks.length > 0
    ? chunks
    : [{ file, chunk_index: 0, content: content.trim(), date }];
}

/**
 * SQLite FTS5 search index for local mode.
 * Phase 6 replaces this with Cloudflare D1 (FTS) + Vectorize (vectors).
 */
export class SearchIndex {
  private db: Database.Database;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    const dbPath = join(repoPath, ".soul", "index.sqlite");

    // Ensure .soul directory exists
    const soulDir = dirname(dbPath);
    if (!existsSync(soulDir)) {
      mkdirSync(soulDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        date TEXT,
        mtime REAL NOT NULL,
        UNIQUE(file, chunk_index)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        content_rowid='id'
      );

      CREATE TABLE IF NOT EXISTS file_meta (
        file TEXT PRIMARY KEY,
        mtime REAL NOT NULL,
        chunk_count INTEGER NOT NULL
      );
    `);
  }

  /**
   * Index a single file. Skips if mtime hasn't changed.
   */
  async indexFile(file: string): Promise<boolean> {
    const fullPath = join(this.repoPath, file);
    if (!existsSync(fullPath)) return false;

    const fileStat = await stat(fullPath);
    const mtime = fileStat.mtimeMs;

    // Check if already indexed at this mtime
    const existing = this.db
      .prepare("SELECT mtime FROM file_meta WHERE file = ?")
      .get(file) as { mtime: number } | undefined;

    if (existing && existing.mtime === mtime) {
      return false; // Already up to date
    }

    const content = await readFile(fullPath, "utf-8");
    const chunks = chunkMarkdown(content, file);

    // Transaction: remove old chunks, insert new ones
    const tx = this.db.transaction(() => {
      // Get old chunk IDs for FTS cleanup
      const oldChunks = this.db
        .prepare("SELECT id, content FROM chunks WHERE file = ?")
        .all(file) as { id: number; content: string }[];

      for (const old of oldChunks) {
        this.db
          .prepare("DELETE FROM chunks_fts WHERE rowid = ?")
          .run(old.id);
      }

      this.db.prepare("DELETE FROM chunks WHERE file = ?").run(file);

      // Insert new chunks
      const insertChunk = this.db.prepare(
        "INSERT INTO chunks (file, chunk_index, content, date, mtime) VALUES (?, ?, ?, ?, ?)"
      );
      const insertFts = this.db.prepare(
        "INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)"
      );

      for (const chunk of chunks) {
        const result = insertChunk.run(
          chunk.file,
          chunk.chunk_index,
          chunk.content,
          chunk.date ?? null,
          mtime
        );
        insertFts.run(result.lastInsertRowid, chunk.content);
      }

      // Update file metadata
      this.db
        .prepare(
          "INSERT OR REPLACE INTO file_meta (file, mtime, chunk_count) VALUES (?, ?, ?)"
        )
        .run(file, mtime, chunks.length);
    });

    tx();
    return true;
  }

  /**
   * Index all markdown files in the given folders.
   * Returns count of files updated.
   */
  async indexAll(
    folders: string[] = ["memory", "daily", "dreams"]
  ): Promise<{ indexed: number; skipped: number; chunks: number }> {
    let indexed = 0;
    let skipped = 0;

    for (const folder of folders) {
      const fullFolder = join(this.repoPath, folder);
      if (!existsSync(fullFolder)) continue;

      const entries = await readdir(fullFolder, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const file = join(folder, entry.name);
        const updated = await this.indexFile(file);
        if (updated) indexed++;
        else skipped++;
      }
    }

    // Also index top-level identity files
    for (const file of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      if (existsSync(join(this.repoPath, file))) {
        const updated = await this.indexFile(file);
        if (updated) indexed++;
        else skipped++;
      }
    }

    const totalChunks = (
      this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
        count: number;
      }
    ).count;

    return { indexed, skipped, chunks: totalChunks };
  }

  /**
   * Remove indexed entries for files that no longer exist on disk.
   */
  async prune(): Promise<number> {
    const allFiles = this.db
      .prepare("SELECT file FROM file_meta")
      .all() as { file: string }[];

    let pruned = 0;
    const tx = this.db.transaction(() => {
      for (const { file } of allFiles) {
        if (!existsSync(join(this.repoPath, file))) {
          const oldChunks = this.db
            .prepare("SELECT id FROM chunks WHERE file = ?")
            .all(file) as { id: number }[];
          for (const { id } of oldChunks) {
            this.db
              .prepare("DELETE FROM chunks_fts WHERE rowid = ?")
              .run(id);
          }
          this.db.prepare("DELETE FROM chunks WHERE file = ?").run(file);
          this.db.prepare("DELETE FROM file_meta WHERE file = ?").run(file);
          pruned++;
        }
      }
    });
    tx();
    return pruned;
  }

  /**
   * FTS5 search. Returns ranked results with BM25 scoring.
   */
  search(query: string, scope?: string[]): SearchHit[] {
    // Prepare FTS5 query — escape special chars, add prefix matching
    // Use OR so results match any term; BM25 ranks multi-term matches higher
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term.replace(/"/g, '""')}"*`)
      .join(" OR ");

    if (!ftsQuery) return [];

    let sql = `
      SELECT
        c.file,
        c.content AS excerpt,
        c.date,
        rank AS score
      FROM chunks_fts fts
      JOIN chunks c ON c.id = fts.rowid
      WHERE chunks_fts MATCH ?
    `;

    const params: any[] = [ftsQuery];

    // Filter by scope (folder prefix)
    if (scope?.length) {
      const conditions = scope.map(() => "c.file LIKE ?").join(" OR ");
      sql += ` AND (${conditions})`;
      for (const s of scope) {
        params.push(`${s}/%`);
      }
    }

    sql += ` ORDER BY rank LIMIT 20`;

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        file: string;
        excerpt: string;
        date: string | null;
        score: number;
      }>;

      return rows.map((r) => ({
        file: r.file,
        excerpt:
          r.excerpt.length > 400 ? r.excerpt.slice(0, 400) + "..." : r.excerpt,
        score: Math.abs(r.score), // FTS5 rank is negative (lower = better)
        date: r.date ?? undefined,
      }));
    } catch {
      // Fallback if FTS query syntax fails
      return [];
    }
  }

  /**
   * Get index statistics.
   */
  stats(): { files: number; chunks: number } {
    const files = (
      this.db.prepare("SELECT COUNT(*) as count FROM file_meta").get() as {
        count: number;
      }
    ).count;
    const chunks = (
      this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
        count: number;
      }
    ).count;
    return { files, chunks };
  }

  close(): void {
    this.db.close();
  }
}
