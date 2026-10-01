import { MAX_BUFFERED_BYTES, MAX_PLAIN_BYTES, type TtlSeconds } from "../shared/protocol.ts";

export function validateFiles(files: readonly { size: number }[]): string | null {
  if (files.length === 0) return "ファイルを1個選んでください。";
  if (files.length !== 1) return "一度に送れるファイルは1個です。";
  const file = files[0];
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_PLAIN_BYTES) {
    return "ファイルは10 GBまでです。";
  }
  return null;
}

export function resolveFiles<T extends { size: number }>(
  files: readonly T[],
): { file: T | null; error: string | null } {
  const error = validateFiles(files);
  return { file: error ? null : (files[0] ?? null), error };
}

export function validateText(text: string, maxBytes = MAX_BUFFERED_BYTES): string | null {
  if (text.length === 0) return "文章を入力してください。";
  if (new TextEncoder().encode(text).byteLength > maxBytes) return "文章は100 MBまでです。";
  return null;
}

export function parseTtl(value: string): TtlSeconds {
  if (value === "3600") return 3600;
  if (value === "86400") return 86400;
  if (value === "604800") return 604800;
  throw new Error("invalid expiry selection");
}

export function formatExpiry(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "期限を確認できません";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "期限を確認できません";
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return `${formatter.format(date)}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
}

export function formatSize(size: number): string {
  const unit =
    size >= 1_000_000_000 ? "GB" : size >= 1_000_000 ? "MB" : size >= 1_000 ? "KB" : "bytes";
  const value =
    unit === "GB"
      ? size / 1_000_000_000
      : unit === "MB"
        ? size / 1_000_000
        : unit === "KB"
          ? size / 1_000
          : size;
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(value)} ${unit}`;
}

export function safeDownloadName(name: string): string {
  return (
    Array.from(name, (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || character === "/" || character === "\\" ? "_" : character;
    })
      .join("")
      .slice(0, 240) || "download"
  );
}
