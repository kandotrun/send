import { transferErrorCode } from "../shared/errors.ts";

type FailureAction = "send" | "receive" | "manage";

// 表示は固定のアプリ所有文言のみ。生の例外やHTTP本文のフィールドは参照しない。
export function failureDetail(error: unknown, action: FailureAction): string {
  switch (transferErrorCode(error)) {
    case "network":
      return "通信できませんでした。接続を確認して、もう一度お試しください。";
    case "unavailable": {
      const recovery =
        action === "send"
          ? "新しく送信し直してください。"
          : action === "manage"
            ? "保管した管理リンク全体を確認してください。"
            : "送り主に新しい共有リンクを作ってもらってください。";
      return `転送を利用できません。期限切れ・取り消し済み、またはリンクが無効です。${recovery}`;
    }
    case "uploads-disabled":
      return "現在、新しい送信を受け付けていません。時間をおいてお試しください。";
    case "rate-limit":
      return "送信が混み合っているか、利用上限に達しています。時間をおいてお試しください。";
    case "decryption":
      return "復号できませんでした。共有リンク全体を送り主に確認してください。解決しない場合は、新しい共有リンクを作ってもらってください。";
    case "too-large":
      return "送れる大きさを超えています。ファイルは10 GB以下、文章は100 MB以下にしてください。";
    case "conflict":
      return "転送の状態が変わりました。新しく送信し直してください。";
    default:
      return "処理できませんでした。もう一度お試しください。";
  }
}
