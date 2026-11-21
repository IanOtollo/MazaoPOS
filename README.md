# MazaoPOS

A point of sale for a hardware shop: the till, stock and units, suppliers, customers who buy on credit, staff roles, reports and a dashboard. It runs in the browser and needs an internet connection.

Author: IanOtollo

## How it fits together

- **The screens** (React, built with Vite) are hosted on Vercel.
- **The backend** is Convex: the database and the API (`convex/`). Every request from the screens goes to the Convex HTTP address.
- Vercel runs `scripts/vercel-build.mjs` on each push. When `CONVEX_DEPLOY_KEY` is set it publishes the Convex functions first, then builds the screens.

## Settings in Vercel

| Name | Value | Secret? |
|---|---|---|
| `VITE_API_URL` | the Convex HTTP address, for example `https://your-deployment.convex.site` | no |
| `CONVEX_DEPLOY_KEY` | a deploy key from the Convex dashboard (Settings, Deploy keys) | yes, Production only |

First sign-in uses PIN `1234` (the Admin account). Change it under Settings, Staff.

## Working on it

Needs Node 22 or newer.

```
npm install
npx convex dev        # keeps the backend in step while you edit convex/
npm run dev:web       # the screens at http://localhost:5173
npm run typecheck
npm run test:convex   # end-to-end check; wipes the DEV deployment (needs TEST_RESET_ALLOWED=1 there)
```

The older offline version (a Node server with a SQLite file) is kept under the git tag `offline-sqlite-v1`.
