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
 *
 *  The roundup article itself is generated from the music-db
 *  spreadsheet (the single source of truth for track metadata):
 *  generateArticle() reads the "tracks" and "meta" sheets of
 *  the spreadsheet named by the MUSIC_DB_ID script property
 *  and rewrites the document named by the ARTICLE_DOC_ID
 *  script property in the same layout as the hand-maintained
 *  article (tag line, markers + table of contents at the top,
 *  then one section per published track). Nothing else is
 *  written: the document given by ARTICLE_DOC_ID is the only
 *  write target, so staging points it at a throwaway copy.
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

/** -----------------------------
 *  Article generation from the music-db spreadsheet.
 *
 *  The spreadsheet is the master data for the roundup article:
 *  one row per track on the "tracks" sheet (columns are looked
 *  up by header name, so column order does not matter) and
 *  article-level key/value pairs on the "meta" sheet (tags,
 *  suno_profile, intro, outro). generateArticle() rebuilds
 *  the target document from that data; the sheet -> document
 *  conversion is split into pure steps (parse the sheet
 *  values, build a paragraph plan, write the plan) so each
 *  step can be unit-tested without Google services.
 *  ----------------------------- */
export const MUSIC_DB_ID_PROPERTY_KEY = 'MUSIC_DB_ID';
export const ARTICLE_DOC_ID_PROPERTY_KEY = 'ARTICLE_DOC_ID';
export const TRACKS_SHEET_NAME = 'tracks';
export const META_SHEET_NAME = 'meta';
export const ARTICLE_REQUIRED_HEADERS = ['file', 'title', 'published', 'sort'];
export const INSTAGRAM_LINK_LABEL = '▶️Instagramを見る';
export const SUNO_LINK_LABEL = '▶️Suno で曲を聴く';
export const YOUTUBE_LINK_LABEL = '▶️YouTube で動画を見る';

/**
 * Reads a script property that must be configured, failing
 * loudly (before anything is opened or written) when it is
 * missing or blank.
 */
export const getRequiredProperty_ = (key) => {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value || !String(value).trim()) {
    throw new Error(`script property ${key} is not set`);
  }
  return String(value).trim();
};

export const cellText_ = (value) => (value == null ? '' : String(value).trim());

/**
 * Normalizes a published_at cell to "yyyy-MM-dd". Cells come
 * back from the sheet either as strings (kept as-is) or as
 * Date objects (formatted in the project's time zone).
 */
export const cellDate_ = (value) => {
  if (value instanceof Date) return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd');
  return cellText_(value).slice(0, 10);
};

export const cellBool_ = (value) => value === true
  || cellText_(value).toUpperCase() === 'TRUE';

