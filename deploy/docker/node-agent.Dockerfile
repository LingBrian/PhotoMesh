FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN mkdir -p /data && chown node:node /data
WORKDIR /workspace
COPY . .
RUN pnpm install --filter @photomesh/node-agent --frozen-lockfile \
    && pnpm --filter @photomesh/node-agent build

ENV NODE_ENV=production
USER node
CMD ["node", "apps/node-agent/dist/index.js"]
