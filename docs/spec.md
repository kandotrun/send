# send v1 仕様

## 製品の範囲
1件につきファイル1個（10,000,000,000 bytes＝10GBまで）、または文章（100,000,000 bytesまで）。登録不要。期限は1時間・24時間（既定）・7日。期限変更・上書き・一度だけの閲覧・パスワード・複数ファイル・課金はv1に入れない。

送信は4MiBずつ暗号化する。100MB超のファイル受信はPC版Chrome/EdgeのFile System Access APIへ1チャンクずつ認証・復号して書き込み、全体確認後だけcloseして保存を確定する。失敗・キャンセルはabortする。非対応ブラウザーは大容量の本文を取得する前に拒否して案内する。100MB以下と文章は従来のBlob方式であり、端末のメモリ制約が残る。ファイルを自動表示・実行しない。

## 暗号とリンク
Web Cryptoで32bytesのルート鍵・32bytesの閲覧秘密・32bytesの管理秘密、16bytesのIDを毎送信生成。canonical base64url、パディングなし。ID22文字、秘密とSHA-256ダイジェスト43文字。root keyからHKDF-SHA256（saltはIDのUTF-8、infoは`send/v1/manifest`または`send/v1/chunk`）で独立したAES-256-GCM鍵を導出。各暗号文はランダム12bytes nonce || ciphertext || 16bytes tag。AADはmanifest=`send/v1/<id>/manifest`、chunk=`send/v1/<id>/chunk/<index>`のUTF-8。チャンクは4,194,304bytes、空ファイルも1チャンク。chunkCount=max(1,ceil(size/CHUNK_BYTES)); cipherBytes=size+28*chunkCount。同一送信のチャンクは一度のみアップロード可能、内容更新禁止。

閲覧リンク=`<origin>/#r=<id>.<readToken>.<key>`。管理リンク=`<origin>/#m=<id>.<manageToken>`。fragmentをURL queryやpathnameに移さない。管理秘密は閲覧リンクに含めない。サーバーへ送るのは閲覧/管理秘密のSHA-256ハッシュ（作成時）、その後Authorizationヘッダーに権限秘密。復号鍵は一切送らない。作成・復号はバージョン、ID、chunks、size、ttlを暗号認証とともに検証する。manifestには平文で名前・mime・size等が含まれるが送信前に暗号化する。

## API（同一オリジンのみ）
すべてJSONエラー`{error: string}`。readはBearer readToken、manageはBearer manageToken。
- GET `/api/health`: `{ok:true,uploadsEnabled:boolean,maxPlainBytes:number}`。
- POST `/api/transfers`: Origin必須、application/json、CreateRequest、201 `{id,expiresAt}`。TTLは作成時から開始、upload締切は作成から24時間または共有期限の早い方。送受信の自動再開はしない。
- PUT `/api/transfers/:id/chunks/:index`: manage、Origin必須、application/octet-stream、正確な暗号文長。201。再送は409（v1自動再送なし）。
- POST `/api/transfers/:id/complete`: manage、Origin必須、application/json body `{}`、全チャンク確認後ready、200 `{id,expiresAt}`。readyで同じ完了は冪等。
- GET `/api/transfers/:id`: read、readyのみ。TransferRecord。未認証/欠落/expired/revokedは同じ404。
- GET `/api/transfers/:id/chunks/:index`: read、ready、期限未到来のみ。application/octet-stream。復号後にダウンロードする。
- GET `/api/transfers/:id/manage`: manage、ManageRecord。復号鍵なし。
- DELETE `/api/transfers/:id`: manage、Origin必須、失効後204。失効は即座に読み取りを拒否し、削除失敗はGC再試行。ダウンロード済み・すでに開始した配信の停止は保証しない。

## Backend safety
D1/R2はsend専用。R2公開アクセス禁止。AES鍵・生のcapabilityはDBに保存しない。Origin/Host固定、CORS許可なし、encoded pathとquery credentials拒否、404 enumeration resistance、no-store、no-referrer、nosniff、CSP selfのみ、frame禁止。static/API共に同じヘッダーを実HTTPで検証。生IPは保存せず日別HMAC。secret未設定ではcreate fail closed。公開createはUPLOADS_ENABLED=trueの明示が必要。

作成枠はguarded INSERTで原子的に制限。IPごと10分5件、全体UTC日100件、保留/公開/削除待ち暗号文の予約総容量100GB。容量上限に達すると新規作成を拒否する。bytesとchunkCount整合性はserverとD1で検証。最大2385チャンク。期限切れ/失効GCは上限付き1分cronであり、物理回収が確認できるまで予約を解放しない。

未確定writing leaseは時刻だけで回収しない。失効後、同じimmutable object keyに条件付きで永久ゼロバイトfenceを置き、古いIf-None-Match PUTの復活を防止してからleaseを回収する。通常のciphertextは削除し、fenceとID tombstoneは保持する。fenceを消すbucket-wide lifecycleや手作業の一括削除は禁止。物理回収失敗は予約を保持して後続GCで再試行する。

## UI
日本語。静かなエディトリアル調、紙・封筒を思わせる余白と細線、温かい白と墨色、朱色のアクセント。広告/分析/外部fontsなし。ファイル選択と本当に動くdrag&drop、文章タブ、期限select、進行とキャンセル、完了後閲覧リンクと管理リンクを別々にコピー。履歴に復号鍵を自動保存しない。復号失敗/expired/disabled/networkは具体的な案内。管理リンクは本人保管、紛失時復旧不可。スクリーンリーダーlabel、keyboard、live status、mobile、reduced-motionに対応。

## 公開前の限界
リンク所持者は転送可能。サービス運営や依存配信経路による悪意あるJS差し替え・感染端末・拡張機能はWeb E2EE単体では防げない。サイズ/期限/IP等メタデータは見える。ウイルス検査なし。独立した第三者の暗号/セキュリティ監査は未実施。初期版として公開し、ブラウザー対応制約と限界をUI・/policy.htmlで明示する。実iPhoneの大容量受信は未対応。通報先は運営の公開連絡先を利用し、転送IDのみで失効処理できる。鍵・共有リンク全体を通報で集めない。
