import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import * as Code from '../src/Code.js';

// Property-based tests (fast-check) over the same outside inputs
// as the abnormal-case suite: music-db sheet cell values, the
// music-admin JSON payloads built on them, and the RSS / article
// shaping. The JSON domain includes an object whose toString is
// not callable ({"toString": []}), which JSON.parse can produce
// and String() chokes on.
const evil = JSON.parse('{"toString": []}');

global.Utilities = {
  formatDate: vi.fn((date) => date.toISOString().slice(0, 10)),
};

const jsonish = fc.oneof(
  fc.string(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.oneof(fc.string(), fc.double(), fc.boolean(), fc.constant(null)), { maxLength: 3 }),
  fc.dictionary(fc.string(), fc.string()),
  fc.constant(evil),
);

// A sheet cell: what getValues() can return, plus the JSON-ish
// values that flow through the same coercions from the admin API.
const cell = fc.oneof(
  jsonish,
  fc.date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
  fc.constant(undefined),
);

// The documented text coercion, restated as the reference: null /
// absent and unstringifiable values read as empty, everything
// else is String() trimmed.
const textOf = (v) => {
  if (v === null || v === undefined) return '';
  try {
    return String(v).trim();
  } catch {
    return '';
  }
};

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUM_RUNS = { numRuns: 100 };

describe('cell coercions', () => {
  it('cellText_ never throws and matches the documented coercion', () => {
    fc.assert(fc.property(cell, (v) => {
      expect(Code.cellText_(v)).toBe(textOf(v));
    }), NUM_RUNS);
  });

  it('cellBool_ never throws and is true only for true / "TRUE"', () => {
    fc.assert(fc.property(cell, (v) => {
      const expected = v === true || textOf(v).toUpperCase() === 'TRUE';
      expect(Code.cellBool_(v)).toBe(expected);
    }), NUM_RUNS);
  });

  it('cellSort_ never throws, stays finite, and keeps real numbers', () => {
    fc.assert(fc.property(cell, (v) => {
      const n = Code.cellSort_(v);
      expect(Number.isFinite(n)).toBe(true);
      if (typeof v === 'number' && Number.isFinite(v)) expect(n).toBe(v);
      if (typeof v === 'string' && v.trim() === '') {
        expect(n).toBe(Number.MAX_SAFE_INTEGER);
      }
    }), NUM_RUNS);
  });

  it('cellDuration_ never throws and returns whole non-negative seconds', () => {
    fc.assert(fc.property(cell, (v) => {
      const n = Code.cellDuration_(v);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        expect(n).toBe(Math.round(v));
      }
    }), NUM_RUNS);
  });

  it('cellDate_ never throws and never leaks a lone surrogate', () => {
    fc.assert(fc.property(cell, (v) => {
      const s = Code.cellDate_(v);
      expect(typeof s).toBe('string');
      expect(s).not.toMatch(LONE);
    }), NUM_RUNS);
  });
});

describe('text shaping', () => {
  it('escapeXml_ never throws and leaves no raw markup characters', () => {
    fc.assert(fc.property(jsonish, (v) => {
      const out = Code.escapeXml_(v);
      expect(out).not.toMatch(/[<>"']/);
      expect(out).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    }), NUM_RUNS);
  });

  it('splitBlocks_ returns trimmed non-empty blocks', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const blocks = Code.splitBlocks_(s);
      blocks.forEach((b) => {
        expect(b).toBe(b.trim());
        expect(b.length).toBeGreaterThan(0);
      });
      expect(Code.splitBlocks_('')).toEqual([]);
    }), NUM_RUNS);
  });

  it('formatDuration_ always renders M:SS', () => {
    // The domain is scoped to what a duration_sec cell can
    // realistically hold: a measured MP3 length (the browser
    // measures it before upload), so seconds stay far below
    // 10^7. An arbitrary double like 6e22 also breaks the
    // *minutes* rendering (1e+21 in exponential notation), but
    // no real track is that long, so the generator is narrowed
    // instead of bending the formatter for an impossible input.
    const durationCell = fc.oneof(
      fc.double({ min: 0, max: 10_000_000, noNaN: true }),
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.constantFrom('90', '0', '', 'abc', ' 120 '),
      fc.boolean(),
      fc.constant(null),
      fc.constant(evil),
      fc.date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
    );
    fc.assert(fc.property(durationCell, (v) => {
      expect(Code.formatDuration_(v)).toMatch(/^\d+:\d{2}$/);
    }), NUM_RUNS);
  });
});

