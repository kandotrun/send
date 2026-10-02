# send: 藍のビジュアル刷新

ユーザー承認: 現行の便箋トーンを「藍」方向へ刷新する。印象の軸は「安心・信頼」。見出し・補足の文言変更可。ダークモードはOS設定に追従（切替ボタンなし）。

## 目的
- 初見で「端末で暗号化／鍵はサーバーに送らない／期限・取り消しで失効」が伝わる。
- 9〜11pxの補足文をなくし、日本語を読める大きさにする。
- 該当しない注意書きを出さない。共有リンクと管理リンクに主従をつける。
- 見出しの二重表示・成功表示の重複をなくす。

## 範囲
- 対象: `index.html`、`src/web/style.css`、`src/web/main.ts`（表示制御のみ）、`public/favicon.svg`、`public/policy.css`（配色のみ）、`tests/ui.test.ts`、`tests/e2e/*.spec.ts`。
- 対象外: 暗号・API・送受信の振る舞い、`policy.html` の本文、テーマ切替UI、新規依存・外部フォント・外部スクリプト。
- 既存制約を維持: `style=` 属性・インライン script・`innerHTML`・`@import` 禁止。アイコンは `index.html` 内のインラインSVG（`aria-hidden="true"`）。

## デザイントークン
`:root` に定義し、`@media (prefers-color-scheme: dark)` で同名を上書きする。`color-scheme: light dark`。

| トークン | ライト | ダーク | 用途 |
| --- | --- | --- | --- |
| `--ground` | `#EEF2F5` | `#0F1620` | ページ地 |
| `--surface` | `#FFFFFF` | `#16202B` | カード |
| `--surface-muted` | `#F7F9FB` | `#1B2733` | 入力欄・控え・受信文章 |
| `--ink` | `#132230` | `#E6ECF2` | 本文 |
| `--muted` | `#51606F` | `#9AA8B6` | 補足 |
| `--line` | `#D5DDE5` | `#2A3644` | 罫線 |
| `--line-strong` | `#A7B6C5` | `#3B4A5B` | 入力枠・ドロップ枠 |
| `--accent` | `#1F4E79` | `#8DB3DE` | リンク・フォーカス・アイコン |
| `--accent-fill` | `#1F4E79` | `#2F6AA3` | 主ボタン |
| `--accent-fill-hover` | `#183F63` | `#285D90` | 主ボタンhover |
| `--on-accent` | `#FFFFFF` | `#FFFFFF` | 主ボタン文字 |
| `--accent-soft` | `#E3EBF3` | `#1A2A3B` | 安心チェックリスト・アイコン地 |
| `--accent-ink` | `#1F3A57` | `#BCD2EA` | `--accent-soft` 上の文字 |
| `--caution-bg` | `#F6EFE0` | `#2B2416` | 情報系の注意 |
| `--caution-ink` | `#6B4A12` | `#E8CF9A` | 同上の文字 |
| `--danger` | `#A8322B` | `#F08A80` | 取り消し・エラー文字 |
| `--danger-bg` | `#FBEDEB` | `#3A1E1C` | エラー地 |
| `--success` | `#2E6B4F` | `#7CC4A0` | 成功の印 |

- 赤は取り消しとエラーだけ。情報系の注意（100MB案内・ウイルス検査）は `--caution-*`。
- `:focus-visible` は `--accent` の2pxリング。
- `meta[name="theme-color"]` をライト `#EEF2F5`／ダーク `#0F1620` の2本にする（`media` 属性）。

## タイポグラフィと形
- 和文はゴシックに統一: `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif`。
- リンク欄は等幅: `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`。
- 本文15px、補足13px、最小12px。入力・selectは16px（iOSの自動拡大防止）。h1は `clamp(28px, 4.2vw, 36px)`、h2は20px。
- カード角丸12px、操作部品8px、罫線1px。主ボタン高さ52px以上、操作対象は44px以上。

## 画面
共通: 上部の導入（h1と説明）は送信画面だけ表示する。`main.ts` の `setView` が `main` 要素に `data-view` を付け、送信画面以外では導入を視覚的に隠す。h1は読み上げ用に残し、送信「鍵をかけて、リンクで渡す。」／完了「共有リンクの発行」／受信「届いた内容の受け取り」／管理「リンクの管理」／無効「開けないリンク」とする。英字のアイブロウ（`#screen-eyebrow` と各画面の `.eyebrow`）と `send. / 01`・`LINK DELIVERY` の装飾は削除する。

