FROM node:20-alpine

RUN apk add --no-cache python3 make g++ sqlite-dev

RUN npm install -g pnpm@10.26.2

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

COPY packages/agent/package.json              ./packages/agent/
COPY packages/core/package.json               ./packages/core/
COPY packages/swap-aggregator/package.json    ./packages/swap-aggregator/
COPY packages/yield-agent-core/package.json   ./packages/yield-agent-core/

RUN pnpm install --frozen-lockfile

COPY packages/agent/src         ./packages/agent/src
COPY packages/agent/tsconfig.json ./packages/agent/

COPY packages/core/dist         ./packages/core/dist

COPY packages/swap-aggregator/src          ./packages/swap-aggregator/src
COPY packages/swap-aggregator/tsconfig.json ./packages/swap-aggregator/

RUN pnpm --dir packages/swap-aggregator run build

COPY packages/yield-agent-core/src          ./packages/yield-agent-core/src
COPY packages/yield-agent-core/tsconfig.json ./packages/yield-agent-core/

RUN mkdir -p /app/packages/agent/.state

CMD ["pnpm", "--dir", "packages/agent", "run", "orchestrator"]
