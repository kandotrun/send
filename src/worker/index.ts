import { MAX_PLAIN_BYTES } from "../shared/protocol";
import {
  decodeBase64url,
  HttpError,
  jsonBody,
  notFound,
  sameOrigin,
  secure,
  uploadsEnabled,
  validateCreate,
} from "./security";
import {
  authorized,
  cleanup,
  completeTransfer,
  createTransfer,
  manageRecord,
  putChunk,
  readChunk,
  revoke,
  transferRecord,
} from "./storage";

export { cleanup } from "./storage";

async function handle(request: Request, env: Env): Promise<Response> {
  const url = sameOrigin(request, env);
  if (url.search || url.pathname.includes("%") || url.pathname.includes("\\")) throw notFound();
  if (url.pathname === "/api/health" && request.method === "GET") {
    return Response.json({
      ok: true,
      uploadsEnabled: uploadsEnabled(env),
      maxPlainBytes: MAX_PLAIN_BYTES,
    });
  }
  if (url.pathname === "/api/transfers" && request.method === "POST") {
    // Parse/validate before any D1 mutation, including rate counters.
    const value = validateCreate(await jsonBody(request));
    return Response.json(await createTransfer(request, env, value), { status: 201 });
  }
  const route =
    /^\/api\/transfers\/([A-Za-z0-9_-]{22})(?:\/(manage|complete)|\/chunks\/(0|[1-9]\d*))?$/.exec(
      url.pathname,
    );
  if (route) {
    const id = route[1];
    if (!id || !decodeBase64url(id, 16)) throw notFound();
    const suffix = route[2];
    const chunk = route[3];
    if (chunk !== undefined) {
      const index = Number(chunk);
      if (!Number.isSafeInteger(index)) throw notFound();
      if (request.method === "GET")
        return readChunk(request, env, await authorized(request, env, id, "read"), index);
      if (request.method === "PUT") {
        await putChunk(request, env, await authorized(request, env, id, "upload"), index);
        return new Response(null, { status: 201 });
      }
    } else if (suffix === "complete" && request.method === "POST") {
      const row = await authorized(request, env, id, "upload");
      if (Object.keys(await jsonBody(request)).length !== 0)
        throw new HttpError(400, "invalid_request");
      return Response.json(await completeTransfer(request, env, row));
    } else if (suffix === "manage" && request.method === "GET") {
      return Response.json(await manageRecord(env, await authorized(request, env, id, "manage")));
    } else if (suffix === undefined) {
      if (request.method === "GET")
        return Response.json(transferRecord(await authorized(request, env, id, "read")));
      if (request.method === "DELETE") {
        await authorized(request, env, id, "delete");
        await revoke(env, id);
        // Storage reclamation is deferred to the scheduled bounded drain.
        return new Response(null, { status: 204 });
      }
    }
    throw notFound();
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) throw notFound();
  if (request.method !== "GET" && request.method !== "HEAD") throw notFound();
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return secure(await handle(request, env));
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "unavailable");
      return secure(Response.json({ error: failure.code }, { status: failure.status }));
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
