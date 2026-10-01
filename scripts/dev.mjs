import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";

const port = Number(process.env.SEND_PORT ?? "8799");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid SEND_PORT");
const host = "127.0.0.1";
const state = resolve(process.env.SEND_STATE_DIR ?? ".wrangler/send-local-state");
const probe = net.createServer();
await new Promise((yes, no) => {
  probe.once("error", (error) =>
    no(
      error.code === "EADDRINUSE"
        ? new Error(
            `Port ${port} is already in use; choose another SEND_PORT. No existing process was stopped.`,
          )
        : error,
    ),
  );
  probe.listen(port, host, () => probe.close(yes));
});
mkdirSync(state, { recursive: true });
if (!existsSync(".dev.vars")) copyFileSync(".dev.vars.example", ".dev.vars");
const env = {
  ...process.env,
  SEND_PORT: String(port),
  CF_SEND_TELEMETRY: "false",
  DO_NOT_TRACK: "1",
  WRANGLER_SEND_METRICS: "false",
  CI: "1",
};
let current;
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopped = true;
    if (current?.pid) {
      try {
        current.kill(signal);
      } catch {
        /* child already exited */
      }
    }
  });
async function run(command, args) {
  if (stopped) throw new Error("Stopped");
  current = spawn(command, args, { stdio: "inherit", env });
  const child = current;
  await new Promise((yes, no) => {
    child.once("error", no);
    child.once("exit", (code, signal) =>
      code === 0 || stopped ? yes() : no(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
  current = undefined;
}
// Builds are completed before the asset manifest is loaded by the dev server.
await run("npm", ["run", "build:web"]);
// cf beta does not preserve migrations_dir in native configuration. The checked-in
// compatibility config applies exactly this repository's migrations, locally only.
await run("npx", [
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "send",
  "--local",
  "--config",
  "wrangler.jsonc",
  "--persist-to",
  state,
]);
// cf dev delegates to Vite and ignores binding/persistence flags in this beta.
// Serve the built, CSP-protected assets through the explicit local compatibility
// path so browser tests exercise the same Worker + Assets boundary as production.
await run("npx", [
  "wrangler",
  "dev",
  "--config",
  "wrangler.jsonc",
  "--local",
  "--persist-to",
  state,
  "--ip",
  host,
  "--port",
  String(port),
  "--var",
  `APP_ORIGIN:http://${host}:${port}`,
  "--var",
  "UPLOADS_ENABLED:true",
  "--var",
  `IP_CREATE_LIMIT:${process.env.SEND_LOCAL_IP_LIMIT ?? "5"}`,
]);
