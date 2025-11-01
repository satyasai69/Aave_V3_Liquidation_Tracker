# Aave V3 Liquidation Tracker

Monitor real-time liquidation activity on the Aave V3 protocol (Ethereum mainnet) with analytics, historical trends, and asset-level visibility. The monorepo now hosts two workspaces:

- `server/` – Hono + Viem ingestion service that listens for `LiquidationCall` events and persists normalized events to MongoDB.
- `ui/` – Next.js dashboard that connects **directly to MongoDB** (server-side) for snapshots/SSE and renders token-denominated stats.

> **Runtime note**  
> The ingestion service still writes every event into MongoDB, but the UI no longer proxies through the server API – it runs its own Next.js route handlers that read from the database via change streams.

## Features
- 📊 **Live liquidation feed** decoded from `LiquidationCall` (token amounts only; USD summaries removed)
- 🧾 **Aggregated metrics** for liquidation counts and unique liquidators over 1h/24h windows
- 📈 **Historical timeline** (30 minute buckets) and asset distribution derived from Mongo aggregation pipelines
- ⚡ **Direct Mongo-backed SSE** exposed from the Next.js app (`/api/liquidations/stream`)

## Prerequisites
- **Bun** (preferred runtime for scripts/tests) – <https://bun.sh>
- Node.js ≥ 18 (required by Next.js / Viem)
- A MongoDB Atlas cluster (or compatible instance)
- Ethereum mainnet RPC (HTTPS, optional WebSocket for lower latency)

## Getting Started

### 1. Install dependencies

```bash
bun install
```

This installs packages for both workspaces via the root `package.json`.

### 2. Configure the ingestion service (`server/.env`)

Create `server/.env` (or export equivalent env vars):

```ini
ETHEREUM_HTTP_URL=...          # required
ETHEREUM_WS_URL=...            # optional, enables websocket streaming
MONGODB_URI=...                # required
MONGODB_DB_NAME=aave_liquidation_tracker # optional override
SERVER_PORT=4000               # optional
UI_ORIGIN=http://localhost:3000 # optional CORS override
AAVE_MONITOR_AUTO_START=true   # set false to disable auto boot
AAVE_POOL_ADDRESS=...          # optional overrides
AAVE_PRICE_ORACLE_ADDRESS=...
```

Start the ingestion/API server:

```bash
bun run dev:server
```

This continuously backfills and streams events into MongoDB.

#### Run the server in Docker

The `server/` workspace ships with a multi-stage Dockerfile. Build and run it by pointing the container at the same environment variables you would use locally:

```bash
cd server
docker build -t aave-liquidation-server .

# Provide configuration via --env-file or individual -e flags
docker run --rm \
  --env-file .env \
  -p 4000:4000 \
  aave-liquidation-server
```

> The container exposes port `4000` by default. When deploying, ensure the MongoDB + RPC credentials supplied to the container have the required permissions.

### 3. Configure the UI (`ui/.env.local`)

Create `ui/.env.local` with Mongo credentials (Next.js server components only – **do not** prefix with `NEXT_PUBLIC_`):

```ini
MONGODB_URI=...                 # must include credentials
MONGODB_DB_NAME=aave_liquidation_tracker
```

Optionally, set `NEXT_PUBLIC_API_BASE_URL` if the UI is reverse-proxied; default is the same host.

Start the dashboard:

```bash
bun run dev:ui
```

Visit <http://localhost:3000>. The UI will:

1. Hit `/api/liquidations/snapshot` (Next.js route) which runs aggregation pipelines directly on MongoDB.
2. Subscribe to `/api/liquidations/stream` which tails Mongo change streams for new insertions.

### 4. Production build

```bash
bun run build
```

This builds the Next.js UI (`.next`) and compiles the server (`dist/`). Deploy each workspace separately, ensuring they share the same MongoDB instance and RPC credentials.

## Architecture Overview
- **Ingestion** – `server/src/lib/aave/liquidationMonitor.ts` backfills historical logs and streams new blocks (WebSocket or HTTP). Token metadata & pricing fetched via ERC20 + Aave oracle.
- **Persistence** – Events inserted into `liquidations` collection (`server/src/lib/db/*`). Aggregations (summary, timeline, distribution) are executed lazily by the consumer.
- **Server API** – Hono app (`server/src/lib/api/app.ts`) still exposes `/liquidations/*` endpoints for compatibility, but the UI no longer depends on them.
- **UI Data Layer** – `ui/lib/mongo.ts` and `ui/lib/liquidations.ts` encapsulate Mongo connections/queries. Next.js route handlers serve snapshot/stream responses, and `LiquidationDashboard.tsx` consumes them via SWR + SSE.
- **Data Model** – Events store raw token amounts (stringified decimals) alongside helper fields such as `notionalUsd`; the UI displays token amounts only.

## Useful Commands

| Command | Description |
| ------- | ----------- |
| `bun run dev:server` | Start the ingestion/API server (watch mode) |
| `bun run dev:ui` | Start the Next.js dashboard |
| `bun run build` | Build both workspaces |
| `bun run start:server` | Run compiled server (`dist/index.js`) |
| `bun run start:ui` | Run production Next.js server |
| `bun run test:server` | Execute Mongo-backed repository tests (Bun test runner) |

## Operational Notes & Next Steps
- Ensure MongoDB credentials provided to the UI have **read-only** permissions on the `liquidations` collection (ingestion service should use a separate RW credential).
- Consider adding TTL indexes, archiving strategies, or Atlas triggers for long-term retention.
- Add auth/rate-limiting for production-use (both Hono API and Next.js routes).
- Extend analytics (e.g., borrower health factor snapshots, notification hooks) by expanding the aggregation helpers in `ui/lib/liquidations.ts`.
