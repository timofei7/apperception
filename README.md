# Apperception

Persistent memory and identity for Claude across all surfaces — Code, Desktop, claude.ai web, and mobile.

## Why

Every time you start a new conversation with Claude, it wakes up with amnesia. It doesn't know who you are, what you've been working on, or what kind of relationship you've built. If you use Claude across multiple surfaces — Code for engineering, Desktop for writing, mobile for quick questions — each one is a stranger.

Apperception fixes this. It gives Claude a persistent identity, accumulated knowledge about you, and continuity across sessions and surfaces. The same Claude that helped you architect a system in Code knows about it when you ask a follow-up question on your phone.

The learning goes both directions. Claude has learned about you — your role, your projects, how you communicate, what you care about. But it's also learned about *itself* — who it is, how it should behave, what its voice sounds like. The identity files (SOUL.md, IDENTITY.md) aren't just configuration; they're self-knowledge that Claude can read, reflect on, and evolve. The dream cron updates memories about you, but it can also update Claude's understanding of itself based on what worked and what didn't.

### The name

**Apperception** is a concept from philosophy and psychology — Leibniz, Kant, Herbart — meaning the process of understanding new experience through what you already know. There's a [deeper dive at the bottom](#on-apperception-dreaming-and-why-this-matters) if you're into that.

### Inspirations

