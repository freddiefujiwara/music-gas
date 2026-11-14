import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Code from '../src/Code.js';

const mockProperties = { getProperty: vi.fn() };
const mockBlob = {
  getContentType: vi.fn().mockReturnValue('audio/mpeg'),
  getBytes: vi.fn().mockReturnValue([1, 2, 3]),
};

const iterOf = (items) => {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
};

const MODIFIED = 1700000000000;
const SIZE = 3;

/**
 * Builds a fake Drive world: one folder named "music" under a
 * folder named "API", holding two slug-named MP3s plus decoy
 * files that must never be treated as tracks.
 */
const buildWorld = () => {
  const cacheFiles = new Map();
  const cacheFileOf = (name) => ({
    getBlob: () => ({ getDataAsString: () => cacheFiles.get(name) }),
    setContent: (content) => { cacheFiles.set(name, content); },
  });
  const cacheFolder = {
    getName: () => 'music-cache-test',
    getFilesByName: vi.fn((name) => iterOf(cacheFiles.has(name) ? [cacheFileOf(name)] : [])),
    createFile: vi.fn((name, content) => {
      cacheFiles.set(name, content);
      return cacheFileOf(name);
    }),
  };
  const trackFileOf = (name, id) => ({
    getName: () => name,
    getId: () => id,
    getBlob: vi.fn().mockReturnValue(mockBlob),
    getLastUpdated: vi.fn().mockReturnValue(new Date(MODIFIED)),
    getSize: vi.fn().mockReturnValue(SIZE),
    getParents: vi.fn(() => iterOf([musicFolder])),
  });
  const decoyFileOf = (name) => ({ getName: () => name, getId: () => `id-${name}` });
  const musicFolder = {
    getName: () => 'music',
    getParents: vi.fn(() => iterOf([{ getName: () => 'API' }])),
    getFiles: vi.fn(() => iterOf([
      trackFileOf('a.mp3', 'file-a'),
      trackFileOf('b.mp3', 'file-b'),
      decoyFileOf('a [未公開 1分00秒].mp3'),
      decoyFileOf('lyrics-a.txt'),
      decoyFileOf('曲一覧.txt'),
    ])),
    getFoldersByName: vi.fn(() => iterOf([cacheFolder])),
    createFolder: vi.fn(() => cacheFolder),
  };
  const otherFolder = {
    getName: () => 'music',
    getParents: vi.fn(() => iterOf([{ getName: () => 'somewhere-else' }])),
    getFiles: vi.fn(() => iterOf([])),
  };
  return { cacheFiles, cacheFileOf, cacheFolder, musicFolder, otherFolder, trackFileOf };
};

let world;
let scriptCacheStore;

global.PropertiesService = { getScriptProperties: vi.fn().mockReturnValue(mockProperties) };
global.DriveApp = {
  getFileById: vi.fn(),
  getFoldersByName: vi.fn(),
};
global.CacheService = {
  getScriptCache: vi.fn(() => ({
    get: (key) => (scriptCacheStore.has(key) ? scriptCacheStore.get(key) : null),
    put: (key, value) => { scriptCacheStore.set(key, value); },
  })),
};
global.Utilities = {
  base64Encode: vi.fn((bytes) => Buffer.from(bytes).toString('base64')),
  formatDate: vi.fn((date) => date.toISOString().slice(0, 10)),
};
global.SpreadsheetApp = { openById: vi.fn() };
global.DocumentApp = {
  openById: vi.fn(),
  ParagraphHeading: { HEADING2: 'HEADING2' },
};
global.ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: vi.fn((content) => ({
    content,
    mimeType: null,
    setMimeType(m) { this.mimeType = m; return this; },
  })),
};
global.MimeType = { PLAIN_TEXT: 'text/plain' };

const parse = (output) => JSON.parse(output.content);

