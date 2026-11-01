# ADR-008: End-to-End Conversational Commerce & Mobile-Ergonomic UI/UX Architecture

* **Status**: Accepted
* **Context**: PulseRemind & OjaRadar Decoupled Social Commerce Engine
* **Authors**: Principal Systems Architect & Lead Conversational Commerce Designer
* **Date**: November 2026

---

## 1. Executive Summary & Problem Statement

Modern mobile commerce suffers from what we define as the **"App-Switcher Death Spiral"**:
```
AI Assistant Chat (Session Active)
       │
       ▼ [Asynchronous Wait]
Transactional Email Push
       │
       ▼ [Context Switch 1: Leaves Email App]
Mobile Web Browser (/demo/deal-portal)
       │
       ▼ [Context Switch 2: Leaves Browser]
WhatsApp Messenger (wa.me click-to-chat)
       │
       ▼ [Context Switch 3: Manual Renegotiation]
Manual Copy-Paste Back to AI / Mobile Banking App
```

In emerging consumer commerce (specifically Nigeria, with $\approx 85\%$ of appliance transactions occurring informally across WhatsApp, Instagram, and physical hubs like Alaba International and Computer Village), **each application switch imposes a $30\% - 50\%$ drop-off rate**. 

A service that monitors prices and alerts consumers cannot succeed as a static notification system. It must operate as an **ergonomic conversational bridge**.

This ADR establishes the architectural foundation and UX principles for unifying out-of-band asynchronous notifications with in-session conversational commerce.

---

## 2. Comparison of the 3 Macro Interaction Paradigms

| Evaluation Criteria | Paradigm A: Monolithic Static Push (Status Quo) | Paradigm B: In-Chat Generative UI Canvas | Paradigm C: Mobile Bottom-Sheet Action Gateway (Adopted Hybrid) |
| :--- | :--- | :--- | :--- |
| **Interaction Container** | Standard HTML Email $\rightarrow$ Unstyled Webpage | Inline AI Chat Stream (Antigravity Canvas) | Mobile-Ergonomic Bottom Sheet with Embedded Chat Drawer |
| **App-Switching Cost** | **Severe (3–4 hops)** | **Zero (0 hops)** | **Minimal (1 hop from notification $\rightarrow$ unified drawer)** |
| **Real-Time Responsiveness** | Static snapshot; stale upon open | Highly dynamic; live slider & calculations | Live hydrated; real-time recalculation & live webhook |
| **Emerging Market Fit** | Poor (email open rates $<20\%$ in Nigeria) | Excellent for active desktop/mobile chat | Exceptional for mobile web & WhatsApp deep-link handoff |
| **Trust Transmission** | Textual rating metrics ("Wilson 95%") | Interactive visual trade-off matrix | Physical Stall Address, POD guarantee & 1-tap WhatsApp |
| **Ergonomic Suitability** | Poor (desktop-oriented tables) | Responsive in-chat cards | **100% Thumb-Zone Optimized (Fitts's Law $\ge 48\text{px}$ targets)** |

---

## 3. Decision Drivers & Core Principles

### Driver 1: Fitts's Law & Mobile Thumb-Zone Ergonomics
On modern mobile devices (375px to 430px viewports, e.g. iPhone 15/16 Pro Max), the upper 40% of the screen is ergonomically inaccessible during single-handed operation. 
* **Rule**: All primary conversion actions (`[Buy on Official Store]` and `[Chat Stall on WhatsApp]`) must be anchored to a **persistent sticky bottom bar** (`position: sticky; bottom: 0`) with a minimum touch height of $48\text{px}$ (WCAG 2.5.5 Level AAA).

### Driver 2: Replacing Algorithmic Abstractions with Concrete Street Heuristics
Consumers in Lagos or Abuja do not evaluate deals via Bayesian lower bounds or AVP lattices. They look for tangible fraud-suppression heuristics:
* **Physical Market Coordinates**: *"Shop B12, Electrical Section, Alaba International Market, Ojo, Lagos"*.
* **Payment Terms**: *"Pay on Delivery (POD) Verified: Inspect goods physically before cash or transfer"*.
* **Visual Verification**: *"Live WhatsApp Video Call Available to inspect serial numbers"*.
* **Rule**: Suppress internal algorithmic jargon (*"Wilson rating"*, *"AVP lattice"*, *"Predicate satisfied"*) from all consumer-facing viewports.

### Driver 3: Zero-Typing Mobile Negotiation (1-Tap Chips)
Typing on virtual mobile keyboards while on the go introduces severe cognitive friction. 
* **Rule**: Provide pre-composed, clickable negotiation pills:
  1. `💰 "Offer ₦340k"` (dynamically calculated 5–7% below target).
  2. `🚚 "Ask for Lagos Waybill"`.
  3. `📹 "Request Video Proof"`.
  4. `📦 "Pay on Delivery to Ikeja/Lekki"`.
  Tapping any pill instantly mutates the pre-filled RFC 3986 WhatsApp link with an HMAC-signed quote token.

### Driver 4: Unified Conversational Commerce Drawer
Instead of forcing the user back to their AI chat client to modify price targets, the Deal Gateway embeds a collapsible **Live Assistant Drawer**. Users can type or tap suggestions directly on the product page, triggering `/api/webhooks/inbound-email` to mutate the SQLite watch in real time.
