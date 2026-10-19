# PulseRemind — AI Chat Event, Date & Web-State Reminder

**PulseRemind** is a privacy-first MCP Server, OpenAPI Tool Service, Web-Monitoring Engine, and Multi-Channel Notification Dispatcher for **ChatGPT, Claude, Cursor, Antigravity, and Google Gemini**.

Whenever you mention an upcoming event, conference, ticket drop, product launch, registration, deadline, scholarship, or general date reminder during an AI chat, PulseRemind captures your action checklist, monitors the target web page or scheduled date window, binds your email once inside the chat, and alerts you across **Email (Resend), Native Calendar (`.ics` / Google Calendar), Web Push (`Service Worker`), Telegram, Slack, Discord, and WhatsApp**.

---

## Live Production Endpoints

- **Web Dashboard**: `https://pulse-remind.onrender.com`
- **MCP Streamable HTTP Endpoint**: `https://pulse-remind.onrender.com/mcp`
- **OpenAPI 3.1 Tool Spec**: `https://pulse-remind.onrender.com/api/openapi.json`
- **Gemini Function Declarations**: `https://pulse-remind.onrender.com/api/gemini-tools.json`
- **Live iCalendar (`.ics`) Feed**: `https://pulse-remind.onrender.com/api/calendar/all.ics`

---

## Connecting to AI Chat Clients

### 1. ChatGPT Apps / Custom MCP Server & Claude / Cursor (`mcpServers` config)

```json
{
  "mcpServers": {
    "pulseremind": {
      "type": "http",
      "url": "https://pulse-remind.onrender.com/mcp"
    }
  }
}
```

### 2. Available MCP Tools
- `create_opportunity_watch`: Registers a scheduled-date or web-monitored reminder with action checklist, expected timeframe, optional target URL, and 1-click Google Calendar / `.ics` links.
- `set_notification_destination`: Binds the user's email address (and optional push channels) right inside the AI chat and remembers it as their persistent default for all future reminders.
- `extract_watches_from_chat`: Parses a conversation snippet to automatically extract and schedule multiple upcoming events or opportunities.
- `list_active_watches`: Lists all tracked watches and their current status (`hibernating`, `active_monitoring`, `triggered_open`, `paused`).
- `check_watch_now`: Immediately scrapes and evaluates a watch's target webpage and dispatches alerts if open.
- `update_or_cancel_watch`: Pauses, resumes, or deletes a watch.

---

## Local Development & E2E Testing

Requires **Node.js v22.6+ / v23+** (native TypeScript execution and built-in `node:sqlite`).

```bash
# Start the server
npm start

# Run the 11-test End-to-End Automated Test Suite
npm test
```