describe('formatRssDate_', () => {
  const ymd = fc.tuple(
    fc.integer({ min: 1990, max: 2100 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 31 }),
  );

  it('accepts exactly the dates that exist, in RFC-822 form', () => {
    fc.assert(fc.property(ymd, ([y, m, d]) => {
      const input = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const out = Code.formatRssDate_(input);
      const probe = new Date(Date.UTC(y, m - 1, d));
      const exists = probe.getUTCFullYear() === y
        && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
      if (!exists) {
        expect(out).toBe('');
      } else {
        expect(out).toMatch(
          new RegExp(`^\\w{3}, ${String(d).padStart(2, '0')} \\w{3} ${y} 00:00:00 \\+0900$`),
        );
      }
    }), NUM_RUNS);
  });
});

const HEADER = ['file', 'title', 'description', 'instagram', 'suno', 'youtube',
  'published_at', 'duration_sec', 'lyrics', 'sort', 'published'];
const sheetValues = fc.array(
  fc.array(cell, { minLength: 0, maxLength: HEADER.length }),
  { maxLength: 6 },
).map((rows) => [HEADER, ...rows]);

const isBlankRow = (row) => !row || row.every((c) => textOf(c) === '');

describe('tracks sheet parsing', () => {
  it('never throws and keeps the parsed shape for arbitrary cells', () => {
    fc.assert(fc.property(sheetValues, (values) => {
      const all = Code.parseTracksSheetAll_(values);
      const dataRows = values.slice(1);
      expect(all).toHaveLength(dataRows.filter((r) => !isBlankRow(r)).length);
      all.forEach((t) => {
        ['file', 'title', 'description', 'instagram', 'suno', 'youtube',
          'publishedAt', 'lyrics'].forEach((k) => expect(typeof t[k]).toBe('string'));
        expect(Number.isInteger(t.durationSec)).toBe(true);
        expect(t.durationSec).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(t.sort)).toBe(true);
        expect(typeof t.published).toBe('boolean');
        expect(t.row).toBeGreaterThanOrEqual(1);
        expect(t.row).toBeLessThanOrEqual(dataRows.length);
      });
    }), NUM_RUNS);
  });

  it('published mode keeps only published rows with a file, sorted by sort', () => {
    fc.assert(fc.property(sheetValues, (values) => {
      const all = Code.parseTracksSheetAll_(values);
      const published = Code.parseTracksSheet_(values);
      const expected = all.filter((t) => t.published && t.file);
      expect(published.map((t) => t.row)).toEqual(
        expect.arrayContaining(expected.map((t) => t.row)),
      );
      expect(published).toHaveLength(expected.length);
      for (let i = 1; i < published.length; i += 1) {
        expect(published[i - 1].sort).toBeLessThanOrEqual(published[i].sort);
      }
    }), NUM_RUNS);
  });
});

// A parsed track, the shape parseTracksSheet_ produces and the
// RSS / article builders consume: string fields, a boolean flag
// and numeric sort / duration.
const parsedTrack = fc.record({
  file: fc.string(),
  title: fc.string(),
  description: fc.string(),
  instagram: fc.string(),
  suno: fc.string(),
  youtube: fc.string(),
  publishedAt: fc.oneof(
    fc.string(),
    fc.constantFrom('2026-11-13', '2026-02-30', '2024-02-29', '2026-09-22'),
  ),
  durationSec: fc.nat({ max: 100000 }),
  lyrics: fc.string(),
  sort: fc.integer({ min: -5, max: 50 }),
  published: fc.boolean(),
});

