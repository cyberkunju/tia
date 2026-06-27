# TIA WhatsApp bridge — Bun runtime. Small, stateless adapter to the core API.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production \
    STAGING_DIR=/app/staging \
    PORT=8088
RUN mkdir -p /app/staging
EXPOSE 8088
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:8088/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/server.ts"]
