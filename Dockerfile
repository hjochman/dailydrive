# =============================================================================
# Daily Drive by IBM Bob — Dockerfile
# Base: Red Hat Universal Base Image 9 (nodejs-20-minimal)
# Runs as non-root user (uid 1001) — security-compliant
# =============================================================================

FROM registry.access.redhat.com/ubi9/nodejs-24-minimal:latest

# ── Metadata ─────────────────────────────────────────────────────────────────
LABEL org.opencontainers.image.title="Daily Drive by IBM Bob"
LABEL org.opencontainers.image.description="Spotify Daily Drive rebuilt — podcasts + music, containerized"
LABEL org.opencontainers.image.source="https://github.com/patdeg/dailydrive"
LABEL org.opencontainers.image.licenses="MIT"

USER 0

# ── Working directory ─────────────────────────────────────────────────────────
WORKDIR /app

# ── Install dependencies (production only) ───────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Copy application source ──────────────────────────────────────────────────
COPY paths.js \
     token-manager.js \
     spotify-client-base.js \
     spotify-client-oauth.js \
     spotify-client-cookie.js \
     spotify-client-factory.js \
     server.js \
     index.js \
     setup.js \
     taste-profile.js \
     taste-profile-google.js \
     ./

# Copy view templates and public assets
COPY views/   ./views/
COPY public/  ./public/

# Copy Bob images into public directory so they are served as static files
COPY img/bob/ ./public/img/bob/

# ── Persistent data volume ───────────────────────────────────────────────────
# All runtime files (config, token, state, logs) are stored in /data.
# Mount a host directory here:  -v /your/path:/data
RUN mkdir -p /data && chown -R 1001:0 /data && chmod -R g=u /data

# ── Non-root user ─────────────────────────────────────────────────────────────
# uid 1001 is the default unprivileged user in Red Hat UBI images
USER 1001

# ── Environment variable defaults ────────────────────────────────────────────
ENV WEB_PORT=8080 \
    DATA_DIR=/data \
    REFRESH_INTERVAL_HOURS=24 \
    NODE_ENV=production

# ── Expose web port ───────────────────────────────────────────────────────────
EXPOSE 8080

# ── Healthcheck ───────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://127.0.0.1:${WEB_PORT}/api/status || exit 1

# ── Entrypoint ────────────────────────────────────────────────────────────────
CMD ["node", "server.js"]
