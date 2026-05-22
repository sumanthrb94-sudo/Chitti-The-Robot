# Chitti

> *"Sir, the systems are online."*

**Chitti** is a voice-first, autonomous AI assistant — Jarvis for the rest of us.
Talk to it. Watch it think. Ask it about your data and it answers with live
SQL, real charts, and a voice. Built with Claude under the hood, a holographic
HUD on top.

This is **v0.1 — the web agent**. Native apps come next.

---

## What it does

- **Voice in, voice out.** Push a button, speak. Chitti listens with the Web Speech API,
  thinks with the LLM of your choice, and replies through your speakers.
- **Live database analysis.** Ask "what were our top products last quarter?" and Chitti
  writes the SQL, runs it on the local SQLite demo DB, and renders a chart.
- **Tool use.** The LLM orchestrates 5 tools — `list_tables`, `describe_table`,
  `query_database`, `visualize_data`, `get_time` — to answer complex questions
  end-to-end without you writing a line of SQL.
- **Jarvis-grade UI.** Holographic orb that reacts to state (idle / listening /
  thinking / speaking), HUD telemetry, glass panels, neon cyan grid.
- **Open-source first.** Runs end-to-end on free software: Next.js, React,
  Tailwind, framer-motion, recharts, Zustand, better-sqlite3, Web Speech API,
  Inter / JetBrains Mono / Orbitron (SIL OFL). The LLM is pluggable —
  pick **Ollama** (local, OSS) or **Anthropic Claude** (hosted).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          BROWSER                                │
│  ┌─────────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │ ChittiOrb   │  │ Conversation   │  │ DataDashboard        │  │
│  │ (motion)    │  │ Panel + Voice  │  │ (recharts)           │  │
│  └──────┬──────┘  └────────┬───────┘  └──────────────────────┘  │
│         └─────────────┬────┴────────────────┘                   │
│                       │ zustand store                           │
│                       │                                         │
│                       │ Web Speech API (STT + TTS)              │
└───────────────────────┼─────────────────────────────────────────┘
                        │ SSE: /api/chat
┌───────────────────────┼─────────────────────────────────────────┐
│                       ▼                NEXT.JS SERVER           │
│  ┌──────────────────────────┐   ┌───────────────────────────┐   │
│  │  LLM provider router     │──▶│   Tool dispatcher         │   │
│  │  Claude  ⇆  Ollama (OSS) │   │   list_tables             │   │
│  └──────────┬───────────────┘   │   describe_table          │   │
│             │                   │   query_database  ─────┐  │   │
│             │                   │   visualize_data       │  │   │
│             │                   │   get_time             │  │   │
│             ▼                   └────────────────────────┼──┘   │
│  ┌─────────────────────────┐                             │      │
│  │  System prompt:         │   ┌────────────────────┐    │      │
│  │  "you are Chitti…"      │   │  better-sqlite3    │◀───┘      │
│  └─────────────────────────┘   │  SELECT-only guard │           │
│                                └─────────┬──────────┘           │
└──────────────────────────────────────────┼──────────────────────┘
                                           ▼
                                    data/chitti.db
                                    (seeded demo)
```

---

## Getting started

### Prereqs
- Node.js **≥ 20**
- A Chromium-based browser (best Web Speech API support; Safari and Firefox vary)
- An LLM — pick ONE:
  - **Ollama** (open-source, local) — install from [ollama.com](https://ollama.com), then
    `ollama pull llama3.1:8b` (or `qwen2.5:7b`, or `mistral-nemo`).
  - **Anthropic Claude** (hosted) — an `ANTHROPIC_API_KEY`.

### Install & run

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env.local
# edit .env.local — either:
#   ANTHROPIC_API_KEY=sk-ant-…       (uses Claude)
# OR leave ANTHROPIC_API_KEY empty   (auto-falls-back to Ollama at OLLAMA_BASE_URL)

# 3. (Optional) seed the demo DB explicitly — otherwise it auto-seeds on first request
npx tsx scripts/seed.ts

# 4. Launch
npm run dev
# open http://localhost:3000
```

### Pick your LLM provider

```bash
# Force Claude (hosted, proprietary)
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run dev

# Force Ollama (local, OSS) — make sure `ollama serve` is running
LLM_PROVIDER=ollama OLLAMA_MODEL=llama3.1:8b npm run dev

# Auto-detect: if ANTHROPIC_API_KEY is set, Claude; otherwise Ollama
npm run dev
```

### First conversation

1. Click the microphone (or type).
2. Try one of these:
   - *"Chitti, what tables do you have access to?"*
   - *"How many users signed up in the last 90 days?"*
   - *"Show me total revenue by month for the last year as a chart."*
   - *"Which country has the most enterprise customers?"*
   - *"What's the top-selling product by quantity?"*

---

## Deploy to Vercel

Chitti is Vercel-ready out of the box. The DB switches to **in-memory mode**
when `VERCEL=1` is set (auto on Vercel), and `data/seed.sql` is bundled
into the function via a webpack raw import so the demo dataset is always
present on cold start.

### One-time setup

