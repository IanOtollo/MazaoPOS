import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, db, setSetting } from "../db.ts";
import { HttpError, requirePerm } from "../auth.ts";
import { parse } from "../util.ts";

const MAX_BYTES = 400 * 1024;

/** The real file type from the first bytes, so a mislabelled upload (or a script) is never stored as an image. */
function sniff(b: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function logoRoutes(app: FastifyInstance) {
  // public on purpose: the sign-in screen shows the shop's logo before anyone has signed in
  app.get("/api/logo", async (req, reply) => {
    const row = db.prepare("SELECT mime, data FROM files WHERE name='logo'").get() as { mime: string; data: Uint8Array } | undefined;
    if (!row) throw new HttpError(404, "No logo");
    const data = Buffer.from(row.data);
    const etag = `"${createHash("sha1").update(data).digest("hex")}"`;
    reply.header("etag", etag).header("cache-control", "public, max-age=0, must-revalidate").header("x-content-type-options", "nosniff");
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.type(row.mime).send(data);
  });

  app.put("/api/logo", { preHandler: requirePerm("settings.manage") }, async (req) => {
    const { dataUrl } = parse(z.object({ dataUrl: z.string().max(700_000, "That image is too large") }), req.body);
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw new HttpError(400, "Upload a PNG, JPG or WebP image");
    const bytes = Buffer.from(m[2], "base64");
    if (bytes.length > MAX_BYTES) throw new HttpError(400, "That image is too large. Use one under 400 KB.");
    const real = sniff(bytes);
    if (!real) throw new HttpError(400, "That file is not a valid PNG, JPG or WebP image");
    db.prepare("INSERT INTO files (name,mime,data,updated_at) VALUES ('logo',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=excluded.updated_at").run(real, bytes);
    const version = String(Date.now());
    setSetting("logo_version", version);
    audit(req.user!.id, "logo_set", { bytes: bytes.length });
    return { version };
  });

  app.delete("/api/logo", { preHandler: requirePerm("settings.manage") }, async (req) => {
    db.prepare("DELETE FROM files WHERE name='logo'").run();
    setSetting("logo_version", "");
    audit(req.user!.id, "logo_remove");
    return { ok: true };
  });
}