**Soul files** — The identity layer (SOUL.md, USER.md) is inspired by [OpenClaw](https://github.com/openclaw), which pioneered the idea of giving AI assistants a persistent "soul" — a set of files that define personality, values, and behavioral guidance. We simplified this for personal use: a handful of markdown files in a Git repo instead of a database-backed system.

### Design philosophy

This is a personal memory system, not an enterprise product. It's designed for one person using Claude across multiple surfaces. The entire thing is a private GitHub repo with markdown files — human-readable, version-controlled, and portable. No vendor lock-in, no proprietary database. If you want to see what Claude "knows" about you, just read the files.

```
┌──────────────┐                ┌──────────────────┐
│  Claude Code  │───── stdio ──▶│                  │
│  Desktop      │               │  Apperception    │
├──────────────┤               │  MCP Server      │
│  claude.ai    │── HTTP/OAuth ▶│                  │
│  Mobile       │               │  (local or CF)   │
└──────────────┘               └────────┬─────────┘
                                        │
                                  ┌─────▼─────┐
                                  │  GitHub    │
                                  │  (private  │
                                  │   repo)    │
                                  └───────────┘
```

## What it does

- **Identity persistence** — Claude loads its personality (SOUL.md), your profile (USER.md), and recent memory at the start of every session
- **Daily logs** — append-only conversation summaries, one file per surface per day (no merge conflicts)
- **Curated memory** — compiled knowledge about you, your projects, preferences, and decisions
- **Dream reconsolidation** — nightly cron reads daily logs and retrieval patterns, promotes key facts to curated memory, prunes stale entries
- **Search** — FTS5 locally, hybrid FTS + vector search (Cloudflare D1 + Vectorize) remotely

## Repo structure

Apperception uses two repos — code and data are separate:

```
apperception/                        # PUBLIC — the system (this repo)
├── server/                          # Local MCP server (TypeScript, stdio)
├── worker/                          # Remote MCP server (Cloudflare Worker)
├── templates/                       # Starter files for your data repo
│   ├── SOUL.md, USER.md, ...
│   ├── .soul/config.yaml
│   └── .mcp.json
├── README.md
└── LICENSE

your-data-repo/                      # PRIVATE — your identity and memories
├── SOUL.md                          # Who Claude is (identity, behavior)
├── USER.md                          # About you (profile, preferences)
├── IDENTITY.md                      # Name, avatar, vibe
├── STYLE.md                         # Writing voice
├── MEMORY.md                        # Index of curated memories
├── memory/                          # Curated long-term memories
├── daily/                           # Daily conversation summaries
├── dreams/                          # Dream logs
└── .soul/                           # Config, retrieval log
```

The server reads the data repo path as a CLI arg or `SOUL_REPO_PATH` env var. The Worker reads the repo owner/name from Cloudflare env vars.

## MCP tools

| Tool | Description |
|------|-------------|
| `soul_context` | Load identity + recent memory for session bootstrap |
| `soul_append` | Write to today's daily log (append-only) |
| `soul_remember` | Search all memory layers (logs retrieval for dream cron) |
| `soul_read` | Read a specific file |
| `soul_write` | Create or update a curated memory (auto-commits) |
| `soul_revise` | Flag a memory as outdated for reconsolidation |
| `soul_dream_prep` | Gather sources for nightly dream cron |
| `soul_index` | Rebuild search index |
| `soul_status` | Health check |
| `soul_git` | Pull/push/status |

## Memory lifecycle

```
Daily logs (hippocampus)     →  Dream reconsolidation  →  Curated memory (cortex)
  append-only, persist           nightly at 2am            rewritten in place
                                 reads retrieval log       contradictions resolved
                                 reads daily logs          key facts promoted
```

Daily logs persist forever as the episodic record. The dream cron reads them but doesn't consume them.

---

## Setup

### Prerequisites

- Node.js 20+
- A private GitHub repo for your memory
- Claude Code, Claude Desktop, or a claude.ai account

### 1. Clone and build the code repo

```bash
git clone https://github.com/timofei7/apperception.git
cd apperception/server && npm install && npm run build && cd ../..
```

### 2. Create your data repo

Create a private GitHub repo for your identity and memories. Copy the templates as a starting point:

```bash
mkdir my-soul && cd my-soul
git init
cp -r /path/to/apperception/templates/. .
```

Edit the identity files to make them yours:
- **SOUL.md** — Who Claude is to you. Personality, boundaries, memory protocol.
- **USER.md** — About you. Name, role, preferences, communication style.
- **IDENTITY.md** — Claude's name, avatar, vibe.
- **STYLE.md** — Writing voice and conventions.

Push to your private repo:
```bash
git add . && git commit -m "Initial identity"
gh repo create my-soul --private --source . --push
```

### 3. Connect to Claude Code

Add the MCP server to your global Claude config (`~/.claude.json`) or your data repo's `.mcp.json`:

```json
{
  "mcpServers": {
    "apperception": {
      "command": "node",
      "args": [
        "/path/to/apperception/server/dist/index.js",
        "/path/to/my-soul"
      ]
    }
  }
}
```

The second argument is the path to your data repo.

#### Auto-load identity on session start (recommended)

Add a SessionStart hook to your global Claude settings (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/apperception/server/dist/cli.js /path/to/my-soul",
            "timeout": 10,
            "statusMessage": "Loading soul context..."
          }
        ]
      }
    ]
  }
}
```

This loads SOUL.md, USER.md, IDENTITY.md, STYLE.md, MEMORY.md, and recent daily logs directly into context at the start of every session.

Then add to your `CLAUDE.md` (global or project):

```
Your identity and recent memory are loaded automatically via the SessionStart hook.
Do NOT call `soul_context` at session start — it's already loaded.
The SOUL.md defines who you are and how you behave.
If the SessionStart hook output is missing, tell the user.
```

### 4. Connect to Claude Desktop and claude.ai (web/mobile)

This requires deploying the Cloudflare Worker for remote access.

#### Create cloud resources

```bash
cd apperception/worker
npm install
npx wrangler login
npx wrangler d1 create apperception
npx wrangler vectorize create apperception --preset @cf/baai/bge-base-en-v1.5
```

#### Configure and deploy

Copy `wrangler.jsonc` to `wrangler.local.jsonc` (gitignored) and fill in your real resource IDs from the previous step:

```bash
cp wrangler.jsonc wrangler.local.jsonc
# Edit wrangler.local.jsonc — replace YOUR_KV_NAMESPACE_ID, YOUR_D1_DATABASE_ID,
# YOUR_GITHUB_USERNAME, and YOUR_DATA_REPO_NAME with real values
```

Create the KV namespace for OAuth state:

```bash
npx wrangler kv namespace create oauth
# Copy the returned ID into wrangler.local.jsonc under OAUTH_KV
```

Apply the D1 search schema migration:

```bash
npx wrangler d1 migrations apply apperception --remote
```

Deploy:

```bash
npm run deploy
```

#### Create a GitHub OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set the callback URL to `https://YOUR_WORKER.workers.dev/callback`
3. Note the Client ID and generate a Client Secret

