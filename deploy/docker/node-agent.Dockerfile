FROM node:22-bookworm-slim

RUN corepack enable
RUN mkdir -p /data && chown node:node /data
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @photomesh/node-agent build

ENV NODE_ENV=production
USER node
CMD ["node", "apps/node-agent/dist/index.js"]
