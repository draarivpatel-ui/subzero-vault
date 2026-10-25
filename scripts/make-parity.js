'use strict';
// Regenerates tests/fixtures/parity.json from engine.js. The Python twin in server/app.py
// reads the same file in --selftest, so the two implementations are held to one set of numbers.
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const tokenizeIn = [
  'The Quick BROWN fox',
  "Don't stop, it's 8090/tcp",
  'sqlite3.db and WAL-mode backups',
  'café naïve resumé',
  ''
];

const bm25Docs = [
  { id: 'doc1', title: 'Docker Compose basics', body: 'Compose files describe services, volumes and networks. A service is a container definition.', tags: ['docker', 'compose'] },
  { id: 'doc2', title: 'SQLite in WAL mode', body: 'Write ahead logging lets readers continue while a writer commits. Back up with the backup API.', tags: ['sqlite'] },
  { id: 'doc3', title: 'DNS sinkholes', body: 'A sinkhole answers blocked names with a dead address. Containers can run one for the whole network.', tags: ['dns', 'privacy'] },
  { id: 'doc4', title: 'Reverse proxies', body: 'A reverse proxy terminates TLS and forwards requests to a container on a private network.', tags: ['caddy', 'tls'] }
];
const bm25Queries = ['container', 'sqlite backup', 'reverse proxy tls', 'compose services volumes', 'network', 'zebra'];

const sm2Runs = [
  { today: '2026-10-25', qualities: [5, 5, 5, 4, 3, 0, 5, 4, 4] },
  { today: '2026-12-30', qualities: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3] },
  { today: '2028-02-27', qualities: [4, 1, 4, 4, 2, 5] }
];

const savingsInputs = [
  {},
  { enabled: ['readwise', 'raindrop', 'rocketmoney', 'notion', 'linktree'], watts: 10, hardwareCost: 150 },
  { saasGrowth: 0.08, powerGrowth: 0.03, reinvest: 0.04, extraAnnual: 14, kwhPrice: 0.22 },
  { watts: 400 },
  { hardwareCost: 0 },
  { enabled: ['googleone', 'icloud'], prices: { googleone: 1.99, icloud: 2.99 }, years: 3 }
];
const savingsKeys = ['saasMonthly', 'saasAnnual', 'powerKwhYear', 'powerAnnual', 'ownAnnual', 'netAnnual', 'fiveYearPlain', 'fiveYearCompounded', 'breakEvenDay', 'crossMonth'];

const readabilityPages = [
  '<html><head><title>Plain page</title></head><body><nav><a href="/">Home</a></nav><article><h1>Plain page</h1>' +
    '<p>First paragraph of the article, with a comma, and plenty of words to pass the length floor.</p>' +
    '<h2>Next part</h2><p>Second paragraph, also with commas, also long enough to count as real content here.</p>' +
    '<ul><li>one</li><li>two</li></ul></article><footer><p>Footer text that should be dropped from the output, for sure.</p></footer></body></html>',
  '<body><div class="sidebar"><p>Sidebar promo text, quite long, and full of commas, that must not win the scoring.</p></div>' +
    '<div class="post"><p>Main story paragraph one, with detail, and more detail, and then some extra words after that.</p>' +
    '<p>Main story paragraph two, with detail, and more detail, and then some extra words after that, too.</p>' +
    '<blockquote>A pulled quote that is long enough to be counted as a block of text here.</blockquote>' +
    '<pre>line one\nline two</pre></div></body>',
  '<html><head><meta property="og:title" content="Fish &amp; Chips"><title>ignored</title></head><body><main>' +
    '<p>Fish &amp; chips &#38; peas &#x26; vinegar make a meal, a classic one, with salt, in a paper wrapper.</p></main></body></html>'
];

const netscapePages = [
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><A HREF="https://example.com/a" ADD_DATE="1700000000" TAGS="docker,homelab">Alpha &amp; Co</A>\n<DD>A note\n' +
    '<DT><H3>Reading</H3>\n<DL><p>\n<DT><A HREF="https://example.com/b">Beta</A>\n<DT><H3>Deep</H3>\n<DL><p>\n<DT><A HREF="http://example.com/c" TAGS="x">Gamma</A>\n</DL><p>\n</DL><p>\n' +
    '<DT><A HREF="javascript:void(0)">skip</A>\n</DL><p>\n'
];

const out = {
  tokenize: tokenizeIn.map((s) => ({ in: s, out: E.tokenizeDocument(s) })),
  bm25: bm25Queries.map((q) => {
    const hits = E.bm25Search(E.buildInvertedIndex(bm25Docs), q);
    return { docs: bm25Docs, query: q, expect: hits.map((h) => ({ id: h.id, score: h.score })) };
  }),
  sm2: sm2Runs.map((run) => {
    let card = null;
    const expect = run.qualities.map((q) => {
      card = E.scheduleSm2Review(card, q, run.today);
      return { interval: card.interval, repetitions: card.repetitions, ef: card.ef };
    });
    return { today: run.today, qualities: run.qualities, expect: expect };
  }),
  savings: savingsInputs.map((input) => {
    const r = E.computeSubscriptionSavings(input);
    const expect = {};
    savingsKeys.forEach((k) => { expect[k] = r[k]; });
    return { input: input, expect: expect };
  }),
  readability: readabilityPages.map((html) => {
    const r = E.extractReadable(html);
    return { html: html, title: r.title, text: r.text };
  }),
  netscape: netscapePages.map((html) => ({ html: html, items: E.parseNetscapeBookmarks(html) }))
};

fs.writeFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'parity.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote parity.json');
