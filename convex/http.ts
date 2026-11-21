import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });

const dispatch = httpAction(async (ctx, req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  if (url.pathname === "/api/health") return json(200, { ok: true, backend: "convex" });
    let body: unknown = undefined;
  if (req.method !== "GET" && req.method !== "DELETE") {
    const text = await req.text();
    if (text) {
      try { body = JSON.parse(text); } catch { return json(400, { error: "input: invalid JSON" }); }
    }
  }
  const auth = req.headers.get("authorization") ?? "";
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  try {
    const out = (await ctx.runMutation(internal.api.handle, {
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token: auth.startsWith("Bearer ") ? auth.slice(7) : undefined, ip, body: body ?? null,
    })) as { __status?: number; error?: string } | null;
    if (out && typeof out === "object" && out.__status) return json(out.__status, { error: out.error });
    return json(200, out ?? null);
  } catch (e) {
    if (e instanceof ConvexError) {
      const d = e.data as { status?: number; message?: string };
      return json(d.status ?? 400, { error: d.message ?? "Something went wrong" });
    }
    console.error(e);
    return json(500, { error: "Something went wrong on the server" });
  }
});

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
  http.route({ pathPrefix: "/api/", method, handler: dispatch });
}

export default http;
