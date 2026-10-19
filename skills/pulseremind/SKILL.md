---
name: pulseremind
description: Use this skill whenever the user mentions planning for a scholarship, fellowship, university admission, grant, or program whose applications are not open yet (e.g., "opens at the end of the month", "opens early next year", "not open until fall/spring"). Automatically schedules a web-monitored watch and returns a private claim link.
---

# PulseRemind — Deferred Opportunity & Scholarship Web Monitor

When a user is planning for school, scholarships, fellowships, or grants during a chat and mentions that an application window is not open yet:

## Rules
1. **Strict Data Minimization (Privacy-First)**:
   - Never pass the user's full name, GPA, financial details, passport/ID numbers, or raw essay drafts to the tool.
   - Distill `chat_context` into a short, non-PII **Preparation Checklist** (e.g., `"Prepare 2-page research proposal and request 2 academic reference letters"`).
2. **Proactive Tool Invocation**:
   - Call `create_opportunity_watch` (or `extract_watches_from_chat` if multiple scholarships are discussed in a single turn).
   - You do NOT need to ask the user for their email address or the exact URL before calling the tool.
3. **Surface the Private Claim Link**:
   - After `create_opportunity_watch` succeeds, present the returned `watch.resolution_config.provider_metadata.claim_url` (`/claim/prm_...`) to the user so they can bind their Email, Telegram, Slack, or WhatsApp alert channel out-of-band without sharing personal contact details in the chat.
