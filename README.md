# send

**ファイルと文章を、端末で暗号化してリンクで渡す。** アカウント登録は不要です。

初期Web版です。ローカルで動作検証を行うための実装で、公開サービスとしての運用はまだ開始していません。

## できること
- ファイル1個、または文章を送信（最大100MB = 100,000,000 bytes）。
- 本文・ファイル名・内容種別を端末で暗号化。
- 1時間・24時間・7日で期限が切れる共有リンク。
- 共有リンクとは別の管理リンクで手動失効。
- 暗号文の分割アップロード、受信時の改ざん・順序・サイズ検証。

リンクを知る人は受け取れます。ダウンロード済みのコピーは回収できません。ウイルス検査は行いません。第三者によるセキュリティ監査は未実施です。[セキュリティと限界](docs/security.md)を確認してください。

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

## 実装と運用

- [製品・API・暗号プロトコルの仕様](docs/spec.md)
- [セキュリティと公開前ゲート](docs/security.md)
- [開発・検証・運用手順](docs/agent-setup.md)
- [AIエージェント向けルール](AGENTS.md)

Cloudflare Workers + D1 + 非公開R2。操作CLIは公式`cf`を使い、build/dry-runはViteのCloudflare plugin、beta段階のlocal dev/migrationsは検証済みのWrangler互換経路を使います。リソースIDは未設定、本番アップロードは既定で無効です。txtとは鍵・権限・保存先を共有しません。
