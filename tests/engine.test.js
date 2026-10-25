'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

function close(actual, expected, eps) {
  assert.ok(Math.abs(actual - expected) <= (eps === undefined ? 1e-9 : eps), 'expected ' + actual + ' to be within ' + eps + ' of ' + expected);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

test('tokenizeDocument lowercases and drops stopwords', () => {
  assert.deepEqual(E.tokenizeDocument('The Quick BROWN fox and the dog'), ['quick', 'brown', 'fox', 'dog']);
});

test('tokenizeDocument removes apostrophes instead of splitting words', () => {
  assert.deepEqual(E.tokenizeDocument("don't stop, it's Aariv\u2019s"), ['dont', 'stop', 'aarivs']);
});

test('tokenizeDocument keeps digits and splits on punctuation', () => {
  assert.deepEqual(E.tokenizeDocument('port 8090/tcp, sqlite3.db'), ['port', '8090', 'tcp', 'sqlite3', 'db']);
});

test('tokenizeDocument handles non ASCII letters', () => {
  assert.deepEqual(E.tokenizeDocument('caf\u00e9 na\u00efve'), ['caf\u00e9', 'na\u00efve']);
});

test('tokenizeDocument can keep stopwords on request', () => {
  assert.deepEqual(E.tokenizeDocument('the cat', { keepStopwords: true }), ['the', 'cat']);
});

test('tokenizeDocument tolerates null and empty input', () => {
  assert.deepEqual(E.tokenizeDocument(null), []);
  assert.deepEqual(E.tokenizeDocument(''), []);
});

test('wordCount counts letter and digit runs', () => {
  assert.equal(E.wordCount('one two, three 4'), 4);
  assert.equal(E.wordCount(''), 0);
});

// ---------------------------------------------------------------------------
// Inverted index and BM25
// ---------------------------------------------------------------------------

const DOCS = [
  { id: 'a', title: '', body: 'apple banana apple', tags: [] },
  { id: 'b', title: '', body: 'banana cherry', tags: [] },
  { id: 'c', title: '', body: 'cherry date elder fig', tags: [] }
];

test('buildInvertedIndex records N, lengths and average length', () => {
  const ix = E.buildInvertedIndex(DOCS);
  assert.equal(ix.N, 3);
  assert.equal(ix.lengths.get('a'), 3);
  assert.equal(ix.lengths.get('b'), 2);
  assert.equal(ix.lengths.get('c'), 4);
  assert.equal(ix.avgdl, 3);
});

test('buildInvertedIndex stores term frequencies per document', () => {
  const ix = E.buildInvertedIndex(DOCS);
  assert.equal(ix.postings.get('apple').get('a'), 2);
  assert.equal(ix.postings.get('banana').size, 2);
  assert.equal(ix.postings.get('fig').get('c'), 1);
});

test('title tokens count three times and tag tokens twice', () => {
  const ix = E.buildInvertedIndex([{ id: 'x', title: 'Docker', body: 'plain', tags: ['homelab'] }]);
  assert.equal(ix.postings.get('docker').get('x'), 3);
  assert.equal(ix.postings.get('homelab').get('x'), 2);
  assert.equal(ix.postings.get('plain').get('x'), 1);
  assert.equal(ix.lengths.get('x'), 6);
});

test('buildInvertedIndex of nothing is empty and searches return nothing', () => {
  const ix = E.buildInvertedIndex([]);
  assert.equal(ix.N, 0);
  assert.deepEqual(E.bm25Search(ix, 'anything'), []);
});

test('bm25Idf matches ln(1 + (N - n + 0.5) / (n + 0.5))', () => {
  close(E.bm25Idf(3, 1), Math.log(8 / 3));
  close(E.bm25Idf(10, 10), Math.log(1 + 0.5 / 10.5));
  assert.ok(E.bm25Idf(100, 100) > 0, 'idf stays positive even for a term in every document');
});

test('bm25Search hand computed score for a single term', () => {
  const ix = E.buildInvertedIndex(DOCS);
  const hits = E.bm25Search(ix, 'apple');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'a');
  // idf = ln(8/3), tf = 2, dl = 3, avgdl = 3: tf*(k1+1) / (tf + k1*(1 - b + b*dl/avgdl)) = 5 / 3.5
  close(hits[0].score, Math.log(8 / 3) * 5 / 3.5);
  close(hits[0].score, 1.4012, 1e-4);
});

