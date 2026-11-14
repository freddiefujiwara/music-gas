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
 *    GET ?o=rss              -> podcast RSS feed built from music-db
 *    POST { action, ... }    -> the music-admin API (see the
 *      admin section below; owner/share-session authenticated)
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
export const MUSIC_FOLDER_NAME_PROPERTY_KEY = 'MUSIC_FOLDER_NAME';
export const MUSIC_PARENT_FOLDER_NAME = 'API';
export const TRACK_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*\.mp3$/;
export const TRACKS_CACHE_KEY = 'tracks-map-v1';
export const TRACKS_CACHE_TTL_SECONDS = 600;
export const CACHE_FOLDER_PROPERTY_KEY = 'MUSIC_CACHE_FOLDER_NAME';
export const DEFAULT_CACHE_FOLDER_NAME = 'music-cache';

/**
 * The name of the track folder inside "API". Defaults to
 * "music" and can be overridden with the MUSIC_FOLDER_NAME
 * script property, so the staging project can scan (and the
 * admin API can upload into) its own folder instead of the
 * production one it shares the parent folder with.
 */
export const getMusicFolderName_ = () => {
  const name = PropertiesService.getScriptProperties()
    .getProperty(MUSIC_FOLDER_NAME_PROPERTY_KEY);
  return (name && name.trim()) || MUSIC_FOLDER_NAME;
};

/**
 * Locates the archive folder: the unique folder named "music"
 * that sits inside a folder named "API". Returns null when
 * there is not exactly one such folder, so a renamed or
 * duplicated folder fails loudly instead of serving the
 * wrong files.
 */
export const getMusicFolder_ = () => {
  const matches = [];
  const folders = DriveApp.getFoldersByName(getMusicFolderName_());
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
  if (output === 'rss') return serveRss_();

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
 *  suno_profile, podcast_feed, intro, outro). generateArticle() rebuilds
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
export const PODCAST_LINK_LABEL = 'ポッドキャストでも聴けます';

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

/** Durations are whole, non-negative seconds; anything else is zero. */
export const cellDuration_ = (value) => {
  const n = typeof value === 'number' ? value : Number(cellText_(value));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Shared core of the two "tracks" sheet parsers. Every track
 * carries `row`, its data row number (the header row excluded,
 * counting from 1), so the admin API can address the row it
 * came from. Completely blank rows are skipped in both modes
 * (their row numbers are still consumed, so numbering never
 * shifts). Published mode keeps only published rows with a
 * file and orders them by the sort column; the admin mode
 * keeps every non-blank row in sheet order.
 */
export const parseTracksValues_ = (values, includeUnpublished) => {
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
  const tracks = [];
  values.slice(1).forEach((row, index) => {
    if (!row || row.every((cell) => cellText_(cell) === '')) return;
    const track = {
      row: index + 1,
      file: cellText_(col(row, 'file')),
      title: cellText_(col(row, 'title')),
      description: cellText_(col(row, 'description')),
      instagram: cellText_(col(row, 'instagram')),
      suno: cellText_(col(row, 'suno')),
      youtube: cellText_(col(row, 'youtube')),
      publishedAt: cellDate_(col(row, 'published_at')),
      durationSec: cellDuration_(col(row, 'duration_sec')),
      lyrics: cellText_(col(row, 'lyrics')),
      sort: cellSort_(col(row, 'sort')),
      published: cellBool_(col(row, 'published')),
    };
    if (includeUnpublished || (track.published && track.file)) {
      tracks.push(track);
    }
  });
  if (!includeUnpublished) tracks.sort((a, b) => a.sort - b.sort);
  return tracks;
};

/**
 * Parses the "tracks" sheet values (header row + data rows)
 * into track objects, keeping only published rows and
 * ordering them by the sort column, ascending.
 */
export const parseTracksSheet_ = (values) => parseTracksValues_(values, false);

/**
 * Parses the "tracks" sheet values for the admin API: every
 * non-blank row, published or not, in sheet order.
 */
export const parseTracksSheetAll_ = (values) => parseTracksValues_(values, true);

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

  const podcastFeed = cellText_(meta.podcast_feed);
  if (podcastFeed) {
    link(PODCAST_LINK_LABEL, podcastFeed);
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

/** -----------------------------
 *  Podcast RSS feed from the music-db spreadsheet.
 *
 *  The spreadsheet supplies the episode metadata and the
 *  existing Drive folder scan supplies each MP3's byte size.
 *  A row becomes an episode only when it is published in the
 *  sheet and the same file name is present in the scan. The
 *  Internet Archive URL is derived from the file name: the
 *  item identifier is "freddiefujiwara-<slug>".
 *
 *  Feed readers drop items without a <link>, so the Suno URL
 *  is mandatory here. If the spreadsheet cannot be read (or
 *  MUSIC_DB_ID is not configured), subscribers still receive
 *  a valid channel-only feed rather than an exception page.
 *  ----------------------------- */
export const RSS_CHANNEL_TITLE = '川口の歌';
export const RSS_CHANNEL_LINK = 'https://freddiefujiwara.com/blog/1V7cXplHKbsT48EhLarl-SPHfDV-lSEafEId2OMgExkg';
export const RSS_CHANNEL_DESCRIPTION = 'Sunoで作った川口の歌の配信フィード';
export const RSS_CHANNEL_LANGUAGE = 'ja';
export const RSS_ITUNES_AUTHOR = '藤原史和';
export const ARCHIVE_DOWNLOAD_BASE_URL = 'https://archive.org/download';
export const ARCHIVE_IDENTIFIER_PREFIX = 'freddiefujiwara-';
const RSS_WEEKDAYS_ = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RSS_MONTHS_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const escapeXml_ = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/**
 * Formats a yyyy-MM-dd date as midnight Asia/Tokyo in
 * RFC-822 form, e.g. "Sat, 07 Nov 2026 00:00:00 +0900".
 */
export const formatRssDate_ = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cellDate_(value));
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return '';
  return `${RSS_WEEKDAYS_[date.getUTCDay()]}, ${match[3]} `
    + `${RSS_MONTHS_[month - 1]} ${match[1]} 00:00:00 +0900`;
};

