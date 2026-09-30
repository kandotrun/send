import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

export const ORIGIN = "https://send.test";
export async function startWorker() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const script = (
    await build({
      stdin: {
        contents: `import worker, { cleanup } from './src/worker/index.ts';
let failDelete = false, failPut = false;
let overrides = {};
export default { async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/__test/')) {
    if (path === '/__test/config') overrides = await request.json();
    if (['/__test/hold','/__test/release','/__test/pending'].includes(path)) return env.R2_GATE.fetch('https://gate.test/' + path.split('/').pop());
    if (path === '/__test/delete-fail') failDelete = true;
    if (path === '/__test/delete-ok') failDelete = false;
    if (path === '/__test/put-fail') failPut = true;
    if (path === '/__test/cleanup') await cleanup(wrapped(env), Number(new URL(request.url).searchParams.get('now')) || Date.now());
    return Response.json({ok: true});
  }
  // Miniflare's dispatch transport replaces Host with its ephemeral loopback listener.
  // Restore the caller's logical Host only in this test entry, never in production.
  const headers = new Headers(request.headers);
  headers.set('Host', headers.get('X-Test-Host') ?? new URL(request.url).host);
  headers.delete('X-Test-Host');
  if (headers.get('X-Test-IP') === 'missing') headers.delete('CF-Connecting-IP');
  else if (headers.has('X-Test-IP')) headers.set('CF-Connecting-IP', headers.get('X-Test-IP'));
  headers.delete('X-Test-IP');
  return worker.fetch(new Request(request, {headers}), wrapped(env), ctx);
}};
function wrapped(env) {
  const bucket = env.CIPHERTEXT;
  return {...env, ...overrides, CIPHERTEXT: new Proxy(bucket, {get(target, key) {
    if (key === 'put') return async (...args) => {
      await env.R2_GATE.fetch('https://gate.test/wait');
      const result = await bucket.put(...args);
      if (failPut) { failPut = false; throw new Error('injected R2 completion failure'); }
      return result;
    };
    if (key === 'get') return async (...args) => {
      await env.R2_GATE.fetch('https://gate.test/wait');
      return bucket.get(...args);
    };
    if (key === 'delete') return async (...args) => { if (failDelete) throw new Error('injected R2 delete failure'); return bucket.delete(...args); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  }})};
}`,
        resolveDir: root,
        sourcefile: "tests/worker/runtime.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
    })
  ).outputFiles[0]?.text;
  if (!script) throw new Error("Worker bundle missing");
  let holding = false;
  const pending: (() => void)[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-09-30",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["CIPHERTEXT"],
      bindings: {
        APP_ORIGIN: ORIGIN,
        UPLOADS_ENABLED: "true",
        RATE_LIMIT_SECRET: "worker-test-fixture-only-not-a-production-secret",
        GLOBAL_BYTE_CAP: "1000000000",
        IP_CREATE_LIMIT: "100",
        GLOBAL_CREATE_LIMIT: "1000",
      },
      serviceBindings: {
        R2_GATE: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/hold") holding = true;
          if (path === "/release") {
            holding = false;
            pending.splice(0).forEach((resolve) => {
              resolve();
            });
          }
          if (path === "/pending") return Response.json({ pending: pending.length });
          if (path === "/wait" && holding)
            await new Promise<void>((resolve) => pending.push(resolve));
          return Response.json({ ok: true });
        },
        ASSETS: async () =>
          new Response("<!doctype html><title>send</title>", {
            headers: { "Content-Type": "text/html" },
          }),
      },
    }),
  );
  const db = await mf.getD1Database("DB");
  const migration = `${root}migrations/0001.sql`;
  await db.exec(await readFile(migration, "utf8"));
  return { mf, db, bucket: await mf.getR2Bucket("CIPHERTEXT") };
}
