import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as Code from '../src/Code.js';

// Abnormal-case tests: the inputs from outside this code are the
// music-db sheet cell values (a cell can hold a string, a number,
// a boolean, a Date or nothing, whatever column it sits in), the
// Internet Archive / Google tokeninfo API responses, and the
// music-admin API's JSON body. None of those are guaranteed to
// carry the type the shaping code expects, and a JSON payload can
// even carry an object whose toString is not callable
// ({"toString": []}), which makes String() throw. Every case
// below asserts graceful behaviour: no throw, the deformed value
// reads as absent, and one broken row never takes the RSS feed,
// the article generation or the admin API down with it.
const evil = JSON.parse('{"toString": []}');

const HEADER = ['file', 'title', 'description', 'instagram', 'suno', 'youtube',
  'published_at', 'duration_sec', 'lyrics', 'sort', 'published'];
const row = (overrides = {}) => {
  const base = {
    file: 'a.mp3', title: '曲A', description: '説明。', instagram: 'https://ig/a',
    suno: 'https://suno/a', youtube: 'https://yt/a', published_at: '2026-11-13',
    duration_sec: 100, lyrics: '歌詞。', sort: 1, published: 'TRUE',
  };
  const merged = { ...base, ...overrides };
  return HEADER.map((h) => merged[h]);
};

const iterOf = (items) => {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
};

/** In-memory sheet: rows are plain arrays, writes mutate them. */
const makeSheet = (rows) => {
  const state = { rows: rows.map((r) => [...r]) };
  return {
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
        .slice(r - 1, r - 1 + nr).map((r2) => r2.slice(c - 1, c - 1 + nc))),
    })),
    getDataRange: vi.fn(() => ({
      getValues: () => state.rows.map((r) => [...r]),
    })),
    appendRow: vi.fn((r) => { state.rows.push([...r]); }),
    deleteRow: vi.fn((n) => { state.rows.splice(n - 1, 1); }),
  };
};

let props;
let sheets;
let tokenPayload;
let iaFiles;
let uuidCounter;

const parse = (output) => JSON.parse(output.content);
const post = (body) => Code.doPost({
  postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) },
});