test('bm25Search sums the score of several query terms', () => {
  const ix = E.buildInvertedIndex(DOCS);
  const hits = E.bm25Search(ix, 'banana cherry');
  const byId = Object.fromEntries(hits.map((h) => [h.id, h.score]));
  const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5));
  // doc b: tf 1 for both, dl 2: 2.5 / (1 + 1.5 * (0.25 + 0.75 * 2/3))
  const partB = idf * 2.5 / (1 + 1.5 * (0.25 + 0.75 * 2 / 3));
  close(byId.b, 2 * partB);
  assert.equal(hits[0].id, 'b', 'the document matching both terms ranks first');
  assert.deepEqual(hits[0].terms.sort(), ['banana', 'cherry']);
});

test('bm25Search term frequency saturates instead of growing linearly', () => {
  const ix = E.buildInvertedIndex([
    { id: 'one', body: 'rust filler filler filler filler' },
    { id: 'two', body: 'rust rust filler filler filler' },
    { id: 'four', body: 'rust rust rust rust filler' },
    { id: 'none', body: 'filler filler filler filler filler' }
  ]);
  const s = Object.fromEntries(E.bm25Search(ix, 'rust').map((h) => [h.id, h.score]));
  assert.ok(s.two > s.one && s.four > s.two);
  assert.ok(s.four - s.two < (s.two - s.one) * 3, 'gains shrink as tf grows');
});

test('bm25Search penalises long documents when b is above zero', () => {
  const ix = E.buildInvertedIndex([
    { id: 'short', body: 'needle pad' },
    { id: 'long', body: 'needle pad pad pad pad pad pad pad pad pad' }
  ]);
  const withB = E.bm25Search(ix, 'needle');
  assert.equal(withB[0].id, 'short');
  const noB = E.bm25Search(ix, 'needle', { b: 0 });
  close(noB[0].score, noB[1].score, 1e-12);
});

test('bm25Search honours custom k1', () => {
  const ix = E.buildInvertedIndex(DOCS);
  const k0 = E.bm25Search(ix, 'apple', { k1: 0 })[0].score;
  close(k0, Math.log(8 / 3), 1e-12);
});

test('bm25Search breaks ties by id', () => {
  const ix = E.buildInvertedIndex([{ id: 'b', body: 'same' }, { id: 'a', body: 'same' }, { id: 'c', body: 'other' }]);
  assert.deepEqual(E.bm25Search(ix, 'same').map((h) => h.id), ['a', 'b']);
});

test('bm25Search supports limit and requireAll', () => {
  const ix = E.buildInvertedIndex(DOCS);
  assert.equal(E.bm25Search(ix, 'banana cherry', { limit: 1 }).length, 1);
  assert.deepEqual(E.bm25Search(ix, 'banana cherry', { requireAll: true }).map((h) => h.id), ['b']);
});

test('bm25Search ignores stopword only queries and unknown terms', () => {
  const ix = E.buildInvertedIndex(DOCS);
  assert.deepEqual(E.bm25Search(ix, 'the and of'), []);
  assert.deepEqual(E.bm25Search(ix, 'zebra'), []);
});

test('bm25Search is safe with terms that collide with object prototype names', () => {
  const ix = E.buildInvertedIndex([{ id: 'p', body: 'constructor prototype toString' }]);
  assert.equal(E.bm25Search(ix, 'constructor')[0].id, 'p');
  assert.deepEqual(E.bm25Search(ix, 'hasOwnProperty'), []);
});

test('a title match outranks the same word buried in a body', () => {
  const ix = E.buildInvertedIndex([
    { id: 'body', title: 'Notes', body: 'sqlite is mentioned once here among other words about gardens and bread' },
    { id: 'title', title: 'SQLite', body: 'gardens and bread and other words about cooking' }
  ]);
  assert.equal(E.bm25Search(ix, 'sqlite')[0].id, 'title');
});

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

