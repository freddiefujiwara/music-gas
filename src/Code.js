/** -----------------------------
 *  music-gas: serves the blog's embedded-player audio.
 *
 *  The MP3 files live in Google Drive (the archive). Browsers
 *  refuse to play Drive's direct-download responses inside an
 *  <audio> element (they arrive as Content-Disposition:
 *  attachment), and the audio is not hosted on GitHub, so this
 *  endpoint bridges the gap: given a track file name it reads the
 *  file from Drive and returns the bytes as base64 JSON, which
 *  the blog front-end decodes into a Blob for APlayer.
 *
 *  The file name -> Drive file ID mapping lives in the script
 *  property TRACKS_JSON (an object such as
 *  {"hatogaya-urawa.mp3": "<driveFileId>", ...}), so no Drive
 *  IDs appear in this repository.
 *
 *  Converted responses are cached on Drive: the first read of a
 *  track stores the ready-made JSON ({ ok, track, mime, data })
 *  plus the source file's last-updated time and size in a cache
 *  folder next to the MP3s. Later reads serve the cached JSON
 *  when those stamps still match, skipping the blob read and
 *  the base64 conversion. Any cache trouble falls back to the
 *  live conversion, so playback never depends on the cache.
 *  The responses are far too large for CacheService (100 KB per
 *  value), so the cache lives on Drive, like blog-gas does.
 *
 *  The cache folder name defaults to "music-cache" and can be
 *  overridden with the script property MUSIC_CACHE_FOLDER_NAME.
 *  Each Apps Script project must use its own name (staging and
 *  production share the MP3 folder but never a cache folder).
 *
 *  API:
 *    GET ?track=<file name>  -> { ok, track, mime, data(base64) }
 *    GET ?o=list             -> { ok, tracks: [file names] }
 *  Errors are JSON too: { ok: false, error }.
 *
 *  Editor helper:
 *    preCacheMusic() builds/refreshes the cache for every track.
 *  ----------------------------- */
export const TRACKS_PROPERTY_KEY = 'TRACKS_JSON';
export const CACHE_FOLDER_PROPERTY_KEY = 'MUSIC_CACHE_FOLDER_NAME';
export const DEFAULT_CACHE_FOLDER_NAME = 'music-cache';

export const getTracks_ = () => {
  const raw = PropertiesService.getScriptProperties().getProperty(TRACKS_PROPERTY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) { /* fall through */ }
  return null;
};

export const getCacheFolderName_ = () => {
  const name = PropertiesService.getScriptProperties()
    .getProperty(CACHE_FOLDER_PROPERTY_KEY);
  return (name && name.trim()) || DEFAULT_CACHE_FOLDER_NAME;
};

export const convertTrack_ = (track, file) => {
  const blob = file.getBlob();
  return {
    ok: true,
    track,
    mime: blob.getContentType() || 'audio/mpeg',
    data: Utilities.base64Encode(blob.getBytes()),
  };
};

/**
 * Finds (or creates) this project's cache folder next to the
 * given MP3 file. Throws when the file has no parent folder;
 * callers treat any failure as "cache unavailable".
 */
export const getCacheFolder_ = (file) => {
  const parents = file.getParents();
  if (!parents || !parents.hasNext()) throw new Error('mp3 has no parent folder');
  const parent = parents.next();
  const name = getCacheFolderName_();
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
};

export const readTrackCache_ = (folder, track, file) => {
  try {
    const files = folder.getFilesByName(`${track}.json`);
    if (!files.hasNext()) return null;
    const cached = JSON.parse(files.next().getBlob().getDataAsString());
    if (!cached || cached.ok !== true || cached.track !== track
      || typeof cached.data !== 'string' || !cached.data) return null;
    if (cached.sourceModified !== file.getLastUpdated().getTime()) return null;
    if (cached.sourceSize !== file.getSize()) return null;
    return { ok: true, track, mime: cached.mime || 'audio/mpeg', data: cached.data };
  } catch (e) {
    return null;
  }
};

export const writeTrackCache_ = (folder, track, payload, file) => {
  try {
    const content = JSON.stringify({
      ...payload,
      sourceModified: file.getLastUpdated().getTime(),
      sourceSize: file.getSize(),
    });
    const files = folder.getFilesByName(`${track}.json`);
    if (files.hasNext()) files.next().setContent(content);
    else folder.createFile(`${track}.json`, content, MimeType.PLAIN_TEXT);
  } catch (e) { /* cache writes are best effort */ }
};

/**
 * Serves one track, using the Drive cache when it is fresh and
 * falling back to the live conversion whenever it is not.
 */
export const serveTrack_ = (track, file) => {
  let folder = null;
  try {
    folder = getCacheFolder_(file);
  } catch (e) { /* cache unavailable: convert live below */ }
  if (folder) {
    const cached = readTrackCache_(folder, track, file);
    if (cached) return cached;
  }
  const payload = convertTrack_(track, file);
  if (folder) writeTrackCache_(folder, track, payload, file);
  return payload;
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
    return json_(serveTrack_(track, DriveApp.getFileById(fileId)));
  } catch (err) {
    return json_({ ok: false, error: `failed to read track: ${err.message}` });
  }
};

/**
 * Warms the cache for every configured track (run from the
 * editor; no trigger needed). Fresh entries are kept as-is.
 */
export const preCacheMusic = () => {
  const tracks = getTracks_();
  if (!tracks) {
    console.log('tracks are not configured');
    return;
  }
  Object.keys(tracks).forEach((track) => {
    try {
      const file = DriveApp.getFileById(tracks[track]);
      const folder = getCacheFolder_(file);
      if (readTrackCache_(folder, track, file)) {
        console.log(`Fresh: ${track}`);
        return;
      }
      writeTrackCache_(folder, track, convertTrack_(track, file), file);
      console.log(`Cached: ${track}`);
    } catch (e) {
      console.error(`Failed: ${track}: ${e.message}`);
    }
  });
};

export const json_ = (obj) => ContentService
  .createTextOutput(JSON.stringify(obj))
  .setMimeType(ContentService.MimeType.JSON);