beforeEach(() => {
  vi.clearAllMocks();
  props = {
    MUSIC_DB_ID: 'db-id',
    ARTICLE_DOC_ID: 'doc-id',
    AVAILABLE_GMAILS: 'owner@example.com',
    GOOGLE_OAUTH_CLIENT_ID: 'client-123',
  };
  tokenPayload = {
    iss: 'https://accounts.google.com',
    aud: 'client-123',
    exp: Math.floor(Date.now() / 1000) + 3600,
    email_verified: 'true',
    email: 'owner@example.com',
  };
  iaFiles = [];
  uuidCounter = 0;
  sheets = {
    tracks: makeSheet([HEADER, row()]),
    meta: makeSheet([
      ['key', 'value'],
      ['tags', '音楽、川口'],
      ['intro', '導入文。'],
      ['outro', '締め。'],
    ]),
  };

  global.PropertiesService = {
    getScriptProperties: vi.fn(() => ({
      getProperty: vi.fn((key) => (key in props ? props[key] : null)),
    })),
  };
  global.SpreadsheetApp = {
    openById: vi.fn(() => ({
      getSheetByName: (name) => sheets[name] || null,
      insertSheet: vi.fn((name) => {
        sheets[name] = makeSheet([]);
        return sheets[name];
      }),
    })),
  };
  global.UrlFetchApp = {
    fetch: vi.fn((url) => {
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(tokenPayload),
        };
      }
      if (url.startsWith('https://archive.org/metadata/')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ files: iaFiles }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  };
  global.Utilities = {
    formatDate: vi.fn((date) => date.toISOString().slice(0, 10)),
    computeDigest: vi.fn((algo, input) => [...createHash('sha256').update(String(input)).digest()]),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    getUuid: vi.fn(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`),
  };
  global.CacheService = {
    getScriptCache: vi.fn(() => ({
      get: () => null,
      put: vi.fn(),
      remove: vi.fn(),
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
  // One published track in the Drive scan, for the RSS path.
  const musicFolder = {
    getName: () => 'music',
    getParents: vi.fn(() => iterOf([{ getName: () => 'API' }])),
    getFiles: vi.fn(() => iterOf([{
      getName: () => 'a.mp3',
      getId: () => 'file-a',
    }])),
  };
  global.DriveApp = {
    getFoldersByName: vi.fn(() => iterOf([musicFolder])),
    getFileById: vi.fn(() => ({ getSize: () => 12345 })),
  };
});

describe('unstringifiable cell values (toString is not callable)', () => {
  it('cellText_ reads an unstringifiable value as empty instead of throwing', () => {
    expect(() => Code.cellText_(evil)).not.toThrow();
    expect(Code.cellText_(evil)).toBe('');
  });

  it('one unstringifiable cell does not break the tracks parse', () => {
    const tracks = Code.parseTracksSheet_([
      HEADER,
      row({ file: 'bad.mp3', title: evil, sort: 1 }),
      row({ file: 'good.mp3', title: '良い曲', sort: 2 }),
    ]);
    expect(tracks.map((t) => t.file)).toEqual(['bad.mp3', 'good.mp3']);
    expect(tracks[0].title).toBe('');
    expect(tracks[1].title).toBe('良い曲');
  });

  it('an unstringifiable header cell does not break the tracks parse', () => {
    const header = [...HEADER];
    header[2] = evil; // the description column header
    const tracks = Code.parseTracksSheetAll_([header, row()]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].file).toBe('a.mp3');
    // The renamed column reads as absent, not as a crash.
    expect(tracks[0].description).toBe('');
  });

  it('an unstringifiable meta value reads as empty and keeps the other keys', () => {
    const meta = Code.parseMetaSheet_([
      ['key', 'value'],
      ['tags', evil],
      ['intro', '導入文。'],
    ]);
    expect(meta).toEqual({ tags: '', intro: '導入文。' });
  });

  it('escapeXml_ reads an unstringifiable value as empty', () => {
    expect(() => Code.escapeXml_(evil)).not.toThrow();
    expect(Code.escapeXml_(evil)).toBe('');
  });

  it('the date and duration coercions survive unstringifiable cells', () => {
    expect(Code.cellDate_(evil)).toBe('');
    expect(Code.formatRssDate_(evil)).toBe('');
    expect(Code.formatDuration_(evil)).toBe('0:00');
    expect(Code.cellBool_(evil)).toBe(false);
  });

  it('a track parsed from a sheet with an unstringifiable cell still reaches the RSS feed', () => {
    sheets.tracks = makeSheet([
      HEADER,
      row({ description: evil }),
    ]);
    const output = Code.doGet({ parameter: { o: 'rss' } });
    expect(output.content).toContain('<title>曲A</title>');
    expect(output.content).toContain('length="12345"');
  });

  it('list_tracks answers for a sheet holding an unstringifiable cell', () => {
    sheets.tracks = makeSheet([
      HEADER,
      row({ title: evil }),
      row({ file: 'b.mp3', title: '曲B', sort: 2 }),
    ]);
    const session = parse(post({ action: 'exchange_session', idToken: 'good' }));
    expect(session.ok).toBe(true);
    const res = parse(post({
      action: 'list_tracks', session_token: session.session_token,
    }));
    expect(res.ok).toBe(true);
    expect(res.tracks.map((t) => t.file)).toEqual(['a.mp3', 'b.mp3']);
    expect(res.tracks[0].title).toBe('');
  });
});

describe('bare Number() coercions must not fabricate values', () => {
  it('a blank sort cell sorts last, not as zero', () => {
    expect(Code.cellSort_('')).toBe(Number.MAX_SAFE_INTEGER);
    expect(Code.cellSort_('   ')).toBe(Number.MAX_SAFE_INTEGER);
    const tracks = Code.parseTracksSheet_([
      HEADER,
      row({ file: 'blank-sort.mp3', title: 'ソートなし', sort: '' }),
      row({ file: 'sorted.mp3', title: 'ソートあり', sort: 5 }),
    ]);
    expect(tracks.map((t) => t.file)).toEqual(['sorted.mp3', 'blank-sort.mp3']);
  });

  it('an array or boolean sort cell does not become a number', () => {
    expect(Code.cellSort_([65])).toBe(Number.MAX_SAFE_INTEGER);
    expect(Code.cellSort_(true)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('an array or boolean duration cell does not become seconds', () => {
    expect(Code.cellDuration_([65])).toBe(0);
    expect(Code.cellDuration_(true)).toBe(0);
    expect(Code.cellDuration_('')).toBe(0);
    expect(Code.cellDuration_('90')).toBe(90);
  });

  it('trackRowCells_ writes no sort for boolean, array or blank payload values', () => {
    expect(Code.trackRowCells_({ sort: true }, ['sort'])).toEqual(['']);
    expect(Code.trackRowCells_({ sort: [65] }, ['sort'])).toEqual(['']);
    expect(Code.trackRowCells_({ sort: '' }, ['sort'])).toEqual(['']);
    expect(Code.trackRowCells_({ sort: '3' }, ['sort'])).toEqual([3]);
    expect(Code.trackRowCells_({ sort: 2 }, ['sort'])).toEqual([2]);
  });

  it('trackRowCells_ survives an unstringifiable sort instead of throwing', () => {
    expect(() => Code.trackRowCells_({ sort: evil }, ['sort'])).not.toThrow();
    expect(Code.trackRowCells_({ sort: evil }, ['sort'])).toEqual(['']);
  });

  it('resolveTrack_ rejects array and unstringifiable row addresses', () => {
    const tracks = Code.parseTracksSheetAll_([HEADER, row()]);
    expect(() => Code.resolveTrack_(tracks, [1])).toThrow('invalid row');
    expect(() => Code.resolveTrack_(tracks, evil)).toThrow('invalid row');
    expect(Code.resolveTrack_(tracks, '1').file).toBe('a.mp3');
  });

  it('check_archive does not fabricate a size from an array size field', () => {
    iaFiles = [{ name: 'a.mp3', size: [123] }];
    expect(Code.checkArchive_('a.mp3')).toEqual({ exists: true, size: 0 });
    iaFiles = [{ name: 'a.mp3', size: '123' }];
    expect(Code.checkArchive_('a.mp3')).toEqual({ exists: true, size: 123 });
    iaFiles = [{ name: 'a.mp3', size: 456 }];
    expect(Code.checkArchive_('a.mp3')).toEqual({ exists: true, size: 456 });
  });
});

describe('tokeninfo payload coercions', () => {
  it('an unstringifiable exp reads as an expired token', () => {
    tokenPayload = { ...tokenPayload, exp: evil };
    const res = parse(post({ action: 'exchange_session', idToken: 'good' }));
    expect(res).toMatchObject({ ok: false, status: 401, error: 'token expired' });
  });

  it('an array exp does not become a far-future expiry', () => {
    tokenPayload = { ...tokenPayload, exp: [9999999999] };
    const res = parse(post({ action: 'exchange_session', idToken: 'good' }));
    expect(res).toMatchObject({ ok: false, status: 401, error: 'token expired' });
  });

  it('an unstringifiable email reads as a missing email', () => {
    tokenPayload = { ...tokenPayload, email: evil };
    const res = parse(post({ action: 'exchange_session', idToken: 'good' }));
    expect(res).toMatchObject({ ok: false, status: 401, error: 'missing email' });
  });
});

describe('nonexistent dates do not roll over', () => {
  it('formatRssDate_ rejects February 30th and other impossible dates', () => {
    expect(Code.formatRssDate_('2026-02-30')).toBe('');
    expect(Code.formatRssDate_('2026-02-29')).toBe(''); // 2026 is not a leap year
    expect(Code.formatRssDate_('2026-04-31')).toBe('');
    expect(Code.formatRssDate_('2026-13-01')).toBe('');
    expect(Code.formatRssDate_('2024-02-29')).toBe('Thu, 29 Feb 2024 00:00:00 +0900');
  });

  it('the RSS feed drops a track dated February 30th and keeps the valid one', () => {
    const xml = Code.buildRssFeed_([
      {
        file: 'bad.mp3', title: '存在しない日付', suno: 'https://suno/bad',
        publishedAt: '2026-02-30', durationSec: 10, sort: 1, published: true,
      },
      {
        file: 'good.mp3', title: '正しい日付', suno: 'https://suno/good',
        publishedAt: '2026-02-27', durationSec: 10, sort: 2, published: true,
      },
    ], { 'bad.mp3': 1, 'good.mp3': 1 });
    expect(xml).not.toContain('存在しない日付');
    expect(xml).toContain('正しい日付');
  });
});

describe('string truncation must not split surrogate pairs', () => {
  // cellDate_ keeps the first ten characters of a published_at
  // cell; counting UTF-16 code units can cut an astral character
  // in half and leak a lone surrogate into the article heading
  // and the feed.
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('cellDate_ never returns a lone surrogate', () => {
    expect(Code.cellDate_('123456789🎵x')).not.toMatch(LONE);
    expect(Code.cellDate_('🎵🎵🎵🎵🎵🎵🎵')).not.toMatch(LONE);
    expect(Code.cellDate_('2026-11-13')).toBe('2026-11-13');
  });

  it('archiveUrl_ does not throw on a file name holding a lone surrogate', () => {
    expect(() => Code.archiveUrl_('a\uD83C.mp3')).not.toThrow();
    expect(Code.archiveUrl_('a\uD83C.mp3')).toContain('archive.org/download/');
  });
});