test('makeSnippet wraps matching words in mark tags', () => {
  const html = E.makeSnippet('Run the container behind a reverse proxy.', ['container', 'proxy'], 200);
  assert.equal(html, 'Run the <mark>container</mark> behind a reverse <mark>proxy</mark>.');
});

test('makeSnippet escapes HTML in the source text', () => {
  const html = E.makeSnippet('<script>alert(1)</script> docker', ['docker'], 200);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<mark>docker</mark>'));
});

test('makeSnippet centres long text on the first hit and adds ellipses', () => {
  const text = 'word '.repeat(60) + 'needle ' + 'word '.repeat(60);
  const html = E.makeSnippet(text, ['needle'], 80);
  assert.ok(html.startsWith('...'));
  assert.ok(html.endsWith('...'));
  assert.ok(html.includes('<mark>needle</mark>'));
});

test('makeSnippet only marks whole words', () => {
  assert.equal(E.makeSnippet('catalog cat', ['cat'], 100), 'catalog <mark>cat</mark>');
});

test('makeSnippet handles empty text and no terms', () => {
  assert.equal(E.makeSnippet('', ['x']), '');
  assert.equal(E.makeSnippet('plain text', []), 'plain text');
});

// ---------------------------------------------------------------------------
// SM-2
// ---------------------------------------------------------------------------

test('SM-2 first perfect review schedules one day and raises EF to 2.6', () => {
  const c = E.scheduleSm2Review(null, 5, '2026-10-25');
  assert.equal(c.repetitions, 1);
  assert.equal(c.interval, 1);
  close(c.ef, 2.6);
  assert.equal(c.due, '2026-10-26');
});

test('SM-2 second review is six days and the third multiplies by EF', () => {
  let c = E.scheduleSm2Review(null, 5, '2026-10-25');
  c = E.scheduleSm2Review(c, 5, '2026-10-26');
  assert.equal(c.interval, 6);
  close(c.ef, 2.7);
  assert.equal(c.due, '2026-11-01');
  c = E.scheduleSm2Review(c, 5, '2026-11-01');
  assert.equal(c.interval, 16, 'round(6 * 2.7) = 16');
  close(c.ef, 2.8);
});

test('SM-2 quality 4 leaves EF unchanged', () => {
  const c = E.scheduleSm2Review({ repetitions: 2, interval: 6, ef: 2.5, due: '2026-01-01' }, 4, '2026-01-01');
  close(c.ef, 2.5);
  assert.equal(c.interval, 15);
});

test('SM-2 quality 3 lowers EF by 0.14', () => {
  const c = E.scheduleSm2Review({ repetitions: 2, interval: 6, ef: 2.5, due: '2026-01-01' }, 3, '2026-01-01');
  close(c.ef, 2.36);
  assert.equal(c.interval, 15);
});

test('SM-2 lapse below 3 restarts repetitions and keeps EF', () => {
  const c = E.scheduleSm2Review({ repetitions: 5, interval: 80, ef: 2.2, due: '2026-01-01' }, 2, '2026-01-01');
  assert.equal(c.repetitions, 0);
  assert.equal(c.interval, 1);
  close(c.ef, 2.2);
  assert.equal(c.due, '2026-01-02');
});

test('SM-2 easiness factor never drops below 1.3', () => {
  let c = null;
  for (let i = 0; i < 20; i++) c = E.scheduleSm2Review(c, 3, '2026-01-01');
  close(c.ef, 1.3);
});

test('SM-2 rejects invalid quality values', () => {
  assert.throws(() => E.scheduleSm2Review(null, 6), RangeError);
  assert.throws(() => E.scheduleSm2Review(null, -1), RangeError);
  assert.throws(() => E.scheduleSm2Review(null, 2.5), RangeError);
  assert.throws(() => E.scheduleSm2Review(null, '4'), RangeError);
});

test('SM-2 does not mutate the card it was given', () => {
  const card = Object.freeze({ repetitions: 1, interval: 1, ef: 2.5, due: '2026-01-01' });
  const next = E.scheduleSm2Review(card, 5, '2026-01-01');
  assert.equal(card.repetitions, 1);
  assert.equal(next.repetitions, 2);
});