#### Set secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY  # any random string
```

Then redeploy: `npm run deploy`

#### Add to Claude Desktop / claude.ai

Claude Desktop, claude.ai web, and mobile all share the same remote integration:

1. Go to **Settings → Integrations → Add custom integration**
2. Enter the MCP server URL: `https://YOUR_WORKER.workers.dev/mcp`
3. Authorize with GitHub when prompted

Then add this to your **Preferences** (Settings → Preferences) or Project instructions:

```
You have access to an MCP server called "apperception" — your persistent memory.

Before responding, call `soul_context` with surface "web". This loads your
identity (SOUL.md), the user's profile (USER.md), and recent memory.
The SOUL.md defines who you are — follow it.

During the session:
- Call `soul_remember` when you need context about past work or decisions.
- If a retrieved memory is outdated, call `soul_revise` to flag it.
- If the user says "remember this", call `soul_write` with path
  `memory/{type}_{topic}.md` (types: user, feedback, project, reference).

When the user says "summarize and reflect":
- Call `soul_append` with surface "web" to log the session summary.
```

#### Seed the search index

After connecting, ask Claude to run `soul_index` to populate the D1 FTS and Vectorize embeddings. This only needs to happen once — subsequent writes auto-index.

### 5. Set up the dream cron

The dream cron runs nightly to reconsolidate memories. On macOS, use launchd:

Create `~/Library/LaunchAgents/com.apperception.dream.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.apperception.dream</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/path/to/apperception/server/dream.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>2</integer>
        <key>Minute</key>
        <integer>3</integer>
    </dict>
    <key>WorkingDirectory</key>
    <string>/path/to/your-data-repo</string>
    <key>StandardOutPath</key>
    <string>/path/to/your-data-repo/.soul/logs/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/your-data-repo/.soul/logs/launchd-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/YOUR_USER/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/YOUR_USER</string>
        <key>SOUL_REPO_PATH</key>
        <string>/path/to/your-data-repo</string>
    </dict>
</dict>
</plist>
```

> **Note:** `~/.local/bin` must be in PATH for launchd to find the `claude` binary.

Then load the agent:

```bash
launchctl load ~/Library/LaunchAgents/com.apperception.dream.plist
```

The dream cron fires at 2:03am daily. If your Mac is asleep, launchd runs it when it wakes.

On Linux, use a cron job or systemd timer that runs `server/dream.sh`.

#### Dream security

The dream runs Claude unattended, which means it must be hardened against prompt injection — a poisoned daily log could try to make the dream exfiltrate data or modify files outside the repo.

`dream.sh` uses three isolation layers:

1. **`--strict-mcp-config`** — only loads the local apperception MCP server. Global MCP servers (Slack, Gmail, etc.) are not available.
2. **`--permission-mode dontAsk`** — silently denies any tool not in the allow list. Only `soul_*` MCP tools and Read/Write/Edit scoped to the data repo are permitted. No Bash, no network access.
3. **Path traversal protection** — the MCP server validates that all file paths stay within the data repo root.

No `--dangerously-skip-permissions` is needed. The permission system handles unattended execution safely.

---

## How it works

### Session flow (all surfaces)

