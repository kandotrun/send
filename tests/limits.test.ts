import { expect, test } from "vitest";
import { CHUNK_BYTES, MAX_PLAIN_BYTES } from "../src/shared/protocol";

test("file transfers allow exactly decimal 10 GB with bounded 4 MiB chunks", () => {
  expect(MAX_PLAIN_BYTES).toBe(10_000_000_000);
  expect(CHUNK_BYTES).toBe(4_194_304);
  expect(Math.ceil(MAX_PLAIN_BYTES / CHUNK_BYTES)).toBe(2385);
});
