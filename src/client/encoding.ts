const alphabet = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // 小さなブロック単位で処理し、引数展開によるスタック超過を避ける。
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(
  value: string,
  expectedBytes?: number,
  maxBytes = 8192,
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !alphabet.test(value) ||
    value.length % 4 === 1 ||
    value.length > Math.ceil((maxBytes * 4) / 3)
  )
    throw new Error("リンクまたは暗号データの形式が正しくありません。");
  let decoded: string;
  try {
    decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new Error("リンクまたは暗号データの形式が正しくありません。");
  }
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  if (
    bytes.length > maxBytes ||
    (expectedBytes !== undefined && bytes.length !== expectedBytes) ||
    encodeBase64Url(bytes) !== value
  )
    throw new Error("リンクまたは暗号データの形式が正しくありません。");
  return bytes;
}

export function assertId(id: string): void {
  decodeBase64Url(id, 16);
}
export function assertSecret(secret: string): void {
  decodeBase64Url(secret, 32);
}