test('addDaysIso crosses month and year boundaries and leap days', () => {
  assert.equal(E.addDaysIso('2026-12-31', 1), '2027-01-01');
  assert.equal(E.addDaysIso('2028-02-28', 1), '2028-02-29');
  assert.equal(E.addDaysIso('2026-10-25', 16), '2026-11-10');
});

test('previewIntervals shows what each answer would schedule', () => {
  const card = { repetitions: 2, interval: 10, ef: 2.5, due: '2026-01-01' };
  const p = E.previewIntervals(card, [1, 3, 4, 5], '2026-01-01');
  assert.deepEqual(p.map((x) => x.interval), [1, 25, 25, 25]);
});

// ---------------------------------------------------------------------------
// Cloud rent calculator
// ---------------------------------------------------------------------------

test('catalog holds twelve subscriptions and no discontinued Pocket row', () => {
  assert.equal(E.SUBSCRIPTION_CATALOG.length, 12);
  assert.ok(!E.SUBSCRIPTION_CATALOG.some((s) => /pocket/i.test(s.name)));
});

test('default scenario rents out 239.76 a year', () => {
  const r = E.computeSubscriptionSavings(E.defaultCalcState());
  assert.equal(r.saasMonthly, 19.98);
  assert.equal(r.saasAnnual, 239.76);
});

test('default scenario electricity is 6 W at 0.17 per kWh', () => {
  const r = E.computeSubscriptionSavings(E.defaultCalcState());
  close(r.powerKwhYear, 52.56);
  assert.equal(r.powerAnnual, 8.94);
  assert.equal(r.netAnnual, 230.82);
});

test('default scenario breaks even on day 190', () => {
  const r = E.computeSubscriptionSavings(E.defaultCalcState());
  assert.equal(r.breakEvenDay, 190);
  close(r.crossMonth, 6.238, 0.002);
});

test('default scenario five year saving is 1034.12', () => {
  const r = E.computeSubscriptionSavings(E.defaultCalcState());
  assert.equal(r.fiveYearPlain, 1034.12);
  assert.equal(r.fiveYearCompounded, 1034.12);
  assert.equal(r.yearly.length, 5);
});

test('disabled and unpriced subscriptions are left out', () => {
  const s = E.defaultCalcState();
  s.enabled = ['readwise', 'googleone'];
  const r = E.computeSubscriptionSavings(s);
  assert.equal(r.saasMonthly, 9.99, 'Google One has no price so it adds nothing');
  assert.equal(r.lines.find((l) => l.id === 'googleone').monthly, 0);
});

test('entering a price for a blank subscription counts it', () => {
  const s = E.defaultCalcState();
  s.enabled = ['googleone'];
  s.prices.googleone = 1.99;
  assert.equal(E.computeSubscriptionSavings(s).saasMonthly, 1.99);
});

test('yearly price growth compounds the rent', () => {
  const s = E.defaultCalcState();
  s.saasGrowth = 0.1;
  const r = E.computeSubscriptionSavings(s);
  close(r.yearly[1].saas, 239.76 * 1.1, 0.01);
  close(r.yearly[2].saas, 239.76 * 1.21, 0.01);
  assert.ok(r.fiveYearPlain > 1034.12);
});

test('reinvesting savings compounds the five year total', () => {
  const s = E.defaultCalcState();
  s.reinvest = 0.05;
  const r = E.computeSubscriptionSavings(s);
  assert.ok(r.fiveYearCompounded > r.fiveYearPlain);
  const net = 239.76 - 52.56 * 0.17;
  let expect = 0;
  for (let y = 0; y < 5; y++) expect += net * Math.pow(1.05, 4 - y);
  close(r.fiveYearCompounded, Math.floor((expect - 120) * 100 + 0.5) / 100, 0.011);
});

test('free hardware breaks even on day zero', () => {
  const s = E.defaultCalcState();
  s.hardwareCost = 0;
  const r = E.computeSubscriptionSavings(s);
  assert.equal(r.breakEvenDay, 0);
  assert.equal(r.crossMonth, 0);
});