1. **Import the repo** in Vercel: https://vercel.com/new — pick this GitHub repo.
2. **Framework Preset**: Next.js (auto-detected).
3. **Environment variables** — add these in the Vercel dashboard under
   *Settings → Environment Variables*:

   | Name | Required | Value |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | ✅ yes | Your Anthropic key (`sk-ant-…`) |
   | `CHITTI_MODEL` | optional | `claude-sonnet-4-6` (default) or `claude-opus-4-7` |
   | `CHITTI_DB_MODE` | optional | `memory` (auto-set on Vercel; leave blank) |

4. **Deploy.** Click Deploy. First build takes ~90s; cold starts after that are <1s.

### Vercel-specific notes

- **Filesystem**: We use `:memory:` SQLite on Vercel — each cold start re-seeds
  from the bundled `seed.sql` in ~200ms. Perfect for a demo / playground.
  For persistent data, swap `lib/db.ts` to a hosted DB (Turso, Neon, Supabase).
- **Streaming**: `/api/chat` sets `maxDuration = 60` (Hobby plan max). Pro plans
  can extend up to 300s if your conversations get longer.
- **Cost**: Each turn that uses tools makes 2–6 Claude calls. Watch your
  Anthropic spend — set a usage cap in your Anthropic dashboard.
- **Voice**: Web Speech API works fully client-side. No Vercel-side cost
  for STT/TTS.

### Limitations of the in-memory mode

Since Vercel functions are stateless, every invocation gets a fresh seed.
That means:
- ✅ All demo queries work identically every time.
- ❌ You can't INSERT/UPDATE data (we block writes anyway for safety).
- ❌ Conversation memory is in-browser (Zustand) — not server-side.

For production use cases needing real data, see *Roadmap → v0.3*.

---

## Project layout

```
.
├── app/
│   ├── layout.tsx              # Root layout
│   ├── page.tsx                # Renders <MainShell />
│   ├── globals.css             # Tailwind + HUD utilities
│   └── api/
│       ├── chat/route.ts       # SSE streaming Claude endpoint
│       └── db/route.ts         # DB introspection + query
├── components/
│   ├── ChittiOrb.tsx           # The holographic orb (centerpiece)
│   ├── VoiceInterface.tsx      # Mic button + recognition
│   ├── VoiceVisualizer.tsx     # Audio bars
│   ├── ConversationPanel.tsx   # Transcript
│   ├── InputBar.tsx            # Text fallback + send
│   ├── SystemStatus.tsx        # HUD top bar
│   ├── DataDashboard.tsx       # Recharts artifacts
│   └── MainShell.tsx           # Page composition + streaming logic
├── lib/
│   ├── claude.ts               # Anthropic streaming + tool loop
│   ├── tools.ts                # Tool schemas + dispatcher
│   ├── system-prompt.ts        # Chitti's personality
│   ├── db.ts                   # SQLite + SELECT-only safety
│   ├── seed.ts                 # ensureSeeded wrapper
│   ├── voice.ts                # Web Speech API helpers
│   ├── chat-client.ts          # Client-side SSE consumer
│   ├── store.ts                # Zustand global store
│   └── utils.ts                # cn, uid, formatNumber
├── types/index.ts              # Shared contracts
├── data/
│   ├── seed.sql                # Demo dataset
│   └── chitti.db               # Created at runtime (gitignored)
└── scripts/seed.ts             # Manual seed command
```

---

## Safety

- The `query_database` tool only runs **`SELECT` / `WITH`** queries.
  Any attempt at `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`,
  `PRAGMA`, `ATTACH`, `VACUUM`, etc. is rejected before reaching SQLite.
- Table names in `describe_table` are validated against `^[a-zA-Z_][a-zA-Z0-9_]*$`.
- Results capped at 1,000 rows.
- `ANTHROPIC_API_KEY` lives only in the server process, never the browser.

---

## What's next

This is **the web prototype**. The roadmap:

1. **v0.2 — Hardening**: streaming UI polish, wake-word detection, conversation persistence.
2. **v0.3 — Production data**: pluggable DB adapters (Postgres, MySQL, BigQuery), schema vector search, redaction.
3. **v1.0 — Native apps**:
   - Electron desktop app (always-on, hotkey summon)
   - iOS / Android via Expo (CarPlay / Android Auto support)
   - Optional always-listening with on-device wake word

---

## Stack (open-source first)

Every dependency below is permissively licensed open source.

| Layer | Tool | License |
|---|---|---|
| Framework | Next.js 14 (App Router) + React 18 | MIT |
| Language | TypeScript | Apache 2.0 |
| UI | TailwindCSS, framer-motion, lucide-react, recharts | MIT |
| State | Zustand | MIT |
| DB | better-sqlite3 (SQLite WAL) | MIT |
| Voice | Web Speech API (browser-native STT + TTS) | W3C standard |
| Fonts | Inter, JetBrains Mono, Orbitron — self-hosted via `next/font` | SIL OFL |
| **LLM — Option A** | **Ollama** (llama3.1, qwen2.5, mistral-nemo, etc.) | **MIT** |
| LLM — Option B | Anthropic Claude (via official SDK) | SDK MIT, API proprietary |

The only proprietary slot is the *optional* hosted-LLM path. Run Chitti on
Ollama and the entire stack — code, models, weights — is OSS.

---

*Chitti is your robot. Be nice to it. It'll outlive us all.*
