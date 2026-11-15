# music-gas

「川口の歌」のための Google Apps Script です。ポッドキャスト RSS フィードの配信、まとめ記事の自動生成、music-admin の管理 API を担います。

MP3 の正本は Google Drive（「API」フォルダ内の「music」フォルダ）に置き、再生用の音声は Internet Archive で配信します。このエンドポイント自体は音声を返しません（以前は Drive から読み出した音声を base64 の JSON で返す `?track=` 方式でしたが、再生がポッドキャストフィード方式に移行したため廃止しました）。

## API

- `GET ?o=rss` → music-db を正本とするポッドキャスト RSS フィード（XML）
- `POST { action, ... }` → music-admin の管理 API（後述）
- エラー時 → `{ ok: false, error }`

## 設定

対応表の登録は不要です。Drive の「API」フォルダの中にある「music」フォルダを自動で読み取り、ローマ字スラッグ形式のファイル名（`<スラッグ>.mp3`、英小文字・数字・ハイフン）を持つファイルを公開曲として扱います。このスキャンは、RSS の enclosure サイズ取得と、管理 API の公開・アップロード時の存在確認に使います。

曲を追加するときは、`<スラッグ>.mp3` をそのフォルダに入れて、music-db に行を足します（通常は music-admin から行います）。未公開テイク（`[未公開 …]` 付きの名前）や歌詞テキストなど、スラッグ形式でないファイルは無視されます。

## 記事の自動生成

まとめ記事ドキュメントは、スプレッドシート `music-db` を正本として自動生成します。エディタから `generateArticle()` を実行すると、`tracks` タブ（公開フラグが TRUE の曲を sort 順）と `meta` タブ（tags / suno_profile / intro / outro）を読んで、対象ドキュメントの本文を組み立て直します。

必要なスクリプトプロパティ:

- `MUSIC_DB_ID` — music-db のスプレッドシート ID
- `ARTICLE_DOC_ID` — 生成先ドキュメントの ID（**このドキュメントだけ**が書き換わります。ステージングでは必ず使い捨てコピーの ID を指定してください）

スコープ追加（スプレッドシート読み取り・ドキュメント書き込み）のため、マージ後はエディタで `generateArticle()` を一度実行して再認可してください。公開曲が1曲も無い場合は、記事を消してしまわないようエラーで止まります。

## 管理 API（music-admin 用）

管理画面 `music-admin` のバックエンドです。`POST`（JSON を `text/plain` で送信）で受け付け、認証は他の管理系サイトと同じ方式です。Google の ID トークンを許可リスト（スクリプトプロパティ `AVAILABLE_GMAILS`）で検証し、30 日間有効のオーナーセッションへ交換します。オーナーは一時アクセスリンク（共有セッション、オーナー同等）も発行できます。セッションは music-db 内の `owner_sessions` / `share_sessions` タブにハッシュ化して保存され、タブが無ければ初回利用時に自動で作られます。

アクション: `exchange_session` / `revoke_session` / `issue_share` / `revoke_share` / `list_tracks`（未公開を含む全行＋meta）/ `create_track` / `update_track` / `delete_track`（シートの行のみ削除）/ `update_meta` / `upload_mp3`（Drive の曲フォルダへ保存、上限 10MB）/ `publish_track` / `unpublish_track` / `regenerate_article` / `check_archive`

行の指定はデータ行番号（ヘッダを除く 1 始まり）で、任意で現在の `file` を併せて渡すと一致を検証します。`update_track` では `file` の変更はできません。

公開（`publish_track`）は「シートの公開フラグを TRUE → Internet Archive へアップロード → 記事再生成」の順に冪等なステップで実行し、ステップ別の結果を返します（ロールバックはしません）。IA のアップロードは ias3 API の `Authorization: LOW <access>:<secret>` 方式で、キーはスクリプトプロパティ `IA_ACCESS_KEY` / `IA_SECRET_KEY` にだけ置きます。未設定の場合は IA のステップだけを `skipped_not_configured` として公開自体は完了します。

追加で必要なスクリプトプロパティ:

- `AVAILABLE_GMAILS` — 許可する Google アカウント（カンマ区切り）
- `GOOGLE_OAUTH_CLIENT_ID` — 他アプリと共通の OAuth クライアント ID
- `IA_ACCESS_KEY` / `IA_SECRET_KEY` — Internet Archive の S3 キー（本人のみ登録。未設定でも公開フローは動きます）
- `MUSIC_FOLDER_NAME` — 任意。曲フォルダ名の差し替え（既定は `music`。ステージングでは `music-staging` を指定して本番フォルダと分離します）

`script.external_request` スコープ（tokeninfo 検証と IA アップロード用）を追加したため、マージ後は本番・ステージング両プロジェクトでエディタから関数を一度実行して再認可してください。

## ポッドキャスト RSS

`GET ?o=rss` は、music-db の `tracks` タブで公開フラグが TRUE の曲だけを、新しい順に配信します。各エピソードの音声 URL はファイル名から導出します（`https://archive.org/download/freddiefujiwara-<スラッグ>/<ファイル名>`）。Drive フォルダのスキャンに存在しない曲は出しません。`MUSIC_DB_ID` が未設定の場合やシートを読めない場合は、購読を壊さないよう item の無い channel だけのフィードを返します。

## デプロイ

他の -gas リポジトリと同じ CI 構成です。

- `main` への push → 本番プロジェクトへデプロイ
- それ以外のブランチへの push → ステージングプロジェクトへデプロイ
- 必要な Secrets: `CLASPRC_JSON` / `DEPLOYMENT_ID` / `STAGING_SCRIPT_ID` / `STAGING_DEPLOYMENT_ID`
- `.clasp.json` の `scriptId` は本番プロジェクトの ID です（ステージングは CI が差し替えます）

初回は Apps Script エディタで関数を一度実行し、Drive 読み取りの認可を済ませてください。