test('a box that costs more to run than the rent never breaks even', () => {
  const s = E.defaultCalcState();
  s.watts = 400;
  const r = E.computeSubscriptionSavings(s);
  assert.equal(r.breakEvenDay, null);
  assert.equal(r.crossMonth, null);
  assert.ok(r.netAnnual < 0);
});

test('chart series run month 0 through month 36 for three years', () => {
  const s = E.defaultCalcState();
  s.years = 3;
  const r = E.computeSubscriptionSavings(s);
  assert.equal(r.series.saas.length, 37);
  assert.equal(r.series.own.length, 37);
  assert.equal(r.series.saas[0], 0);
  assert.equal(r.series.own[0], 120);
  close(r.series.saas[12], 239.76, 1e-9);
  close(r.series.own[12], 120 + 8.9352, 1e-9);
});

test('extra annual cost such as a domain shifts break even later', () => {
  const s = E.defaultCalcState();
  s.extraAnnual = 12;
  const r = E.computeSubscriptionSavings(s);
  assert.equal(r.ownAnnual, 20.94);
  assert.ok(r.breakEvenDay > 190);
});

test('normalizeCalc clamps nonsense input', () => {
  const c = E.normalizeCalc({ hardwareCost: -50, watts: 'abc', saasGrowth: 9, years: 99, enabled: ['readwise', 'nope'] });
  assert.equal(c.hardwareCost, 0);
  assert.equal(c.watts, 6);
  assert.equal(c.saasGrowth, 1);
  assert.equal(c.years, 10);
  assert.deepEqual(c.enabled, ['readwise']);
});

test('calculator URL state round trips and defaults encode to nothing', () => {
  assert.equal(E.encodeCalcState(E.defaultCalcState()), '');
  const s = E.defaultCalcState();
  s.enabled = ['readwise', 'notion'];
  s.watts = 12;
  s.prices.googleone = 2.99;
  const back = E.decodeCalcState(E.encodeCalcState(s));
  assert.deepEqual(back.enabled, ['readwise', 'notion']);
  assert.equal(back.watts, 12);
  assert.equal(back.prices.googleone, 2.99);
});

test('decodeCalcState falls back to defaults on garbage', () => {
  assert.deepEqual(E.decodeCalcState('%%%not-base64%%%'), E.defaultCalcState());
  assert.deepEqual(E.decodeCalcState(''), E.defaultCalcState());
});

test('hardware presets are labelled estimates with sane values', () => {
  assert.equal(E.HARDWARE_PRESETS.length, 3);
  E.HARDWARE_PRESETS.forEach((h) => { assert.ok(h.cost >= 0 && h.watts > 0); });
});

// ---------------------------------------------------------------------------
// Readability
// ---------------------------------------------------------------------------

const PAGE = '<!doctype html><html><head><title>Pi-hole in plain words | Some Blog</title>' +
  '<meta property="og:title" content="Pi-hole &amp; DNS sinkholes"></head><body>' +
  '<nav><a href="/">Home</a><a href="/about">About</a></nav>' +
  '<div class="sidebar"><p>Subscribe to the newsletter for more posts, tips, and tricks every week.</p></div>' +
  '<article><h1>Pi-hole &amp; DNS sinkholes</h1>' +
  '<p>A DNS sinkhole answers queries for blocked names with an address that goes nowhere, which stops the connection early.</p>' +
  '<h2>Limits</h2>' +
  '<p>Apps that use their own encrypted resolver can skip it, so a sinkhole is a filter, not a firewall, and should be treated as one.</p>' +
  '<ul><li>Blocklists need upkeep</li></ul>' +
  '<pre>dig example.com @192.168.1.2</pre>' +
  '</article><footer><p>Copyright notice that must not appear in the extracted text, ever.</p></footer>' +
  '<script>var junk = "<p>script text</p>";</script></body></html>';

test('extractReadable prefers og:title over the title tag', () => {
  assert.equal(E.extractReadable(PAGE).title, 'Pi-hole & DNS sinkholes');
});

