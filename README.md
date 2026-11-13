# music-gas

ブログの埋め込み音楽プレイヤー（APlayer）へ音源を届けるための Google Apps Script です。

MP3 の保管は Google Drive です。Drive の直リンクは `Content-Disposition: attachment` で返るためブラウザの `<audio>` では再生できず、GitHub に音源を置くこともしないので、このエンドポイントが Drive から読み出した音声を base64 の JSON で返し、ブログ側で復元して再生します。

## API

- `GET ?track=<ファイル名>` → `{ ok: true, track, mime, data }`（data は base64）
- `GET ?o=list` → `{ ok: true, tracks: [...] }`（公開曲のファイル名一覧）
- エラー時 → `{ ok: false, error }`

## 設定

対応表の登録は不要です。エンドポイントは Drive の「API」フォルダの中にある「music」フォルダを自動で読み取り、ローマ字スラッグ形式のファイル名（`<スラッグ>.mp3`、英小文字・数字・ハイフン）を持つファイルを公開曲として扱います。

曲を追加するときは、`<スラッグ>.mp3` をそのフォルダに入れて、ブログ記事の `[[音楽|タイトル|<スラッグ>.mp3]]` マーカーから参照するだけです。未公開テイク（`[未公開 …]` 付きの名前）や歌詞テキストなど、スラッグ形式でないファイルは無視されます。

キャッシュフォルダ名はスクリプトプロパティ `MUSIC_CACHE_FOLDER_NAME` で変更できます（既定は `music-cache`）。本番とステージングでは必ず別の名前を使ってください。

## デプロイ

他の -gas リポジトリと同じ CI 構成です。

- `main` への push → 本番プロジェクトへデプロイ
- それ以外のブランチへの push → ステージングプロジェクトへデプロイ
- 必要な Secrets: `CLASPRC_JSON` / `DEPLOYMENT_ID` / `STAGING_SCRIPT_ID` / `STAGING_DEPLOYMENT_ID`
- `.clasp.json` の `scriptId` は本番プロジェクトの ID です（ステージングは CI が差し替えます）

初回は Apps Script エディタで関数を一度実行し、Drive 読み取りの認可を済ませてください。