const wireWorld = (folders) => {
  world = buildWorld();
  scriptCacheStore = new Map();
  mockProperties.getProperty.mockImplementation((key) => {
    if (key === Code.CACHE_FOLDER_PROPERTY_KEY) return 'music-cache-test';
    return null;
  });
  global.DriveApp.getFoldersByName.mockImplementation(() => iterOf(folders(world)));
  const byId = new Map();
  // Index the world folder's track files by ID for getFileById.
  const filesIter = world.musicFolder.getFiles();
  const all = [];
  while (filesIter.hasNext()) all.push(filesIter.next());
  all.forEach((f) => { if (f.getId) byId.set(f.getId(), f); });
  world.musicFolder.getFiles.mockClear();
  global.DriveApp.getFileById.mockImplementation((id) => {
    if (!byId.has(id)) throw new Error(`unknown id ${id}`);
    return byId.get(id);
  });
  return world;
};

beforeEach(() => {
  vi.clearAllMocks();
  wireWorld((w) => [w.musicFolder]);
});

describe('track discovery', () => {
  it('lists only the slug-named mp3 files in the archive folder', () => {
    expect(parse(Code.doGet({ parameter: { o: 'list' } })))
      .toEqual({ ok: true, tracks: ['a.mp3', 'b.mp3'] });
  });

  it('reports not configured when the music folder is not inside API', () => {
    wireWorld((w) => [w.otherFolder]);
    expect(parse(Code.doGet({ parameter: { track: 'a.mp3' } })))
      .toEqual({ ok: false, error: 'tracks are not configured' });
  });

  it('reports not configured when the music folder is ambiguous', () => {
    wireWorld((w) => [w.musicFolder, w.musicFolder]);
    expect(parse(Code.doGet({ parameter: { o: 'list' } })))
      .toEqual({ ok: false, error: 'tracks are not configured' });
  });

  it('reuses the cached track map instead of rescanning the folder', () => {
    parse(Code.doGet({ parameter: { o: 'list' } }));
    expect(world.musicFolder.getFiles).toHaveBeenCalledTimes(1);
    parse(Code.doGet({ parameter: { o: 'list' } }));
    expect(world.musicFolder.getFiles).toHaveBeenCalledTimes(1);
  });
});

describe('doGet', () => {
  it('rejects a missing track parameter', () => {
    expect(parse(Code.doGet({ parameter: {} })))
      .toEqual({ ok: false, error: 'missing track parameter' });
  });

  it('rejects an unknown track', () => {
    expect(parse(Code.doGet({ parameter: { track: 'zzz.mp3' } })))
      .toEqual({ ok: false, error: 'unknown track' });
  });

  it('rejects an unpublished take name as a track', () => {
    expect(parse(Code.doGet({ parameter: { track: 'a [未公開 1分00秒].mp3' } })))
      .toEqual({ ok: false, error: 'unknown track' });
  });

  it('returns the file as base64 JSON', () => {
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.ok).toBe(true);
    expect(out.track).toBe('a.mp3');
    expect(out.mime).toBe('audio/mpeg');
    expect(out.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(global.DriveApp.getFileById).toHaveBeenCalledWith('file-a');
  });

  it('reports Drive read failures', () => {
    global.DriveApp.getFileById.mockImplementationOnce(() => { throw new Error('nope'); });
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('nope');
  });
});

