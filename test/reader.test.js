// The screenshot reader's pure parts, taken straight from public/index.html (the page has no build
// step, so the test reads the same source the browser runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const page = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const between = (from, to) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)));
const music = between('/*MUSIC-START*/', '/*MUSIC-END*/');
const reader = between('  const DARK_INK_FROM', '  async function prepShot(');
const layout = between('  function oneReadingPerLetter(', '  async function ocrShots(');
const R = new Function(`${music}\n${reader}\n${layout}\nreturn { readingGrey, oneReadingPerLetter, layoutLines };`)();

const sym = (t, x0, x1, y0 = 0, y1 = 30) => ({ text: t, bbox: { x0, x1, y0, y1 } });
const word = (syms) => ({ text: syms.map((s) => s.text).join(''), symbols: syms,
  bbox: { x0: syms[0].bbox.x0, x1: syms[syms.length - 1].bbox.x1, y0: Math.min(...syms.map((s) => s.bbox.y0)), y1: Math.max(...syms.map((s) => s.bbox.y1)) } });
const line = (words) => ({ bbox: { x0: words[0].bbox.x0, x1: words[words.length - 1].bbox.x1,
  y0: Math.min(...words.map((w) => w.bbox.y0)), y1: Math.max(...words.map((w) => w.bbox.y1)) }, words });
// a lyric line of evenly spaced letters starting at x, one letter every 20px
const lyric = (text, y, x = 40) => {
  const words = []; let at = x;
  for (const t of text.split(' ')) {
    const syms = [...t].map((ch, i) => sym(ch, at + i * 20, at + i * 20 + 16, y, y + 28));
    words.push(word(syms)); at += t.length * 20 + 20;
  }
  return line(words);
};

test('a light page reads the darkest colour channel, as before', () => {
  assert.equal(R.readingGrey(63, 169, 245, false), 63, 'light-blue chord text stays dark');
  assert.equal(R.readingGrey(34, 34, 34, false), 34);
  assert.equal(R.readingGrey(255, 255, 255, false), 255);
});

test('a dark page reads light letters as ink and coloured chord boxes as background', () => {
  assert.equal(R.readingGrey(17, 17, 17, true), 255, 'the page is background');
  assert.equal(R.readingGrey(75, 63, 158, true), 255, 'a purple chord box is background');
  assert.equal(R.readingGrey(255, 255, 255, true), 0, 'the white letter in it is ink');
  assert.equal(R.readingGrey(255, 209, 102, true), 0, 'yellow chord text is ink, not lost');
  assert.ok(R.readingGrey(150, 150, 150, true) < 40, 'grey section names are ink');
});

test('one letter read twice becomes one letter', () => {
  // a chord's bold C split into "C" + "c" side by side
  let r = R.oneReadingPerLetter([sym('C', 227, 242), sym('c', 242, 255)], 'Cc');
  assert.equal(r.text, 'C');
  // overlapping, as the reader also does
  r = R.oneReadingPerLetter([sym('C', 116, 133), sym('c', 120, 148)], 'Cc');
  assert.equal(r.text, 'C');
  // a letter read again inside its own width: a monospace "I" read as "IT"
  r = R.oneReadingPerLetter([sym('I', 324, 338), sym('T', 334, 338)], 'IT');
  assert.equal(r.text, 'I');
});

test('real words and flat chords are left alone', () => {
  assert.equal(R.oneReadingPerLetter([sym('B', 0, 16), sym('b', 16, 30)], 'Bb').text, 'Bb', 'B-flat stays');
  const aaron = [sym('A', 0, 16), sym('a', 17, 30), sym('r', 32, 40), sym('o', 42, 54), sym('n', 56, 68)];
  assert.equal(R.oneReadingPerLetter(aaron, 'Aaron').text, 'Aaron');
  assert.equal(R.oneReadingPerLetter([sym('E', 0, 16), sym('m', 20, 40)], 'Em').text, 'Em');
});

test('a chord read as "Cc" lands as C over its word', () => {
  const chordRow = line([word([sym('C', 200, 220, 0, 30), sym('c', 220, 236, 0, 30)])]);
  const rows = R.layoutLines([chordRow, lyric('Chafe beneath the clouds', 40)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text.trim(), 'C', 'one C, not "Cc"');
  assert.equal(rows[1].text.replace(/\s+/g, ' '), 'Chafe beneath the clouds');
  const col = rows[0].text.indexOf('C'), start = rows[1].text.indexOf('beneath');
  assert.ok(col >= start && col < start + 'beneath'.length, 'the C sits over "beneath"');
});
