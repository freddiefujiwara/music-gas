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
