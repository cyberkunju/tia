# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# TIA web — React/Vite SPA built with Bun, served by nginx which also reverse-
# proxies /api → the FastAPI service (single origin: no CORS, no runtime config).
#
#   docker build -t tia-web apps/web
# ─────────────────────────────────────────────────────────────────────────────

############################
# Stage 1 — build the SPA  #
############################
FROM oven/bun:1-alpine AS build
WORKDIR /app

# Install deps from the frozen lockfile first (cached unless deps change).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build. VITE_API_BASE=/api makes the client call the same origin; nginx proxies it.
COPY . .
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=${VITE_API_BASE}
RUN bun run build

############################
# Stage 2 — serve via nginx#
############################
FROM nginx:1.27-alpine AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/tia.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=5 \
  CMD wget -q -O - http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