test('extractReadable keeps article paragraphs and drops chrome', () => {
  const r = E.extractReadable(PAGE);
  assert.ok(r.text.includes('A DNS sinkhole answers queries'));
  assert.ok(r.text.includes('## Limits'));
  assert.ok(r.text.includes('- Blocklists need upkeep'));
  assert.ok(r.text.includes('dig example.com @192.168.1.2'));
  assert.ok(!r.text.includes('Subscribe to the newsletter'));
  assert.ok(!r.text.includes('Copyright notice'));
  assert.ok(!r.text.includes('script text'));
  assert.ok(!r.text.includes('Home'));
});

test('extractReadable does not repeat the h1 inside the body', () => {
  const r = E.extractReadable(PAGE);
  assert.ok(!r.blocks.some((b) => b.type === 'h' && b.text === 'Pi-hole & DNS sinkholes'));
});

test('extractReadable decodes entities and counts words', () => {
  const r = E.extractReadable('<body><div><p>Fish &amp; chips &#38; peas &#x26; more words go in this one long paragraph, for length.</p></div></body>');
  assert.ok(r.text.startsWith('Fish & chips & peas & more'));
  assert.equal(r.wordCount, E.wordCount(r.text));
});

test('extractReadable picks the densest container among several', () => {
  const html = '<body><div id="a"><p>Short blurb here that is a little over twenty five characters.</p></div>' +
    '<div id="b"><p>This is the real story, with several clauses, commas, and detail that goes on for a while longer than the blurb does.</p>' +
    '<p>And a second long paragraph, again with commas, to push this container well ahead of the other one in score.</p></div></body>';
  const r = E.extractReadable(html);
  assert.ok(r.text.includes('real story'));
  assert.ok(!r.text.includes('Short blurb'));
});

test('extractReadable drops link heavy list blocks', () => {
  const html = '<body><article><p>Real paragraph with enough words to be a paragraph worth keeping in the output text.</p>' +
    '<ul><li><a href="/1">Link one</a></li><li><a href="/2">Link two</a></li></ul></article></body>';
  const r = E.extractReadable(html);
  assert.ok(!r.text.includes('Link one'));
});

test('extractReadable falls back to body text when no paragraphs score', () => {
  const r = E.extractReadable('<html><title>Tiny</title><body><h2>Heading</h2><li>item</li></body></html>');
  assert.equal(r.title, 'Tiny');
  assert.ok(r.text.includes('Heading'));
});

test('extractReadable survives empty and broken input', () => {
  assert.equal(E.extractReadable('').text, '');
  assert.doesNotThrow(() => E.extractReadable('<p>unclosed <b>tags <div>everywhere'));
  assert.doesNotThrow(() => E.extractReadable(null));
});

// ---------------------------------------------------------------------------
// Netscape bookmarks
// ---------------------------------------------------------------------------

const BOOKMARKS = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
  '  <DT><A HREF="https://example.com/a" ADD_DATE="1700000000" TAGS="docker,homelab">Alpha &amp; Co</A>\n' +
  '  <DD>A note about alpha\n' +
  '  <DT><H3 ADD_DATE="1700000001">Reading</H3>\n' +
  '  <DL><p>\n' +
  '    <DT><A HREF="https://example.com/b">Beta</A>\n' +
  '    <DT><H3>Deep</H3>\n' +
  '    <DL><p>\n      <DT><A HREF="http://example.com/c" TAGS="x">Gamma</A>\n    </DL><p>\n' +
  '  </DL><p>\n' +
  '  <DT><A HREF="javascript:alert(1)">Bookmarklet</A>\n' +
  '</DL><p>\n';

test('parseNetscapeBookmarks reads titles, urls, tags and dates', () => {
  const items = E.parseNetscapeBookmarks(BOOKMARKS);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Alpha & Co');
  assert.equal(items[0].url, 'https://example.com/a');
  assert.deepEqual(items[0].tags, ['docker', 'homelab']);
  assert.equal(items[0].addDate, '2023-11-14');
});

test('parseNetscapeBookmarks tracks nested folders', () => {
  const items = E.parseNetscapeBookmarks(BOOKMARKS);
  assert.equal(items[0].folder, '');
  assert.equal(items[1].folder, 'Reading');
  assert.equal(items[2].folder, 'Reading/Deep');
});

