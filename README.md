# PullVault
Live Demo: https://pull-vault-production.up.railway.app

Pokemon TCG pack-ripping + peer-to-peer trading + live auctions. Work-trial submission.
Focus: transactional consistency, concurrency safety, realtime updates, and marketplace economics.

## Stack

- **Next.js 14** (App Router) + TypeScript + Tailwind
- **PostgreSQL** for OLTP — every money/inventory operation is transactional
- **Redis** for pub/sub (drop inventory updates, auction bids, price ticks)
- **Socket.io** for real-time push to clients
- **decimal.js** for percentage math; cents stored as `BIGINT`

## Quick start

```bash
# 1. Install deps
npm install

# 2. Provision a Postgres + Redis. Free options:
#    Postgres → https://neon.tech (preferred — no install)
#    Redis    → https://upstash.com
#    Both have a free tier with no credit card.
cp .env.example .env
# edit .env, paste your DATABASE_URL and REDIS_URL

# 3. Apply schema
npm run db:migrate

# 4. Seed pack tiers, drops, and a Pokemon card catalog (~400 cards)
npm run db:seed

# 5. Run dev server (Next + Socket.io + workers)
npm run dev
# → http://localhost:3000
```
## Screenshots

<img width="1512" height="857" alt="Pack Drops page" src="https://github.com/user-attachments/assets/2ff6f21c-72cb-41a2-953c-9bebbbd0278e" />
<img width="1512" height="862" alt="Collection" src="https://github.com/user-attachments/assets/306df5da-4816-488a-b73e-a82d71be48f2" />
<img width="1512" height="860" alt="Marketplace" src="https://github.com/user-attachments/assets/74087c1f-e050-4b89-b765-6353d7856991" />
<img width="1512" height="857" alt="Auction" src="https://github.com/user-attachments/assets/2afdef4e-488b-4044-8fea-f6909611bafe" />
<img width="1512" height="860" alt="Admin Economics dashboard" src="https://github.com/user-attachments/assets/fc63a61b-6c07-43a4-8a11-1325b4bb7543" />


## High-level architecture

```text
Client (Next.js App Router)
        ↓
REST APIs + Socket.io server
        ↓
Transactional service layer
(pack-engine / market-engine / auction-engine)
        ↓
PostgreSQL (source of truth)
        ↓
Redis pub/sub + worker loops
(real-time bids, drops, price ticks)
```


## Project layout

```
src/
├── app/
│   ├── (pages)/             # Next.js App Router pages
│   ├── api/                 # REST API routes
│   └── layout.tsx
├── lib/
│   ├── db.ts                # pg pool, withTx, withTxRetry (40001 retry)
│   ├── redis.ts             # ioredis pub/sub
│   ├── auth.ts              # JWT cookie sessions (jose)
│   ├── money.ts             # decimal.js helpers, fee constants
│   ├── pokemon-api.ts       # Pokemon TCG API client + rarity normaliser
│   ├── pack-engine.ts       # buyPack(), revealPack(), computeTierEV()
│   ├── market-engine.ts     # listCard(), buyListing(), cancelListing()
│   └── auction-engine.ts    # createAuction(), placeBid(), settleAuction()
├── server.js                # Custom server: Next + Socket.io + workers
└── scripts/
    ├── schema.sql           # Postgres DDL with CHECK + partial unique indexes
    ├── migrate.ts           # `npm run db:migrate [--reset]`
    ├── seed.ts              # `npm run db:seed`
    └── workers.ts           # auction-closer + price-tick + drop-launcher loops
```

## Key engineering decisions

- Money stored as BIGINT cents to avoid floating-point drift.
- PostgreSQL is the source of truth for all inventory and balance state.
- Redis is used only for ephemeral realtime fan-out and worker coordination.
- Conditional SQL UPDATE patterns prevent double-spends and duplicate purchases.
- Auction settlement runs in transactional boundaries to preserve consistency.
- Socket.io pushes live updates without polling.
- Retry-on-serialization-failure logic (`40001`) protects concurrent writes.

  
## Scope cuts (be honest about these in the review)

- **Auth** is email/password only — no social login, no email verification.
- **Pack reveal** is functional but not animated (pack burst / 3D flip). The
  brief explicitly de-prioritises animations and weights "must work correctly"
  far more.
- **Mobile** is responsive at the grid level but not designed for it.
- **Idempotency keys** table exists in the schema but isn't yet wired into
  POST routes — a real prod system would key every POST so retried requests
  don't double-buy. The current SQL conditional-UPDATE pattern already
  prevents *user-facing* double-effects, but a flaky network can still cost
  the user a successful response.
- **Price polling** uses simulated random walks (worker tick) instead of
  pulling TCGPlayer directly — TCGPlayer's developer key has a long approval
  cycle and the brief explicitly allows simulation when access is gated.
- **Tests** are not included. The concurrency contracts are described in the
  ARCHITECTURE doc and demonstrable in two browser tabs.

## What to read first

1. [ARCHITECTURE.md](./ARCHITECTURE.md) — schema, concurrency strategy,
   pack EV math, parameter justification, scaling failure modes.

## Demoing concurrency in two tabs

- **Pack drop:** open `/packs` in two tabs as two different users, click Buy
  on the same pack at the same instant. One succeeds, one gets a 409 sold-out.
- **Trade race:** put a card on the marketplace, open it in two tabs as two
  different buyers. One gets the card, the other sees `ALREADY_SOLD`.
- **Auction sniper:** put a card on a 60-second auction, place a bid in the
  last 30 seconds, watch the timer extend by 30 seconds.

## Deploy

Deploy on Railway (one click from a fork) — Next + custom server + workers all run in one container. For Vercel, split the worker into a separate Railway/Render service and set `RUN_WORKERS=false` on the Vercel build.

The `socket.io` `path: "/api/socket"` routing means it works behind Vercel's
edge once you also enable WebSocket via Vercel's Edge Runtime adapter — but
Railway is simpler for the demo.
