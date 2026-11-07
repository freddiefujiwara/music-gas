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
 *  API:
 *    GET ?track=<file name>  -> { ok, track, mime, data(base64) }
 *    GET ?o=list             -> { ok, tracks: [file names] }
 *  Errors are JSON too: { ok: false, error }.
 *  ----------------------------- */
export const TRACKS_PROPERTY_KEY = 'TRACKS_JSON';

export const getTracks_ = () => {
  const raw = PropertiesService.getScriptProperties().getProperty(TRACKS_PROPERTY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) { /* fall through */ }
  return null;
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
    const blob = DriveApp.getFileById(fileId).getBlob();
    return json_({
      ok: true,
      track,
      mime: blob.getContentType() || 'audio/mpeg',
      data: Utilities.base64Encode(blob.getBytes()),
    });
  } catch (err) {
    return json_({ ok: false, error: `failed to read track: ${err.message}` });
  }
};

export const json_ = (obj) => ContentService
  .createTextOutput(JSON.stringify(obj))
  .setMimeType(ContentService.MimeType.JSON);
