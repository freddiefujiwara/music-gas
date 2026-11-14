import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as Code from '../src/Code.js';

const TRACK_HEADER = ['file', 'title', 'description', 'instagram', 'suno', 'youtube',
  'published_at', 'duration_sec', 'lyrics', 'sort', 'published'];
const SESSION_HEADER = ['token_hash', 'issued_at', 'expires_at', 'revoked_at',
  'access_count', 'last_accessed_at'];

const iterOf = (items) => {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
};

/** In-memory sheet: rows are plain arrays, writes mutate them. */
const makeSheet = (rows) => {
  const state = { rows: rows.map((r) => [...r]) };
  const sheet = {
    state,
    getRange: vi.fn((r, c, nr = 1, nc = 1) => ({
      setValue: vi.fn((v) => { state.rows[r - 1][c - 1] = v; }),
      setValues: vi.fn((vv) => {
        vv.forEach((rowVals, i) => rowVals.forEach((v, j) => {
          if (!state.rows[r - 1 + i]) state.rows[r - 1 + i] = [];
          state.rows[r - 1 + i][c - 1 + j] = v;
        }));
      }),
      getValues: vi.fn(() => state.rows
        .slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc))),
    })),
    getDataRange: vi.fn(() => ({
      getValues: () => state.rows.map((r) => [...r]),
    })),
    getLastRow: vi.fn(() => state.rows.length),
    appendRow: vi.fn((row) => { state.rows.push([...row]); }),
    deleteRow: vi.fn((n) => { state.rows.splice(n - 1, 1); }),
  };
  return sheet;
};

const trackRow = (overrides = {}) => {
  const base = {
    file: 'a.mp3', title: '曲A', description: '説明A', instagram: 'https://ig/a',
    suno: 'https://suno/a', youtube: '', published_at: '2026-11-13',
    duration_sec: 100, lyrics: '歌詞A', sort: 1, published: true,
  };
  const merged = { ...base, ...overrides };
  return TRACK_HEADER.map((h) => merged[h]);
};

let props;
let sheets;
let spreadsheet;
let driveFiles;
let musicFolderFiles;
let tokenPayload;
let tokenHttpCode;
let fetchHandler;
let uuidCounter;
let scriptCacheStore;

const validPayload = () => ({
  iss: 'https://accounts.google.com',
  aud: 'client-123',
  exp: Math.floor(Date.now() / 1000) + 3600,
  email_verified: 'true',
  email: 'owner@example.com',
});

const post = (body) => Code.doPost({
  postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) },
});
const parse = (output) => JSON.parse(output.content);

const makeDriveFile = (name, bytes = [1, 2, 3]) => {
  const file = {
    name,
    trashed: false,
    getName: () => name,
    getId: () => `id-${name}`,
    getBlob: () => ({
      getBytes: () => bytes,
      getContentType: () => 'audio/mpeg',
      getDataAsString: () => '',
    }),
    getLastUpdated: () => new Date(1700000000000),
    getSize: () => bytes.length,
    getParents: () => iterOf([musicFolder]),
    setTrashed: vi.fn((v) => { file.trashed = v; }),
  };
  return file;
};

