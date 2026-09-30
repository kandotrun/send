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

アップロード中のisolate停止・D1障害では、`writing` lease・暗号文・容量予約が無期限に残り得ます。通常GCはこのleaseを除外し、期限経過だけでは回収しません。期限切れ・失効後の読み取り拒否は維持されます。

公開前にsend専用DBの未確定lease件数と最古作成時刻、予約量を秘密を出さず監視する手順を整えます。元のPUTが再開できないことを確認できる停止・隔離手順、対象objectの削除readback、DB予約の整合性検証を含む回復runbookの承認・実リソース検証が必要です。未検証のDELETE/UPDATEをここから実行しないこと。leaseの時刻だけで予約解放・identity再利用をしてはいけません。

## 公開デプロイ

この初期PRにはデプロイ承認はありません。`cf deploy`、リモートmigrations、D1/R2作成、DNS設定、公開アップロード有効化は実行しないでください。

承認後は[公開前ゲート](security.md#公開前ゲート)を満たし、send専用D1/R2とcanonical originを確認して設定を更新します。cfのresource commandは `cf cli search`・`cf schema`・`--help` で正確なread/write scopeを確認してから使います。global容量・rate・secretを明示し、`UPLOADS_ENABLED=true` は全ゲート確認後にのみ設定します。本番に `.dev.vars` をアップロードしないこと。

デプロイ後はdeployment revision、配信bundleのbyte/hash、public headers、合成アカウント不要の送受信・失効・GCを実リソースでreadback検証します。テストの鍵とリンクをログやPRコメントに掲載しないこと。確認済みのテストデータだけを削除します。
