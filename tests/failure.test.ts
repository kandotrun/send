import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeTransferError, TransferError, transferErrorCode } from "../src/shared/errors";
import { failureDetail } from "../src/web/failure";

const root = fileURLToPath(new URL("../", import.meta.url));
const sensitive = "private-name.txt https://send.example/#r=key.read-token.manage-token";
const generic = "処理できませんでした。もう一度お試しください。";

// 分類を持つのはアプリが作った固定エラーのみ。例外の本文や似たオブジェクトを信用しない。
describe("spec: trusted transfer failures", () => {
  it("keeps genuine errors immutable and preserves their identity through sanitization", () => {
    const error = new TransferError("network");
    expect(error.message).toBe("通信に失敗しました。接続を確認してください。");
    expect(Object.isFrozen(error)).toBe(true);
    expect(transferErrorCode(error)).toBe("network");
    expect(safeTransferError(error)).toBe(error);
    expect(error.cause).toBeUndefined();
  });

  it("does not trust forged categories, prototypes, raw errors or throwing getters", () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error(sensitive);
        },
      },
    );
    for (const error of [
      undefined,
      null,
      sensitive,
      new Error(sensitive),
      new TypeError(sensitive),
      { code: "network", status: 503, message: sensitive },
      Object.create(TransferError.prototype),
      hostile,
    ]) {
      expect(transferErrorCode(error)).toBeUndefined();
      const safe = safeTransferError(error);
      expect(safe).toBeInstanceOf(TransferError);
      expect(safe.code).toBe("unknown");
      expect(safe.message).toBe("転送を処理できませんでした。もう一度お試しください。");
      expect(safe.cause).toBeUndefined();
    }
  });
});

// DOMやサーバーの例外本文に依存せず、実装そのものから固定の日本語案内を検証する。
describe("spec: actionable Japanese failure guidance", () => {
  it.each([
    ["network", "通信できませんでした。接続を確認して、もう一度お試しください。"],
    [
      "unavailable",
      "転送を利用できません。期限切れ・取り消し済み、またはリンクが無効です。送り主に新しい共有リンクを作ってもらってください。",
    ],
    ["uploads-disabled", "現在、新しい送信を受け付けていません。時間をおいてお試しください。"],
    ["rate-limit", "送信が混み合っているか、利用上限に達しています。時間をおいてお試しください。"],
    [
      "decryption",
      "復号できませんでした。共有リンク全体を送り主に確認してください。解決しない場合は、新しい共有リンクを作ってもらってください。",
    ],
    ["too-large", "送れる大きさを超えています。100 MB以下の内容を選んでください。"],
    ["conflict", "転送の状態が変わりました。新しく送信し直してください。"],
  ] as const)("maps trusted %s to distinct fixed guidance", (code, copy) => {
    expect(failureDetail(new TransferError(code), "receive")).toBe(copy);
  });

  it("offers management-specific recovery without claiming unavailable means decrypt failure", () => {
    expect(failureDetail(new TransferError("unavailable"), "manage")).toBe(
      "転送を利用できません。期限切れ・取り消し済み、またはリンクが無効です。保管した管理リンク全体を確認してください。",
    );
    expect(failureDetail(new TransferError("unavailable"), "send")).toBe(
      "転送を利用できません。期限切れ・取り消し済み、またはリンクが無効です。新しく送信し直してください。",
    );
  });

  it("maps every unknown exception to generic copy without reading attacker-controlled fields", () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error(sensitive);
        },
      },
    );
    for (const error of [
      undefined,
      sensitive,
      new Error(sensitive),
      new TypeError(sensitive),
      { status: 429, code: "rate-limit", message: sensitive },
      Object.create(TransferError.prototype),
      hostile,
      new TransferError("unknown"),
    ]) {
      for (const action of ["send", "receive", "manage"] as const)
        expect(failureDetail(error, action)).toBe(generic);
    }
  });

  it("wires the tested pure classifier into the page instead of inspecting raw exception status", () => {
    const main = readFileSync(`${root}src/web/main.ts`, "utf8");
    expect(main).toContain('import { failureDetail } from "./failure.ts";');
    expect(main).not.toContain("function failureDetail(");
    expect(main).not.toContain("error.status");
    expect(main).not.toContain("error instanceof TypeError");
  });
});