describe('track cache', () => {
  const DATA = Buffer.from([1, 2, 3]).toString('base64');
  const CACHED_DATA = Buffer.from('CACHED').toString('base64');

  const seedCache = (track, overrides = {}) => {
    world.cacheFiles.set(`${track}.json`, JSON.stringify({
      ok: true,
      track,
      mime: 'audio/mpeg',
      data: CACHED_DATA,
      sourceModified: MODIFIED,
      sourceSize: SIZE,
      ...overrides,
    }));
  };

  it('serves a fresh cached response without converting', () => {
    seedCache('a.mp3');
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out).toEqual({ ok: true, track: 'a.mp3', mime: 'audio/mpeg', data: CACHED_DATA });
    expect(global.Utilities.base64Encode).not.toHaveBeenCalled();
  });

  it('converts and stores the response on a cache miss', () => {
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.data).toBe(DATA);
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(world.cacheFiles.get('a.mp3.json'));
    expect(stored.data).toBe(DATA);
    expect(stored.sourceModified).toBe(MODIFIED);
    expect(stored.sourceSize).toBe(SIZE);
  });

  it('rebuilds the cache when the source file changed', () => {
    seedCache('a.mp3', { sourceModified: MODIFIED - 1 });
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.data).toBe(DATA);
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(1);
    expect(JSON.parse(world.cacheFiles.get('a.mp3.json')).sourceModified).toBe(MODIFIED);
  });

  it('falls back to live conversion when reading the cache fails', () => {
    world.cacheFolder.getFilesByName.mockImplementation(() => { throw new Error('cache broken'); });
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.ok).toBe(true);
    expect(out.data).toBe(DATA);
  });

  it('still serves when the cache folder cannot be resolved', () => {
    const fileA = global.DriveApp.getFileById('file-a');
    fileA.getParents.mockImplementation(() => iterOf([]));
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.ok).toBe(true);
    expect(out.data).toBe(DATA);
  });

  it('preCacheMusic warms every track and skips fresh ones', () => {
    Code.preCacheMusic();
    expect(world.cacheFiles.has('a.mp3.json')).toBe(true);
    expect(world.cacheFiles.has('b.mp3.json')).toBe(true);
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(2);
    Code.preCacheMusic();
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(2);
  });

  it('looks the cache folder up by the script-property name', () => {
    parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(world.musicFolder.getFoldersByName).toHaveBeenCalledWith('music-cache-test');
  });

  it('rebuilds the cache when only the size changed', () => {
    seedCache('a.mp3', { sourceSize: SIZE + 1 });
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.data).toBe(DATA);
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(1);
    expect(JSON.parse(world.cacheFiles.get('a.mp3.json')).sourceSize).toBe(SIZE);
  });

  it('preCacheAll is available as an alias of preCacheMusic', () => {
    Code.preCacheAll();
    expect(world.cacheFiles.has('a.mp3.json')).toBe(true);
    expect(world.cacheFiles.has('b.mp3.json')).toBe(true);
  });
});

describe('article generation: sheet parsing', () => {
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

  it('keeps only published rows and orders them by the sort column', () => {
    const tracks = Code.parseTracksSheet_([
      HEADER,
      row({ file: 'b.mp3', title: '曲B', sort: 2 }),
      row({ file: 'c.mp3', title: '曲C', sort: 3, published: 'FALSE' }),
      row({ file: 'a.mp3', title: '曲A', sort: 1 }),
    ]);
    expect(tracks.map((t) => t.file)).toEqual(['a.mp3', 'b.mp3']);
    expect(tracks[0]).toMatchObject({
      title: '曲A', publishedAt: '2026-11-13', youtube: 'https://yt/a', published: true,
    });
  });

  it('looks columns up by header name, not by position', () => {
    const shuffled = ['published', 'sort', 'title', 'file', 'lyrics', 'youtube',
      'suno', 'instagram', 'description', 'published_at', 'duration_sec'];
    const values = { file: 'x.mp3', title: '曲X', sort: '5', published: true, published_at: '2026-09-22' };
    const tracks = Code.parseTracksSheet_([shuffled, shuffled.map((h) => values[h] ?? '')]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ file: 'x.mp3', title: '曲X', sort: 5, publishedAt: '2026-09-22' });
  });

  it('accepts boolean and string TRUE, rejects other published values', () => {
    const tracks = Code.parseTracksSheet_([
      HEADER,
      row({ file: 'a.mp3', published: true }),
      row({ file: 'b.mp3', published: 'true', sort: 2 }),
      row({ file: 'c.mp3', published: 'yes', sort: 3 }),
      row({ file: 'd.mp3', published: '', sort: 4 }),
    ]);
    expect(tracks.map((t) => t.file)).toEqual(['a.mp3', 'b.mp3']);
  });

  it('formats Date published_at cells as yyyy-MM-dd', () => {
    const tracks = Code.parseTracksSheet_([
      HEADER,
      row({ published_at: new Date('2026-11-13T00:00:00.000Z') }),
    ]);
    expect(tracks[0].publishedAt).toBe('2026-11-13');
  });

  it('throws when a required column is missing', () => {
    const noPublished = HEADER.filter((h) => h !== 'published');
    expect(() => Code.parseTracksSheet_([noPublished, noPublished.map(() => '')]))
      .toThrow('tracks sheet is missing the "published" column');
  });

  it('parses the meta sheet into a key/value map', () => {
    const meta = Code.parseMetaSheet_([
      ['key', 'value'],
      ['tags', '音楽、川口'],
      ['', 'ignored'],
      ['intro', '導入文。'],
      ['outro'],
    ]);
    expect(meta).toEqual({ tags: '音楽、川口', intro: '導入文。', outro: '' });
  });
});

