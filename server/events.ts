import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { requireLogin } from "./auth.ts";

/**
 * Live updates. Every open screen holds one long-lived connection to GET /api/events (Server-Sent Events).
 * Whenever anyone successfully changes something, we tell every screen WHAT KIND of data changed, and each
 * screen re-reads only what it shows. No polling, no refresh button.
 */
const clients = new Set<ServerResponse>();

const TOPICS: [RegExp, string[]][] = [
  [/^\/api\/sales/, ["sales", "stock", "customers", "dashboard"]],
  [/^\/api\/shifts/, ["shifts", "dashboard"]],
  [/^\/api\/products/, ["products", "stock", "dashboard"]],
  [/^\/api\/categories/, ["products"]],
  [/^\/api\/stock/, ["stock", "products", "dashboard"]],
  [/^\/api\/customers/, ["customers", "dashboard"]],
  [/^\/api\/settings/, ["settings"]],
  [/^\/api\/users/, ["staff", "roles"]],
  [/^\/api\/roles/, ["roles", "staff"]],
  [/^\/api\/backups/, ["backups"]],
  [/^\/api\/logo/, ["settings"]],
  [/^\/api\/(suppliers|purchases)/, ["suppliers", "stock", "products", "dashboard"]],
];

export function registerEvents(app: FastifyInstance) {
  app.get("/api/events", { preHandler: requireLogin() }, async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n: connected\n\n");
    clients.add(res);
    // a comment every 25 seconds keeps routers and proxies from closing an idle connection
    const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25_000);
    req.raw.on("close", () => { clearInterval(beat); clients.delete(res); });
    return reply;
  });

  // Runs after a response has been sent, so the database change is already committed when screens re-read.
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || reply.statusCode >= 400) return;
    const hit = TOPICS.find(([re]) => re.test(req.url.split("?")[0]));
    if (!hit) return;
    const msg = `event: change\ndata: ${JSON.stringify({ topics: hit[1] })}\n\n`;
    for (const c of clients) {
      try { c.write(msg); } catch { clients.delete(c); }
    }
  });
}
