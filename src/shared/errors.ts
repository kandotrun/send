const messages = {
  network: "通信に失敗しました。接続を確認してください。",
  unavailable: "転送が見つかりません。期限切れまたは削除済みです。",
  "uploads-disabled": "現在、新しい送信を受け付けていません。時間をおいてお試しください。",
  "rate-limit": "利用上限に達しました。時間をおいてお試しください。",
  decryption: "復号できません。リンクまたは暗号データを確認してください。",
  "too-large": "ファイルまたは転送データが大きすぎます。",
  conflict: "転送の状態が変わりました。アップロードをやり直してください。",
  unknown: "転送を処理できませんでした。もう一度お試しください。",
} as const;

export type TransferErrorCode = keyof typeof messages;
const trusted = new WeakMap<object, TransferErrorCode>();

// 生の例外・サーバー本文・causeを保持しない。似た形やprototypeだけでは信用しない。
export class TransferError extends Error {
  readonly code: TransferErrorCode;

  constructor(code: TransferErrorCode) {
    super(messages[code]);
    this.name = "TransferError";
    this.code = code;
    trusted.set(this, code);
    Object.freeze(this);
  }
}

export function transferErrorCode(error: unknown): TransferErrorCode | undefined {
  return error !== null && typeof error === "object" ? trusted.get(error) : undefined;
}

export function safeTransferError(error: unknown): TransferError {
  return transferErrorCode(error) !== undefined
    ? (error as TransferError)
    : new TransferError("unknown");
}