/** Formats a duration in seconds as M:SS. */
export const formatDuration_ = (value) => {
  const seconds = cellDuration_(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export const archiveUrl_ = (file) => {
  const name = cellText_(file);
  const slug = name.replace(/\.mp3$/i, '');
  const identifier = `${ARCHIVE_IDENTIFIER_PREFIX}${slug}`;
  return `${ARCHIVE_DOWNLOAD_BASE_URL}/${encodeURIComponent(identifier)}`
    + `/${encodeURIComponent(name)}`;
};

/**
 * Builds the complete RSS document. `fileSizes` maps file
 * names to the byte sizes found by the Drive folder scan;
 * tracks absent from that map are not published as episodes.
 */
export const buildRssFeed_ = (tracks, fileSizes = {}) => {
  const sizes = fileSizes && typeof fileSizes === 'object' ? fileSizes : {};
  const episodes = (Array.isArray(tracks) ? tracks : [])
    .filter((track) => track && track.published !== false && track.file && track.suno
      && Object.prototype.hasOwnProperty.call(sizes, track.file)
      && Number.isFinite(sizes[track.file]) && sizes[track.file] >= 0
      && formatRssDate_(track.publishedAt))
    .sort((a, b) => {
      const byDate = cellDate_(b.publishedAt).localeCompare(cellDate_(a.publishedAt));
      return byDate || cellSort_(a.sort) - cellSort_(b.sort);
    });

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
    '  <channel>',
    `    <title>${escapeXml_(RSS_CHANNEL_TITLE)}</title>`,
    `    <link>${escapeXml_(RSS_CHANNEL_LINK)}</link>`,
    `    <description>${escapeXml_(RSS_CHANNEL_DESCRIPTION)}</description>`,
    `    <language>${escapeXml_(RSS_CHANNEL_LANGUAGE)}</language>`,
    `    <itunes:author>${escapeXml_(RSS_ITUNES_AUTHOR)}</itunes:author>`,
  ];

  episodes.forEach((track) => {
    lines.push(
      '    <item>',
      `      <title>${escapeXml_(track.title)}</title>`,
      `      <link>${escapeXml_(track.suno)}</link>`,
      `      <guid isPermaLink="false">${escapeXml_(track.file)}</guid>`,
      `      <pubDate>${formatRssDate_(track.publishedAt)}</pubDate>`,
      `      <description>${escapeXml_(track.description)}</description>`,
      `      <enclosure url="${escapeXml_(archiveUrl_(track.file))}" `
        + `length="${sizes[track.file]}" type="audio/mpeg"/>`,
      `      <itunes:duration>${formatDuration_(track.durationSec)}</itunes:duration>`,
      '    </item>',
    );
  });

  lines.push('  </channel>', '</rss>');
  return lines.join('\n');
};

/**
 * Reads the published sheet rows and pairs them with the
 * Drive scan's file sizes. Every failure mode deliberately
 * degrades to a channel-only feed instead of throwing.
 */
export const serveRss_ = () => {
  let tracks = [];
  try {
    const dbId = PropertiesService.getScriptProperties()
      .getProperty(MUSIC_DB_ID_PROPERTY_KEY);
    if (dbId && String(dbId).trim()) {
      tracks = readMusicDb_(SpreadsheetApp.openById(String(dbId).trim())).tracks;
    }
  } catch (e) {
    tracks = [];
  }

  const fileSizes = {};
  if (tracks.length) {
    let scanned = null;
    try {
      scanned = getTracks_();
    } catch (e) { /* an unavailable scan means no episodes */ }
    if (scanned) {
      tracks.forEach((track) => {
        const fileId = scanned[track.file];
        if (!fileId) return;
        try {
          const size = DriveApp.getFileById(fileId).getSize();
          if (Number.isFinite(size) && size >= 0) fileSizes[track.file] = size;
        } catch (e) { /* skip tracks whose Drive file cannot be read */ }
      });
    }
  }

  return xml_(buildRssFeed_(tracks, fileSizes));
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

/** -----------------------------
 *  Admin API (doPost) for the music-admin site.
 *
 *  Ported from list-of-stuff-gas so every admin surface in
 *  this family authenticates the same way: the owner's Google
 *  ID token, verified against the AVAILABLE_GMAILS allowlist,
 *  is exchanged for a 30-day owner session; the owner can also
 *  issue a temporary share link whose token is owner-equivalent.
 *  Sessions are stored hashed in owner_sessions / share_sessions
 *  sheets inside the music-db spreadsheet itself (created on
 *  first use), so pointing a project at a different music-db
 *  copy separates its sessions too.
 *
 *  Actions:
 *    exchange_session / revoke_session / issue_share / revoke_share
 *    list_tracks / create_track / update_track / delete_track
 *    update_meta / upload_mp3 / publish_track / unpublish_track
 *    regenerate_article / check_archive
 *
 *  Every mutation runs under the script lock and drops the
 *  scanned track map cache, so the public player and RSS feed
 *  read the new state on their next request.
 *  ----------------------------- */
export const GOOGLE_OAUTH_CLIENT_ID_PROPERTY_KEY = 'GOOGLE_OAUTH_CLIENT_ID';
export const AVAILABLE_GMAILS_PROPERTY_KEY = 'AVAILABLE_GMAILS';
export const OWNER_SESSIONS_SHEET_NAME = 'owner_sessions';
export const SHARE_SESSIONS_SHEET_NAME = 'share_sessions';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_SHEET_HEADERS = [
  'token_hash', 'issued_at', 'expires_at', 'revoked_at',
  'access_count', 'last_accessed_at',
];

export const getScriptProperty_ = (key) => PropertiesService
  .getScriptProperties().getProperty(key);

export const allowedEmails_ = () => (getScriptProperty_(AVAILABLE_GMAILS_PROPERTY_KEY) || '')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter((v) => v.length > 0);

/** Throws an Error when the token is missing, invalid, or not allowed. */
export const verifyIdToken_ = (idToken) => {
  if (!idToken) throw new Error('missing id token');
  const clientId = getScriptProperty_(GOOGLE_OAUTH_CLIENT_ID_PROPERTY_KEY);
  const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  let res;
  try {
    res = UrlFetchApp.fetch(tokenInfoUrl, { muteHttpExceptions: true });
  } catch (err) {
    // A transport-level failure (DNS, connection) is transient;
    // retry once before giving up. HTTP-level failures arrive as
    // a response (muteHttpExceptions) and are not retried.
    res = UrlFetchApp.fetch(tokenInfoUrl, { muteHttpExceptions: true });
  }
  if (res.getResponseCode() !== 200) throw new Error('token verification failed');
  const payload = JSON.parse(res.getContentText());
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('invalid iss');
  }
  if (payload.aud !== clientId) throw new Error('invalid aud');
  const exp = Number(payload.exp || 0);
  if (!exp || exp * 1000 <= Date.now()) throw new Error('token expired');
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error('email not verified');
  }
  const email = String(payload.email || '').toLowerCase();
  if (!email) throw new Error('missing email');
  if (!allowedEmails_().includes(email)) throw new Error('forbidden email');
  return email;
};

