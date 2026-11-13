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
 *  There is no track registry to maintain. The endpoint scans
 *  the archive folder (the folder named "music" inside "API")
 *  and treats every file named like a romaji slug —
 *  "<slug>.mp3", lowercase letters, digits and hyphens — as a
 *  published track. Adding a song is just: drop "<slug>.mp3"
 *  into the folder and reference that file name from the blog
 *  article's [[音楽|...]] marker. Files with any other name
 *  (unpublished takes, lyrics text files, the index) are
 *  ignored. The scanned name -> file ID map is cached for a
 *  few minutes so requests do not rescan the folder every time.
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
 *    preCacheMusic() (alias: preCacheAll()) builds/refreshes
 *    the cache for every track.
 *  ----------------------------- */
export const MUSIC_FOLDER_NAME = 'music';
export const MUSIC_PARENT_FOLDER_NAME = 'API';
export const TRACK_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*\.mp3$/;
export const TRACKS_CACHE_KEY = 'tracks-map-v1';
export const TRACKS_CACHE_TTL_SECONDS = 600;
export const CACHE_FOLDER_PROPERTY_KEY = 'MUSIC_CACHE_FOLDER_NAME';
export const DEFAULT_CACHE_FOLDER_NAME = 'music-cache';

/**
 * Locates the archive folder: the unique folder named "music"
 * that sits inside a folder named "API". Returns null when
 * there is not exactly one such folder, so a renamed or
 * duplicated folder fails loudly instead of serving the
 * wrong files.
 */
export const getMusicFolder_ = () => {
  const matches = [];
  const folders = DriveApp.getFoldersByName(MUSIC_FOLDER_NAME);
  while (folders.hasNext()) {
    const folder = folders.next();
    const parents = folder.getParents();
    while (parents.hasNext()) {
      if (parents.next().getName() === MUSIC_PARENT_FOLDER_NAME) {
        matches.push(folder);
        break;
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
};

export const scanTracks_ = (folder) => {
  const tracks = {};
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (TRACK_NAME_PATTERN.test(name)) tracks[name] = file.getId();
  }
  return tracks;
};

/**
 * Returns the { file name -> Drive file ID } map for every
 * published track, or null when the archive folder cannot be
 * found or holds no tracks. The map is kept in CacheService
 * for a few minutes; any cache trouble falls back to a live
 * scan, so playback never depends on the cache working.
 */
export const getTracks_ = () => {
  let cache = null;
  try {
    cache = CacheService.getScriptCache();
    const hit = cache && cache.get(TRACKS_CACHE_KEY);
    if (hit) {
      const parsed = JSON.parse(hit);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.keys(parsed).length) return parsed;
    }
  } catch (e) { /* fall through to a live scan */ }

  const folder = getMusicFolder_();
  if (!folder) return null;
  const tracks = scanTracks_(folder);
  if (!Object.keys(tracks).length) return null;

  try {
    if (cache) cache.put(TRACKS_CACHE_KEY, JSON.stringify(tracks), TRACKS_CACHE_TTL_SECONDS);
  } catch (e) { /* the map cache is best-effort */ }
  return tracks;
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
 * Warms the cache for every published track (run from the
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

/** Alias kept from the original cache proposal (PR #3). */
export const preCacheAll = () => preCacheMusic();

export const json_ = (obj) => ContentService
  .createTextOutput(JSON.stringify(obj))
  .setMimeType(ContentService.MimeType.JSON);
