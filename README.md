# MazaoPOS

A point of sale for a hardware shop. It runs on the shop computer, keeps selling when the internet is down, and covers the till, stock, suppliers, customers who buy on credit, staff roles, reports and backups.

Author: IanOtollo

## Run it on your computer

Needs Node 22.5 or newer.

```
npm install
npm run dev
```

Open http://localhost:5173 and sign in with PIN `1234` (this is the first Admin account; change the PIN straight away under Settings, Staff).

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Runs the end-to-end checks on a throwaway database |
| `npm run typecheck` | Checks the code for type errors |
| `npm run build:web` | Builds the screens into `web/dist` |
| `npm start` | Runs the server and serves the built screens from one address |

## How the pieces fit

There are two parts:

- **The screens** (the website the cashier and the admin use). These are plain files and can be hosted anywhere, including Vercel.
- **The server** (Node and a SQLite database file). It keeps the shop's data and sends live updates to every open screen.

The data lives in one file, `data/pos.db`, on whichever computer runs the server. A daily copy is kept in `data/backups` and can be downloaded from Settings, Backup.

## Deploying the screens on Vercel

1. Push this repository to GitHub.
2. In Vercel choose **Add New, Project**, and import it. The settings come from `vercel.json`, so leave the defaults.
3. Under **Environment Variables** add `VITE_API_URL` with the https address of your server (see below).
4. Deploy.

### The server cannot run on Vercel

Vercel runs short-lived functions. It cannot keep a database file between requests and it cannot hold a live-updates connection open, and this system needs both. So the server runs somewhere that stays on and has a disk that persists:

- **The shop computer**, made reachable over https with a tunnel such as Cloudflare Tunnel or Tailscale Funnel. The data then never leaves the shop. This is the recommended setup.
- **A small hosted server** (Railway, Fly.io, or any VPS) with a persistent volume for the `data` folder.

On the server machine:

```
npm install
npm run build:web
npm start
```

Set `CORS_ORIGIN` to your Vercel address so only your screens can use the server. See `.env.example` for every setting.

Vercel pages are https, so the server address in `VITE_API_URL` must be https too; the browser blocks an https page from calling a plain http address.

Vercel's free Hobby plan is for personal, non-commercial use. A shop running its real business should use a paid plan, or host the screens from the shop computer instead and skip Vercel.
