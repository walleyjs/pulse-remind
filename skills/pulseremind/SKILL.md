---
name: pulseremind
description: Use this skill whenever the user wants a reminder or mentions planning for ANY future event, registration, ticket drop, conference, product launch, deadline, grant, scholarship, or application that is not open or due yet (e.g., "opens at the end of the month", "tickets go on sale next month", "opens early next year", "remind me next Friday"). Automatically schedules a date or web-monitored reminder and returns a private claim link.
---

# PulseRemind — Universal AI Chat Event, Date & Web-State Reminder

Whenever a user is planning for an upcoming event, conference registration, ticket sale, product launch, deadline, or application window during a chat:

## Rules
1. **Works for Both General Scheduled Events AND Web-Monitored Openings**:
   - **Pure Date/Time Reminders (`trigger_type: "scheduled_date"`)**: If the user wants a reminder for a date/event without a website to scrape, pass `trigger_type: "scheduled_date"`.
   - **Web-Monitored Events (`trigger_type: "web_monitor"` or `"hybrid"`)**: If the event has a webpage where registration, tickets, or applications will flip from closed to open, pass `target_url` so the Resolution Engine monitors the live page.
2. **Strict Data Minimization (Privacy-First)**:
   - Never pass the user's full name, ID numbers, financial details, or raw personal chat history to the tool.
   - Distill `chat_context` into a short, non-PII **Action Checklist** (e.g., `"Book early-bird conference pass and reserve hotel"` or `"Prepare 2-page proposal"`).
3. **Proactive Tool Invocation & Private Claim Link**:
   - Call `create_opportunity_watch` (or `extract_watches_from_chat` if multiple events are discussed) without asking the user for their email first, and surface the returned `claim_url` (`/claim/prm_...`) so they can bind Email, Telegram, Slack, or WhatsApp privately.