export const openMusicDb_ = () => SpreadsheetApp
  .openById(getRequiredProperty_(MUSIC_DB_ID_PROPERTY_KEY));

/**
 * Returns one of the session sheets inside music-db, creating
 * it (with its header row) when it does not exist yet, so no
 * manual sheet setup is ever needed.
 */
export const getSessionSheet_ = (name) => {
  const ss = openMusicDb_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(SESSION_SHEET_HEADERS);
  }
  return sheet;
};

export const hashSessionToken_ = (token) => Utilities
  .computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token))
  .map((byte) => ((byte % 256) + 256) % 256)
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

export const sessionCellIso_ = (value) => {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

export const readSessionRows_ = (name) => {
  const sheet = getSessionSheet_(name);
  return { sheet, values: sheet.getDataRange().getValues() };
};

export const revokeActiveSessions_ = (name, nowIso) => {
  const { sheet, values } = readSessionRows_(name);
  values.forEach((row, index) => {
    if (index === 0) return;
    const revokedAt = sessionCellIso_(row[3]);
    const expiresAt = sessionCellIso_(row[2]);
    if (!revokedAt && expiresAt && expiresAt > nowIso) {
      sheet.getRange(index + 1, 4).setValue(nowIso);
    }
  });
};

export const issueSession_ = (name, tokenKey, { revokePrevious = true } = {}) => {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  if (revokePrevious) revokeActiveSessions_(name, nowIso);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  getSessionSheet_(name).appendRow([hashSessionToken_(token), nowIso, expiresIso, '', 0, '']);
  return {
    [tokenKey]: token,
    issued_at: nowIso,
    expires_at: expiresIso,
    ttl_seconds: SESSION_TTL_SECONDS,
  };
};

/** Owner sessions coexist across devices: issuing never revokes. */
export const issueOwnerSession_ = () => issueSession_(
  OWNER_SESSIONS_SHEET_NAME, 'session_token', { revokePrevious: false },
);

/** Share sessions are single-link: issuing revokes the old link. */
export const issueShareSession_ = () => issueSession_(
  SHARE_SESSIONS_SHEET_NAME, 'share_token',
);

export const revokeShareSession_ = () => {
  revokeActiveSessions_(SHARE_SESSIONS_SHEET_NAME, new Date().toISOString());
  return { revoked: true };
};

export const validateSessionToken_ = (name, token) => {
  if (!token) return null;
  const hash = hashSessionToken_(token);
  const { sheet, values } = readSessionRows_(name);
  const nowIso = new Date().toISOString();
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index];
    if (row[0] !== hash) continue;
    if (sessionCellIso_(row[3])) return null;
    const expiresAt = sessionCellIso_(row[2]);
    if (!expiresAt || expiresAt <= nowIso) return null;
    sheet.getRange(index + 1, 5).setValue(Number(row[4] || 0) + 1);
    sheet.getRange(index + 1, 6).setValue(nowIso);
    return { expires_at: expiresAt };
  }
  return null;
};

