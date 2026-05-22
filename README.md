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
- A modern browser (Chromium for best Web Speech API support; Safari and Firefox vary)

### Sign up for the services you want

Chitti is **BYO-key** — every external service is plugged in by pasting an API key into the app's Settings modal (gear icon → tabs). Nothing is stored on a Chitti-owned server. Keys live in your browser's localStorage and travel with each request.

Here's the full menu — pick what you need:

| # | Service | What it does for Chitti | Required? | Cost / Tier | Where to get the key | Where to paste it |
|---|---|---|---|---|---|---|
| 1 | **OpenRouter** [openrouter.ai](https://openrouter.ai) | LLM brain (Kimi K2, Claude, GPT-4, Llama — one key for ~200 models) | ✅ yes (or pick another LLM) | $5 deposit; many models including `moonshotai/kimi-k2:free` work on free tier | Sign in → Keys → Create Key (starts with `sk-or-...`) | gear → **BRAIN** tab → OpenRouter preset → API KEY |
| 2 | **Upstash Vector** [upstash.com](https://upstash.com) | Long-term memory — Chitti remembers facts across sessions | optional but recommended | Free tier 10k vectors, no credit card | Console → Vector → Create DB → copy `UPSTASH_VECTOR_REST_URL` + `UPSTASH_VECTOR_REST_TOKEN` | gear → **MEMORY** tab → both fields |
| 3 | **OpenAI** [platform.openai.com](https://platform.openai.com) | Embeddings for the memory layer (only needed if you turn on memory) | optional | ~$0.02 per million tokens (essentially free for personal use). First-time signup includes ~$5 trial credit. | Dashboard → API keys → Create key (starts with `sk-...`) | gear → **MEMORY** tab → Embedding key |
| 4 | **ElevenLabs** [elevenlabs.io](https://elevenlabs.io) | Premium voice — replaces the robotic browser TTS with a natural Jarvis-grade voice | optional | Free tier 10k chars/month | Profile → API Keys → copy `sk_...` | gear → **VOICE** tab → ElevenLabs → API KEY |
| 5 | **Picovoice** [console.picovoice.ai](https://console.picovoice.ai) | Wake word — say "Jarvis" without tapping the mic button | optional | Free for personal use | Console → AccessKey → copy | gear → **WAKE** tab → Access key |
| 6 | **Groq** [console.groq.com](https://console.groq.com) | Whisper-grade speech recognition (much more accurate than the browser's built-in) | optional | Generous free tier, no card | Keys → Create API Key (starts with `gsk_...`) | gear → **VOICE** tab → Groq Whisper → API KEY |
| 7 | **Anthropic** [console.anthropic.com](https://console.anthropic.com) | Claude (alternative LLM brain if you prefer Claude over Kimi K2) | optional | Pay-as-you-go | Console → API Keys → Create key (`sk-ant-...`) | gear → **BRAIN** tab → Claude preset → API KEY |

**The minimum to get up and running**: just #1 (an LLM key — OpenRouter recommended). Everything else stacks on top in any order.

**For the full Jarvis experience**: #1 + #2 + #3 + #4 + #5 + #6. About 10 minutes of signups total, all free tiers will cover personal use.

### Install & run locally

```bash
# 1. Install
npm install

# 2. Configure (optional — settings can be entered in the app's Settings modal instead of .env)
cp .env.example .env.local
# edit .env.local as needed — every var here is overridable from the Settings modal

# 3. (Optional) seed the demo SQLite DB explicitly — otherwise it auto-seeds on first request
npx tsx scripts/seed.ts

# 4. Launch
npm run dev
# open http://localhost:3000
# Tap the gear icon top-right → BRAIN → paste OpenRouter key → SAVE
```

### Pick your LLM provider

```bash
# Force a specific provider (otherwise auto-detected from whichever key is set)
LLM_PROVIDER=openai OPENAI_API_KEY=sk-or-... OPENAI_BASE_URL=https://openrouter.ai/api/v1 npm run dev
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run dev
LLM_PROVIDER=ollama OLLAMA_MODEL=llama3.1:8b npm run dev  # needs `ollama serve` locally
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
