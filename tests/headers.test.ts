import { expect, test } from "vitest";
import { secure } from "../src/worker/security";

test("secure responses opt out of CDN transformations and automatic analytics injection", () => {
  const response = secure(new Response("encrypted delivery"));
  expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
});
