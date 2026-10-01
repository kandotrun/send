import type { ManageLink, ReadLink } from "../shared/protocol";
import { assertId, assertSecret } from "./encoding";

export function currentOrigin(): string | undefined {
  return typeof window !== "undefined" ? window.location.origin : undefined;
}

function canonicalOrigin(origin: string): string {
  const url = new URL(origin);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    origin.replace(/\/$/, "") !== url.origin
  )
    throw invalid();
  return url.origin;
}

function parts(input: string, kind: "r" | "m", expectedOrigin = currentOrigin()): string[] {
  try {
    const url = new URL(input, expectedOrigin);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      input !== `${url.origin}/${url.hash}` ||
      url.search ||
      url.pathname !== "/" ||
      (expectedOrigin && url.origin !== canonicalOrigin(expectedOrigin))
    )
      throw invalid();
    const prefix = `#${kind}=`;
    if (!url.hash.startsWith(prefix)) throw invalid();
    const values = url.hash.slice(prefix.length).split(".");
    if (values.length !== (kind === "r" ? 3 : 2)) throw invalid();
    assertId(values[0] ?? "");
    for (const value of values.slice(1)) assertSecret(value);
    return values;
  } catch {
    throw invalid();
  }
}

export function parseReadLink(url: string, expectedOrigin?: string): ReadLink {
  const [id, readToken, key] = parts(url, "r", expectedOrigin);
  if (!id || !readToken || !key) throw invalid();
  return { id, readToken, key };
}
export function parseManageLink(url: string, expectedOrigin?: string): ManageLink {
  const [id, manageToken] = parts(url, "m", expectedOrigin);
  if (!id || !manageToken) throw invalid();
  return { id, manageToken };
}
export function buildReadUrl(origin: string, link: ReadLink): string {
  assertId(link.id);
  assertSecret(link.readToken);
  assertSecret(link.key);
  return `${canonicalOrigin(origin)}/#r=${link.id}.${link.readToken}.${link.key}`;
}
export function buildManageUrl(origin: string, link: ManageLink): string {
  assertId(link.id);
  assertSecret(link.manageToken);
  return `${canonicalOrigin(origin)}/#m=${link.id}.${link.manageToken}`;
}
function invalid(): Error {
  return new Error("共有リンクの形式または送信元が正しくありません。");
}
