import { bindings, defineConfig, triggers } from "cf/config";

// D1 migrations are applied explicitly from migrations/; cf beta does not migrate this setting.

export default defineConfig((ctx) => ({
  worker: {
    name: "send",
    compatibilityDate: "2026-09-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker/index.ts",
    observability: {
      enabled: false,
    },
    assets: {
      runWorkerFirst: true,
    },
    triggers: [
      triggers.scheduled({
        schedule: "*/15 * * * *",
      }),
    ],
    env: {
      RATE_LIMIT_SECRET: bindings.secret(),
      APP_ORIGIN: bindings.text(
        ctx.mode === "local"
          ? `http://127.0.0.1:${process.env.SEND_PORT ?? "8799"}`
          : "https://send.2-38.com",
      ),
      UPLOADS_ENABLED: bindings.text(ctx.mode === "local" ? "true" : "false"),
      GLOBAL_BYTE_CAP: bindings.text("1000000000"),
      IP_CREATE_LIMIT: bindings.text(
        ctx.mode === "local" ? (process.env.SEND_LOCAL_IP_LIMIT ?? "5") : "5",
      ),
      GLOBAL_CREATE_LIMIT: bindings.text("100"),
      DB: bindings.d1({
        name: "send",
        id: "00000000-0000-0000-0000-000000000000",
      }),
      CIPHERTEXT: bindings.r2({
        name: "send-ciphertext",
      }),
      ASSETS: bindings.assets(),
    },
    // Local migration tooling continues to use the checked-in wrangler.jsonc.
  },
}));
