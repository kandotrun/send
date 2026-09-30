import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// cf が Vite を検出しても、静的ファイルだけでなく Worker を生成する。
test("spec: Cloudflare build emits a fail-closed Worker deployment, not only static assets", () => {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, CF_SEND_TELEMETRY: "false", DO_NOT_TRACK: "1", CI: "1" },
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const root = resolve(".cloudflare/output/v0");
  expect(existsSync(`${root}/config.json`), "Build Output is missing").toBe(true);
  const worker = JSON.parse(readFileSync(`${root}/workers/default/worker.config.json`, "utf8"));
  expect(worker.name).toBe("send");
  expect(worker.env.UPLOADS_ENABLED.value).toBe("false");
  expect(worker.env.APP_ORIGIN.value).toBe("https://send.2-38.com");
  expect(worker.env.DB.type).toBe("d1");
  expect(worker.env.CIPHERTEXT.type).toBe("r2");
  expect(worker.assets.runWorkerFirst).toBe(true);
  expect(worker.manifest.mainModule).toBe("index.js");
  expect(existsSync(`${root}/workers/default/bundle/index.js`)).toBe(true);
  expect(existsSync(`${root}/workers/default/assets/index.html`)).toBe(true);
});
