# Contributing to PulseRemind

Thank you for your interest in contributing to PulseRemind! This document provides guidelines and workflows for contributing to the core engine, MCP server, web dashboard, and temporal resolution adapters.

---

## Architectural Philosophy: Zero-Dependency Standard Library

PulseRemind is deliberately engineered to run with **zero third-party npm production dependencies**:
- **Database**: Native `node:sqlite` in WAL mode.
- **Cryptography & Security**: Native `node:crypto` (HMAC, SHA-256, AES-GCM, VAPID ES256).
- **HTTP & Protocol Servers**: Native `node:http`, `node:stream`, and Node 22 native `fetch`.
- **Test Runner**: Native `node:test` and `node:assert`.

> [!IMPORTANT]
> **Please do not add third-party npm dependencies** to `package.json` without an approved Architectural Decision Record (ADR). Maintaining zero npm runtime dependencies protects our supply-chain integrity, ensures instant boot times, and minimizes deployment attack surface.

---

## Development Prerequisites

- **Node.js**: v22.6.0 or higher (v23+ recommended).
- **Git**: Installed and configured.
- **Docker** (Optional): For containerized testing.

---

## Local Development Workflow

### 1. Clone the Repository
```bash
git clone https://github.com/walleyjs/pulse-remind.git
cd pulse-remind
```

### 2. Environment Configuration
Copy the template configuration:
```bash
cp .env.example .env
```
*(By default, `.env` runs in hermetic local SQLite mode. No external API keys are required to build, run, or test).*

### 3. Running the Server Locally
```bash
npm start
# Server listens at http://localhost:3456
```
To run with automatic file-watching on file edits:
```bash
npm run dev
```

### 4. Running the Stdio MCP Server
To test the Model Context Protocol stdio server directly:
```bash
npm run mcp
```

---

## Testing Protocol

We maintain a rigorous 30-suite integration test matrix covering:
- MCP JSON-RPC 2.0 tool execution.
- Adversarial HTML scraping and DOM edge cases.
- Temporal state-machine transitions and virtual-time leaps.
- Multi-tenant cryptographic isolation.
- RFC 5545 `.ics` formatting and email outbox delivery.

Run the test suite:
```bash
npm test
```
All pull requests must pass 100% of integration tests before review.

---

## Submitting Pull Requests

1. **Branch Naming**: Use descriptive prefixes:
   - `feat/add-new-channel-adapter`
   - `fix/etag-304-caching`
   - `docs/clarify-mcp-setup`
2. **Commit Messages**: Follow Conventional Commits:
   - `feat: support Telegram Bot API dispatch`
   - `fix: resolve race condition in outbox exponential backoff`
   - `test: add adversarial table DOM test cases`
3. **Open a PR**: Fill out the PR template completely, referencing any related issues.
