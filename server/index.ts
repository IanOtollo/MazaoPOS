import Fastify from "fastify";
import cors from "@fastify/cors";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { seed } from "./db.ts";
import { HttpError } from "./auth.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { salesRoutes } from "./routes/sales.ts";
import { reportRoutes } from "./routes/reports.ts";
import { importRoutes } from "./routes/import.ts";
import { crmRoutes } from "./routes/crm.ts";
import { logoRoutes } from "./routes/logo.ts";
import { supplierRoutes } from "./routes/suppliers.ts";
import { registerEvents } from "./events.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { backupRoutes, startBackupSchedule } from "./routes/backup.ts";

seed();

const app = Fastify({ logger: { level: "warn" } });
await app.register(cors, { origin: true });

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
  app.log.error(err);
  return reply.status(500).send({ error: "Something went wrong on the server" });
});

registerEvents(app);
app.get("/api/health", async () => ({ ok: true }));
catalogRoutes(app);
salesRoutes(app);
reportRoutes(app);
importRoutes(app);
crmRoutes(app);
logoRoutes(app);
supplierRoutes(app);
dashboardRoutes(app);
backupRoutes(app);
startBackupSchedule();

// Serve the built till UI so other tills only need a browser pointed at this PC.
const dist = join(process.cwd(), "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};
if (existsSync(dist)) {
  app.get("/*", async (req, reply) => {
    const path = (req.url.split("?")[0] ?? "/").replace(/\.\./g, "");
    let file = join(dist, path);
    if (!existsSync(file) || path === "/") file = join(dist, "index.html");
    reply.header("content-type", MIME[extname(file)] ?? "application/octet-stream");
    return reply.send(readFileSync(file));
  });
}

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`POS server listening on http://localhost:${port}`);
