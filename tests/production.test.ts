import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import config from "../cloudflare.config";

test("production is explicit and capacity admits 10GB without borrowing another app's storage", () => {
  const source = readFileSync("cloudflare.config.ts", "utf8");
  const compatibility = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
  expect(source).toContain('ctx.mode === "live"');
  expect(source).toContain('"100000000000"');
  expect(source).toContain('pattern: "send.2-38.com/*"');
  expect(source).toContain('schedule: "* * * * *"');
  expect(compatibility.vars.UPLOADS_ENABLED).toBe("false");
  expect(compatibility.vars.GLOBAL_BYTE_CAP).toBe("100000000000");
  expect(compatibility.d1_databases[0].database_id).not.toBe(
    "00000000-0000-0000-0000-000000000000",
  );
  expect(config).toBeDefined();
});
