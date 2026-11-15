import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Code from '../src/Code.js';

const mockProperties = { getProperty: vi.fn() };
const iterOf = (items) => {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
};

const SIZE = 3;

/**
 * Builds a fake Drive world: one folder named "music" under a
 * folder named "API", holding two slug-named MP3s plus decoy
 * files that must never be treated as tracks.
 */
const buildWorld = () => {
  const trackFileOf = (name, id) => ({
    getName: () => name,
    getId: () => id,
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
  };
  const otherFolder = {
    getName: () => 'music',
    getParents: vi.fn(() => iterOf([{ getName: () => 'somewhere-else' }])),
    getFiles: vi.fn(() => iterOf([])),
  };
  return { musicFolder, otherFolder, trackFileOf };
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
  MimeType: { JSON: 'application/json', XML: 'text/xml' },
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
  mockProperties.getProperty.mockImplementation(() => null);
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
  it('maps only the slug-named mp3 files in the archive folder', () => {
    expect(Code.getTracks_()).toEqual({ 'a.mp3': 'file-a', 'b.mp3': 'file-b' });
  });

  it('returns null when the music folder is not inside API', () => {
    wireWorld((w) => [w.otherFolder]);
    expect(Code.getTracks_()).toBeNull();
  });

  it('returns null when the music folder is ambiguous', () => {
    wireWorld((w) => [w.musicFolder, w.musicFolder]);
    expect(Code.getTracks_()).toBeNull();
  });

  it('reuses the cached track map instead of rescanning the folder', () => {
    Code.getTracks_();
    expect(world.musicFolder.getFiles).toHaveBeenCalledTimes(1);
    Code.getTracks_();
    expect(world.musicFolder.getFiles).toHaveBeenCalledTimes(1);
  });
});

