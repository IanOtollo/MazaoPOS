import { audit, fail, requirePerm, setSetting, type Handler } from "../lib";

const MAX_BYTES = 400 * 1024;

/** The real file type from the first bytes, so a mislabelled upload (or a script) is never stored as an image. */
function sniff(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const tag = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b.length > 12 && tag(0, 4) === "RIFF" && tag(8, 12) === "WEBP") return "image/webp";
  return null;
}

export const routes: Record<string, Handler> = {
  // public on purpose: the sign-in screen shows the shop's logo before anyone has signed in
  "GET /api/logo": async (ctx) => {
    const f = await ctx.db.query("files").withIndex("by_name", (q) => q.eq("name", "logo")).unique();
    if (!f) return { __status: 404, error: "No logo" };
    return { __binary: { mime: f.mime, base64: f.base64, etag: `"${f.updatedAt}"` } };
  },

  "PUT /api/logo": async (ctx, { token, body }) => {
    const actor = await requirePerm(ctx, token, "settings.manage");
    const dataUrl = body?.dataUrl;
    if (typeof dataUrl !== "string") return fail(400, "dataUrl: required");
    if (dataUrl.length > 700_000) return fail(400, "That image is too large");
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return fail(400, "Upload a PNG, JPG or WebP image");
    const raw = atob(m[2]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (bytes.length > MAX_BYTES) return fail(400, "That image is too large. Use one under 400 KB.");
    const real = sniff(bytes);
    if (!real) return fail(400, "That file is not a valid PNG, JPG or WebP image");
    const existing = await ctx.db.query("files").withIndex("by_name", (q) => q.eq("name", "logo")).unique();
    if (existing) await ctx.db.patch(existing._id, { mime: real, base64: m[2], updatedAt: Date.now() });
    else await ctx.db.insert("files", { name: "logo", mime: real, base64: m[2], updatedAt: Date.now() });
    const version = String(Date.now());
    await setSetting(ctx, "logo_version", version);
    await audit(ctx, actor.id, "logo_set", { bytes: bytes.length });
    return { version };
  },

  "DELETE /api/logo": async (ctx, { token }) => {
    const actor = await requirePerm(ctx, token, "settings.manage");
    const existing = await ctx.db.query("files").withIndex("by_name", (q) => q.eq("name", "logo")).unique();
    if (existing) await ctx.db.delete(existing._id);
    await setSetting(ctx, "logo_version", "");
    await audit(ctx, actor.id, "logo_remove");
    return { ok: true };
  },
};
