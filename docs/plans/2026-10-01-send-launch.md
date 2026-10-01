# send: 10GB対応と初回公開

ユーザー承認: PR #1をマージし send.2-38.com に公開する。1ファイルの上限を10GB（10,000,000,000 bytes）にする。

## 実装境界
- 親: shared protocol、web UI、config、docs、E2E、remote operations、commit/push/merge/deploy。
- client担当: src/client/*.ts、tests/client.test.ts・crypto.test.ts・streaming.test.ts。転送鍵の境界は不変。
- worker担当: src/worker/*.ts、migrations/0001.sql、tests/worker*.ts・worker/harness.ts。
- commit/push/deployは親だけ。担当外ファイル変更・本番操作は禁止。

## 契約
- MAX_PLAIN_BYTES=10_000_000_000、MAX_BUFFERED_BYTES=100_000_000、CHUNK_BYTES=4_194_304、2385 chunks。
- 送信は既存のBlob.sliceを使い常に分割。大容量受信はOpenedTransfer.downloadTo(WritableStream<Uint8Array<ArrayBuffer>>, options?)、書込完了を待つバックプレッシャー。成功時だけclose、失敗・中止はabort。
- download()は100MB超を通信前に拒否。文章も100MB上限のまま。
- 100MB超の保存はFile System Access APIを持つPC版Chrome/Edge。保存先選択をクリック直後に行い、対応外は安全に案内して拒否。小さい受信は従来どおり。
- 公開時の総予約容量100GB、IP 5件/10分、全体100件/UTC日。1ファイル10GBを通す。本番secret専用、D1/R2専用、R2公開無効、canonical domainのみ。通常buildはアップロード無効、`--mode live`だけ有効（Vite既定production modeと区別）。
- upload_deadlineは最大24時間（ただし共有期限まで）。大容量送信の15分打切りを解消。
- 未確定R2 PUTの回復は単なる時間切れにしない。必要なら同一immutable object keyに条件付きの永久ゼロバイトfenceを作り、古いIf-None-Match PUTを防止してからD1 lease/予約を回収する。fenceは削除禁止、bucket-wide lifecycleで消さない。D1のtombstoneと同様に残るメタデータを明示。
- GCは1分cronでbounded cleanup、容量は回収が確認されるまで保持。

## 検証・公開
1. 各変更をRED-GREENで検証。Native R2条件付き競合・D1容量回収の回帰。
2. 全体unit・browser E2E・build・deploy dry-run・audit。
3. 真の10GB生成ファイルでブラウザ送受信とディスク出力のSHA-256一致・ピークメモリを検証（ローカル／本番を区別）。失敗を架空の成功にしない。
4. 独立spec review → quality/security review。blocker解消後push、最新headのCI成功、merge。
5. Cloudflare専用リソース・secret・domainを準備し本番公開。read-back config、health、公開UI、暗号化send/read/revoke、GCを検証。公開資料に初期版・第三者暗号監査なし・ブラウザ制約・通報/プライバシーを明記。