test('parseNetscapeBookmarks keeps notes and skips javascript links', () => {
  const items = E.parseNetscapeBookmarks(BOOKMARKS);
  assert.equal(items[0].note, 'A note about alpha');
  assert.ok(!items.some((i) => /javascript/i.test(i.url)));
});

test('parseNetscapeBookmarks copes with lower case tags and empty input', () => {
  const items = E.parseNetscapeBookmarks('<dl><dt><a href="https://x.test/">x</a></dl>');
  assert.equal(items.length, 1);
  assert.deepEqual(E.parseNetscapeBookmarks(''), []);
  assert.deepEqual(E.parseNetscapeBookmarks(null), []);
});

test('exportNetscapeBookmarks writes the doctype and escapes titles', () => {
  const out = E.exportNetscapeBookmarks([{ title: 'A <b> & "c"', url: 'https://x.test/?a=1&b=2', tags: ['t1', 't2'], addDate: '2023-11-14' }]);
  assert.ok(out.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
  assert.ok(out.includes('A &lt;b&gt; &amp; &quot;c&quot;'));
  assert.ok(out.includes('HREF="https://x.test/?a=1&amp;b=2"'));
  assert.ok(out.includes('ADD_DATE="1699920000"'));
  assert.ok(out.includes('TAGS="t1,t2"'));
});

test('bookmarks survive an export then import round trip', () => {
  const items = E.parseNetscapeBookmarks(BOOKMARKS);
  const again = E.parseNetscapeBookmarks(E.exportNetscapeBookmarks(items));
  assert.equal(again.length, items.length);
  again.forEach((it, i) => {
    assert.equal(it.url, items[i].url);
    assert.equal(it.title, items[i].title);
    assert.equal(it.folder, items[i].folder);
    assert.deepEqual(it.tags, items[i].tags);
    assert.equal(it.note, items[i].note);
  });
  assert.equal(again[0].addDate, '2023-11-14');
});

// ---------------------------------------------------------------------------
// Cron and Compose generator
// ---------------------------------------------------------------------------

test('validateCron accepts common schedules', () => {
  ['0 3 * * *', '*/15 * * * *', '0 0 1 1 *', '5,35 2-4 * * 1-5', '0 3 * * 7'].forEach((c) => {
    assert.equal(E.validateCron(c).valid, true, c);
  });
});

test('validateCron rejects malformed schedules', () => {
  ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', 'a b c d e', '*/0 * * * *', '5-2 * * * *', '* * * * * *'].forEach((c) => {
    const v = E.validateCron(c);
    assert.equal(v.valid, false, c);
    assert.ok(v.error.length > 0);
  });
});

test('generateDockerCompose default publishes the port and mounts data', () => {
  const g = E.generateDockerCompose({});
  assert.ok(g.compose.includes('"${VAULT_PORT:-8090}:8090"'));
  assert.ok(g.compose.includes('./data:/data'));
  assert.ok(g.compose.includes('healthcheck:'));
  assert.ok(g.compose.includes('restart: unless-stopped'));
  assert.equal(g.caddyfile, null);
  assert.ok(g.env.includes('VAULT_PORT=8090'));
});

test('generateDockerCompose honours port and volume path', () => {
  const g = E.generateDockerCompose({ port: 9000, dataPath: '/srv/vault' });
  assert.ok(g.compose.includes('${VAULT_PORT:-9000}:8090'));
  assert.ok(g.compose.includes('/srv/vault:/data'));
  assert.ok(g.env.includes('VAULT_PORT=9000'));
});

test('generateDockerCompose rejects unsafe paths and ports', () => {
  const g = E.generateDockerCompose({ port: 99999, dataPath: '$(rm -rf /)' });
  assert.ok(g.compose.includes('${VAULT_PORT:-65535}'));
  assert.ok(g.compose.includes('./data:/data'));
  assert.ok(!g.compose.includes('rm -rf'));
});

