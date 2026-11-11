import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

const mockProperties = { getProperty: vi.fn() };
const mockBlob = {
  getContentType: vi.fn().mockReturnValue('audio/mpeg'),
  getBytes: vi.fn().mockReturnValue([1, 2, 3]),
};

global.PropertiesService = { getScriptProperties: vi.fn().mockReturnValue(mockProperties) };
global.DriveApp = { getFileById: vi.fn().mockReturnValue({ getBlob: vi.fn().mockReturnValue(mockBlob) }) };
global.Utilities = { base64Encode: vi.fn((bytes) => Buffer.from(bytes).toString('base64')) };
global.ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: vi.fn((content) => ({
    content,
    mimeType: null,
    setMimeType(m) { this.mimeType = m; return this; },
  })),
};

const parse = (output) => JSON.parse(output.content);

describe('doGet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProperties.getProperty.mockReturnValue(JSON.stringify({ 'a.mp3': 'file-a', 'b.mp3': 'file-b' }));
  });

  it('reports when tracks are not configured', () => {
    mockProperties.getProperty.mockReturnValue(null);
    expect(parse(Code.doGet({ parameter: { track: 'a.mp3' } })))
      .toEqual({ ok: false, error: 'tracks are not configured' });
  });

  it('lists the configured track names', () => {
    expect(parse(Code.doGet({ parameter: { o: 'list' } })))
      .toEqual({ ok: true, tracks: ['a.mp3', 'b.mp3'] });
  });

  it('rejects a missing track parameter', () => {
    expect(parse(Code.doGet({ parameter: {} })))
      .toEqual({ ok: false, error: 'missing track parameter' });
  });

  it('rejects an unknown track', () => {
    expect(parse(Code.doGet({ parameter: { track: 'zzz.mp3' } })))
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
  const MODIFIED = 1700000000000;
  const SIZE = 3;
  const DATA = Buffer.from([1, 2, 3]).toString('base64');
  const CACHED_DATA = Buffer.from('CACHED').toString('base64');

  let cacheFiles;
  let cacheFolder;
  let parentFolder;
  let mp3File;

  const iterOf = (items) => {
    let i = 0;
    return { hasNext: () => i < items.length, next: () => items[i++] };
  };
  const cacheFileOf = (name) => ({
    getBlob: () => ({ getDataAsString: () => cacheFiles.get(name) }),
    setContent: (content) => { cacheFiles.set(name, content); },
  });
  const seedCache = (track, overrides = {}) => {
    cacheFiles.set(`${track}.json`, JSON.stringify({
      ok: true,
      track,
      mime: 'audio/mpeg',
      data: CACHED_DATA,
      sourceModified: MODIFIED,
      sourceSize: SIZE,
      ...overrides,
    }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cacheFiles = new Map();
    cacheFolder = {
      getFilesByName: vi.fn((name) => iterOf(cacheFiles.has(name) ? [cacheFileOf(name)] : [])),
      createFile: vi.fn((name, content) => {
        cacheFiles.set(name, content);
        return cacheFileOf(name);
      }),
    };
    parentFolder = {
      getFoldersByName: vi.fn(() => iterOf([cacheFolder])),
      createFolder: vi.fn(() => cacheFolder),
    };
    mp3File = {
      getBlob: vi.fn().mockReturnValue(mockBlob),
      getLastUpdated: vi.fn().mockReturnValue(new Date(MODIFIED)),
      getSize: vi.fn().mockReturnValue(SIZE),
      getParents: vi.fn(() => iterOf([parentFolder])),
    };
    mockProperties.getProperty.mockImplementation((key) => {
      if (key === Code.TRACKS_PROPERTY_KEY) {
        return JSON.stringify({ 'a.mp3': 'file-a', 'b.mp3': 'file-b' });
      }
      if (key === Code.CACHE_FOLDER_PROPERTY_KEY) return 'music-cache-test';
      return null;
    });
    global.DriveApp.getFileById.mockReturnValue(mp3File);
    global.MimeType = { PLAIN_TEXT: 'text/plain' };
  });

  it('serves a fresh cached response without converting', () => {
    seedCache('a.mp3');
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out).toEqual({ ok: true, track: 'a.mp3', mime: 'audio/mpeg', data: CACHED_DATA });
    expect(global.Utilities.base64Encode).not.toHaveBeenCalled();
    expect(mp3File.getBlob).not.toHaveBeenCalled();
  });

  it('converts and stores the response on a cache miss', () => {
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.data).toBe(DATA);
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(cacheFiles.get('a.mp3.json'));
    expect(stored.data).toBe(DATA);
    expect(stored.sourceModified).toBe(MODIFIED);
    expect(stored.sourceSize).toBe(SIZE);
  });

  it('rebuilds the cache when the source file changed', () => {
    seedCache('a.mp3', { sourceModified: MODIFIED - 1 });
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.data).toBe(DATA);
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cacheFiles.get('a.mp3.json')).sourceModified).toBe(MODIFIED);
  });

  it('falls back to live conversion when reading the cache fails', () => {
    cacheFolder.getFilesByName.mockImplementation(() => { throw new Error('cache broken'); });
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.ok).toBe(true);
    expect(out.data).toBe(DATA);
  });

  it('still serves when the cache folder cannot be resolved', () => {
    mp3File.getParents.mockImplementation(() => iterOf([]));
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.ok).toBe(true);
    expect(out.data).toBe(DATA);
  });

  it('preCacheMusic warms every track and skips fresh ones', () => {
    Code.preCacheMusic();
    expect(cacheFiles.has('a.mp3.json')).toBe(true);
    expect(cacheFiles.has('b.mp3.json')).toBe(true);
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(2);
    Code.preCacheMusic();
    expect(global.Utilities.base64Encode).toHaveBeenCalledTimes(2);
  });
});
