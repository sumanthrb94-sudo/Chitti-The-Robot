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
  thinks with Claude, and replies through your speakers.
- **Live database analysis.** Ask "what were our top products last quarter?" and Chitti
  writes the SQL, runs it on the local SQLite demo DB, and renders a chart.
- **Tool use.** Claude orchestrates 5 tools — `list_tables`, `describe_table`,
  `query_database`, `visualize_data`, `get_time` — to answer complex questions
  end-to-end without you writing a line of SQL.
- **Jarvis-grade UI.** Holographic orb that reacts to state (idle / listening /
  thinking / speaking), HUD telemetry, glass panels, neon cyan grid.

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
│  │  Claude streaming loop   │──▶│   Tool dispatcher         │   │
│  │  (Anthropic SDK)         │   │   list_tables             │   │
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
- An **Anthropic API key** (`ANTHROPIC_API_KEY`)
- A Chromium-based browser (best Web Speech API support; Safari and Firefox vary)

### Install & run

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env.local
# edit .env.local — paste your ANTHROPIC_API_KEY

# 3. (Optional) seed the demo DB explicitly — otherwise it auto-seeds on first request
npx tsx scripts/seed.ts

# 4. Launch
npm run dev
# open http://localhost:3000
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

## Stack

- **Framework**: Next.js 14 (App Router) + React 18 + TypeScript
- **AI**: Anthropic SDK (Claude Sonnet/Opus 4.x) — model selectable via `CHITTI_MODEL`
- **UI**: TailwindCSS, framer-motion, lucide-react, recharts
- **State**: Zustand
- **DB**: better-sqlite3 (swappable)
- **Voice**: Web Speech API (STT + TTS) — ElevenLabs slot ready for premium TTS

---

*Chitti is your robot. Be nice to it. It'll outlive us all.*
