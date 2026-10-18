# PulseRemind — AI Chat Opportunity Reminder & Web Monitor

**PulseRemind** is an MCP Server, OpenAPI Tool Service, Web-Monitoring Engine, and Multi-Channel Notification Dispatcher.

When you are planning something in an LLM chat (such as graduate school scholarships, fellowships, grants, or admissions that won't open until **the end of the month** or **early next year**), the AI assistant invokes PulseRemind to capture the conversation context, schedule a smart web watch, monitor the target portal, and alert you across **Email, In-App Dashboard, Slack, Discord, Telegram, and WhatsApp** the moment applications open.

---

## Quick Start

Requires **Node.js v22.6+ / v23+** (uses native TypeScript execution and built-in `node:sqlite` — zero external npm install required).

```bash
# Start the Web Dashboard, REST Tool API, MCP HTTP Server & Background Scheduler
npm start
```

Then open **http://localhost:3456** in your browser.

```bash
# Run the End-to-End Automated Test Suite
npm test
```

---

## Connecting to AI Chat Clients

### 1. Model Context Protocol (MCP) — Claude Desktop, Cursor, Antigravity
Add the stdio MCP server to your `mcpServers` configuration:

```json
{
  "mcpServers": {
    "pulseremind": {
      "command": "node",
      "args": [
        "--no-warnings",
        "/path/to/pulseremind/src/mcp/stdio-server.ts"
      ]
    }
  }
}
```

Or connect over HTTP JSON-RPC at:
- `POST http://localhost:3456/mcp`

### 2. Available MCP Tools
- `create_opportunity_watch`: Registers a new web-monitored reminder with conversation context, expected opening timeframe (`"end of this month"`, `"early next year"`), target URL, and notification channels.
- `extract_watches_from_chat`: Parses a raw conversation transcript between a user and an LLM to automatically extract and schedule future-dated opportunities.
- `list_active_watches`: Lists all tracked watches and their current status (`hibernating`, `active_monitoring`, `triggered_open`, `paused`).
- `check_watch_now`: Immediately scrapes and evaluates a watch's target webpage and dispatches alerts if open.
- `update_or_cancel_watch`: Pauses, resumes, or deletes a watch.

### 3. ChatGPT Custom GPT Actions (OpenAPI 3.1)
Import the OpenAPI schema directly from:
- `GET http://localhost:3456/api/openapi.json`
# pulse-remind
# pulse-remind
