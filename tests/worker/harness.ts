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
let failDelete = false, failPut = false, failPutBeforeSettled = false, failFence = false, failFenceAfter = false, failHead = false, failFenceHead = false;
let calls = [];
let overrides = {};
export default { async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/__test/')) {
    if (path === '/__test/config') overrides = await request.json();
    if (['hold','release','pending'].flatMap(action => ['', '-fence', '-put-settled', '-put-unsettled', '-head'].map(suffix => '/__test/' + action + suffix)).includes(path)) return env.R2_GATE.fetch('https://gate.test/' + path.split('/').pop());
    if (path === '/__test/drain-put-unsettled') return env.R2_UNKNOWN_PUT.fetch('https://unknown.test/drain');
    if (path === '/__test/put-fail-before-settled') failPutBeforeSettled = true;
    if (path === '/__test/storage-calls') return Response.json(calls);
    if (path === '/__test/delete-fail') failDelete = true;
    if (path === '/__test/delete-ok') failDelete = false;
    if (path === '/__test/put-fail') failPut = true;
    if (path === '/__test/fence-fail') failFence = true;
    if (path === '/__test/fence-fail-after') failFenceAfter = true;
    if (path === '/__test/fence-ok') { failFence = false; failFenceAfter = false; }
    if (path === '/__test/head-fail') failHead = true;
    if (path === '/__test/fence-head-fail') failFenceHead = true;
    if (path === '/__test/head-ok') { failHead = false; failFenceHead = false; }
    if (path === '/__test/cleanup') await cleanup(wrapped(env, ctx), Number(new URL(request.url).searchParams.get('now')) || Date.now());
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
  return worker.fetch(new Request(request, {headers}), wrapped(env, ctx), ctx);
}};
function wrapped(env, ctx) {
  const bucket = env.CIPHERTEXT;
  return {...env, ...overrides, CIPHERTEXT: new Proxy(bucket, {get(target, key) {
    if (key === 'put') return async (...args) => {
      const fence = args[2]?.customMetadata?.sendLeaseFence === '1';
      if (!fence && failPutBeforeSettled) {
        failPutBeforeSettled = false;
        // The host binding owns and awaits the actual native PUT; waitUntil owns
        // its transport even after this caller observes an unknown-outcome error.
        const headers = {'X-Object-Key': args[0]};
        ctx.waitUntil(env.R2_UNKNOWN_PUT.fetch('https://unknown.test/put', {
          method: 'PUT', headers, body: args[1],
        }).then(response => response.arrayBuffer()));
        await env.R2_UNKNOWN_PUT.fetch('https://unknown.test/started', {headers});
        throw new Error('injected caller rejection before native R2 settlement');
      }
      await env.R2_GATE.fetch('https://gate.test/wait' + (fence ? '-fence' : ''));
      if (fence && failFence) throw new Error('injected R2 fence failure');
      const result = await bucket.put(...args);
      calls.push({op: 'put', key: args[0], fence, size: result?.size ?? null});
      if (fence && failFenceAfter) throw new Error('injected R2 fence completion failure');
      if (!fence) {
        await env.R2_GATE.fetch('https://gate.test/wait-put-settled');
        if (failPut) { failPut = false; throw new Error('injected R2 completion failure'); }
      }
      return result;
    };
    if (key === 'head') return async (...args) => {
      await env.R2_GATE.fetch('https://gate.test/wait-head');
      if (failHead) throw new Error('injected R2 head failure');
      const result = await bucket.head(...args);
      if (failFenceHead && result?.customMetadata?.sendLeaseFence === '1') throw new Error('injected R2 fence head failure');
      calls.push({op: 'head', key: args[0], size: result?.size ?? null});
      return result;
    };
    if (key === 'get') return async (...args) => {
      await env.R2_GATE.fetch('https://gate.test/wait');
      return bucket.get(...args);
    };
    if (key === 'delete') return async (...args) => {
      calls.push({op: 'delete', key: args[0]});
      if (failDelete) throw new Error('injected R2 delete failure');
      return bucket.delete(...args);
    };
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
  const holding = new Set<string>();
  const pending = new Map<string, (() => void)[]>();
  const releaseGate = (gate: string) => {
    holding.delete(gate);
    pending
      .get(gate)
      ?.splice(0)
      .forEach((resolve) => {
        resolve();
      });
  };
  const waitAtGate = async (gate: string) => {
    if (!holding.has(gate)) return;
    const queue = pending.get(gate) ?? [];
    pending.set(gate, queue);
    await new Promise<void>((resolve, reject) => {
      const release = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        queue.splice(queue.indexOf(release), 1);
        reject(new Error(`Native R2 host gate ${gate} was not released`));
      }, 30_000);
      queue.push(release);
    });
  };
  let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
  const unknownStarted = new Set<string>();
  const unknownOperations: Promise<void>[] = [];
  const unknownResults: { key: string; size: number | null }[] = [];
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
          const [action, ...parts] = new URL(request.url).pathname.slice(1).split("-");
          const gate = parts.join("-");
          const queue = pending.get(gate) ?? [];
          pending.set(gate, queue);
          if (action === "hold") holding.add(gate);
          if (action === "release") releaseGate(gate);
          if (action === "pending") return Response.json({ pending: queue.length });
          if (action === "wait") await waitAtGate(gate);
          return Response.json({ ok: true });
        },
        R2_UNKNOWN_PUT: async (request) => {
          const action = new URL(request.url).pathname;
          if (action === "/drain") {
            await Promise.all(unknownOperations);
            return Response.json(unknownResults);
          }
          const key = request.headers.get("X-Object-Key");
          if (!key) throw new Error("Native R2 unknown PUT key missing");
          const startedGate = `started:${key}`;
          if (action === "/started") {
            if (!unknownStarted.has(key)) {
              holding.add(startedGate);
              await waitAtGate(startedGate);
            }
            return Response.json({ started: true });
          }
          const bytes = await request.arrayBuffer();
          // This awaited host service owns the real native operation independently
          // of the rejected caller. No workerd-global detached promise can vanish.
          const operation = (async () => {
            const blocked = waitAtGate("put-unsettled");
            unknownStarted.add(key);
            releaseGate(startedGate);
            await blocked;
            const result = await bucket.put(key, bytes, {
              onlyIf: { etagDoesNotMatch: "*" },
              httpMetadata: { contentType: "application/octet-stream" },
            });
            unknownResults.push({ key, size: result?.size ?? null });
          })();
          unknownOperations.push(operation);
          await operation;
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
  bucket = await mf.getR2Bucket("CIPHERTEXT");
  return { mf, db, bucket };
}