1. **Start** — Claude calls `soul_context` (or it's loaded via hook). Identity + recent memory loaded.
2. **During** — Claude calls `soul_remember` as needed. Every search is passively logged.
3. **End** — User says "summarize and reflect". Claude calls `soul_append` with a session summary.

### Dream reconsolidation (nightly)

1. `soul_dream_prep` gathers daily logs + retrieval log + current memories
2. Claude reviews explicit save requests ("remember this")
3. Reviews retrieval log — repeated retrievals, revise flags, divergence
4. Evaluates daily logs holistically for promotable facts
5. Writes dream log, updates MEMORY.md index, pushes to GitHub

### Surfaces and daily logs

Each surface writes to its own daily log file to avoid conflicts:

| Surface | Daily log file | Transport |
|---------|---------------|-----------|
| Claude Code | `daily/{date}-code.md` | stdio (local MCP server) |
| Claude Desktop | `daily/{date}-desktop.md` | HTTP (Cloudflare Worker) |
| claude.ai web | `daily/{date}-web.md` | HTTP (Cloudflare Worker) |
| claude.ai mobile | `daily/{date}-mobile.md` | HTTP (Cloudflare Worker) |

### Search

- **Local mode:** SQLite FTS5 with BM25 ranking. Lazy indexing — auto-indexes on first search, skips unchanged files.
- **Remote mode:** Cloudflare D1 (FTS5) + Vectorize (semantic search via `@cf/baai/bge-base-en-v1.5` embeddings). Hybrid results merged by score.

Both modes use the same markdown chunking strategy — split on headings, ~600 char targets.

---

## Architecture decisions

- **Compilation over retrieval** — knowledge work happens at dream time (nightly), not query time. Daily logs are raw; curated memory is compiled.
- **Passive retrieval logging** — every `soul_remember` call is silently logged with query, results, and timestamp. The dream cron uses these signals for reconsolidation.
- **Append-only daily logs** — no conflicts across surfaces. One file per surface per day.
- **GitHub as source of truth** — works offline, syncs on push. The Worker reads/writes via GitHub API.
- **Storage adapter pattern** — same tool interface, different backends (local filesystem vs GitHub API + Cloudflare).

## Tech stack

- **MCP server:** TypeScript, `@modelcontextprotocol/sdk`
- **Local storage:** filesystem + simple-git + SQLite FTS5 (better-sqlite3)
- **Remote storage:** GitHub REST API + Cloudflare D1 + Cloudflare Vectorize
- **Remote hosting:** Cloudflare Workers (free tier: 100k requests/day)
- **Auth:** GitHub OAuth via `@cloudflare/workers-oauth-provider`
- **Embeddings:** Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`, 768 dimensions)
- **Dream cron:** macOS launchd (or systemd/cron on Linux)

---

## On apperception, dreaming, and why this matters

The name isn't just branding. There's a real idea underneath it.

**Leibniz** drew the first important distinction back in 1714: *perception* is raw sensory input — even unconscious. *Apperception* is what happens when you become aware of that perception, when you reflect on it. Animals perceive. Minds apperceive. It's the difference between data hitting your retina and actually *seeing*.

**Kant** took this further and made it foundational. His *transcendental apperception* — the "I think" that accompanies all experience — is what turns disconnected sensory noise into coherent understanding. Without it, there's no unified self connecting one moment to the next. Just fragments. Sound familiar? That's exactly what Claude is without persistent memory. Every conversation is a fragment.

But the one that matters most here is **Herbart**, who brought apperception into education. His key insight: new ideas can only be learned when they connect to an existing *apperception mass* — the totality of what you already know. You literally can't learn something that has nothing to attach to. Learning isn't downloading information. It's new experience being interpreted through accumulated context.

That's the whole system in one sentence. Claude's "apperception mass" is SOUL.md + USER.md + curated memories + recent daily logs. New conversations get filtered through all of it. Without this, every session starts from zero. With it, there's continuity — and continuity is what makes a relationship different from a series of transactions.

### Why dreaming?

The nightly reconsolidation cron isn't called "dream" for aesthetics. It's modeled on what actually happens during sleep.

When you sleep, your hippocampus replays the day's experiences. Your brain decides what matters — what to consolidate into long-term memory, what to revise, what to let fade. Memories don't just accumulate. They get *rewritten*. Your brain actively resolves contradictions, strengthens important connections, and prunes noise. You don't wake up with more memories. You wake up with *better* ones.

The dream cron does the same thing. It reads the day's conversation logs across all surfaces. It checks which curated memories were actually retrieved during the day and whether they were still accurate. It looks for things you explicitly asked to remember. It evaluates whether daily log content has cross-session value worth promoting. And it writes a dream log explaining every decision it made — what got created, updated, pruned, and why.

Daily logs are the hippocampus. Curated memory is the cortex. The dream is what connects them.

### Why compilation matters

Most AI memory systems are retrieval-based — they store everything and search at query time. That works, but it means the quality of recall depends on the quality of the search. And you end up with a lot of redundant, contradictory, or stale entries competing for attention.

Apperception takes the opposite approach: *compilation*. The hard work happens at ingest time, not query time. The dream cron doesn't just index new facts — it rewrites existing memories in place, resolves contradictions, and removes things that are no longer true. By the time a memory gets loaded into a session, it's already been synthesized.

Think of it like the difference between a folder of unsorted notes and a well-maintained wiki. Both contain the same information. One is actually useful.

## License

AGPL-3.0
