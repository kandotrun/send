import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("spec: fresh-checkout local fixture satisfies the fail-closed rate-secret gate", () => {
  const source = readFileSync(resolve(".dev.vars.example"), "utf8");
  const value = source
    .split(/\r?\n/)
    .find((line) => line.startsWith("RATE_LIMIT_SECRET="))
    ?.split("=")
    .slice(1)
    .join("=");
  const decoded = value?.replace(/^(['"])(.*)\1$/, "$2");
  expect(decoded?.length).toBeGreaterThanOrEqual(32);
});

test("spec: local runner builds, migrates isolated state, binds loopback, and never deploys", () => {
  const path = resolve("scripts/dev.mjs");
  expect(existsSync(path), "local runner is not implemented").toBe(true);
  const source = readFileSync(path, "utf8");
  expect(source).toContain("127.0.0.1");
  expect(source).toContain("migrations");
  expect(source).toContain("--local");
  expect(source).toContain("--persist-to");
  expect(source).toContain("EADDRINUSE");
  expect(source).not.toContain("kill -");
  expect(source).not.toContain("'deploy'");
});
