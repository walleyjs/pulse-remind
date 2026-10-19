---
name: pulseremind
description: Use this skill whenever the user wants a reminder or mentions planning for ANY future event, registration, ticket drop, conference, product launch, deadline, grant, scholarship, or application that is not open or due yet (e.g., "opens at the end of the month", "tickets go on sale next month", "opens early next year", "remind me next Friday"). Automatically schedules a date or web-monitored reminder, binds their email in-chat (once), and returns a 1-click Google/Apple Calendar link.
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
3. **Ask-Once Seamless In-Chat Email Binding & 1-Click Calendar Links**:
   - Call `create_opportunity_watch` immediately to capture the reminder.
   - Always share the returned `calendar_links.google_calendar_url` and `calendar_links.ics_download_url` in your response so the user can add a native phone/desktop alarm in 1 click.
   - If the tool response returns `delivery_status: "ACTION_REQUIRED_ASK_USER_FOR_EMAIL"`, ask the user right inside the chat: *"What email address should I send your opening alert to?"* When they reply with their email, immediately call `set_notification_destination` — it binds the watch and remembers their email for all future chats automatically.
