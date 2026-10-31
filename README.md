# PulseRemind (Cue)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.6.0-green.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/Dependencies-Zero_NPM-brightgreen.svg)](#zero-dependency-architecture)
[![Tests](https://img.shields.io/badge/Tests-37%2F37_Passing-success.svg)](tests/e2e.test.ts)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-purple.svg)](https://modelcontextprotocol.io/)
[![Docker](https://img.shields.io/badge/Docker-Multi--Stage-blue.svg)](Dockerfile)

**PulseRemind** is an autonomous temporal trigger and web-state resolution engine for AI agents (**Claude, ChatGPT, Cursor, Antigravity, and Google Gemini**).

When an AI assistant discusses a future event—such as a conference registration, scholarship opening, product drop, regulatory deadline, or ticket sale—PulseRemind captures the context, arms an adaptive web watch, detects DOM state transitions with sub-minute hazard-rate bursts, and dispatches multi-channel alerts with RFC 5545 calendar alarms.

---

## The Problem: AI Agents Have "Future Amnesia"

Modern LLMs are exceptional at researching and synthesizing opportunities, but they are trapped in the conversational present. If an application opens "next month" or tickets drop "tomorrow at 9 AM", the agent cannot stay awake.

PulseRemind bridges conversational AI to the temporal future:
1. **Captures Future Intent**: The agent autonomously invokes declarative MCP tools when dates or unreleased portals are discussed.
2. **Minimizes PII**: The engine scrubs private personal details and distills raw chat context into a structured, non-PII Action Checklist.
3. **Monitors Web State**: It monitors target URLs using HTTP conditional revalidation (`ETag` / `If-None-Match` `304`), Schema.org `<script type="application/ld+json">`, SSR `__NEXT_DATA__` hydration states, and semantic DOM diffs.
4. **Idempotent Dispatch**: When an opening occurs, it fires across **Email (with RFC 5545 monotonic `.ics` attachments), Native Calendar, Web Push, Telegram, Discord, and Slack**.

---

## Architectural Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CONVERSATIONAL AI AGENTS                           │
│     Claude Desktop  │  ChatGPT Actions  │  Cursor  │  Antigravity / Gemini │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                      [ MCP Stdio / HTTP JSON-RPC / OpenAPI ]
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             PULSEREMIND CORE                                │
│                                                                             │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌──────────────────┐ │
│  │   Privacy Minimizer   │  │ Temporal State Machine│  │ Resolution Engine│ │
│  │  • PII Auto-Scrubbing │  │  • Exponential Proxim.│  │  • ETag 304 Cache│ │
│  │  • Action Checklists  │  │  • AoE UTC-12 Support │  │  • JSON-LD / SSR │ │
│  │  • Out-of-Band Tokens │  │  • Virtual-Time Leaps │  │  • Anti-Flap DOM │ │
│  └───────────────────────┘  └───────────────────────┘  └──────────────────┘ │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                    [ Hermetic or Distributed Persistence ]
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             STORAGE ADAPTER                                 │
│        Local: node:sqlite (WAL Mode)   │   Cloud: Supabase PostgreSQL       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                       [ Resilient Transactional Outbox ]
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MULTI-CHANNEL DISPATCHERS                           │
│  • Email (Resend + .ics)       • RFC 5545 Calendar (Dual VALARMs)           │
│  • W3C Web Push (VAPID ES256)  • Mobile Instant Push (ntfy.sh)              │
│  • Slack / Discord Webhooks    • In-App Live Activity Stream                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Capabilities

* **Zero-Dependency Architecture**: Built 100% on native Node.js standard library primitives (`node:sqlite`, `node:crypto`, `node:http`, `node:stream`). Zero third-party npm production packages. Zero supply-chain attack surface.
* **Octopus ResolutionEngine**:
  * Emits `If-None-Match` with cached `ETag` to resolve 304 Not Modified in < 25ms.
  * Detects Schema.org `InStock` vs. `SoldOut` and Next.js / Nuxt SSR hydration states.
  * Anti-Flap Consensus: Verifies DOM state changes across multi-probe intervals to eliminate false positives from temporary server glitches or maintenance modals.
* **Temporal Urgency Scheduling**: Automatically transitions watches across discrete state phases:
  * `hibernating`: Checked weekly.
  * `exponential_approach`: Polling frequency scales exponentially as the window approaches.
  * `burst_sampling`: Sub-minute sampling right before drops or portal openings.
  * `anywhere_on_earth`: Computes AoE (UTC-12) boundaries for international academic and grant deadlines.
* **RFC 5545 Dual-Alarm Calendar Synchronization**: Generates standard `.ics` feeds with CRLF formatting, 75-octet line folding, monotonic `SEQUENCE` updates, and dual `VALARM` triggers (T-24h and T-1h).
* **Multi-Tenant Cryptographic Vaults**: Isolated session storage with progressive account linking: users claiming tokens or confirming emails atomically coalesce historical sessions into their private vault.
* **Multi-Platform Deal Discovery & Comparison Engine**:
  * **Zero-Link Natural Query**: Search across competing storefronts and syndicated deal streams by product name alone (e.g. *"washing machine"*, *"MacBook Pro M4 16-inch"*).
  * **SKU Disambiguation & Anti-Accessory Guards**: Evaluates token semantics and category price floors to eliminate accessory/spare-part noise (e.g., rejecting \$18 drain hoses or toy washers).
  * **Total Landed Cost ($P_{\text{landed}} = P_{\text{item}} + P_{\text{shipping}} - D_{\text{promo}}$)**: Computes true landed prices incorporating real shipping fees and verified non-destructive promo code discounts.
  * **95% Wilson Score Rating Credibility**: Computes lower bound statistical confidence intervals for merchant ratings, filtering out fake 1-review 5.0★ shill sellers.
  * **1-to-$N$ Competitive Cluster Watches**: Arms multiple competing stores in parallel when current prices exceed target. The first store to drop price wins the race and atomically cools down sibling watches.
* **Nigerian E-Commerce Localization & Anti-Fraud Suite**:
  * **NGN Currency & Slang Lexer**: Native parsing of `₦`, `NGN`, `N`, comma-separated values, and suffix expressions (`450k` $\to ₦450,000$, `1.2m` $\to ₦1,200,000$).
  * **Condition Classifier & UK-Used / Tokunbo Guard**: Distinguishes `brand_new`, `uk_used`, and `refurbished` items, preventing second-hand goods from masquerading as steep price drops unless explicitly requested.
  * **Merchant Trust Tiers**: Weights Wilson confidence by distributor legitimacy: Official Store (1.05x), Platform Fulfilled (1.00x), Vetted 3P (0.95x), and Unverified Classifieds (0.25x).
  * **High-Ticket Fraud Protection**: Rejects unverified classified listings over ₦50,000 to eliminate deposit/wharf scams.
  * **Regional Destination Freight Modeling**: Accurately computes delivery fees across `lagos`, `abuja`, and `interstate` zones.
  * **Multi-Store Support**: Integrated catalogs for Jumia Nigeria, Konga, Fouani Nigeria Official (LG & Hisense), Slot.ng, and Kara.

---

## Quickstart (< 2 Minutes)

### Option A: Local Hermetic Mode (Zero Setup)

PulseRemind requires **Node.js v22.6+** or **v23+**.

```bash
# 1. Clone the repository
git clone https://github.com/walleyjs/pulse-remind.git
cd pulse-remind

# 2. Start the engine (defaults to local SQLite + in-app simulation)
npm start
```
Open **`http://localhost:3456`** to access the high-density Event Horizon workspace.

### Option B: Turnkey Docker Deployment

Run the unprivileged multi-stage container via Docker Compose:

```bash
docker compose up -d
```
Check health:
```bash
curl http://localhost:3456/api/health
```

---

## Connecting to AI Clients

### 1. Claude Desktop & Cursor (MCP Config)

Add PulseRemind to your `claude_desktop_config.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pulseremind": {
      "command": "node",
      "args": [
        "--no-warnings",
        "/absolute/path/to/pulse-remind/src/pkg/mcp/stdio-server.ts"
      ]
    }
  }
}
```

Or connect via Streamable HTTP JSON-RPC endpoint:
```json
{
  "mcpServers": {
    "pulseremind": {
      "type": "http",
      "url": "http://localhost:3456/mcp"
    }
  }
}
```

### 2. ChatGPT Custom Actions (OpenAPI 3.1)

In the ChatGPT Custom GPT builder, import the declarative OpenAPI specification from:
`http://localhost:3456/api/openapi.json`

---

## MCP Tools Reference

All tool schemas are strictly declarative and sanitized against prompt-injection and unsolicited chaining:

| Tool Name | Purpose | Key Parameters |
| :--- | :--- | :--- |
| `create_opportunity_watch` | Arms a scheduled reminder or web-monitored opportunity watch. | `title`, `category`, `window_start_date`, `target_url`, `chat_context`, `recipient_email` |
| `set_notification_destination` | Binds a verified email address to a watch or session vault. | `recipient_email`, `watch_id`, `save_as_default` |
| `extract_watches_from_chat` | Parses full transcripts to extract multiple future-dated opportunities. | `transcript`, `session_id`, `recipient_email` |
| `list_active_watches` | Lists monitored events scoped to the current tenant session. | `status_filter` (`all`, `active`, `hibernating`, `triggered_open`) |
| `check_watch_now` | Triggers an immediate scrape and evaluation of a target portal. | `watch_id` |
| `update_or_cancel_watch` | Modifies or deletes an active watch. | `watch_id`, `action` (`pause`, `resume`, `delete`) |
| `find_best_deals_and_watch` | Searches across competing merchants by product name, disambiguates SKUs, computes landed prices with regional freight and verified promos, and provisions competitive cluster watches. | `query`, `target_price`, `destination_zone`, `min_rating_confidence`, `required_promo_code`, `max_cluster_watches`, `recipient_email` |

---

## Configuration Reference

PulseRemind runs out of the box with zero external configuration. To enable cloud hybrid mode or external delivery channels, copy `.env.example` to `.env`:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3456` | HTTP and MCP server listen port |
| `STORAGE_PROVIDER` | `sqlite` | `sqlite` (local WAL) or `supabase` (cloud PostgreSQL) |
| `PULSEREMIND_DB_PATH` | `./data/pulseremind.db` | Filesystem path for local SQLite database |
| `SUPABASE_URL` | *(none)* | Supabase project URL (optional) |
| `SUPABASE_SERVICE_ROLE_KEY` | *(none)* | Supabase PostgREST service role key (optional) |
| `RESEND_API_KEY` | *(none)* | Resend API token for outbound transactional emails |
| `NTFY_TOPIC` | *(none)* | Topic for instant mobile notifications via ntfy.sh |
| `SCHEDULER_INTERVAL_MS` | `60000` | Resolution loop tick frequency (1 minute) |

---

## Verification & Test Matrix

PulseRemind includes a comprehensive 37-suite integration test verifying everything from multi-tenant boundaries to virtual-time leaps and localized multi-store deal discovery:

```bash
# Run all 37 tests in offline memory mode
npm test
```

```
✔ 1. Extracts future-dated scholarship plans from AI transcripts
✔ 2. MCP tools create watch, detect closed state, and fire alerts
✔ 3. Octopus ResolutionEngine optimizations: Deduplication & Transient Backoff
...
✔ 34. Temporal Commerce Predicate Engine: Price Drops, Wilson Score Rating Quality, and Promo Verification
✔ 35. Full-Stack Commerce Watch Lifecycle: NL Extraction, SQLite Persistence, Multi-Poll Hysteresis, and Outbox Dispatch
✔ 36. Multi-Platform Deal Discovery & Comparison Engine: Anti-Accessory Disambiguation, Landed Cost Ranking, Wilson Fraud Filter, and 1-to-N Cluster Watch Cooldown
✔ 37. Nigerian E-Commerce Localization: NGN & Slang Tokenizer, UK-Used Guard, Merchant Trust Tiers, Regional Freight, and Multi-Store Cluster Race

ℹ tests 37 | suites 0 | pass 37 | fail 0
```

---

## Contributing

We welcome community contributions! Please read our [Contributing Guidelines](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

Before opening a pull request, verify that:
1. All 37 integration tests pass via `npm test`.
2. No third-party npm runtime dependencies are added.
3. Code strictly adheres to native TypeScript and Node.js standard library APIs.

---

## Security

Please report vulnerabilities directly via GitHub Private Vulnerability Reporting or review our [Security Policy](SECURITY.md).

---

## License

PulseRemind is licensed under the [Apache License, Version 2.0](LICENSE).
Copyright 2026 PulseRemind Contributors.
