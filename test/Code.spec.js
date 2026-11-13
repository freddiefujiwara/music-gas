import { describe, it, expect, vi, beforeEach } from 'vitest';
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
global.Utilities = { base64Encode: vi.fn((bytes) => Buffer.from(bytes).toString('base64')) };
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
