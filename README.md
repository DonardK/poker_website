# Texas Hold'em Platform

Production-oriented real-time Texas Hold'em: Next.js client, authoritative Express/Socket.io server, Redis game state, PostgreSQL persistence, and autonomous AI bots.

## Local stack

```bash
cp .env.example .env
cp .env.example apps/web/.env.local
docker compose up -d
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

- Web: http://localhost:3000
- API / Socket.io: http://localhost:4000
- Guest play is enabled for instant local tables against bots.

## Phases

1. Architecture & data layer (current)
2. Deterministic poker engine
3. State machine & game loop
4. Quantitative bot engine
5. Socket integration & zero-trust masking
6. Table UI, Zustand sync, Framer Motion