export const validateOwnerToken_ = (token) => validateSessionToken_(
  OWNER_SESSIONS_SHEET_NAME, token,
);

export const validateShareToken_ = (token) => validateSessionToken_(
  SHARE_SESSIONS_SHEET_NAME, token,
);

export const revokeOwnerSession_ = (token) => {
  if (token) {
    const hash = hashSessionToken_(token);
    const { sheet, values } = readSessionRows_(OWNER_SESSIONS_SHEET_NAME);
    const nowIso = new Date().toISOString();
    values.forEach((row, index) => {
      if (index > 0 && row[0] === hash && !sessionCellIso_(row[3])) {
        sheet.getRange(index + 1, 4).setValue(nowIso);
      }
    });
  }
  return { revoked: true };
};

/**
 * Owner proof for owner-only actions: a valid Google ID token,
 * or a live owner session token (the post-sign-in steady state).
 * A share token cannot mint more share tokens.
 */
export const requireOwnerAuth_ = (body) => {
  if (body.session_token && validateOwnerToken_(body.session_token)) return;
  verifyIdToken_(body.idToken);
};

/** Serializes admin mutations so row-addressed writes cannot race. */
export const withScriptLock_ = (fn) => {
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
};

/** Drops the scanned track map so public reads see fresh state. */
export const invalidateTracksCache_ = () => {
  try {
    const cache = CacheService.getScriptCache();
    if (cache) cache.remove(TRACKS_CACHE_KEY);
  } catch (e) { /* the map cache is best-effort */ }
};

/** -----------------------------
 *  Admin writes against the tracks / meta sheets.
 *
 *  Columns are resolved by header name, exactly like the
 *  readers, and a row is addressed by its data row number
 *  (header excluded, from 1). Callers may also pass the row's
 *  current `file` as a consistency check, so a stale screen
 *  cannot rewrite or delete the wrong row after the sheet
 *  changed underneath it.
 *  ----------------------------- */
export const TRACK_SHEET_COLUMNS = [
  'file', 'title', 'description', 'instagram', 'suno', 'youtube',
  'published_at', 'duration_sec', 'lyrics', 'sort', 'published',
];
export const META_KEYS = ['tags', 'suno_profile', 'podcast_feed', 'intro', 'outro'];