describe('article generation: paragraph plan', () => {
  const META = {
    tags: '音楽、川口',
    suno_profile: 'https://suno.com/@freddiefujiwara',
    intro: '導入1。\n\n導入2。\n\n導入3。',
    outro: '締めの一文。',
  };
  const trackA = {
    file: 'a.mp3', title: '曲A', description: '説明A。', instagram: 'https://ig/a',
    suno: 'https://suno/a', youtube: 'https://yt/a', publishedAt: '2026-11-13',
    lyrics: '', sort: 1, published: true,
  };
  const trackB = {
    file: 'b.mp3', title: '曲B', description: '説明B1。\n\n説明B2。', instagram: 'https://ig/b',
    suno: 'https://suno/b', youtube: '', publishedAt: '2026-11-07',
    lyrics: '歌詞B1行目\n歌詞B2行目\n\n歌詞B3行目', sort: 2, published: true,
  };
  const project = (plan) => plan.map((item) => (item.kind === 'empty'
    ? 'E'
    : `${item.kind}:${item.text}${item.url ? `->${item.url}` : ''}`));

  it('lays out tags, intro, markers, table of contents, sections, outro in order', () => {
    expect(project(Code.buildArticlePlan_([trackA, trackB], META))).toEqual([
      'text:[[タグ：音楽、川口]]',
      'E',
      'text:導入1。',
      'E',
      'text:導入2。',
      'E',
      'link:https://suno.com/@freddiefujiwara->https://suno.com/@freddiefujiwara',
      'E',
      'text:導入3。',
      'E',
      'text:[[音楽|曲A|a.mp3]]',
      'text:[[音楽|曲B|b.mp3]]',
      'text:[[目次]]',
      'heading:2026-11-13 曲A',
      'text:説明A。',
      'E',
      'link:▶️Instagramを見る->https://ig/a',
      'link:▶️Suno で曲を聴く->https://suno/a',
      'link:▶️YouTube で動画を見る->https://yt/a',
      'E',
      'E',
      'heading:2026-11-07 曲B',
      'text:説明B1。',
      'E',
      'text:説明B2。',
      'E',
      'link:▶️Instagramを見る->https://ig/b',
      'link:▶️Suno で曲を聴く->https://suno/b',
      'E',
      'E',
      'text:[[歌詞]]',
      'text:歌詞B1行目',
      'text:歌詞B2行目',
      'E',
      'text:歌詞B3行目',
      'text:締めの一文。',
    ]);
  });

  it('omits the YouTube link when the cell is empty', () => {
    const plan = Code.buildArticlePlan_([trackB], META);
    expect(plan.some((item) => item.text === Code.YOUTUBE_LINK_LABEL)).toBe(false);
    expect(plan.some((item) => item.text === Code.INSTAGRAM_LINK_LABEL)).toBe(true);
  });

  it('omits the lyrics block entirely when a track has no lyrics', () => {
    const plan = Code.buildArticlePlan_([trackA], META);
    expect(plan.some((item) => item.text === '[[歌詞]]')).toBe(false);
  });

  it('uses the title as the heading text (date + title)', () => {
    const plan = Code.buildArticlePlan_([trackA], META);
    const heading = plan.find((item) => item.kind === 'heading');
    expect(heading.text).toBe('2026-11-13 曲A');
  });
});

