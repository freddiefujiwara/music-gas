# music-gas

ブログの埋め込み音楽プレイヤー（APlayer）へ音源を届けるための Google Apps Script です。

MP3 の保管は Google Drive です。Drive の直リンクは `Content-Disposition: attachment` で返るためブラウザの `<audio>` では再生できず、GitHub に音源を置くこともしないので、このエンドポイントが Drive から読み出した音声を base64 の JSON で返し、ブログ側で復元して再生します。

## API

- `GET ?track=<ファイル名>` → `{ ok: true, track, mime, data }`（data は base64）
- `GET ?o=list` → `{ ok: true, tracks: [...] }`（設定済みのファイル名一覧）
- エラー時 → `{ ok: false, error }`

## 設定

曲名ファイル名 → Drive ファイル ID の対応は、スクリプトプロパティ `TRACKS_JSON` に JSON で入れます（リポジトリに Drive の ID は書きません）。

```json
{"hatogaya-urawa.mp3": "<Drive file ID>", "...": "..."}
```

## デプロイ

他の -gas リポジトリと同じ CI 構成です。

- `main` への push → 本番プロジェクトへデプロイ
- それ以外のブランチへの push → ステージングプロジェクトへデプロイ
- 必要な Secrets: `CLASPRC_JSON` / `DEPLOYMENT_ID` / `STAGING_SCRIPT_ID` / `STAGING_DEPLOYMENT_ID`
- `.clasp.json` の `scriptId` は本番プロジェクトの ID です（ステージングは CI が差し替えます）

初回は Apps Script エディタで関数を一度実行し、Drive 読み取りの認可を済ませてください。