/** Sort keys that do not parse sort last instead of crashing. */
export const cellSort_ = (value) => {
  const n = typeof value === 'number' ? value : Number(cellText_(value));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/**
 * Parses the "tracks" sheet values (header row + data rows)
 * into track objects, keeping only published rows and
 * ordering them by the sort column, ascending.
 */
export const parseTracksSheet_ = (values) => {
  if (!Array.isArray(values) || !values.length) {
    throw new Error('tracks sheet is empty');
  }
  const headers = values[0].map((h) => cellText_(h));
  ARTICLE_REQUIRED_HEADERS.forEach((h) => {
    if (!headers.includes(h)) {
      throw new Error(`tracks sheet is missing the "${h}" column`);
    }
  });
  const col = (row, name) => {
    const i = headers.indexOf(name);
    return i >= 0 && i < row.length ? row[i] : '';
  };
  return values.slice(1)
    .map((row) => ({
      file: cellText_(col(row, 'file')),
      title: cellText_(col(row, 'title')),
      description: cellText_(col(row, 'description')),
      instagram: cellText_(col(row, 'instagram')),
      suno: cellText_(col(row, 'suno')),
      youtube: cellText_(col(row, 'youtube')),
      publishedAt: cellDate_(col(row, 'published_at')),
      lyrics: cellText_(col(row, 'lyrics')),
      sort: cellSort_(col(row, 'sort')),
      published: cellBool_(col(row, 'published')),
    }))
    .filter((track) => track.published && track.file)
    .sort((a, b) => a.sort - b.sort);
};

/** Parses the "meta" sheet values into a { key: value } map. */
export const parseMetaSheet_ = (values) => {
  const meta = {};
  if (!Array.isArray(values)) return meta;
  values.slice(1).forEach((row) => {
    const key = cellText_(row && row[0]);
    if (key) meta[key] = row.length > 1 ? cellText_(row[1]) : '';
  });
  return meta;
};

/**
 * Splits a multi-paragraph cell into blocks on blank lines.
 * A block may still hold single newlines; those become
 * separate paragraphs when the plan is built.
 */
export const splitBlocks_ = (text) => String(text || '')
  .split(/\n[ \t]*\n/)
  .map((block) => block.trim())
  .filter((block) => block);

/**
 * Builds the paragraph plan for the article: an array of
 * { kind: 'text' | 'heading' | 'link' | 'empty', text?, url? }
 * in document order, mirroring the hand-maintained article:
 *
 *   [[タグ：…]] / intro blocks with the Suno profile link-card
 *   paragraph after the second block / one [[音楽|title|file]]
 *   marker per track / [[目次]] / per track: "date title"
 *   heading, description blocks, label links, [[歌詞]] and the
 *   lyric lines / outro paragraphs.
 *
 *  Section headings use the track title as-is (the title is
 *  canonical; older hand-written heading variants are not
 *  reproduced).
 */
export const buildArticlePlan_ = (tracks, meta) => {
  const plan = [];
  const text = (t) => plan.push({ kind: 'text', text: t });
  const empty = () => plan.push({ kind: 'empty' });
  const link = (label, url) => plan.push({ kind: 'link', text: label, url });
  const blockLines = (block) => {
    block.split('\n').forEach((line) => {
      if (line.trim()) text(line.trim());
    });
  };

  text(`[[タグ：${cellText_(meta.tags)}]]`);
  empty();

  const profile = cellText_(meta.suno_profile);
  const introBlocks = splitBlocks_(meta.intro);
  introBlocks.forEach((block, i) => {
    blockLines(block);
    empty();
    if (profile && i === 1) {
      link(profile, profile);
      empty();
    }
  });
  if (profile && introBlocks.length < 2) {
    link(profile, profile);
    empty();
  }

  tracks.forEach((track) => text(`[[音楽|${track.title}|${track.file}]]`));
  text('[[目次]]');

  tracks.forEach((track) => {
    plan.push({ kind: 'heading', text: `${track.publishedAt} ${track.title}` });
    splitBlocks_(track.description).forEach((block) => {
      blockLines(block);
      empty();
    });
    if (track.instagram) link(INSTAGRAM_LINK_LABEL, track.instagram);
    if (track.suno) link(SUNO_LINK_LABEL, track.suno);
    if (track.youtube) link(YOUTUBE_LINK_LABEL, track.youtube);
    empty();
    empty();
    const lyrics = String(track.lyrics || '').replace(/\s+$/, '');
    if (lyrics) {
      text('[[歌詞]]');
      lyrics.split('\n').forEach((line) => {
        if (line.trim()) text(line);
        else empty();
      });
    }
  });

  const outroBlocks = splitBlocks_(meta.outro);
  outroBlocks.forEach((block, i) => {
    blockLines(block);
    if (i < outroBlocks.length - 1) empty();
  });

  return plan;
};

/**
 * Rewrites the document body from a paragraph plan. The body
 * is cleared first (clear() leaves one empty paragraph, which
 * the first plan item reuses), then every plan item becomes
 * one paragraph. This is the only place generateArticle()
 * writes anything.
 */
export const writeArticlePlan_ = (body, plan) => {
  body.clear();
  const existing = body.getParagraphs();
  const first = existing && existing.length ? existing[0] : null;
  plan.forEach((item, index) => {
    const paragraph = index === 0 && first ? first : body.appendParagraph('');
    if (item.kind === 'heading') {
      paragraph.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    }
    if (item.text) {
      const run = paragraph.appendText(item.text);
      if (item.kind === 'link' && item.url) run.setLinkUrl(item.url);
    }
  });
  return plan.length;
};

export const readMusicDb_ = (spreadsheet) => {
  const tracksSheet = spreadsheet.getSheetByName(TRACKS_SHEET_NAME);
  if (!tracksSheet) throw new Error(`music-db has no "${TRACKS_SHEET_NAME}" sheet`);
  const metaSheet = spreadsheet.getSheetByName(META_SHEET_NAME);
  if (!metaSheet) throw new Error(`music-db has no "${META_SHEET_NAME}" sheet`);
  return {
    tracks: parseTracksSheet_(tracksSheet.getDataRange().getValues()),
    meta: parseMetaSheet_(metaSheet.getDataRange().getValues()),
  };
};

/**
 * Regenerates the roundup article document from music-db
 * (run from the editor; no trigger needed). Only the document
 * named by the ARTICLE_DOC_ID script property is written.
 * Refuses to run with no published tracks, so a broken sheet
 * can never blank the article.
 */
export const generateArticle = () => {
  const dbId = getRequiredProperty_(MUSIC_DB_ID_PROPERTY_KEY);
  const docId = getRequiredProperty_(ARTICLE_DOC_ID_PROPERTY_KEY);
  const { tracks, meta } = readMusicDb_(SpreadsheetApp.openById(dbId));
  if (!tracks.length) throw new Error('no published tracks found in music-db');
  const plan = buildArticlePlan_(tracks, meta);
  const written = writeArticlePlan_(DocumentApp.openById(docId).getBody(), plan);
  console.log(`generateArticle: wrote ${written} paragraphs for ${tracks.length} tracks`);
  return written;
};

export const json_ = (obj) => ContentService
  .createTextOutput(JSON.stringify(obj))
  .setMimeType(ContentService.MimeType.JSON);