export const readTracksSheetAll_ = (spreadsheet) => {
  const sheet = spreadsheet.getSheetByName(TRACKS_SHEET_NAME);
  if (!sheet) throw new Error(`music-db has no "${TRACKS_SHEET_NAME}" sheet`);
  const values = sheet.getDataRange().getValues();
  return { sheet, values, tracks: parseTracksSheetAll_(values) };
};

export const resolveTrack_ = (tracks, row, file) => {
  const n = Number(row);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid row: ${row}`);
  const track = tracks.find((t) => t.row === n);
  if (!track) throw new Error(`track row not found: ${row}`);
  const expected = cellText_(file);
  if (expected && track.file !== expected) {
    throw new Error(`track file mismatch: row ${n} is ${track.file}, not ${expected}`);
  }
  return track;
};

/**
 * Coerces one track payload into sheet cells in the sheet's
 * own header order. Both the sheet's snake_case column names
 * and the parsed camelCase fields are accepted; published_at
 * is written as a yyyy-MM-dd string, published as a boolean,
 * sort and duration_sec as numbers.
 */
export const trackRowCells_ = (track, headers) => {
  const src = track || {};
  const sort = Number(src.sort);
  return headers.map((header) => {
    switch (header) {
      case 'published_at': return cellDate_(src.published_at ?? src.publishedAt);
      case 'duration_sec': return cellDuration_(src.duration_sec ?? src.durationSec);
      case 'sort': return Number.isFinite(sort) ? sort : '';
      case 'published': return cellBool_(src.published);
      default: return cellText_(src[header]);
    }
  });
};

export const createTrack_ = (spreadsheet, track) => {
  const { sheet, values, tracks } = readTracksSheetAll_(spreadsheet);
  const file = cellText_(track && track.file);
  if (!TRACK_NAME_PATTERN.test(file)) {
    throw new Error(`invalid track file name: ${file}`);
  }
  if (tracks.some((t) => t.file === file)) {
    throw new Error(`track already exists: ${file}`);
  }
  const headers = values[0].map((h) => cellText_(h));
  sheet.appendRow(trackRowCells_({ ...track, file }, headers));
  return { row: values.length };
};

export const updateTrack_ = (spreadsheet, row, track, expectedFile) => {
  const { sheet, values, tracks } = readTracksSheetAll_(spreadsheet);
  const current = resolveTrack_(tracks, row, expectedFile);
  if (track && track.file !== undefined && cellText_(track.file) !== current.file) {
    throw new Error('file cannot be changed');
  }
  const headers = values[0].map((h) => cellText_(h));
  const merged = { ...current, ...(track || {}), file: current.file };
  sheet.getRange(current.row + 1, 1, 1, headers.length)
    .setValues([trackRowCells_(merged, headers)]);
  return { row: current.row };
};

/** Deletes the sheet row only; the Drive MP3 and IA item stay. */
export const deleteTrack_ = (spreadsheet, row, file) => {
  const { sheet, tracks } = readTracksSheetAll_(spreadsheet);
  const track = resolveTrack_(tracks, row, file);
  sheet.deleteRow(track.row + 1);
  return { row: track.row, file: track.file };
};

export const setTrackPublished_ = (spreadsheet, row, published) => {
  const { sheet, values, tracks } = readTracksSheetAll_(spreadsheet);
  const track = resolveTrack_(tracks, row);
  const headers = values[0].map((h) => cellText_(h));
  const colIndex = headers.indexOf('published');
  if (colIndex < 0) {
    throw new Error('tracks sheet is missing the "published" column');
  }
  sheet.getRange(track.row + 1, colIndex + 1).setValue(published === true);
  return track;
};

/** Writes the given meta keys, appending rows for new keys. */
export const updateMeta_ = (spreadsheet, meta) => {
  const sheet = spreadsheet.getSheetByName(META_SHEET_NAME);
  if (!sheet) throw new Error(`music-db has no "${META_SHEET_NAME}" sheet`);
  const values = sheet.getDataRange().getValues();
  const updated = [];
  META_KEYS.forEach((key) => {
    if (!meta || !(key in meta)) return;
    const idx = values.findIndex((r, i) => i > 0 && cellText_(r[0]) === key);
    if (idx >= 0) sheet.getRange(idx + 1, 2).setValue(cellText_(meta[key]));
    else sheet.appendRow([key, cellText_(meta[key])]);
    updated.push(key);
  });
  return { updated };
};

/** -----------------------------
 *  MP3 upload into the track folder.
 *
 *  The browser sends the file as base64 in the JSON body and
 *  measures the duration itself (Apps Script cannot parse
 *  MP3s), so this action only validates and stores the bytes.
 *  An existing file of the same name is replaced: the new file
 *  is created first, then the old one is trashed, so the
 *  folder never holds zero or two live copies under the name
 *  the folder scan keys on. Uploading alone never publishes:
 *  without a published sheet row the track stays invisible.
 *  ----------------------------- */
export const MAX_MP3_BYTES = 10 * 1024 * 1024;

export const uploadMp3_ = (fileName, dataBase64) => {
  const name = cellText_(fileName);
  if (!TRACK_NAME_PATTERN.test(name)) {
    throw new Error(`invalid file name: ${fileName}`);
  }
  if (!dataBase64 || typeof dataBase64 !== 'string') {
    throw new Error('missing mp3 data');
  }
  let bytes;
  try {
    bytes = Utilities.base64Decode(dataBase64);
  } catch (e) {
    throw new Error('invalid base64 data');
  }
  if (!bytes.length) throw new Error('empty mp3 data');
  if (bytes.length > MAX_MP3_BYTES) {
    throw new Error(`mp3 is too large: ${bytes.length} bytes (limit ${MAX_MP3_BYTES})`);
  }
  const folder = getMusicFolder_();
  if (!folder) throw new Error('music folder is not configured');
  const existing = folder.getFilesByName(name);
  const olds = [];
  while (existing.hasNext()) olds.push(existing.next());
  folder.createFile(Utilities.newBlob(bytes, 'audio/mpeg', name));
  olds.forEach((file) => file.setTrashed(true));
  return { file_name: name, size: bytes.length, replaced: olds.length > 0 };
};

/** -----------------------------
 *  Internet Archive upload (the ias3 S3-like API).
 *
 *  IA accepts a simplified auth header, Authorization:
 *  LOW <access key>:<secret key>, instead of an AWS signature,
 *  which is what makes this possible from UrlFetchApp. With
 *  x-amz-auto-make-bucket one PUT creates the item and stores
 *  the file; the item identifier follows the existing rule
 *  "freddiefujiwara-<slug>". The key pair lives only in the
 *  IA_ACCESS_KEY / IA_SECRET_KEY script properties. When they
 *  are not configured the publish flow skips this step and
 *  says so, instead of failing the whole publish.
 *  ----------------------------- */
export const IA_ACCESS_KEY_PROPERTY_KEY = 'IA_ACCESS_KEY';
export const IA_SECRET_KEY_PROPERTY_KEY = 'IA_SECRET_KEY';
export const ARCHIVE_S3_BASE_URL = 'https://s3.us.archive.org';
export const ARCHIVE_METADATA_BASE_URL = 'https://archive.org/metadata';
export const ARCHIVE_COLLECTION = 'opensource_audio';

export const archiveIdentifier_ = (file) => `${ARCHIVE_IDENTIFIER_PREFIX}${
  cellText_(file).replace(/\.mp3$/i, '')}`;

export const archiveKeys_ = () => {
  const access = getScriptProperty_(IA_ACCESS_KEY_PROPERTY_KEY);
  const secret = getScriptProperty_(IA_SECRET_KEY_PROPERTY_KEY);
  if (!access || !String(access).trim() || !secret || !String(secret).trim()) {
    return null;
  }
  return { access: String(access).trim(), secret: String(secret).trim() };
};

/** The x-archive-meta-* headers for one track's item. */
export const archiveMetaHeaders_ = (track) => {
  const title = (track && track.title) || '';
  return {
    'x-archive-meta-mediatype': 'audio',
    'x-archive-meta-collection': ARCHIVE_COLLECTION,
    'x-archive-meta-title': encodeURIComponent(title),
    'x-archive-meta-creator': encodeURIComponent(RSS_ITUNES_AUTHOR),
    'x-archive-meta-description': encodeURIComponent(
      `Sunoで作った川口の歌「${title}」です。`,
    ),
    'x-archive-meta-subject': encodeURIComponent('川口;Suno;music'),
  };
};

/**
 * Checks the public metadata API for the track's file inside
 * its IA item. Never throws: any failure reads as "not there",
 * which is all the admin list's badge needs.
 */
export const checkArchive_ = (file) => {
  const name = cellText_(file);
  try {
    const res = UrlFetchApp.fetch(
      `${ARCHIVE_METADATA_BASE_URL}/${encodeURIComponent(archiveIdentifier_(name))}`,
      { muteHttpExceptions: true },
    );
    if (res.getResponseCode() !== 200) return { exists: false };
    const files = (JSON.parse(res.getContentText()) || {}).files || [];
    const hit = files.find((f) => f && f.name === name);
    return hit ? { exists: true, size: Number(hit.size) || 0 } : { exists: false };
  } catch (e) {
    return { exists: false };
  }
};

/**
 * PUTs the Drive file's bytes into its IA item. Returns a
 * step result instead of throwing: 'ok' when the file is
 * already visible in the metadata, 'accepted' when IA took
 * the PUT but has not published the file yet (its ingest is
 * asynchronous), 'skipped_not_configured' without keys.
 */
export const uploadToArchive_ = (track, driveFile) => {
  const keys = archiveKeys_();
  if (!keys) return { status: 'skipped_not_configured' };
  const identifier = archiveIdentifier_(track.file);
  const bytes = driveFile.getBlob().getBytes();
  let res;
  try {
    res = UrlFetchApp.fetch(
      `${ARCHIVE_S3_BASE_URL}/${encodeURIComponent(identifier)}/${encodeURIComponent(track.file)}`,
      {
        method: 'put',
        contentType: 'audio/mpeg',
        payload: bytes,
        headers: {
          Authorization: `LOW ${keys.access}:${keys.secret}`,
          'x-amz-auto-make-bucket': '1',
          'x-archive-size-hint': String(bytes.length),
          ...archiveMetaHeaders_(track),
        },
        muteHttpExceptions: true,
      },
    );
  } catch (e) {
    return { status: 'error', error: `archive upload failed: ${e.message}` };
  }
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    return { status: 'error', error: `archive upload failed: HTTP ${code}` };
  }
  return { status: checkArchive_(track.file).exists ? 'ok' : 'accepted' };
};

/** -----------------------------
 *  Publish / unpublish.
 *
 *  Publishing is three idempotent steps run in order — flip
 *  the sheet row to published, upload the MP3 to Internet
 *  Archive, regenerate the article — and the result reports
 *  each step separately. Nothing is rolled back: every step
 *  can simply be re-run, which the admin's retry does. The
 *  pre-checks run before anything changes: the sheet is the
 *  source of truth for the article and the RSS feed, and the
 *  feed drops items without a <link>, so file / title / suno
 *  and the Drive MP3 itself are all mandatory.
 *  ----------------------------- */
export const publishTrack_ = (spreadsheet, row, file) => {
  const { tracks } = readTracksSheetAll_(spreadsheet);
  const track = resolveTrack_(tracks, row, file);
  const missing = [];
  if (!track.file) missing.push('file');
  if (!track.title) missing.push('title');
  if (!track.suno) missing.push('suno');
  if (missing.length) {
    throw new Error(`cannot publish: missing ${missing.join(', ')}`);
  }
  const scanned = getTracks_();
  if (!scanned || !scanned[track.file]) {
    throw new Error(`mp3 not found in the music folder: ${track.file}`);
  }
  const steps = {};
  setTrackPublished_(spreadsheet, track.row, true);
  steps.sheet = 'ok';
  const archive = uploadToArchive_(track, DriveApp.getFileById(scanned[track.file]));
  steps.archive = archive.status === 'error'
    ? `error: ${archive.error}` : archive.status;
  try {
    generateArticle();
    steps.article = 'ok';
  } catch (e) {
    steps.article = `error: ${e.message}`;
  }
  invalidateTracksCache_();
  return { file: track.file, steps };
};

export const unpublishTrack_ = (spreadsheet, row, file) => {
  const { tracks } = readTracksSheetAll_(spreadsheet);
  const track = resolveTrack_(tracks, row, file);
  const steps = {};
  setTrackPublished_(spreadsheet, track.row, false);
  steps.sheet = 'ok';
  // The IA item is deliberately left in place (it cannot be
  // removed reliably); only the sheet flag and the article move.
  try {
    generateArticle();
    steps.article = 'ok';
  } catch (e) {
    steps.article = `error: ${e.message}`;
  }
  invalidateTracksCache_();
  return { file: track.file, steps };
};

export const authError_ = (err) => {
  const message = (err && err.message) || 'unauthorized';
  return json_({
    ok: false,
    status: message === 'forbidden email' ? 403 : 401,
    error: message,
  });
};

export const doPost = (e) => {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return json_({ ok: false, error: 'invalid JSON body' });
  }

  // Exchanging a Google ID token for a 30-day owner session is
  // how a sign-in starts; revoking the session is how it ends.
  if (body.action === 'exchange_session') {
    try {
      verifyIdToken_(body.idToken);
    } catch (err) {
      return authError_(err);
    }
    try {
      return json_(withScriptLock_(() => ({ ok: true, ...issueOwnerSession_() })));
    } catch (err) {
      return json_({ ok: false, error: err.message });
    }
  }
  if (body.action === 'revoke_session') {
    try {
      return json_(withScriptLock_(() => ({
        ok: true, ...revokeOwnerSession_(body.session_token),
      })));
    } catch (err) {
      return json_({ ok: false, error: err.message });
    }
  }

  // Issuing and revoking access links requires owner proof
  // (the Google ID token, or the owner session from it); a
  // share token cannot mint more credentials.
  if (body.action === 'issue_share' || body.action === 'revoke_share') {
    try {
      requireOwnerAuth_(body);
    } catch (err) {
      return authError_(err);
    }
    try {
      const result = withScriptLock_(() => {
        if (body.action === 'issue_share') return issueShareSession_();
        return revokeShareSession_();
      });
      return json_({ ok: true, ...result });
    } catch (err) {
      return json_({ ok: false, error: err.message });
    }
  }

  // The remaining actions accept the owner's ID token, the
  // owner session exchanged from it, or a share token from an
  // issued access link (owner-equivalent).
  let shareSession = null;
  if (body.session_token) {
    let ownerSession = null;
    try {
      ownerSession = validateOwnerToken_(body.session_token);
    } catch (err) {
      return json_({ ok: false, error: err.message });
    }
    if (!ownerSession) {
      return json_({ ok: false, status: 401, error: 'session expired or invalid' });
    }
  } else if (body.share_token) {
    try {
      shareSession = validateShareToken_(body.share_token);
    } catch (err) {
      return json_({ ok: false, error: err.message });
    }
    if (!shareSession) {
      return json_({ ok: false, status: 401, error: 'share session expired or invalid' });
    }
  } else {
    try {
      verifyIdToken_(body.idToken);
    } catch (err) {
      return authError_(err);
    }
  }
  const out = (payload) => (shareSession
    ? { ...payload, _share: { expires_at: shareSession.expires_at } }
    : payload);

  try {
    if (body.action === 'list_tracks') {
      const spreadsheet = openMusicDb_();
      const { tracks } = readTracksSheetAll_(spreadsheet);
      const metaSheet = spreadsheet.getSheetByName(META_SHEET_NAME);
      const meta = metaSheet
        ? parseMetaSheet_(metaSheet.getDataRange().getValues())
        : {};
      return json_(out({ ok: true, tracks, meta }));
    }
    if (body.action === 'check_archive') {
      const file = cellText_(body.file);
      return json_(out({ ok: true, file, ...checkArchive_(file) }));
    }
    if (body.action === 'create_track') {
      const result = withScriptLock_(() => {
        const created = createTrack_(openMusicDb_(), body.track);
        invalidateTracksCache_();
        return created;
      });
      return json_(out({ ok: true, ...result }));
    }
    if (body.action === 'update_track') {
      const result = withScriptLock_(() => {
        const updated = updateTrack_(openMusicDb_(), body.row, body.track, body.file);
        invalidateTracksCache_();
        return updated;
      });
      return json_(out({ ok: true, ...result }));
    }
    if (body.action === 'delete_track') {
      const result = withScriptLock_(() => {
        const deleted = deleteTrack_(openMusicDb_(), body.row, body.file);
        invalidateTracksCache_();
        return deleted;
      });
      return json_(out({ ok: true, ...result }));
    }
    if (body.action === 'update_meta') {
      const result = withScriptLock_(() => updateMeta_(openMusicDb_(), body.meta));
      return json_(out({ ok: true, ...result }));
    }
    if (body.action === 'upload_mp3') {
      const result = withScriptLock_(() => {
        const uploaded = uploadMp3_(body.file_name, body.data_base64);
        invalidateTracksCache_();
        return uploaded;
      });
      return json_(out({ ok: true, ...result }));
    }
    if (body.action === 'publish_track') {
      const result = withScriptLock_(() => publishTrack_(
        openMusicDb_(), body.row, body.file,
      ));
      return json_(out({ ok: true, ...result }));
    }
    if (body.action === 'unpublish_track') {
      const result = withScriptLock_(() => unpublishTrack_(
        openMusicDb_(), body.row, body.file,
      ));
      return json_(out({ ok: true, ...result }));
    }
    if (body.action === 'regenerate_article') {
      const paragraphs = withScriptLock_(() => generateArticle());
      return json_(out({ ok: true, paragraphs }));
    }
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
  return json_({ ok: false, error: 'unknown action' });
};

export const json_ = (obj) => ContentService
  .createTextOutput(JSON.stringify(obj))
  .setMimeType(ContentService.MimeType.JSON);

export const xml_ = (text) => ContentService
  .createTextOutput(text)
  .setMimeType(ContentService.MimeType.XML);
