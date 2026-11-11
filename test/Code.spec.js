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
global.MimeType = { PLAIN_TEXT: 'text/plain' };
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

describe('response cache', () => {
  const SOURCE_MODIFIED = 1700000000000;
  const iter = (items) => {
    let i = 0;
    return { hasNext: () => i < items.length, next: () => items[i++] };
  };
  let entries;
  let cacheFolder;
  let parentFolder;
  let sourceFile;

  const makeEntry = (content) => {
    const entry = {
      content,
      getBlob() { return { getDataAsString: () => entry.content }; },
      setContent: vi.fn((c) => { entry.content = c; }),
    };
    return entry;
  };

  beforeEach(() => {
    entries = new Map();
    cacheFolder = {
      getFilesByName: vi.fn((name) => iter(entries.has(name) ? [entries.get(name)] : [])),
      createFile: vi.fn((name, content) => {
        const entry = makeEntry(content);
        entries.set(name, entry);
        return entry;
      }),
    };
    parentFolder = {
      getFoldersByName: vi.fn(() => iter([cacheFolder])),
      createFolder: vi.fn(),
    };
    sourceFile = {
      getBlob: () => mockBlob,
      getLastUpdated: () => new Date(SOURCE_MODIFIED),
      getParents: () => iter([parentFolder]),
    };
    global.DriveApp.getFileById.mockReturnValue(sourceFile);
  });

  const seedEntry = (modified, data) => {
    const entry = makeEntry(JSON.stringify({
      sourceModified: modified,
      payload: { ok: true, track: 'a.mp3', mime: 'audio/mpeg', data },
    }));
    entries.set('a.mp3.json', entry);
    return entry;
  };

  it('serves a fresh cache entry without encoding', () => {
    seedEntry(SOURCE_MODIFIED, 'Q0FDSEVE');
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.data).toBe('Q0FDSEVE');
    expect(global.Utilities.base64Encode).not.toHaveBeenCalled();
  });

  it('builds and stores the entry on a cache miss', () => {
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.ok).toBe(true);
    expect(cacheFolder.createFile).toHaveBeenCalledWith('a.mp3.json', expect.any(String), 'text/plain');
    const stored = JSON.parse(cacheFolder.createFile.mock.calls[0][1]);
    expect(stored.sourceModified).toBe(SOURCE_MODIFIED);
    expect(stored.payload.data).toBe(out.data);
  });

  it('rebuilds a stale entry in place', () => {
    const entry = seedEntry(SOURCE_MODIFIED - 1, 'U1RBTEU=');
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.data).not.toBe('U1RBTEU=');
    expect(entry.setContent).toHaveBeenCalled();
    expect(JSON.parse(entry.content).sourceModified).toBe(SOURCE_MODIFIED);
  });

  it('falls back to live encoding when the cache read fails', () => {
    cacheFolder.getFilesByName.mockImplementation(() => { throw new Error('cache down'); });
    const out = parse(Code.doGet({ parameter: { track: 'a.mp3' } }));
    expect(out.ok).toBe(true);
    expect(out.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('preCacheAll builds an entry for every track', () => {
    expect(Code.preCacheAll()).toBe(2);
    expect(cacheFolder.createFile).toHaveBeenCalledTimes(2);
    expect(entries.has('a.mp3.json')).toBe(true);
    expect(entries.has('b.mp3.json')).toBe(true);
  });
});
