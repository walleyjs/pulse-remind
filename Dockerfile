# ==============================================================================
# PulseRemind / Cue — Production Multi-Stage Dockerfile
# ==============================================================================
# Multi-stage build running unprivileged under user `node`.
# Zero third-party npm dependencies required (built-in node:sqlite).
# ==============================================================================

# --- Stage 1: Verification & Build Stage ---
FROM node:23-slim AS builder
WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY tests/ ./tests/

# Run complete hermetic test verification inside container build
ENV PULSEREMIND_DB_PATH=:memory:
RUN node --test --no-warnings tests/e2e.test.ts

# --- Stage 2: Minimal Production Runtime ---
FROM node:23-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3456
ENV PULSEREMIND_DB_PATH=/app/data/pulseremind.db

# Create storage volume directory and assign ownership to unprivileged user
RUN mkdir -p /app/data && chown -R node:node /app

# Copy application sources from builder
COPY --chown=node:node --from=builder /app/package.json ./package.json
COPY --chown=node:node --from=builder /app/src ./src
COPY --chown=node:node --from=builder /app/public ./public

# Switch to unprivileged non-root user (UID 1000)
USER node

# Container healthcheck against /api/health
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3456) + '/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

EXPOSE 3456

# Start web dashboard, tool server, and temporal resolution loop
CMD ["node", "--no-warnings", "src/index.ts"]
