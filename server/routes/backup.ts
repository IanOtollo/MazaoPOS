import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { audit, db } from "../db.ts";
import { HttpError, requirePerm } from "../auth.ts";

const DIR = resolve(process.env.BACKUP_DIR ?? "data/backups");
const KEEP = 30; // most recent backups to retain
const NAME = /^pos-\d{8}-\d{6}\.db$/;

mkdirSync(DIR, { recursive: true });

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** A consistent snapshot of the live database (safe while the shop is trading). */
export function backupNow(): { name: string; size: number } {
  const name = `pos-${stamp()}.db`;
  const path = join(DIR, name);
  if (existsSync(path)) return { name, size: statSync(path).size }; // one per second is plenty
  db.exec(`VACUUM INTO '${path.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  // keep only the newest KEEP files
  const all = readdirSync(DIR).filter((f) => NAME.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) unlinkSync(join(DIR, old));
  return { name, size: statSync(path).size };
}

export function listBackups() {
  return readdirSync(DIR)
    .filter((f) => NAME.test(f))
    .sort()
    .reverse()
    .map((name) => {
      const st = statSync(join(DIR, name));
      return { name, size: st.size, created_at: st.mtime.toISOString() };
    });
}

/** Back up on start-up if the last one is over 24h old, then re-check every hour. */
export function startBackupSchedule() {
  const check = () => {
    try {
      const last = listBackups()[0];
      if (!last || Date.now() - new Date(last.created_at).getTime() > 24 * 3600 * 1000) {
        const b = backupNow();
        audit(null, "backup_auto", b);
      }
    } catch (e) {
      console.error("Automatic backup failed:", e);
    }
  };
  check();
  setInterval(check, 3600 * 1000).unref();
}

export function backupRoutes(app: FastifyInstance) {
  app.get("/api/backups", { preHandler: requirePerm("settings.manage") }, async () => ({ folder: DIR, keep: KEEP, backups: listBackups() }));

  app.post("/api/backups", { preHandler: requirePerm("settings.manage") }, async (req) => {
    const b = backupNow();
    audit(req.user!.id, "backup_manual", b);
    return b;
  });

  app.get("/api/backups/:name", { preHandler: requirePerm("settings.manage") }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!NAME.test(name) || !existsSync(join(DIR, name))) throw new HttpError(404, "Backup not found");
    audit(req.user!.id, "backup_download", { name });
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${name}"`);
    return reply.send(readFileSync(join(DIR, name)));
  });
}
