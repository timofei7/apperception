-- Migration number: 0001 	 2026-04-10T20:08:10.042Z
-- Apperception D1 search schema

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