describe('buildRssFeed_', () => {
  const sizes = fc.dictionary(fc.string(), fc.nat({ max: 10000000 }));

  it('never throws, and every emitted item is complete and in order', () => {
    fc.assert(fc.property(fc.array(parsedTrack, { maxLength: 8 }), sizes, (tracks, fileSizes) => {
      const xml = Code.buildRssFeed_(tracks, fileSizes);
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
      const expected = tracks.filter((t) => t.published !== false && t.file && t.suno
        && Object.prototype.hasOwnProperty.call(fileSizes, t.file)
        && Number.isFinite(fileSizes[t.file]) && fileSizes[t.file] >= 0
        && Code.formatRssDate_(t.publishedAt));
      expect(items).toHaveLength(expected.length);
      items.forEach((item) => {
        expect(item).toContain('<link>');
        expect(item).toContain('<guid isPermaLink="false">');
        expect(item).toContain('<pubDate>');
        expect(item).toContain('<enclosure url="https://archive.org/download/');
        expect(item).toContain('<itunes:duration>');
      });
      // Dates descend; equal dates keep ascending sort order.
      const order = items.map((item) => tracks.find(
        (t) => item.includes(`<guid isPermaLink="false">${Code.escapeXml_(t.file)}</guid>`),
      ));
      for (let i = 1; i < order.length; i += 1) {
        const prev = order[i - 1];
        const cur = order[i];
        if (!prev || !cur) continue;
        const byDate = Code.cellDate_(cur.publishedAt)
          .localeCompare(Code.cellDate_(prev.publishedAt));
        expect(byDate).toBeLessThanOrEqual(0);
        if (byDate === 0) expect(prev.sort).toBeLessThanOrEqual(cur.sort);
      }
    }), NUM_RUNS);
  });
});

describe('buildArticlePlan_', () => {
  const meta = fc.record({
    tags: fc.string(),
    suno_profile: fc.string(),
    podcast_feed: fc.string(),
    intro: fc.string(),
    outro: fc.string(),
  });

  it('never throws and keeps one marker and one heading per track', () => {
    fc.assert(fc.property(fc.array(parsedTrack, { maxLength: 6 }), meta, (tracks, m) => {
      const plan = Code.buildArticlePlan_(tracks, m);
      expect(plan[0]).toMatchObject({ kind: 'text' });
      expect(plan[0].text.startsWith('[[タグ：')).toBe(true);
      expect(plan.filter((p) => p.kind === 'heading')).toHaveLength(tracks.length);
      expect(plan.filter(
        (p) => p.kind === 'text' && p.text.startsWith('[[音楽|'),
      )).toHaveLength(tracks.length);
      plan.filter((p) => p.kind === 'link').forEach((p) => {
        expect(typeof p.url).toBe('string');
        expect(p.url.length).toBeGreaterThan(0);
      });
      plan.forEach((p) => {
        if (p.text !== undefined) expect(p.text).not.toMatch(LONE);
      });
    }), NUM_RUNS);
  });
});

describe('trackRowCells_', () => {
  it('always returns one well-typed cell per header', () => {
    const payload = fc.dictionary(fc.constantFrom(...HEADER), jsonish);
    fc.assert(fc.property(payload, (track) => {
      const cells = Code.trackRowCells_(track, HEADER);
      expect(cells).toHaveLength(HEADER.length);
      HEADER.forEach((h, i) => {
        if (h === 'published') expect(typeof cells[i]).toBe('boolean');
        else if (h === 'sort') {
          expect(cells[i] === '' || Number.isFinite(cells[i])).toBe(true);
        } else if (h === 'duration_sec') {
          expect(Number.isInteger(cells[i])).toBe(true);
          expect(cells[i]).toBeGreaterThanOrEqual(0);
        } else expect(typeof cells[i]).toBe('string');
      });
    }), NUM_RUNS);
  });
});

describe('archiveUrl_', () => {
  it('always builds an archive.org download URL under the identifier prefix', () => {
    fc.assert(fc.property(fc.string(), (file) => {
      const url = Code.archiveUrl_(file);
      expect(url.startsWith('https://archive.org/download/freddiefujiwara-')).toBe(true);
      expect(url).not.toMatch(/\s/);
    }), NUM_RUNS);
  });
});
