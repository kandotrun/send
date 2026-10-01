# 開発・検証・運用

## 準備

```sh
npm ci
npm run dev
```

初回起動で `.dev.vars.example` を `.dev.vars` にコピーします。ローカルテスト用の値であり本番secretではありません。既存の `.dev.vars` は上書きしません。`SEND_PORT` は1024–65535の未使用ポート、`SEND_STATE_DIR` はこの開発インスタンス専用の状態ディレクトリに設定できます。

`npm run dev` は順にUIをbuild、Wrangler互換設定のmigrationsをローカル状態へ適用、明示的にローカルの `wrangler dev` を起動します。cf betaはViteを検出するとdevを委譲し、bindingやpersist-toの引数を転送しません。ホットリロード用JSを許可するためにCSPを弱めず、build済みUIを実Worker/Assets経由で検証する互換経路です。build後のサーバーでUIを再buildしたら、所有するdevプロセスを停止して起動し直してください。別プロジェクトのサーバーをkillしないこと。

`Ctrl+C` で起動した子プロセス群だけを停止します。ローカル状態を消したい場合は、必ずその状態を使用する自分のdevプロセスを止め、対象ディレクトリを確認してから削除してください。他の `.wrangler` 状態をまとめて消してはいけません。

## テスト

```sh
cp .dev.vars.example .dev.vars  # 新しいcheckoutのみ。既存secretがある場合は実行しない。
npm run types
npm run check
npx playwright install chromium
npm run test:e2e
npm run deploy:dry
npm audit --audit-level=moderate
```

- `tests/crypto.test.ts`: AES/HKDF・リンク・改ざん・型。
- `tests/client.test.ts`: 実loopback HTTPのクライアント境界。
- `tests/worker.test.ts`: Miniflareの実D1/R2、権限・期限・予約・競合・GC。
- `tests/e2e/transfer.spec.ts`: 実Web送受信・ファイルbyte一致・DOM安全性・失効・drag/drop・mobile。

VitestとPlaywrightは別runnerです。Playwrightはloopback8809ポートにテスト専用サーバーを起動し、終了時に停止します。既存サーバーを再利用しません。E2E状態には合成データしか入れません。

cf build/dry-runは `cloudflare.config.ts` とViteのCloudflare pluginを使用します。`index.html` をrepository rootに置き、native configとWorker bundleを同時に解決します。`npm run build:web` はローカル配信用assets-only buildです。生成物は `.cloudflare/` と `dist/` にありgitignore対象。cfのtraceや全文ログはリンク/Authorization/秘密を含み得るため、共有前に必ず除去します。

## 未確定アップロードの監視・回復

アップロード中のisolate停止・D1障害で未確定 `writing` leaseが残った場合、GCは転送を失効させ、同じimmutable object keyに永久ゼロバイトfenceを条件付きで設置してからleaseを回収します。時刻だけでは回収しません。古いIf-None-Match PUTはfenceにより拒否されます。fenceは永久保持し、一括削除・bucket-wide lifecycleで消してはいけません。

監視は未確定lease件数・最古時刻・予約量・実R2 payload容量の集計のみを取得します。転送ID・object key・暗号manifest・リンク・秘密をログに出さないこと。GCが失敗している場合はUPLOADS_ENABLEDを無効にして予約整合性を調査します。手作業でchunksをDELETEしたりreserved_bytesを0へUPDATEしてはいけません。通常のGCにfencingと回収を任せます。

## 公開デプロイ

Kanが2026-10-01にPRマージ・send.2-38.com公開・10GB化を承認しました。以後の再公開でも対象account/D1/R2、レビュー、最新CIを確認します。対象外リソースは変更しません。

[初期公開条件](security.md#初期公開の条件と残る検証)を満たし、send専用D1/R2とcanonical originを確認します。cfのresource commandは `cf cli search`・`cf schema`・`--help` で正確なread/write scopeを確認してから使います。global容量・rate・secretを明示し、`UPLOADS_ENABLED=true` は全ゲート確認後にのみ設定します。本番に `.dev.vars` をアップロードしないこと。

デプロイ後はdeployment revision、配信bundleのbyte/hash、public headers、合成アカウント不要の送受信・失効・GCを実リソースでreadback検証します。テストの鍵とリンクをログやPRコメントに掲載しないこと。確認済みのテストデータだけを削除します。
