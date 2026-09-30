# send v1 仕様

## 製品の範囲
1件につきファイル1個、または文章。100,000,000 bytesまで。登録不要。期限は1時間・24時間（既定）・7日。期限変更・上書き・一度だけの閲覧・パスワード・複数ファイル・課金はv1に入れない。受信者は全文を復号して確認してから保存する。ファイルの自動プレビューはしない。メモリ上に最大100MB程度の平文を組み立てるため、端末によっては最大サイズを処理できない。

## 暗号とリンク
Web Cryptoで32bytesのルート鍵・32bytesの閲覧秘密・32bytesの管理秘密、16bytesのIDを毎送信生成。canonical base64url、パディングなし。ID22文字、秘密とSHA-256ダイジェスト43文字。root keyからHKDF-SHA256（saltはIDのUTF-8、infoは`send/v1/manifest`または`send/v1/chunk`）で独立したAES-256-GCM鍵を導出。各暗号文はランダム12bytes nonce || ciphertext || 16bytes tag。AADはmanifest=`send/v1/<id>/manifest`、chunk=`send/v1/<id>/chunk/<index>`のUTF-8。チャンクは4,194,304bytes、空ファイルも1チャンク。chunkCount=max(1,ceil(size/CHUNK_BYTES)); cipherBytes=size+28*chunkCount。同一送信のチャンクは一度のみアップロード可能、内容更新禁止。

閲覧リンク=`<origin>/#r=<id>.<readToken>.<key>`。管理リンク=`<origin>/#m=<id>.<manageToken>`。fragmentをURL queryやpathnameに移さない。管理秘密は閲覧リンクに含めない。サーバーへ送るのは閲覧/管理秘密のSHA-256ハッシュ（作成時）、その後Authorizationヘッダーに権限秘密。復号鍵は一切送らない。作成・復号はバージョン、ID、chunks、size、ttlを暗号認証とともに検証する。manifestには平文で名前・mime・size等が含まれるが送信前に暗号化する。

## API（同一オリジンのみ）
すべてJSONエラー`{error: string}`。readはBearer readToken、manageはBearer manageToken。
- GET `/api/health`: `{ok:true,uploadsEnabled:boolean,maxPlainBytes:number}`。
- POST `/api/transfers`: Origin必須、application/json、CreateRequest、201 `{id,expiresAt}`。TTLは作成時から開始、upload締切は作成から15分または期限の早い方。
- PUT `/api/transfers/:id/chunks/:index`: manage、Origin必須、application/octet-stream、正確な暗号文長。201。再送は409（v1自動再送なし）。
- POST `/api/transfers/:id/complete`: manage、Origin必須、application/json body `{}`、全チャンク確認後ready、200 `{id,expiresAt}`。readyで同じ完了は冪等。
- GET `/api/transfers/:id`: read、readyのみ。TransferRecord。未認証/欠落/expired/revokedは同じ404。
- GET `/api/transfers/:id/chunks/:index`: read、ready、期限未到来のみ。application/octet-stream。復号後にダウンロードする。
- GET `/api/transfers/:id/manage`: manage、ManageRecord。復号鍵なし。
- DELETE `/api/transfers/:id`: manage、Origin必須、失効後204。失効は即座に読み取りを拒否し、削除失敗はGC再試行。ダウンロード済み・すでに開始した配信の停止は保証しない。

## Backend safety
D1/R2はsend専用。R2公開アクセス禁止。AES鍵・生のcapabilityはDBに保存しない。Origin/Host固定、CORS許可なし、encoded pathとquery credentials拒否、404 enumeration resistance、no-store、no-referrer、nosniff、CSP selfのみ、frame禁止。static/API共に同じヘッダーを実HTTPで検証。生IPは保存せず日別HMAC。secret未設定ではcreate fail closed。公開createはUPLOADS_ENABLED=trueの明示が必要。

作成枠はguarded INSERTまたはtransactionで同時処理を原子的に制限。IPごと10分5件、全体1日100件、保留/公開/削除待ち暗号文の予約総容量1GB。bytesとchunkCount整合性はserver検証。期限切れ/失効GCは上限付き15分cron、削除成功前に予約を解放しない。chunk uploadとrevoke/complete/GCの競合を防ぎ、遅いputが復活させたobjectを削除、失敗時はtombstoneを残す。期限到来後のアクセス拒否と物理削除の時差は区別する。

## UI
日本語。静かなエディトリアル調、紙・封筒を思わせる余白と細線、温かい白と墨色、朱色のアクセント。広告/分析/外部fontsなし。ファイル選択と本当に動くdrag&drop、文章タブ、期限select、進行とキャンセル、完了後閲覧リンクと管理リンクを別々にコピー。履歴に復号鍵を自動保存しない。復号失敗/expired/disabled/networkは具体的な案内。管理リンクは本人保管、紛失時復旧不可。スクリーンリーダーlabel、keyboard、live status、mobile、reduced-motionに対応。

## 公開前の限界
リンク所持者は転送可能。サービス運営や依存配信経路による悪意あるJS差し替え・感染端末・拡張機能はWeb E2EE単体では防げない。サイズ/期限/IP等メタデータは見える。ウイルス検査なし。独立した暗号/セキュリティ監査は未実施。匿名アップロードの違法利用・通報/削除手順、rate/cost metrics、Cloudflareログ/backup保持確認は公開前ゲート。