describe('doGet', () => {
  it('rejects a bare request', () => {
    expect(parse(Code.doGet({ parameter: {} })))
      .toEqual({ ok: false, error: 'unknown output' });
  });

  it('no longer serves individual tracks (the base64 bridge is gone)', () => {
    expect(parse(Code.doGet({ parameter: { track: 'a.mp3' } })))
      .toEqual({ ok: false, error: 'unknown output' });
  });

  it('no longer serves the track list', () => {
    expect(parse(Code.doGet({ parameter: { o: 'list' } })))
      .toEqual({ ok: false, error: 'unknown output' });
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

  it('adds the podcast link after the intro when podcast_feed is set', () => {
    const meta = { ...META, podcast_feed: 'https://example.com/feed.rss' };
    const projected = project(Code.buildArticlePlan_([trackA], meta));
    const linkAt = projected.indexOf(
      'link:ポッドキャストでも聴けます->https://example.com/feed.rss',
    );
    expect(linkAt).toBeGreaterThan(projected.indexOf('text:導入3。'));
    expect(linkAt).toBeLessThan(projected.indexOf('text:[[音楽|曲A|a.mp3]]'));
    expect(projected[linkAt + 1]).toBe('E');
  });

  it('omits the podcast link when podcast_feed is not set', () => {
    const plan = Code.buildArticlePlan_([trackA], META);
    expect(plan.some((item) => item.text === Code.PODCAST_LINK_LABEL)).toBe(false);
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

describe('podcast RSS feed', () => {
  const track = (overrides = {}) => ({
    file: 'hatogaya-urawa.mp3',
    title: '鳩ヶ谷から浦和まで',
    description: '鳩ヶ谷から浦和までを歌った曲です。',
    instagram: 'https://ig/hatogaya-urawa',
    suno: 'https://suno.com/song/hatogaya-urawa',
    youtube: 'https://youtube.com/watch?v=hatogaya-urawa',
    publishedAt: '2026-11-07',
    durationSec: 120,
    lyrics: '',
    sort: 2,
    published: true,
    ...overrides,
  });

  it('orders episodes by publication date descending, then sort ascending', () => {
    const xml = Code.buildRssFeed_([
      track({ file: 'older.mp3', title: '古い曲', publishedAt: '2026-09-22', sort: 1 }),
      track({ file: 'same-day-later.mp3', title: '同日の後', publishedAt: '2026-11-07', sort: 3 }),
      track(),
      track({ file: 'newest.mp3', title: '最新の曲', publishedAt: '2026-11-13', sort: 4 }),
    ], {
      'older.mp3': 100,
      'same-day-later.mp3': 300,
      'hatogaya-urawa.mp3': 200,
      'newest.mp3': 400,
    });
    const titles = [...xml.matchAll(/<item>\s*<title>([^<]+)<\/title>/g)]
      .map((match) => match[1]);
    expect(titles).toEqual(['最新の曲', '鳩ヶ谷から浦和まで', '同日の後', '古い曲']);
  });

  it('derives the Internet Archive enclosure URL and uses the scanned size', () => {
    const xml = Code.buildRssFeed_([track()], { 'hatogaya-urawa.mp3': 2787607 });
    expect(xml).toContain('<enclosure url="https://archive.org/download/'
      + 'freddiefujiwara-hatogaya-urawa/hatogaya-urawa.mp3" '
      + 'length="2787607" type="audio/mpeg"/>');
    expect(Code.archiveUrl_('night-walk-kawaguchi.mp3')).toBe(
      'https://archive.org/download/freddiefujiwara-night-walk-kawaguchi/'
      + 'night-walk-kawaguchi.mp3',
    );
  });

  it('converts published_at to an Asia/Tokyo RFC-822 pubDate and formats duration', () => {
    expect(Code.formatRssDate_('2026-11-07')).toBe('Sat, 07 Nov 2026 00:00:00 +0900');
    expect(Code.formatRssDate_('2026-09-22')).toBe('Tue, 22 Sep 2026 00:00:00 +0900');
    expect(Code.formatDuration_(120)).toBe('2:00');
    expect(Code.formatDuration_(48)).toBe('0:48');
    const xml = Code.buildRssFeed_([track()], { 'hatogaya-urawa.mp3': 1 });
    expect(xml).toContain('<pubDate>Sat, 07 Nov 2026 00:00:00 +0900</pubDate>');
    expect(xml).toContain('<itunes:duration>2:00</itunes:duration>');
  });

  it('escapes XML in channel item fields and keeps the mandatory Suno link', () => {
    const xml = Code.buildRssFeed_([track({
      title: 'A & B <川口>',
      description: '説明 "quoted" & <tagged>',
      suno: 'https://suno.example/song?a=1&b=2',
    })], { 'hatogaya-urawa.mp3': 1 });
    expect(xml).toContain('<title>A &amp; B &lt;川口&gt;</title>');
    expect(xml).toContain('<description>説明 &quot;quoted&quot; &amp; &lt;tagged&gt;</description>');
    expect(xml).toContain('<link>https://suno.example/song?a=1&amp;b=2</link>');
    expect(Code.escapeXml_("a & <b> \"c\" 'd'"))
      .toBe('a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;');
  });

  it('omits unpublished tracks and tracks absent from the Drive scan', () => {
    const xml = Code.buildRssFeed_([
      track(),
      track({ file: 'draft.mp3', title: '下書き', published: false }),
      track({ file: 'missing.mp3', title: '未スキャン' }),
    ], {
      'hatogaya-urawa.mp3': 200,
      'draft.mp3': 300,
    });
    expect(xml).toContain('<title>鳩ヶ谷から浦和まで</title>');
    expect(xml).not.toContain('<title>下書き</title>');
    expect(xml).not.toContain('<title>未スキャン</title>');
    expect([...xml.matchAll(/<item>/g)]).toHaveLength(1);
  });

  it('parses duration_sec from the tracks sheet', () => {
    const HEADER = ['file', 'title', 'description', 'instagram', 'suno', 'youtube',
      'published_at', 'duration_sec', 'lyrics', 'sort', 'published'];
    const values = {
      file: 'a.mp3', title: '曲A', description: '', instagram: '', suno: 'https://suno/a',
      youtube: '', published_at: '2026-11-07', duration_sec: '120', lyrics: '',
      sort: 1, published: true,
    };
    const tracks = Code.parseTracksSheet_([
      HEADER,
      HEADER.map((h) => values[h]),
    ]);
    expect(tracks[0].durationSec).toBe(120);
  });

  describe('doGet integration', () => {
    const HEADER = ['file', 'title', 'description', 'instagram', 'suno', 'youtube',
      'published_at', 'duration_sec', 'lyrics', 'sort', 'published'];
    const row = (values) => HEADER.map((h) => values[h] ?? '');
    const makeSheet = (values) => ({
      getDataRange: vi.fn(() => ({ getValues: () => values })),
    });
    const wireRss = (trackValues) => {
      mockProperties.getProperty.mockImplementation((key) => {
        if (key === Code.MUSIC_DB_ID_PROPERTY_KEY) return 'db-id';
        return null;
      });
      const sheets = {
        tracks: makeSheet(trackValues),
        meta: makeSheet([['key', 'value']]),
      };
      global.SpreadsheetApp.openById.mockReturnValue({
        getSheetByName: (name) => sheets[name] || null,
      });
    };

    it('serves only published, scanned tracks in RSS order', () => {
      wireRss([
        HEADER,
        row({ file: 'a.mp3', title: '古い曲', description: '古い説明', suno: 'https://suno/a', published_at: '2026-09-22', duration_sec: 48, sort: 8, published: 'TRUE' }),
        row({ file: 'b.mp3', title: '新しい曲', description: '新しい説明', suno: 'https://suno/b', published_at: '2026-11-07', duration_sec: 120, sort: 2, published: 'TRUE' }),
        row({ file: 'c.mp3', title: 'スキャンに無い曲', suno: 'https://suno/c', published_at: '2026-11-13', duration_sec: 10, sort: 1, published: 'TRUE' }),
        row({ file: 'a.mp3', title: '非公開の曲', suno: 'https://suno/draft', published_at: '2026-11-14', duration_sec: 10, sort: 0, published: 'FALSE' }),
      ]);
      const output = Code.doGet({ parameter: { o: 'rss' } });
      expect(output.mimeType).toBe('text/xml');
      expect(global.SpreadsheetApp.openById).toHaveBeenCalledWith('db-id');
      const titles = [...output.content.matchAll(/<item>\s*<title>([^<]+)<\/title>/g)]
        .map((match) => match[1]);
      expect(titles).toEqual(['新しい曲', '古い曲']);
      expect(output.content).toContain('length="3"');
      expect(output.content).not.toContain('スキャンに無い曲');
      expect(output.content).not.toContain('非公開の曲');
    });

    it('returns a channel-only feed when MUSIC_DB_ID is not set', () => {
      const output = Code.doGet({ parameter: { o: 'rss' } });
      expect(output.mimeType).toBe('text/xml');
      expect(output.content).toContain('<title>川口の歌</title>');
      expect(output.content).not.toContain('<item>');
      expect(global.SpreadsheetApp.openById).not.toHaveBeenCalled();
    });

    it('returns a channel-only feed when the spreadsheet cannot be read', () => {
      mockProperties.getProperty.mockImplementation((key) => (
        key === Code.MUSIC_DB_ID_PROPERTY_KEY ? 'db-id' : null));
      global.SpreadsheetApp.openById.mockImplementation(() => {
        throw new Error('read failed');
      });
      const output = Code.doGet({ parameter: { o: 'rss' } });
      expect(output.content).toContain('<title>川口の歌</title>');
      expect(output.content).not.toContain('<item>');
    });
  });
});

describe('manifest', () => {
  it('grants the spreadsheet/document scopes and keeps anonymous web app access', () => {
    const manifest = JSON.parse(readFileSync(new URL('../appsscript.json', import.meta.url), 'utf8'));
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/documents');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/script.external_request');
    expect(manifest.webapp.access).toBe('ANYONE_ANONYMOUS');
  });
});