let musicFolder;
const buildDrive = () => {
  driveFiles = new Map();
  musicFolderFiles = [makeDriveFile('a.mp3'), makeDriveFile('b.mp3')];
  musicFolderFiles.forEach((f) => driveFiles.set(f.getId(), f));
  musicFolder = {
    getName: () => props.MUSIC_FOLDER_NAME || 'music',
    getParents: () => iterOf([{ getName: () => 'API' }]),
    getFiles: vi.fn(() => iterOf(musicFolderFiles.filter((f) => !f.trashed))),
    getFilesByName: vi.fn((name) => iterOf(
      musicFolderFiles.filter((f) => f.getName() === name && !f.trashed),
    )),
    getFoldersByName: vi.fn(() => iterOf([])),
    createFolder: vi.fn(() => { throw new Error('no cache folder in admin tests'); }),
    createFile: vi.fn((blob) => {
      const file = makeDriveFile(blob.getName(), blob.getBytes());
      musicFolderFiles.push(file);
      driveFiles.set(file.getId(), file);
      return file;
    }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  props = {
    MUSIC_DB_ID: 'db-id',
    ARTICLE_DOC_ID: 'doc-id',
    AVAILABLE_GMAILS: 'owner@example.com, second@example.com',
    GOOGLE_OAUTH_CLIENT_ID: 'client-123',
    MUSIC_CACHE_FOLDER_NAME: 'music-cache-test',
  };
  sheets = {
    tracks: makeSheet([
      TRACK_HEADER,
      trackRow(),
      trackRow({ file: 'b.mp3', title: '曲B', suno: 'https://suno/b', sort: 2, published: false }),
      trackRow({ file: 'c.mp3', title: '曲C', suno: '', sort: 3, published: false }),
    ]),
    meta: makeSheet([
      ['key', 'value'],
      ['tags', '音楽、川口'],
      ['suno_profile', 'https://suno.com/@freddiefujiwara'],
      ['intro', '導入文。'],
      ['outro', '締め。'],
    ]),
  };
  spreadsheet = {
    getSheetByName: vi.fn((name) => sheets[name] || null),
    insertSheet: vi.fn((name) => {
      // A freshly inserted sheet is empty; getSessionSheet_
      // appends the header row itself.
      sheets[name] = makeSheet([]);
      return sheets[name];
    }),
  };
  buildDrive();
  tokenPayload = validPayload();
  tokenHttpCode = 200;
  uuidCounter = 0;
  scriptCacheStore = new Map();
  fetchHandler = (url) => {
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return {
        getResponseCode: () => tokenHttpCode,
        getContentText: () => JSON.stringify(tokenPayload),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  global.PropertiesService = {
    getScriptProperties: vi.fn(() => ({
      getProperty: vi.fn((key) => (key in props ? props[key] : null)),
    })),
  };
  global.SpreadsheetApp = { openById: vi.fn(() => spreadsheet) };
  global.DocumentApp = {
    openById: vi.fn(() => { throw new Error('no doc in admin tests'); }),
    ParagraphHeading: { HEADING2: 'HEADING2' },
  };
  global.DriveApp = {
    getFileById: vi.fn((id) => {
      if (!driveFiles.has(id)) throw new Error(`unknown id ${id}`);
      return driveFiles.get(id);
    }),
    getFoldersByName: vi.fn(() => iterOf([musicFolder])),
  };
  global.UrlFetchApp = { fetch: vi.fn((url, opts) => fetchHandler(url, opts)) };
  global.Utilities = {
    base64Encode: vi.fn((bytes) => Buffer.from(bytes).toString('base64')),
    base64Decode: vi.fn((text) => {
      if (/[^A-Za-z0-9+/=]/.test(text)) throw new Error('bad base64');
      return [...Buffer.from(text, 'base64')];
    }),
    formatDate: vi.fn((date) => date.toISOString().slice(0, 10)),
    computeDigest: vi.fn((algo, input) => [...createHash('sha256').update(String(input)).digest()]),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    getUuid: vi.fn(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`),
    newBlob: vi.fn((bytes, type, name) => ({
      getBytes: () => bytes,
      getContentType: () => type,
      getName: () => name,
    })),
  };
  global.CacheService = {
    getScriptCache: vi.fn(() => ({
      get: (key) => (scriptCacheStore.has(key) ? scriptCacheStore.get(key) : null),
      put: (key, value) => { scriptCacheStore.set(key, value); },
      remove: (key) => { scriptCacheStore.delete(key); },
    })),
  };
  global.LockService = {
    getScriptLock: vi.fn(() => ({ waitLock: vi.fn(), releaseLock: vi.fn() })),
  };
  global.ContentService = {
    MimeType: { JSON: 'application/json', XML: 'text/xml' },
    createTextOutput: vi.fn((content) => ({
      content,
      mimeType: null,
      setMimeType(m) { this.mimeType = m; return this; },
    })),
  };
  global.MimeType = { PLAIN_TEXT: 'text/plain' };
});

/** Signs in through the real exchange flow and returns the session token. */
const signIn = () => {
  const res = parse(post({ action: 'exchange_session', idToken: 'good-token' }));
  expect(res.ok).toBe(true);
  return res.session_token;
};

describe('doPost body parsing and auth', () => {
  it('rejects an invalid JSON body', () => {
    expect(parse(post('{not json'))).toEqual({ ok: false, error: 'invalid JSON body' });
  });

  it('rejects a missing ID token', () => {
    expect(parse(post({ action: 'list_tracks' })))
      .toMatchObject({ ok: false, status: 401, error: 'missing id token' });
  });

  it('rejects a token the verifier endpoint refuses', () => {
    tokenHttpCode = 400;
    expect(parse(post({ action: 'list_tracks', idToken: 'bad' })))
      .toMatchObject({ ok: false, status: 401, error: 'token verification failed' });
  });

  it('rejects tokens with wrong iss / aud / expiry / verification', () => {
    tokenPayload = { ...validPayload(), iss: 'https://evil.example' };
    expect(parse(post({ action: 'list_tracks', idToken: 'x' })))
      .toMatchObject({ ok: false, error: 'invalid iss' });
    tokenPayload = { ...validPayload(), aud: 'someone-else' };
    expect(parse(post({ action: 'list_tracks', idToken: 'x' })))
      .toMatchObject({ ok: false, error: 'invalid aud' });
    tokenPayload = { ...validPayload(), exp: Math.floor(Date.now() / 1000) - 10 };
    expect(parse(post({ action: 'list_tracks', idToken: 'x' })))
      .toMatchObject({ ok: false, error: 'token expired' });
    tokenPayload = { ...validPayload(), email_verified: false };
    expect(parse(post({ action: 'list_tracks', idToken: 'x' })))
      .toMatchObject({ ok: false, error: 'email not verified' });
  });

  it('rejects a valid token for a non-allowlisted email with 403', () => {
    tokenPayload = { ...validPayload(), email: 'stranger@example.com' };
    expect(parse(post({ action: 'list_tracks', idToken: 'x' })))
      .toMatchObject({ ok: false, status: 403, error: 'forbidden email' });
  });

  it('retries the tokeninfo fetch once on a transport failure', () => {
    let calls = 0;
    const base = fetchHandler;
    fetchHandler = (url, opts) => {
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        calls += 1;
        if (calls === 1) throw new Error('dns blew up');
      }
      return base(url, opts);
    };
    expect(parse(post({ action: 'list_tracks', idToken: 'x' })).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('rejects an unknown action after auth', () => {
    const token = signIn();
    expect(parse(post({ action: 'dance', session_token: token })))
      .toEqual({ ok: false, error: 'unknown action' });
  });

  it('rejects a bogus session token with the session error', () => {
    expect(parse(post({ action: 'list_tracks', session_token: 'nope' })))
      .toEqual({ ok: false, status: 401, error: 'session expired or invalid' });
  });
});

describe('owner sessions', () => {
  it('exchange_session issues a 30-day session stored hashed in music-db', () => {
    const res = parse(post({ action: 'exchange_session', idToken: 'good' }));
    expect(res.ok).toBe(true);
    expect(res.session_token).toHaveLength(64);
    expect(res.ttl_seconds).toBe(30 * 24 * 60 * 60);
    const rows = sheets.owner_sessions.state.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(SESSION_HEADER);
    expect(rows[1][0]).not.toBe(res.session_token);
    expect(rows[1][0]).toBe(Code.hashSessionToken_(res.session_token));
    // The session sheet was created on first use, inside music-db.
    expect(global.SpreadsheetApp.openById).toHaveBeenCalledWith('db-id');
    expect(spreadsheet.insertSheet).toHaveBeenCalledWith('owner_sessions');
  });

  it('a second sign-in does not revoke the first session', () => {
    const first = signIn();
    const second = signIn();
    expect(first).not.toBe(second);
    expect(parse(post({ action: 'list_tracks', session_token: first })).ok).toBe(true);
    expect(parse(post({ action: 'list_tracks', session_token: second })).ok).toBe(true);
  });

  it('revoke_session kills only that session', () => {
    const first = signIn();
    const second = signIn();
    expect(parse(post({ action: 'revoke_session', session_token: first })))
      .toEqual({ ok: true, revoked: true });
    expect(parse(post({ action: 'list_tracks', session_token: first })).ok).toBe(false);
    expect(parse(post({ action: 'list_tracks', session_token: second })).ok).toBe(true);
  });

  it('an expired session is rejected', () => {
    const token = signIn();
    const rows = sheets.owner_sessions.state.rows;
    rows[1][2] = new Date(Date.now() - 1000).toISOString();
    expect(parse(post({ action: 'list_tracks', session_token: token })))
      .toMatchObject({ ok: false, status: 401 });
  });
});

describe('share sessions', () => {
  it('issue_share requires owner proof and revokes the previous link', () => {
    const owner = signIn();
    const first = parse(post({ action: 'issue_share', session_token: owner }));
    expect(first.ok).toBe(true);
    expect(first.share_token).toHaveLength(64);
    const second = parse(post({ action: 'issue_share', session_token: owner }));
    expect(second.share_token).not.toBe(first.share_token);
    expect(parse(post({ action: 'list_tracks', share_token: first.share_token })))
      .toMatchObject({ ok: false, status: 401, error: 'share session expired or invalid' });
    const viaShare = parse(post({ action: 'list_tracks', share_token: second.share_token }));
    expect(viaShare.ok).toBe(true);
    expect(viaShare._share.expires_at).toBe(second.expires_at);
  });

  it('a share token cannot issue or revoke share links', () => {
    const owner = signIn();
    const share = parse(post({ action: 'issue_share', session_token: owner }));
    expect(parse(post({ action: 'issue_share', share_token: share.share_token })))
      .toMatchObject({ ok: false, status: 401 });
    expect(parse(post({ action: 'revoke_share', share_token: share.share_token })))
      .toMatchObject({ ok: false, status: 401 });
  });

  it('revoke_share kills the active link', () => {
    const owner = signIn();
    const share = parse(post({ action: 'issue_share', session_token: owner }));
    expect(parse(post({ action: 'revoke_share', session_token: owner })))
      .toEqual({ ok: true, revoked: true });
    expect(parse(post({ action: 'list_tracks', share_token: share.share_token })).ok)
      .toBe(false);
  });
});

describe('Muse API keys', () => {
  const issueKey = (owner) => parse(post({
    action: 'issue_claude_key', session_token: owner,
  }));

  it('issue_claude_key requires owner proof', () => {
    expect(parse(post({ action: 'issue_claude_key' })))
      .toMatchObject({ ok: false, status: 401 });
    const owner = signIn();
    const share = parse(post({ action: 'issue_share', session_token: owner }));
    expect(parse(post({ action: 'issue_claude_key', share_token: share.share_token })))
      .toMatchObject({ ok: false, status: 401 });
  });

  it('issues a 30-day key stored hashed in music-db, returned once in plaintext', () => {
    const owner = signIn();
    const res = issueKey(owner);
    expect(res.ok).toBe(true);
    expect(res.claude_key).toMatch(/^mk_[0-9a-f]{64}$/);
    expect(res.ttl_seconds).toBe(30 * 24 * 60 * 60);
    const rows = sheets.claude_keys.state.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(SESSION_HEADER);
    expect(rows[1][0]).not.toBe(res.claude_key);
    expect(rows[1][0]).toBe(Code.hashSessionToken_(res.claude_key));
    expect(rows[1][2]).toBe(res.expires_at);
    expect(spreadsheet.insertSheet).toHaveBeenCalledWith('claude_keys');
  });

  it('a live key authenticates data actions as owner-equivalent', () => {
    const owner = signIn();
    const { claude_key: key } = issueKey(owner);
    const list = parse(post({ action: 'list_tracks', claude_key: key }));
    expect(list.ok).toBe(true);
    expect(list.tracks.map((t) => t.file)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    expect(list._share).toBeUndefined();
    const created = parse(post({
      action: 'create_track',
      claude_key: key,
      track: { file: 'd.mp3', title: '曲D', suno: 'https://suno/d' },
    }));
    expect(created.ok).toBe(true);
    // Use bumps the access count and last-accessed timestamp.
    const rows = sheets.claude_keys.state.rows;
    expect(rows[1][4]).toBe(2);
    expect(rows[1][5]).not.toBe('');
  });

  it('issuing a new key revokes the previous one', () => {
    const owner = signIn();
    const first = issueKey(owner);
    const second = issueKey(owner);
    expect(second.claude_key).not.toBe(first.claude_key);
    expect(parse(post({ action: 'list_tracks', claude_key: first.claude_key })))
      .toEqual({ ok: false, status: 401, error: 'claude key expired or invalid' });
    expect(parse(post({ action: 'list_tracks', claude_key: second.claude_key })).ok)
      .toBe(true);
  });

  it('an expired key is rejected', () => {
    const owner = signIn();
    const { claude_key: key } = issueKey(owner);
    const rows = sheets.claude_keys.state.rows;
    rows[1][2] = new Date(Date.now() - 1000).toISOString();
    expect(parse(post({ action: 'list_tracks', claude_key: key })))
      .toMatchObject({ ok: false, status: 401, error: 'claude key expired or invalid' });
  });

  it('revoke_claude_key kills the live key', () => {
    const owner = signIn();
    const { claude_key: key } = issueKey(owner);
    expect(parse(post({ action: 'revoke_claude_key', session_token: owner })))
      .toEqual({ ok: true, revoked: true });
    expect(parse(post({ action: 'list_tracks', claude_key: key })).ok).toBe(false);
  });

  it('a bogus key is rejected with the claude key error', () => {
    expect(parse(post({ action: 'list_tracks', claude_key: 'mk_nope' })))
      .toEqual({ ok: false, status: 401, error: 'claude key expired or invalid' });
  });

  it('the key cannot drive the session or credential actions', () => {
    const owner = signIn();
    const { claude_key: key } = issueKey(owner);
    // No ID token is present, so the exchange cannot start.
    expect(parse(post({ action: 'exchange_session', claude_key: key })))
      .toMatchObject({ ok: false, status: 401, error: 'missing id token' });
    expect(parse(post({ action: 'issue_share', claude_key: key })))
      .toMatchObject({ ok: false, status: 401 });
    expect(parse(post({ action: 'revoke_share', claude_key: key })))
      .toMatchObject({ ok: false, status: 401 });
    expect(parse(post({ action: 'issue_claude_key', claude_key: key })))
      .toMatchObject({ ok: false, status: 401 });
    expect(parse(post({ action: 'revoke_claude_key', claude_key: key })))
      .toMatchObject({ ok: false, status: 401 });
    // And the key itself is untouched by those attempts.
    expect(parse(post({ action: 'list_tracks', claude_key: key })).ok).toBe(true);
  });

  it('claude_key_status reports activity and expiry, never the key', () => {
    const owner = signIn();
    expect(parse(post({ action: 'claude_key_status', session_token: owner })))
      .toEqual({ ok: true, active: false });
    const issued = issueKey(owner);
    const status = parse(post({ action: 'claude_key_status', session_token: owner }));
    expect(status).toEqual({
      ok: true, active: true, issued_at: issued.issued_at, expires_at: issued.expires_at,
    });
    expect(JSON.stringify(status)).not.toContain(issued.claude_key);
    parse(post({ action: 'revoke_claude_key', session_token: owner }));
    expect(parse(post({ action: 'claude_key_status', session_token: owner })))
      .toEqual({ ok: true, active: false });
  });
});

describe('list_tracks', () => {
  it('returns every row including unpublished ones, plus meta', () => {
    const token = signIn();
    const res = parse(post({ action: 'list_tracks', session_token: token }));
    expect(res.ok).toBe(true);
    expect(res.tracks.map((t) => t.file)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    expect(res.tracks.map((t) => t.row)).toEqual([1, 2, 3]);
    expect(res.tracks[0]).toMatchObject({ title: '曲A', published: true, publishedAt: '2026-11-13' });
    expect(res.tracks[1].published).toBe(false);
    expect(res.meta).toMatchObject({ tags: '音楽、川口', intro: '導入文。' });
  });
});

describe('track writes', () => {
  it('create_track appends a row in header order', () => {
    const token = signIn();
    const res = parse(post({
      action: 'create_track',
      session_token: token,
      track: {
        file: 'd.mp3', title: '曲D', description: '', instagram: '', suno: 'https://suno/d',
        youtube: '', published_at: '2026-11-14', duration_sec: 42, lyrics: '',
        sort: 4, published: false,
      },
    }));
    expect(res).toEqual({ ok: true, row: 4 });
    const rows = sheets.tracks.state.rows;
    expect(rows[4]).toEqual(['d.mp3', '曲D', '', '', 'https://suno/d', '',
      '2026-11-14', 42, '', 4, false]);
  });

  it('create_track rejects duplicates and invalid file names', () => {
    const token = signIn();
    expect(parse(post({
      action: 'create_track', session_token: token, track: { file: 'a.mp3' },
    }))).toEqual({ ok: false, error: 'track already exists: a.mp3' });
    expect(parse(post({
      action: 'create_track', session_token: token, track: { file: 'Bad Name.mp3' },
    }))).toEqual({ ok: false, error: 'invalid track file name: Bad Name.mp3' });
  });

  it('update_track rewrites the row and keeps unspecified fields', () => {
    const token = signIn();
    const res = parse(post({
      action: 'update_track',
      session_token: token,
      row: 2,
      track: { title: '曲B改' },
    }));
    expect(res).toEqual({ ok: true, row: 2 });
    const row = sheets.tracks.state.rows[2];
    expect(row[0]).toBe('b.mp3');
    expect(row[1]).toBe('曲B改');
    expect(row[4]).toBe('https://suno/b');
  });

  it('update_track verifies the file consistency check', () => {
    const token = signIn();
    expect(parse(post({
      action: 'update_track', session_token: token, row: 2, file: 'zzz.mp3', track: {},
    }))).toEqual({
      ok: false, error: 'track file mismatch: row 2 is b.mp3, not zzz.mp3',
    });
  });

  it('update_track refuses to change the file name', () => {
    const token = signIn();
    expect(parse(post({
      action: 'update_track', session_token: token, row: 2, track: { file: 'other.mp3' },
    }))).toEqual({ ok: false, error: 'file cannot be changed' });
  });

  it('update_track rejects an out-of-range row', () => {
    const token = signIn();
    expect(parse(post({
      action: 'update_track', session_token: token, row: 99, track: {},
    }))).toEqual({ ok: false, error: 'track row not found: 99' });
    expect(parse(post({
      action: 'update_track', session_token: token, row: 0, track: {},
    }))).toEqual({ ok: false, error: 'invalid row: 0' });
  });

  it('delete_track removes only the sheet row', () => {
    const token = signIn();
    const res = parse(post({
      action: 'delete_track', session_token: token, row: 2, file: 'b.mp3',
    }));
    expect(res).toEqual({ ok: true, row: 2, file: 'b.mp3' });
    expect(sheets.tracks.state.rows.map((r) => r[0])).toEqual(['file', 'a.mp3', 'c.mp3']);
    // The Drive file is untouched.
    expect(driveFiles.get('id-b.mp3').trashed).toBe(false);
  });

  it('update_meta writes existing keys and appends missing ones', () => {
    const token = signIn();
    const res = parse(post({
      action: 'update_meta',
      session_token: token,
      meta: { intro: '新しい導入。', outro: '新しい締め。' },
    }));
    expect(res).toEqual({ ok: true, updated: ['intro', 'outro'] });
    const meta = Object.fromEntries(sheets.meta.state.rows.slice(1).map((r) => [r[0], r[1]]));
    expect(meta.intro).toBe('新しい導入。');
    expect(meta.outro).toBe('新しい締め。');
    expect(meta.tags).toBe('音楽、川口');
  });
});

describe('upload_mp3', () => {
  const mp3 = Buffer.from([9, 8, 7, 6]).toString('base64');

  it('stores a new file in the music folder', () => {
    const token = signIn();
    const res = parse(post({
      action: 'upload_mp3', session_token: token, file_name: 'new-song.mp3', data_base64: mp3,
    }));
    expect(res).toEqual({ ok: true, file_name: 'new-song.mp3', size: 4, replaced: false });
    expect(musicFolderFiles.some((f) => f.getName() === 'new-song.mp3')).toBe(true);
  });

  it('replaces an existing file by trashing the old one', () => {
    const token = signIn();
    const old = driveFiles.get('id-a.mp3');
    const res = parse(post({
      action: 'upload_mp3', session_token: token, file_name: 'a.mp3', data_base64: mp3,
    }));
    expect(res).toEqual({ ok: true, file_name: 'a.mp3', size: 4, replaced: true });
    expect(old.setTrashed).toHaveBeenCalledWith(true);
    const live = musicFolderFiles.filter((f) => f.getName() === 'a.mp3' && !f.trashed);
    expect(live).toHaveLength(1);
  });

  it('rejects bad names, bad base64 and oversized files', () => {
    const token = signIn();
    expect(parse(post({
      action: 'upload_mp3', session_token: token, file_name: 'UPPER.mp3', data_base64: mp3,
    }))).toEqual({ ok: false, error: 'invalid file name: UPPER.mp3' });
    expect(parse(post({
      action: 'upload_mp3', session_token: token, file_name: 'x.mp3', data_base64: '***',
    }))).toEqual({ ok: false, error: 'invalid base64 data' });
    const big = Buffer.alloc(Code.MAX_MP3_BYTES + 1).toString('base64');
    const res = parse(post({
      action: 'upload_mp3', session_token: token, file_name: 'x.mp3', data_base64: big,
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('mp3 is too large');
  });

  it('scans the folder named by the MUSIC_FOLDER_NAME property', () => {
    props.MUSIC_FOLDER_NAME = 'music-staging';
    expect(Code.getMusicFolderName_()).toBe('music-staging');
    expect(Code.getMusicFolder_()).toBe(musicFolder);
    delete props.MUSIC_FOLDER_NAME;
    expect(Code.getMusicFolderName_()).toBe('music');
  });
});

describe('Internet Archive', () => {
  it('check_archive reads the metadata API without keys', () => {
    fetchHandler = (url) => {
      if (url === 'https://archive.org/metadata/freddiefujiwara-a') {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ files: [{ name: 'a.mp3', size: '123' }] }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    expect(Code.checkArchive_('a.mp3')).toEqual({ exists: true, size: 123 });
    expect(Code.checkArchive_('b.mp3')).toEqual({ exists: false });
  });

  it('check_archive treats fetch failures as absent', () => {
    fetchHandler = () => { throw new Error('down'); };
    expect(Code.checkArchive_('a.mp3')).toEqual({ exists: false });
  });

  it('uploadToArchive_ skips when the keys are not configured', () => {
    const track = { file: 'a.mp3', title: '曲A' };
    expect(Code.uploadToArchive_(track, driveFiles.get('id-a.mp3')))
      .toEqual({ status: 'skipped_not_configured' });
    expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
  });

  it('uploadToArchive_ PUTs with the LOW auth header and meta headers', () => {
    props.IA_ACCESS_KEY = 'access-key';
    props.IA_SECRET_KEY = 'secret-key';
    const calls = [];
    fetchHandler = (url, opts) => {
      calls.push({ url, opts });
      if (url.startsWith('https://archive.org/metadata/')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ files: [{ name: 'a.mp3', size: 3 }] }),
        };
      }
      return { getResponseCode: () => 200, getContentText: () => '' };
    };
    const track = { file: 'a.mp3', title: '曲A' };
    expect(Code.uploadToArchive_(track, driveFiles.get('id-a.mp3')))
      .toEqual({ status: 'ok' });
    const put = calls.find((c) => c.url.startsWith('https://s3.us.archive.org/'));
    expect(put.url).toBe('https://s3.us.archive.org/freddiefujiwara-a/a.mp3');
    expect(put.opts.method).toBe('put');
    expect(put.opts.headers.Authorization).toBe('LOW access-key:secret-key');
    expect(put.opts.headers['x-amz-auto-make-bucket']).toBe('1');
    expect(put.opts.headers['x-archive-meta-collection']).toBe('opensource_audio');
    expect(put.opts.headers['x-archive-meta-title']).toBe(encodeURIComponent('曲A'));
  });

  it('uploadToArchive_ reports HTTP errors and accepted uploads', () => {
    props.IA_ACCESS_KEY = 'access-key';
    props.IA_SECRET_KEY = 'secret-key';
    const track = { file: 'a.mp3', title: '曲A' };
    fetchHandler = () => ({ getResponseCode: () => 503, getContentText: () => '' });
    expect(Code.uploadToArchive_(track, driveFiles.get('id-a.mp3')))
      .toEqual({ status: 'error', error: 'archive upload failed: HTTP 503' });
    fetchHandler = (url) => (url.startsWith('https://archive.org/metadata/')
      ? { getResponseCode: () => 200, getContentText: () => JSON.stringify({ files: [] }) }
      : { getResponseCode: () => 200, getContentText: () => '' });
    expect(Code.uploadToArchive_(track, driveFiles.get('id-a.mp3')))
      .toEqual({ status: 'accepted' });
  });

  it('check_archive action answers through doPost', () => {
    const token = signIn();
    fetchHandler = (url) => {
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return {
          getResponseCode: () => tokenHttpCode,
          getContentText: () => JSON.stringify(tokenPayload),
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ files: [{ name: 'a.mp3', size: 3 }] }),
      };
    };
    expect(parse(post({ action: 'check_archive', session_token: token, file: 'a.mp3' })))
      .toEqual({ ok: true, file: 'a.mp3', exists: true, size: 3 });
  });
});

describe('publish / unpublish', () => {
  const wireDoc = () => {
    const paragraphs = [];
    const makeParagraph = () => {
      const p = {
        runs: [],
        setHeading: vi.fn(() => p),
        appendText: vi.fn((t) => {
          const run = { text: t, setLinkUrl: vi.fn(() => run) };
          p.runs.push(run);
          return run;
        }),
      };
      return p;
    };
    const body = {
      paragraphs: [makeParagraph()],
      clear: vi.fn(() => { body.paragraphs = [makeParagraph()]; }),
      getParagraphs: vi.fn(() => body.paragraphs),
      appendParagraph: vi.fn(() => {
        const p = makeParagraph();
        body.paragraphs.push(p);
        return p;
      }),
    };
    global.DocumentApp.openById.mockReturnValue({ getBody: () => body });
    return body;
  };

  it('publish flips the sheet, skips IA without keys, regenerates the article', () => {
    wireDoc();
    const token = signIn();
    const res = parse(post({
      action: 'publish_track', session_token: token, row: 2, file: 'b.mp3',
    }));
    expect(res.ok).toBe(true);
    expect(res.file).toBe('b.mp3');
    expect(res.steps).toEqual({ sheet: 'ok', archive: 'skipped_not_configured', article: 'ok' });
    expect(sheets.tracks.state.rows[2][10]).toBe(true);
  });

  it('publish uploads to IA when the keys are configured', () => {
    wireDoc();
    props.IA_ACCESS_KEY = 'access-key';
    props.IA_SECRET_KEY = 'secret-key';
    fetchHandler = (url) => {
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return {
          getResponseCode: () => tokenHttpCode,
          getContentText: () => JSON.stringify(tokenPayload),
        };
      }
      if (url.startsWith('https://archive.org/metadata/')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ files: [{ name: 'b.mp3', size: 3 }] }),
        };
      }
      return { getResponseCode: () => 200, getContentText: () => '' };
    };
    const token = signIn();
    const res = parse(post({
      action: 'publish_track', session_token: token, row: 2, file: 'b.mp3',
    }));
    expect(res.steps.archive).toBe('ok');
  });

  it('publish refuses when a required field or the MP3 is missing', () => {
    const token = signIn();
    expect(parse(post({
      action: 'publish_track', session_token: token, row: 3, file: 'c.mp3',
    }))).toEqual({ ok: false, error: 'cannot publish: missing suno' });
    // Nothing was changed by the refused publish.
    expect(sheets.tracks.state.rows[3][10]).toBe(false);
    sheets.tracks.state.rows[2][4] = 'https://suno/b';
    musicFolderFiles.splice(musicFolderFiles.findIndex((f) => f.getName() === 'b.mp3'), 1);
    driveFiles.delete('id-b.mp3');
    expect(parse(post({
      action: 'publish_track', session_token: token, row: 2, file: 'b.mp3',
    }))).toEqual({ ok: false, error: 'mp3 not found in the music folder: b.mp3' });
  });

  it('unpublish flips the flag back and regenerates', () => {
    wireDoc();
    const token = signIn();
    const res = parse(post({
      action: 'unpublish_track', session_token: token, row: 1, file: 'a.mp3',
    }));
    expect(res.ok).toBe(true);
    expect(res.steps.sheet).toBe('ok');
    expect(sheets.tracks.state.rows[1][10]).toBe(false);
  });

  it('regenerate_article returns the paragraph count', () => {
    wireDoc();
    const token = signIn();
    const res = parse(post({ action: 'regenerate_article', session_token: token }));
    expect(res.ok).toBe(true);
    expect(typeof res.paragraphs).toBe('number');
    expect(res.paragraphs).toBeGreaterThan(0);
  });
});