### 送信
- h1「鍵をかけて、リンクで渡す。」、説明「ファイルも文章も、この端末で暗号化してから送ります。」。`<title>` は「send. — 鍵をかけて、リンクで渡す。」。
- ヘッダー: 鍵アイコン＋ワードマーク `send.`（点は `--accent`）、右に「登録不要・ファイル10 GBまで」。
- カード内: セグメント型の「ファイル／文章」タブ（role=tab は維持）→ ドロップ枠「ファイルをドロップ／または ファイルを選ぶ／1個・10 GBまで」→ 有効期限（`select#expiry` 維持、補足「作成時から数えます。期限を過ぎると受け取れません。」）→ 主ボタン「暗号化して共有リンクをつくる」。
- 主ボタン直下に安心チェックリスト（`--accent-soft`）: 「内容とファイル名は、この端末で暗号化します」「復号の鍵はサーバーに送りません」「期限切れ・取り消し後は受け取れません」。
- その下に「送る前に」箇条書き: タブを開いたまま／「送信は共有期限、または作成から24時間の早い方までに完了する必要があります。」／自動再試行・途中再開なし／1 GB = 1,000,000,000 bytes。
- `#sender-browser-guide` は初期 `hidden`。ファイル選択時に `needsNativeSave({ kind: "file", size })` が真なら表示し、取り除き・無効な置き換え・リセットで隠す（境界値は `tests/save.test.ts` が検証済み）。
- カード下に「リンクを持つ人は、ほかの人に転送できます。送る相手を確かめてください。」。

### 完了
- 見出し: 鍵チェックアイコン＋「共有リンクができました。」、説明「共有リンクを、受け取る相手に送ってください。この画面を閉じると、リンクは再表示できません。」。
- 共有リンク（主）: ラベル＋バッジ「相手に送る」、等幅の入力欄、塗りの「コピー」。
- 管理リンク（控え）: 点線で区切った `--surface-muted` の帯。ラベル「管理リンク（控え）」＋バッジ「自分だけで保管」、枠線のみの「コピー」、「共有リンクを知っている人は受け取れます。管理リンクは送らず、自分で保管してください。」と「管理リンクをなくすと、期限前の取り消しはできません。」。
- 受け取れる期限の行、「新しく送る」（枠線）と「このリンクを取り消す」（赤文字）、「受け取った相手が保存したコピーは取り消せません。」。
- `#status[data-state="success"]` は枠なしの1行表示（`role=status` は維持）。

### 受信
- 見出し: 鍵アイコン＋「暗号化された内容が届いています。」、説明「内容は、ボタンを押すまでダウンロードしません。」（ファイル名は開いた時点で端末内で復号するため「復号もしない」とは書かない）。
- ファイル行（ファイルアイコン・名前・種別とサイズ）、受け取れる期限の行。
- ウイルス検査の注意は `--caution-*` の行。
- `#receiver-browser-guide` は初期 `hidden`。`needsNativeSave(manifest)` が真のときだけ表示。
- 主ボタン（文言は既存ロジック）、受信文章パネル、「自分も送る →」。

### 管理・無効
- 管理: 見出し「リンクを管理する。」、状態・アップロード・有効期限の定義リスト、注意、全幅の「このリンクを取り消す」（赤枠、hoverで `--danger-bg`）。
- 無効: リンク切れアイコン＋「このリンクは開けません。」、説明、「トップに戻る」。

### 進行状況・フッター
- `#status`: 待機中は `--accent` のスピナー、百分率、4pxのプログレスバー。エラーは `--danger-bg`、中止は `--surface-muted`。
- フッター: 「安全性と制約について」はカード型の `details`。本文は現行の安全性説明を維持。下段にタグライン・規約・ソースコードのリンク。

## テスト（RED→GREEN）
単体（`tests/ui.test.ts`）:
1. ライト／ダーク双方で上表の全トークンが定義され、`prefers-color-scheme: dark` と `color-scheme: light dark` がある。
2. トークン値からWCAGコントラストを計算し、両モードで次が4.5以上: `ink`/`muted`/`accent` × `ground`/`surface`/`surface-muted`、`on-accent`×`accent-fill`・`accent-fill-hover`、`accent-ink`×`accent-soft`、`caution-ink`×`caution-bg`、`danger`×`surface`・`danger-bg`、`success`×`surface`。
3. `style.css` に12px未満の `font-size` がない。
4. 英字アイブロウ（`A SMALL DELIVERY` 等）と装飾見出しがなく、新しい見出し・主ボタン・チェックリストがある。既存の安全性文言テストは維持。
5. `#sender-browser-guide` と `#receiver-browser-guide` が初期 `hidden`。`theme-color` が2本ある。

E2E（実Worker・D1・R2）:
1. 文章の受信で `#receiver-browser-guide` が非表示。101MB送受信で送信側・受信側の案内が表示（既存 large-file spec に追加）。
2. 受信・完了・管理画面で導入見出しが非表示、送信画面で表示。
3. `colorScheme: "dark"` で `body` 背景がダークのトークン値、390px幅で横スクロールなし。
4. 既存E2Eがすべて通る。

完了条件: `npm run check` と `npm run test:e2e` が成功し、1280px・375px × ライト・ダークで全画面を目視確認する。
