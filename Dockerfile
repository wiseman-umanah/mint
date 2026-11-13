# syntax=docker/dockerfile:1
# MINT in one image: the web app, the embedded database, the market maker and the trading agent.
FROM node:24-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@12.15.0
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS run
ENV NODE_ENV=production \
    PORT=3000 \
    MINT_DATA_DIR=/data \
    MINT_ENV_FILE=/data/mint.env \
    NEXT_MANUAL_SIG_HANDLE=true
COPY --from=build /app /app
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["sh", "scripts/docker-entrypoint.sh"]
