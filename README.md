# send

**ファイルと文章を、端末で暗号化してリンクで渡す。** アカウント登録は不要です。

初期Web版を **[send.2-38.com](https://send.2-38.com)** で公開しています。
第三者による暗号とセキュリティの監査は未実施です。

## できること
- ファイル1個を最大10GB（10,000,000,000 bytes）、文章を最大100MBまで送信。
- 100MB超のファイル受信はPC版Chrome/Edgeのディスクへの分割保存。Safari/Firefox/iPhone等は100MB以下の受信のみ。
- 本文・ファイル名・内容種別を端末で暗号化。
- 1時間・24時間・7日で期限が切れる共有リンク。
- 共有リンクとは別の管理リンクで手動失効。
- 暗号文の分割アップロード、受信時の改ざん・順序・サイズ検証。

リンクを知る人は受け取れます。ダウンロード済みのコピーは回収できません。ウイルス検査は行いません。第三者によるセキュリティ監査は未実施です。[セキュリティと限界](docs/security.md)を確認してください。
[利用条件とプライバシー](https://send.2-38.com/policy.html)も公開しています。

## ローカルで動かす

Node.js 24 LTSを推奨（22.12以降も対応）。Cloudflareアカウントはローカル動作には不要です。

```sh
npm ci
npm run dev
```

`http://127.0.0.1:8799` を開きます。UIのbuild・ローカルD1 migrations・ローカルR2を準備してから起動します。空いていないポートのプロセスは停止しません。

```sh
SEND_PORT=8819 npm run dev
```

ローカルの権限秘密設定は `.dev.vars.example` から初回起動時だけ作成します。**本番には流用しないでください。** データは `.wrangler/send-local-state` に保存されます。ローカルdevも1IPあたり10分5件の作成制限があります。

## 検証

```sh
npm run check
npx playwright install chromium
npm run test:e2e
npm run deploy:dry
npm audit
```

E2Eは独立したローカル状態を作成し、ブラウザから実API・D1・R2を通して送受信します。テスト専用local modeだけはIP作成枠を広げます。dry-runは公開デプロイや本番DB変更を行いません。

初回公開時の検証範囲は次のとおりです。
- **10GB全量**：Chromiumとローカルのnative Worker/D1/R2、OPFSで送受信し、保存後のSHA-256一致を確認しました。
- **本番HTTPS**：合成の文章と9MiBの複数チャンクファイルで送受信し、手動失効、定期GC、テスト用R2暗号文の回収を確認しました。
- **配信内容**：公開Workerと全静的ファイルのハッシュ一致、セキュリティヘッダー、HTMLへの外部タグ無注入を確認しました。

本番での10GB全量、実OSの保存先ダイアログ、実iPhoneの検証は含みません。

## 実装と運用

- [製品・API・暗号プロトコルの仕様](docs/spec.md)
- [セキュリティと初期公開の条件](docs/security.md)
- [開発・検証・運用手順](docs/agent-setup.md)
- [AIエージェント向けルール](AGENTS.md)

Cloudflare Workers + D1 + 非公開R2。操作CLIは公式`cf`を使い、build/dry-runはViteのCloudflare plugin、beta段階のlocal dev/migrationsは検証済みのWrangler互換経路を使います。send専用D1/R2を設定済み。通常buildはアップロード無効のまま、明示的な `--mode live` でのみ公開を有効にします。txtとは鍵・権限・保存先を共有しません。総暗号文予約100GB・IPごと10分5件・全体UTC日100件の上限があります。

フル10GBの実ブラウザー／ディスク試験は手動で `SEND_TEN_GB=1 SEND_E2E_PORT=8859 npm run test:e2e -- tests/e2e/ten-gb.spec.ts` を実行します。合成ファイル10GBの送信・受信を全量通し、native OPFSのディスク出力をSHA-256で照合します。OSの保存先ダイアログだけをnative OPFSハンドルへ置き換えるため、実ダイアログや実iPhoneの検証とは区別します。
