/** -----------------------------
 *  music-gas: serves the blog's embedded-player audio.
 *
 *  The MP3 files live in Google Drive (the archive). Browsers
 *  refuse to play Drive's direct-download responses inside an
 *  <audio> element (they arrive as Content-Disposition:
 *  attachment), and the audio is not hosted on GitHub, so this
 *  endpoint bridges the gap: given a track file name it reads the
 *  file from Drive and returns the bytes as base64 JSON, which
 *  the blog front-end decodes into a Blob for the player.
 *
 *  Encoding a multi-MB MP3 on every request is slow, so the
 *  encoded response is cached: each track's payload is stored
 *  once as a JSON file in a "music-cache" subfolder next to the
 *  MP3 itself, stamped with the MP3's last-modified time. A
 *  request serves the cached payload while the stamp matches
 *  and rebuilds it (within the same request) when the MP3 has
 *  been replaced. Any cache failure falls back to encoding
 *  live, so playback never depends on the cache working.
 *
 *  The file name -> Drive file ID mapping lives in the script
 *  property TRACKS_JSON (an object such as
 *  {"hatogaya-urawa.mp3": "<driveFileId>", ...}), so no Drive
 *  IDs appear in this repository.
 *
 *  API:
 *    GET ?track=<file name>  -> { ok, track, mime, data(base64) }
 *    GET ?o=list             -> { ok, tracks: [file names] }
 *  Errors are JSON too: { ok: false, error }.
 *
 *  preCacheAll() (run from the editor) builds every cache entry
 *  up front; requests also build entries lazily on a miss.
 *  ----------------------------- */
export const TRACKS_PROPERTY_KEY = 'TRACKS_JSON';
export const CACHE_FOLDER_NAME = 'music-cache';

export const getTracks_ = () => {
  const raw = PropertiesService.getScriptProperties().getProperty(TRACKS_PROPERTY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) { /* fall through */ }
  return null;
};

export const getCacheFolder_ = (file, create) => {
  const parents = file.getParents();
  if (!parents.hasNext()) return null;
  const parent = parents.next();
  const folders = parent.getFoldersByName(CACHE_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return create ? parent.createFolder(CACHE_FOLDER_NAME) : null;
};

export const readCache_ = (file, track) => {
  try {
    const folder = getCacheFolder_(file, false);
    if (!folder) return null;
    const files = folder.getFilesByName(`${track}.json`);
    if (!files.hasNext()) return null;
    const data = JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
    if (!data || data.sourceModified !== file.getLastUpdated().getTime()) return null;
    const payload = data.payload;
    if (!payload || payload.ok !== true || typeof payload.data !== 'string') return null;
    return payload;
  } catch (e) {
    return null;
  }
};

export const writeCache_ = (file, track, payload) => {
  try {
    const folder = getCacheFolder_(file, true);
    if (!folder) return;
    const content = JSON.stringify({ sourceModified: file.getLastUpdated().getTime(), payload });
    const files = folder.getFilesByName(`${track}.json`);
    if (files.hasNext()) {
      files.next().setContent(content);
    } else {
      folder.createFile(`${track}.json`, content, MimeType.PLAIN_TEXT);
    }
  } catch (e) { /* the cache is best-effort */ }
};

export const buildPayload_ = (file, track) => {
  const blob = file.getBlob();
  return {
    ok: true,
    track,
    mime: blob.getContentType() || 'audio/mpeg',
    data: Utilities.base64Encode(blob.getBytes()),
  };
};

export const doGet = (e) => {
  const { track, o: output } = (e && e.parameter) || {};
  const tracks = getTracks_();
  if (!tracks) return json_({ ok: false, error: 'tracks are not configured' });

  if (output === 'list') return json_({ ok: true, tracks: Object.keys(tracks) });

  if (!track) return json_({ ok: false, error: 'missing track parameter' });
  const fileId = tracks[track];
  if (!fileId) return json_({ ok: false, error: 'unknown track' });

  try {
    const file = DriveApp.getFileById(fileId);
    const cached = readCache_(file, track);
    if (cached) return json_(cached);
    const payload = buildPayload_(file, track);
    writeCache_(file, track, payload);
    return json_(payload);
  } catch (err) {
    return json_({ ok: false, error: `failed to read track: ${err.message}` });
  }
};

export const preCacheAll = () => {
  const tracks = getTracks_();
  if (!tracks) throw new Error('tracks are not configured');
  let built = 0;
  Object.entries(tracks).forEach(([track, fileId]) => {
    const file = DriveApp.getFileById(fileId);
    writeCache_(file, track, buildPayload_(file, track));
    built += 1;
  });
  console.log(`preCacheAll: built ${built} cache entries`);
  return built;
};

export const json_ = (obj) => ContentService
  .createTextOutput(JSON.stringify(obj))
  .setMimeType(ContentService.MimeType.JSON);