test('generateDockerCompose adds backup settings only for a valid cron', () => {
  const on = E.generateDockerCompose({ backupCron: '0 3 * * *', backupPath: './bk' });
  assert.ok(on.compose.includes('VAULT_BACKUP_CRON: "0 3 * * *"'));
  assert.ok(on.compose.includes('./bk:/backups'));
  assert.equal(on.backupEnabled, true);
  const off = E.generateDockerCompose({ backupCron: 'nonsense' });
  assert.ok(!off.compose.includes('VAULT_BACKUP'));
  assert.equal(off.backupEnabled, false);
});

test('generateDockerCompose with caddy hides the app port and emits a Caddyfile', () => {
  const g = E.generateDockerCompose({ proxy: 'caddy', domain: 'Vault.Example.com' });
  assert.ok(g.compose.includes('image: caddy:2-alpine'));
  assert.ok(g.compose.includes('expose:'));
  assert.ok(!g.compose.includes('VAULT_PORT'));
  assert.ok(g.compose.includes('caddy-data:'));
  assert.ok(g.caddyfile.startsWith('vault.example.com {'));
  assert.ok(g.caddyfile.includes('reverse_proxy vault:8090'));
});

test('generateDockerCompose with tailscale shares the sidecar network', () => {
  const g = E.generateDockerCompose({ proxy: 'tailscale' });
  assert.ok(g.compose.includes('network_mode: "service:tailscale"'));
  assert.ok(g.compose.includes('/dev/net/tun'));
  assert.ok(g.env.includes('TS_AUTHKEY='));
  assert.ok(!g.compose.includes('ports:'));
});

test('generateDockerCompose strips odd characters from the token and timezone', () => {
  const g = E.generateDockerCompose({ token: 'abc def;rm', timezone: 'Not A Zone!' });
  assert.ok(g.env.includes('VAULT_TOKEN=abcdefrm'));
  assert.ok(g.env.includes('TZ=UTC'));
});

test('generated files contain no tabs and use two space indentation', () => {
  ['none', 'caddy', 'tailscale'].forEach((proxy) => {
    const g = E.generateDockerCompose({ proxy: proxy, backupCron: '0 3 * * *' });
    assert.ok(!g.compose.includes('\t'));
    g.compose.split('\n').forEach((line) => { assert.equal((line.length - line.trimStart().length) % 2, 0, line); });
  });
});

// ---------------------------------------------------------------------------
// Frozen parity fixtures shared with server/app.py
// ---------------------------------------------------------------------------

const PARITY = require('./fixtures/parity.json');

test('parity: tokenizer cases', () => {
  PARITY.tokenize.forEach((c) => { assert.deepEqual(E.tokenizeDocument(c.in), c.out, c.in); });
});

test('parity: BM25 rankings and scores', () => {
  PARITY.bm25.forEach((c) => {
    const ix = E.buildInvertedIndex(c.docs);
    const hits = E.bm25Search(ix, c.query);
    assert.deepEqual(hits.map((h) => h.id), c.expect.map((e) => e.id), c.query);
    hits.forEach((h, i) => close(h.score, c.expect[i].score, 1e-9));
  });
});

test('parity: SM-2 sequences', () => {
  PARITY.sm2.forEach((c) => {
    let card = null;
    c.qualities.forEach((q, i) => {
      card = E.scheduleSm2Review(card, q, c.today);
      assert.equal(card.interval, c.expect[i].interval);
      assert.equal(card.repetitions, c.expect[i].repetitions);
      close(card.ef, c.expect[i].ef, 1e-9);
    });
  });
});

test('parity: savings scenarios', () => {
  PARITY.savings.forEach((c) => {
    const r = E.computeSubscriptionSavings(c.input);
    Object.keys(c.expect).forEach((k) => {
      if (c.expect[k] === null) assert.equal(r[k], null, k); else close(r[k], c.expect[k], 1e-9);
    });
  });
});

test('parity: readability extraction', () => {
  PARITY.readability.forEach((c) => {
    const r = E.extractReadable(c.html);
    assert.equal(r.title, c.title);
    assert.equal(r.text, c.text);
  });
});

test('parity: bookmark parsing', () => {
  PARITY.netscape.forEach((c) => { assert.deepEqual(E.parseNetscapeBookmarks(c.html), c.items); });
});
