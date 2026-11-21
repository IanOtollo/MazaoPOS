// Vercel runs this on every push. With a Convex deploy key it publishes the backend functions first,
// then builds the screens; without one it only builds the screens.
import { spawnSync } from "node:child_process";

const run = (cmd) => {
  const r = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (process.env.CONVEX_DEPLOY_KEY) {
  run('npx convex deploy --cmd "npm run build:web" --cmd-url-env-var-name VITE_CONVEX_URL --yes');
} else {
  console.log("CONVEX_DEPLOY_KEY is not set: building the screens only, backend not redeployed.");
  run("npm run build:web");
}
