import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

// A first, harmless address to prove the deployment answers. The real API routes are added module by module.
http.route({
  path: "/api/health",
  method: "GET",
  handler: httpAction(async () =>
    new Response(JSON.stringify({ ok: true, backend: "convex" }), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    }),
  ),
});

export default http;