describe('article generation: generateArticle', () => {
  const HEADER = ['file', 'title', 'description', 'instagram', 'suno', 'youtube',
    'published_at', 'duration_sec', 'lyrics', 'sort', 'published'];
  const TRACK_VALUES = [
    HEADER,
    ['a.mp3', '曲A', '説明A。', 'https://ig/a', 'https://suno/a', '', '2026-11-13', 100, '', 1, 'TRUE'],
  ];
  const META_VALUES = [
    ['key', 'value'],
    ['tags', '音楽、川口'],
    ['suno_profile', 'https://suno.com/@freddiefujiwara'],
    ['intro', '導入文。'],
    ['outro', '締め。'],
  ];

  const makeSheet = (values) => ({ getDataRange: vi.fn(() => ({ getValues: () => values })) });
  const makeParagraph = () => {
    const p = {
      heading: null,
      runs: [],
      setHeading: vi.fn((h) => { p.heading = h; return p; }),
      appendText: vi.fn((t) => {
        const run = {
          text: t,
          linkUrl: null,
          setLinkUrl: vi.fn((u) => { run.linkUrl = u; return run; }),
        };
        p.runs.push(run);
        return run;
      }),
    };
    return p;
  };
  const makeBody = () => {
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
    return body;
  };

  const wireArticle = ({ trackValues = TRACK_VALUES, metaValues = META_VALUES } = {}) => {
    mockProperties.getProperty.mockImplementation((key) => {
      if (key === Code.MUSIC_DB_ID_PROPERTY_KEY) return 'db-id';
      if (key === Code.ARTICLE_DOC_ID_PROPERTY_KEY) return 'doc-id';
      if (key === Code.CACHE_FOLDER_PROPERTY_KEY) return 'music-cache-test';
      return null;
    });
    const sheets = { tracks: makeSheet(trackValues), meta: makeSheet(metaValues) };
    global.SpreadsheetApp.openById.mockReturnValue({
      getSheetByName: (name) => sheets[name] || null,
    });
    const body = makeBody();
    global.DocumentApp.openById.mockReturnValue({ getBody: () => body });
    return { body, sheets };
  };

  it('fails loudly when MUSIC_DB_ID is not set', () => {
    mockProperties.getProperty.mockReturnValue(null);
    expect(() => Code.generateArticle()).toThrow('script property MUSIC_DB_ID is not set');
    expect(global.SpreadsheetApp.openById).not.toHaveBeenCalled();
    expect(global.DocumentApp.openById).not.toHaveBeenCalled();
  });

  it('fails loudly when ARTICLE_DOC_ID is not set', () => {
    mockProperties.getProperty.mockImplementation((key) => (
      key === Code.MUSIC_DB_ID_PROPERTY_KEY ? 'db-id' : null));
    expect(() => Code.generateArticle()).toThrow('script property ARTICLE_DOC_ID is not set');
    expect(global.SpreadsheetApp.openById).not.toHaveBeenCalled();
  });

  it('fails when the tracks sheet is missing', () => {
    wireArticle();
    global.SpreadsheetApp.openById.mockReturnValue({ getSheetByName: () => null });
    expect(() => Code.generateArticle()).toThrow('music-db has no "tracks" sheet');
  });

  it('refuses to regenerate when no track is published', () => {
    wireArticle({ trackValues: [HEADER] });
    expect(() => Code.generateArticle()).toThrow('no published tracks found in music-db');
    expect(global.DocumentApp.openById).not.toHaveBeenCalled();
  });

  it('rewrites the target document from the sheet', () => {
    const { body } = wireArticle();
    const written = Code.generateArticle();
    expect(global.SpreadsheetApp.openById).toHaveBeenCalledWith('db-id');
    expect(global.DocumentApp.openById).toHaveBeenCalledWith('doc-id');
    // One body paragraph per plan item: the paragraph left by
    // clear() is reused for the first item, not left over.
    expect(body.paragraphs).toHaveLength(written);
    const texts = body.paragraphs.map((p) => p.runs.map((r) => r.text).join(''));
    expect(texts[0]).toBe('[[タグ：音楽、川口]]');
    expect(texts).toContain('[[音楽|曲A|a.mp3]]');
    expect(texts).toContain('[[目次]]');
    expect(texts[texts.length - 1]).toBe('締め。');
    const heading = body.paragraphs.find((p) => p.heading);
    expect(heading.runs[0].text).toBe('2026-11-13 曲A');
    expect(heading.heading).toBe('HEADING2');
    const ig = body.paragraphs.find((p) => p.runs.some((r) => r.text === Code.INSTAGRAM_LINK_LABEL));
    expect(ig.runs[0].linkUrl).toBe('https://ig/a');
  });
});

describe('manifest', () => {
  it('grants the spreadsheet/document scopes and keeps anonymous web app access', () => {
    const manifest = JSON.parse(readFileSync(new URL('../appsscript.json', import.meta.url), 'utf8'));
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/spreadsheets.readonly');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/documents');
    expect(manifest.webapp.access).toBe('ANYONE_ANONYMOUS');
  });
});
