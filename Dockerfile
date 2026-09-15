ARG NODE_IMAGE=mirror.gcr.io/library/node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.mjs ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION=2.1.272
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 DATA_DIR=/app/data BACKUP_DIR=/app/backups DEMO_MODE=false
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm install --global --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version \
    && npm cache clean --force \
    && mkdir /app/data /app/backups \
    && chown node:node /app/data /app/backups
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts ./scripts
USER node
VOLUME ["/app/data", "/app/backups"]
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
