/* SubZero Vault engine. Pure functions only: no DOM, no network, no clock unless a caller passes one.
 * Loads as a browser global (SubZero) and as a CommonJS module for node:test.
 * server/app.py carries a Python twin of the same maths; tests/fixtures/parity.json keeps them honest. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SubZero = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  const STOPWORDS = new Set((
    'a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our ' +
    'she so than that the their them then there these they this to too us was we were what when which who will ' +
    'with you your do does did been being am would could should can just also about over under up out'
  ).split(' '));

  const BM25_K1 = 1.5;
  const BM25_B = 0.75;
  const TITLE_WEIGHT = 3;
  const TAG_WEIGHT = 2;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', rsquo: '\u2019',
    lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
    middot: '\u00b7', bull: '\u2022', laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7',
    mdash: '\u2014', ndash: '\u2013'
  };

  function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, function (whole, body) {
      if (body[0] === '#') {
        const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 1 || code > 0x10ffff) return whole;
        return String.fromCodePoint(code);
      }
      const hit = NAMED_ENTITIES[body.toLowerCase()];
      return hit === undefined ? whole : hit;
    });
  }

  function wordCount(text) {
    const m = String(text || '').match(/[\p{L}\p{N}]+/gu);
    return m ? m.length : 0;
  }

  // Lowercase, drop apostrophes, split on anything that is not a letter or digit, drop stopwords.
  function tokenizeDocument(text, opts) {
    const keepStop = !!(opts && opts.keepStopwords);
    const norm = String(text == null ? '' : text).toLowerCase().replace(/['\u2019]/g, '');
    const raw = norm.match(/[\p{L}\p{N}]+/gu) || [];
    return keepStop ? raw : raw.filter(function (t) { return !STOPWORDS.has(t); });
  }

  // ---------------------------------------------------------------------------
  // Okapi BM25
  // ---------------------------------------------------------------------------

  function weightedTokens(doc) {
    const out = [];
    const title = tokenizeDocument(doc.title || '');
    const tags = tokenizeDocument((doc.tags || []).join(' '));
    const body = tokenizeDocument(doc.body || '');
    for (let i = 0; i < TITLE_WEIGHT; i++) for (let j = 0; j < title.length; j++) out.push(title[j]);
    for (let i = 0; i < TAG_WEIGHT; i++) for (let j = 0; j < tags.length; j++) out.push(tags[j]);
    for (let j = 0; j < body.length; j++) out.push(body[j]);
    return out;
  }

  // docs: [{id, title, body, tags}]. Title tokens count three times and tag tokens twice.
  function buildInvertedIndex(docs) {
    const postings = new Map();
    const lengths = new Map();
    let total = 0;
    (docs || []).forEach(function (doc) {
      const toks = weightedTokens(doc);
      lengths.set(doc.id, toks.length);
      total += toks.length;
      const tf = new Map();
      toks.forEach(function (t) { tf.set(t, (tf.get(t) || 0) + 1); });
      tf.forEach(function (count, term) {
        if (!postings.has(term)) postings.set(term, new Map());
        postings.get(term).set(doc.id, count);
      });
    });
    const N = lengths.size;
    return { N: N, avgdl: N ? total / N : 0, lengths: lengths, postings: postings };
  }

  function bm25Idf(N, n) {
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  // Returns [{id, score, terms}] sorted by score descending, then id ascending.
  function bm25Search(index, query, opts) {
    const o = opts || {};
    const k1 = o.k1 === undefined ? BM25_K1 : o.k1;
    const b = o.b === undefined ? BM25_B : o.b;
    const terms = Array.from(new Set(tokenizeDocument(query)));
    if (!terms.length || !index.N) return [];
    const scores = new Map();
    const matched = new Map();
    terms.forEach(function (term) {
      const plist = index.postings.get(term);
      if (!plist) return;
      const idf = bm25Idf(index.N, plist.size);
      plist.forEach(function (tf, id) {
        const dl = index.lengths.get(id);
        const denom = tf + k1 * (1 - b + b * dl / index.avgdl);
        const part = idf * tf * (k1 + 1) / denom;
        scores.set(id, (scores.get(id) || 0) + part);
        if (!matched.has(id)) matched.set(id, []);
        matched.get(id).push(term);
      });
    });
    let rows = [];
    scores.forEach(function (score, id) {
      if (o.requireAll && matched.get(id).length !== terms.length) return;
      rows.push({ id: id, score: score, terms: matched.get(id) });
    });
    rows.sort(function (a, c) {
      if (c.score !== a.score) return c.score - a.score;
      return String(a.id) < String(c.id) ? -1 : String(a.id) > String(c.id) ? 1 : 0;
    });
    if (o.limit) rows = rows.slice(0, o.limit);
    return rows;
  }

  // HTML-safe snippet around the first hit, with <mark> around each matching word.
  function makeSnippet(text, terms, width) {
    const w = width || 180;
    const src = String(text || '').replace(/\s+/g, ' ').trim();
    if (!src) return '';
    const lower = src.toLowerCase();
    let first = -1;
    (terms || []).forEach(function (t) {
      const at = lower.indexOf(String(t).toLowerCase());
      if (at >= 0 && (first < 0 || at < first)) first = at;
    });
    let start = first < 0 ? 0 : Math.max(0, first - Math.floor(w / 3));
    if (start > 0) {
      const sp = src.indexOf(' ', start);
      if (sp >= 0 && sp < start + 20) start = sp + 1;
    }
    let end = Math.min(src.length, start + w);
    if (end < src.length) {
      const sp = src.lastIndexOf(' ', end);
      if (sp > start + 20) end = sp;
    }
    let slice = src.slice(start, end);
    let html = escapeHtml(slice);
    const pats = (terms || []).filter(Boolean).map(function (t) { return escapeRegExp(escapeHtml(t)); });
    if (pats.length) {
      const re = new RegExp('(^|[^\\p{L}\\p{N}&#;])(' + pats.join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
      html = html.replace(re, function (all, pre, hit) { return pre + '<mark>' + hit + '</mark>'; });
    }
    return (start > 0 ? '...' : '') + html + (end < src.length ? '...' : '');
  }

  // ---------------------------------------------------------------------------
  // SuperMemo SM-2
  // ---------------------------------------------------------------------------

  function todayIso(now) {
    return (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
  }

  function addDaysIso(iso, days) {
    const p = String(iso).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
  }

  function newCard(today) {
    return { repetitions: 0, interval: 0, ef: 2.5, due: today || todayIso() };
  }

  // quality 0..5. Below 3 the card restarts and the easiness factor is left alone (as in the SM-2 text).
  function scheduleSm2Review(card, quality, today) {
    if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
      throw new RangeError('quality must be an integer from 0 to 5');
    }
    const base = card || newCard(today);
    const day = today || todayIso();
    let n = base.repetitions;
    let interval = base.interval;
    let ef = base.ef;
    if (quality >= 3) {
      if (n === 0) interval = 1;
      else if (n === 1) interval = 6;
      else interval = Math.floor(interval * ef + 0.5);
      n += 1;
      const d = 5 - quality;
      ef = Math.max(1.3, Math.floor((ef + (0.1 - d * (0.08 + d * 0.02))) * 1e6 + 0.5) / 1e6);
    } else {
      n = 0;
      interval = 1;
    }
    return { repetitions: n, interval: interval, ef: ef, due: addDaysIso(day, interval), lastQuality: quality };
  }

  // What each answer would schedule next, for the button labels in review mode.
  function previewIntervals(card, qualities, today) {
    return (qualities || [1, 3, 4, 5]).map(function (q) {
      return { quality: q, interval: scheduleSm2Review(card, q, today).interval };
    });
  }

  // ---------------------------------------------------------------------------
  // Cloud rent replacement calculator
  // ---------------------------------------------------------------------------

  // price is dollars per month on the annual plan where one exists; null means "enter your own".
  // basis records where each number came from. None of these were read from a vendor page by this code.
  const SUBSCRIPTION_CATALOG = [
    { id: 'readwise', name: 'Readwise Reader', price: 9.99,
      basis: 'Readwise Full bundle, annual billing, per 2026 pricing guides. Reader is not sold alone.' },
    { id: 'raindrop', name: 'Raindrop.io Pro', price: 3.99,
      basis: 'Project brief figure. Third-party listings disagree (about 3.00 to 3.54).' },
    { id: 'rocketmoney', name: 'Rocket Money Premium', price: 6.00,
      basis: 'Project brief figure. Rocket Money lets you choose a price, reported as 7 to 14 in early 2026.' },
    { id: 'notion', name: 'Notion Plus', price: 10.00,
      basis: 'Notion release notes of 2024-06-26, annual billing, per member.' },
    { id: 'linktree', name: 'Linktree Pro', price: 12.00,
      basis: 'Annual billing per 2026 pricing guides. Monthly billing is higher.' },
    { id: 'instapaper', name: 'Instapaper Premium', price: null,
      basis: 'No price recorded. Enter yours.' },
    { id: 'googleone', name: 'Google One', price: null,
      basis: 'No price recorded. Depends on the storage tier. Enter yours.' },
    { id: 'icloud', name: 'iCloud+', price: null,
      basis: 'No price recorded. Depends on the storage tier. Enter yours.' },
    { id: 'onepassword', name: '1Password', price: null,
      basis: 'No price recorded. Enter yours.' },
    { id: 'dropbox', name: 'Dropbox Plus', price: null,
      basis: 'No price recorded. Enter yours.' },
    { id: 'evernote', name: 'Evernote Personal', price: null,
      basis: 'No price recorded. Enter yours.' },
    { id: 'todoist', name: 'Todoist Pro', price: null,
      basis: 'No price recorded. Enter yours.' }
  ];

  // Starting estimates for the box itself. They are inputs to edit, not quotes.
  const HARDWARE_PRESETS = [
    { id: 'pi5', name: 'Raspberry Pi 5 kit', cost: 120, watts: 6 },
    { id: 'minipc', name: 'Used mini PC', cost: 150, watts: 10 },
    { id: 'spare', name: 'Spare laptop you already own', cost: 0, watts: 14 }
  ];

  const DEFAULT_ENABLED = ['readwise', 'raindrop', 'rocketmoney'];

  function defaultCalcState() {
    const prices = {};
    SUBSCRIPTION_CATALOG.forEach(function (s) { prices[s.id] = s.price; });
    return {
      enabled: DEFAULT_ENABLED.slice(),
      prices: prices,
      hardwareCost: 120,
      watts: 6,
      kwhPrice: 0.17,
      extraAnnual: 0,
      saasGrowth: 0,
      powerGrowth: 0,
      reinvest: 0,
      years: 5
    };
  }

  function round2(x) {
    return Math.floor(x * 100 + 0.5) / 100;
  }

  function num(v, fallback) {
    const n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function normalizeCalc(input) {
    const d = defaultCalcState();
    const s = input || {};
    const prices = {};
    SUBSCRIPTION_CATALOG.forEach(function (c) {
      const raw = s.prices && s.prices[c.id] !== undefined ? s.prices[c.id] : d.prices[c.id];
      prices[c.id] = raw === null || raw === '' ? null : Math.max(0, num(raw, 0));
    });
    const known = new Set(SUBSCRIPTION_CATALOG.map(function (c) { return c.id; }));
    return {
      enabled: (s.enabled || d.enabled).filter(function (id) { return known.has(id); }),
      prices: prices,
      hardwareCost: Math.max(0, num(s.hardwareCost, d.hardwareCost)),
      watts: Math.max(0, num(s.watts, d.watts)),
      kwhPrice: Math.max(0, num(s.kwhPrice, d.kwhPrice)),
      extraAnnual: Math.max(0, num(s.extraAnnual, d.extraAnnual)),
      saasGrowth: clamp(num(s.saasGrowth, d.saasGrowth), 0, 1),
      powerGrowth: clamp(num(s.powerGrowth, d.powerGrowth), 0, 1),
      reinvest: clamp(num(s.reinvest, d.reinvest), 0, 1),
      years: clamp(Math.round(num(s.years, d.years)), 1, 10)
    };
  }

  // Rent (SaaS) against a one-time box plus electricity. Prices grow once per year, not per month.
  function computeSubscriptionSavings(input) {
    const c = normalizeCalc(input);
    const on = new Set(c.enabled);
    const lines = SUBSCRIPTION_CATALOG.map(function (s) {
      const monthly = on.has(s.id) && c.prices[s.id] ? c.prices[s.id] : 0;
      return { id: s.id, name: s.name, enabled: on.has(s.id), monthly: round2(monthly), annual: round2(monthly * 12) };
    });
    const saasMonthly = lines.reduce(function (a, l) { return a + l.monthly; }, 0);
    const saasAnnual = saasMonthly * 12;
    const powerKwhYear = c.watts / 1000 * 24 * 365;
    const powerAnnual = powerKwhYear * c.kwhPrice;
    const ownAnnual = powerAnnual + c.extraAnnual;
    const netAnnual = saasAnnual - ownAnnual;

    // Year by year: net saving of each year, compounded at the reinvest rate to the end of the horizon.
    let compounded = 0;
    let plain = 0;
    const yearly = [];
    for (let y = 0; y < c.years; y++) {
      const saasY = saasAnnual * Math.pow(1 + c.saasGrowth, y);
      const ownY = powerAnnual * Math.pow(1 + c.powerGrowth, y) + c.extraAnnual;
      const net = saasY - ownY;
      plain += net;
      compounded += net * Math.pow(1 + c.reinvest, c.years - 1 - y);
      yearly.push({ year: y + 1, saas: round2(saasY), own: round2(ownY), net: round2(net) });
    }

    const dailyNet = netAnnual / 365;
    const breakEvenDay = c.hardwareCost <= 0 ? 0 : (dailyNet > 0 ? Math.ceil(c.hardwareCost / dailyNet) : null);

    // Month by month cumulative outlay for the chart.
    const months = c.years * 12;
    const saasSeries = [0];
    const ownSeries = [c.hardwareCost];
    let cs = 0;
    let co = c.hardwareCost;
    for (let m = 1; m <= months; m++) {
      const yi = Math.floor((m - 1) / 12);
      cs += saasMonthly * Math.pow(1 + c.saasGrowth, yi);
      co += powerAnnual / 12 * Math.pow(1 + c.powerGrowth, yi) + c.extraAnnual / 12;
      saasSeries.push(cs);
      ownSeries.push(co);
    }
    let crossMonth = null;
    for (let m = 0; m <= months; m++) {
      if (saasSeries[m] >= ownSeries[m]) {
        if (m === 0) { crossMonth = 0; break; }
        const gapPrev = ownSeries[m - 1] - saasSeries[m - 1];
        const gapNow = ownSeries[m] - saasSeries[m];
        crossMonth = (m - 1) + gapPrev / (gapPrev - gapNow);
        break;
      }
    }

    return {
      lines: lines,
      saasMonthly: round2(saasMonthly),
      saasAnnual: round2(saasAnnual),
      powerKwhYear: round2(powerKwhYear),
      powerAnnual: round2(powerAnnual),
      ownAnnual: round2(ownAnnual),
      netAnnual: round2(netAnnual),
      hardwareCost: round2(c.hardwareCost),
      years: c.years,
      fiveYearPlain: round2(plain - c.hardwareCost),
      fiveYearCompounded: round2(compounded - c.hardwareCost),
      breakEvenDay: breakEvenDay,
      crossMonth: crossMonth === null ? null : Math.round(crossMonth * 1000) / 1000,
      yearly: yearly,
      series: { saas: saasSeries, own: ownSeries }
    };
  }

  function b64urlEncode(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(s) {
    const pad = s.replace(/-/g, '+').replace(/_/g, '/');
    return atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  }

  // URL state for the calculator. Only values that differ from the defaults are written.
  function encodeCalcState(state) {
    const c = normalizeCalc(state);
    const d = defaultCalcState();
    const out = {};
    if (c.enabled.slice().sort().join() !== d.enabled.slice().sort().join()) out.e = c.enabled;
    const pr = {};
    SUBSCRIPTION_CATALOG.forEach(function (s) { if (c.prices[s.id] !== d.prices[s.id]) pr[s.id] = c.prices[s.id]; });
    if (Object.keys(pr).length) out.p = pr;
    ['hardwareCost', 'watts', 'kwhPrice', 'extraAnnual', 'saasGrowth', 'powerGrowth', 'reinvest', 'years'].forEach(function (k) {
      if (c[k] !== d[k]) out[k] = c[k];
    });
    return Object.keys(out).length ? b64urlEncode(JSON.stringify(out)) : '';
  }

  function decodeCalcState(token) {
    if (!token) return defaultCalcState();
    try {
      const o = JSON.parse(b64urlDecode(String(token)));
      const base = defaultCalcState();
      if (o.e) base.enabled = o.e;
      if (o.p) Object.keys(o.p).forEach(function (k) { base.prices[k] = o.p[k]; });
      ['hardwareCost', 'watts', 'kwhPrice', 'extraAnnual', 'saasGrowth', 'powerGrowth', 'reinvest', 'years'].forEach(function (k) {
        if (o[k] !== undefined) base[k] = o[k];
      });
      return normalizeCalc(base);
    } catch (e) {
      return defaultCalcState();
    }
  }

  // ---------------------------------------------------------------------------
  // Readability style extraction (string based, no DOM, so Node can test it)
  // ---------------------------------------------------------------------------

  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const DROP_TAGS = new Set(['nav', 'aside', 'footer', 'header', 'form', 'dialog', 'menu']);
  const MAX_DEPTH = 120;
  const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre']);
  const NOISE_RE = /(^|[\s_-])(comment|comments|sidebar|share|sharing|social|promo|advert|ad|ads|cookie|menu|related|subscribe|newsletter|breadcrumb|pagination|popup|modal)([\s_-]|$)/i;
  const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

  function parseAttrs(s) {
    const out = {};
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(s))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    return out;
  }

  function parseHtmlTree(html) {
    const src = String(html || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|svg|template|iframe|canvas|object|select|button)\b[\s\S]*?<\/\1\s*>/gi, ' ');
    const root = { tag: '#root', children: [], parent: null, attrs: {}, depth: 0 };
    let cur = root;
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[4] !== undefined) {
        cur.children.push({ tag: '#text', text: m[4], parent: cur });
        continue;
      }
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (closing) {
        let n = cur;
        while (n && n.tag !== tag) n = n.parent;
        if (n && n.parent) cur = n.parent;
        continue;
      }
      if (tag === 'p' && cur.tag === 'p') cur = cur.parent;
      if (tag === 'li' && cur.tag === 'li') cur = cur.parent;
      if ((tag === 'div' || tag === 'ul' || tag === 'ol' || /^h[1-6]$/.test(tag) || tag === 'blockquote' || tag === 'pre') && cur.tag === 'p') cur = cur.parent;
      const attrs = parseAttrs(m[3]);
      const node = { tag: tag, attrs: attrs, children: [], parent: cur, score: 0, depth: cur.depth + 1 };
      node.drop = DROP_TAGS.has(tag) || NOISE_RE.test((attrs.class || '') + ' ' + (attrs.id || ''));
      cur.children.push(node);
      if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(m[3]) && node.depth < MAX_DEPTH) cur = node;
    }
    return root;
  }

  function nodeText(node, pre) {
    if (node.tag === '#text') return pre ? node.text : node.text.replace(/\s+/g, ' ');
    if (node.drop) return '';
    if (node.tag === 'br') return '\n';
    const inPre = pre || node.tag === 'pre';
    let out = '';
    for (let i = 0; i < node.children.length; i++) out += nodeText(node.children[i], inPre);
    return out;
  }

  function cleanText(node) {
    const raw = decodeEntities(nodeText(node, node.tag === 'pre'));
    return node.tag === 'pre' ? raw.replace(/^\n+|\s+$/g, '') : raw.replace(/\s+/g, ' ').trim();
  }

  function linkTextLen(node) {
    if (node.tag === '#text') return 0;
    if (node.drop) return 0;
    if (node.tag === 'a') return cleanText(node).length;
    let n = 0;
    for (let i = 0; i < node.children.length; i++) n += linkTextLen(node.children[i]);
    return n;
  }

  function linkDensity(node) {
    const len = cleanText(node).length;
    return len ? linkTextLen(node) / len : 0;
  }

  function walk(node, fn) {
    fn(node);
    if (node.children) for (let i = 0; i < node.children.length; i++) walk(node.children[i], fn);
  }

  function insideDropped(node) {
    for (let n = node; n; n = n.parent) if (n.drop) return true;
    return false;
  }

  function hasBlockDescendant(node) {
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      if (c.tag === '#text') continue;
      if (BLOCK_TAGS.has(c.tag) || hasBlockDescendant(c)) return true;
    }
    return false;
  }

  function findMeta(html, name) {
    const re = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    let m;
    while ((m = re.exec(html))) {
      const a = parseAttrs(m[1]);
      if ((a.property || a.name || '').toLowerCase() === name && a.content) return decodeEntities(a.content).trim();
    }
    return '';
  }

  function extractReadable(html) {
    const source = String(html || '');
    const tree = parseHtmlTree(source);
    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source);
    let title = findMeta(source, 'og:title') || (titleTag ? decodeEntities(titleTag[1]).replace(/\s+/g, ' ').trim() : '');
    let h1 = null;
    walk(tree, function (n) { if (!h1 && n.tag === 'h1' && !insideDropped(n)) h1 = n; });
    if (!title && h1) title = cleanText(h1);

    walk(tree, function (n) {
      if ((n.tag === 'p' || n.tag === 'pre' || n.tag === 'blockquote') && !insideDropped(n)) {
        const text = cleanText(n);
        if (text.length < 25) return;
        const points = 1 + (text.match(/,/g) || []).length + Math.min(Math.floor(text.length / 100), 3);
        let anc = n.parent;
        for (let level = 1; anc && anc.tag !== '#root'; level++, anc = anc.parent) {
          anc.score += points / (level === 1 ? 1 : level === 2 ? 2 : level * 3);
        }
      }
    });

    let best = null;
    let bestScore = 0;
    walk(tree, function (n) {
      if (n.tag === '#text' || n.tag === '#root' || n.drop || !n.score || insideDropped(n)) return;
      const bonus = n.tag === 'article' || n.tag === 'main' ? 5 : n.tag === 'div' || n.tag === 'section' ? 2 : 0;
      const adj = (n.score + bonus) * (1 - linkDensity(n));
      if (adj > bestScore) { best = n; bestScore = adj; }
    });
    if (!best) {
      walk(tree, function (n) { if (!best && n.tag === 'body') best = n; });
      if (!best) best = tree;
    }

    const blocks = [];
    (function collect(n) {
      if (n.tag === '#text' || n.drop) return;
      if (BLOCK_TAGS.has(n.tag) && !hasBlockDescendant(n)) {
        const text = cleanText(n);
        if (!text) return;
        if (n === h1 && text === title) return;
        if (linkDensity(n) > 0.5 && text.length < 100) return;
        const kind = n.tag === 'li' ? 'li' : n.tag === 'blockquote' ? 'quote' : n.tag === 'pre' ? 'pre' : /^h[1-6]$/.test(n.tag) ? 'h' : 'p';
        blocks.push({ type: kind, text: text });
        return;
      }
      for (let i = 0; i < n.children.length; i++) collect(n.children[i]);
    }(best));

    const text = blocks.map(function (b) {
      return b.type === 'h' ? '## ' + b.text : b.type === 'li' ? '- ' + b.text : b.type === 'quote' ? '> ' + b.text : b.text;
    }).join('\n\n');
    return { title: title, text: text, blocks: blocks, wordCount: wordCount(text) };
  }

  // ---------------------------------------------------------------------------
  // Netscape bookmark files
  // ---------------------------------------------------------------------------

  function epochToIso(sec) {
    const n = parseInt(sec, 10);
    if (!isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }

  function isoToEpoch(iso) {
    const t = Date.parse(String(iso || '') + 'T00:00:00Z');
    return isFinite(t) ? Math.floor(t / 1000) : 0;
  }

  function indexOfCi(src, needle, from) {
    const re = new RegExp(escapeRegExp(needle), 'ig');
    re.lastIndex = from;
    const m = re.exec(src);
    return m ? m.index : -1;
  }

  function stripTags(s) {
    return String(s).replace(/<[^>]*>/g, '');
  }

  function parseNetscapeBookmarks(html) {
    const src = String(html || '');
    const items = [];
    const stack = [];
    let pending = null;
    let last = null;
    const re = /<(\/?)(dl|h3|a|dd)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    let m;
    while ((m = re.exec(src))) {
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (tag === 'dl') {
        if (closing) stack.pop(); else { stack.push(pending); pending = null; }
      } else if (tag === 'h3' && !closing) {
        const end = indexOfCi(src, '</h3>', re.lastIndex);
        const stop = end < 0 ? src.length : end;
        pending = decodeEntities(stripTags(src.slice(re.lastIndex, stop))).trim();
        re.lastIndex = end < 0 ? stop : end + 5;
      } else if (tag === 'a' && !closing) {
        const end = indexOfCi(src, '</a>', re.lastIndex);
        const stop = end < 0 ? src.length : end;
        const attrs = parseAttrs(m[3]);
        const text = decodeEntities(stripTags(src.slice(re.lastIndex, stop))).replace(/\s+/g, ' ').trim();
        re.lastIndex = end < 0 ? stop : end + 4;
        const url = decodeEntities(attrs.href || '').trim();
        if (/^https?:\/\//i.test(url)) {
          last = {
            title: text || url,
            url: url,
            addDate: epochToIso(attrs.add_date),
            tags: (attrs.tags ? decodeEntities(attrs.tags).split(',') : []).map(function (t) { return t.trim(); }).filter(Boolean),
            folder: stack.filter(Boolean).join('/'),
            note: ''
          };
          items.push(last);
        } else {
          last = null;
        }
      } else if (tag === 'dd' && !closing && last) {
        const next = src.indexOf('<', re.lastIndex);
        const stop = next < 0 ? src.length : next;
        last.note = decodeEntities(src.slice(re.lastIndex, stop)).replace(/\s+/g, ' ').trim();
      }
    }
    return items;
  }

  function exportNetscapeBookmarks(items) {
    const byFolder = new Map();
    (items || []).forEach(function (it) {
      const f = it.folder || '';
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f).push(it);
    });
    function line(it, pad) {
      const attrs = ['HREF="' + escapeHtml(it.url) + '"'];
      const when = isoToEpoch(it.addDate || it.savedAt);
      if (when) attrs.push('ADD_DATE="' + when + '"');
      if (it.tags && it.tags.length) attrs.push('TAGS="' + escapeHtml(it.tags.join(',')) + '"');
      let out = pad + '<DT><A ' + attrs.join(' ') + '>' + escapeHtml(it.title || it.url) + '</A>\n';
      if (it.note) out += pad + '<DD>' + escapeHtml(it.note) + '\n';
      return out;
    }
    let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' +
      '<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n' +
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n' +
      '<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
    (byFolder.get('') || []).forEach(function (it) { out += line(it, '    '); });
    byFolder.forEach(function (list, folder) {
      if (!folder) return;
      out += '    <DT><H3>' + escapeHtml(folder) + '</H3>\n    <DL><p>\n';
      list.forEach(function (it) { out += line(it, '        '); });
      out += '    </DL><p>\n';
    });
    return out + '</DL><p>\n';
  }

  // ---------------------------------------------------------------------------
  // Cron validation and the Docker Compose generator
  // ---------------------------------------------------------------------------

  const CRON_FIELDS = [
    { name: 'minute', lo: 0, hi: 59 },
    { name: 'hour', lo: 0, hi: 23 },
    { name: 'day of month', lo: 1, hi: 31 },
    { name: 'month', lo: 1, hi: 12 },
    { name: 'day of week', lo: 0, hi: 7 }
  ];

  function validateCron(expr) {
    const parts = String(expr == null ? '' : expr).trim().split(/\s+/);
    if (parts.length !== 5) return { valid: false, error: 'A cron schedule needs exactly 5 fields.' };
    for (let i = 0; i < 5; i++) {
      const f = CRON_FIELDS[i];
      const items = parts[i].split(',');
      for (let j = 0; j < items.length; j++) {
        const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(items[j]);
        if (!m) return { valid: false, error: 'Bad ' + f.name + ' field "' + parts[i] + '".' };
        if (m[2] !== undefined) {
          const a = parseInt(m[2], 10);
          const z = m[3] !== undefined ? parseInt(m[3], 10) : a;
          if (a < f.lo || z > f.hi || a > z) return { valid: false, error: f.name + ' must be within ' + f.lo + ' to ' + f.hi + '.' };
        }
        if (m[4] !== undefined && parseInt(m[4], 10) < 1) return { valid: false, error: 'A step must be 1 or more.' };
      }
    }
    return { valid: true, error: '' };
  }

  const REPO_URL = 'https://github.com/draarivpatel-ui/subzero-vault.git';

  function safePath(p, fallback) {
    const s = String(p == null ? '' : p).trim();
    return /^[A-Za-z0-9_./~ -]+$/.test(s) && s.length <= 120 ? s : fallback;
  }

  function safeDomain(d) {
    const s = String(d == null ? '' : d).trim().toLowerCase();
    return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s) && s.length <= 120 ? s : 'vault.example.com';
  }

  function generateDockerCompose(options) {
    const o = options || {};
    const port = clamp(Math.round(num(o.port, 8090)), 1, 65535);
    const dataPath = safePath(o.dataPath, './data');
    const backupPath = safePath(o.backupPath, './backups');
    const proxy = o.proxy === 'caddy' || o.proxy === 'tailscale' ? o.proxy : 'none';
    const cron = String(o.backupCron == null ? '' : o.backupCron).trim();
    const cronOk = cron && validateCron(cron).valid;
    const domain = safeDomain(o.domain);
    const tz = /^[A-Za-z0-9_/+-]{1,40}$/.test(String(o.timezone || '')) ? o.timezone : 'UTC';
    const token = String(o.token == null ? '' : o.token).replace(/[^A-Za-z0-9_-]/g, '');

    const y = [];
    y.push('# Generated by SubZero Vault. Run: docker compose up -d');
    y.push('name: subzero-vault');
    y.push('services:');
    y.push('  vault:');
    y.push('    build:');
    y.push('      context: ' + REPO_URL + '#main');
    y.push('    image: subzero-vault:local');
    y.push('    restart: unless-stopped');
    if (proxy === 'tailscale') {
      y.push('    network_mode: "service:tailscale"');
      y.push('    depends_on:');
      y.push('      - tailscale');
    } else if (proxy === 'caddy') {
      y.push('    expose:');
      y.push('      - "8090"');
    } else {
      y.push('    ports:');
      y.push('      - "127.0.0.1:${VAULT_PORT:-' + port + '}:8090"');
    }
    y.push('    environment:');
    y.push('      VAULT_DB: /data/vault.db');
    y.push('      VAULT_TOKEN: ' + (proxy === 'none' ? '${VAULT_TOKEN:-}' : '${VAULT_TOKEN:?set VAULT_TOKEN in .env}'));
    y.push('      VAULT_ALLOWED_ORIGINS: ${VAULT_ALLOWED_ORIGINS:-https://aariv.me}');
    y.push('      TZ: ${TZ:-UTC}');
    if (cronOk) {
      y.push('      VAULT_BACKUP_DIR: /backups');
      y.push('      VAULT_BACKUP_CRON: ' + JSON.stringify(cron));
    }
    y.push('    volumes:');
    y.push('      - ' + dataPath + ':/data');
    if (cronOk) y.push('      - ' + backupPath + ':/backups');
    y.push('    healthcheck:');
    y.push('      test: ["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen(\'http://127.0.0.1:8090/health\', timeout=3)"]');
    y.push('      interval: 30s');
    y.push('      timeout: 5s');
    y.push('      retries: 3');
    y.push('      start_period: 5s');

    if (proxy === 'caddy') {
      y.push('  caddy:');
      y.push('    image: caddy:2-alpine');
      y.push('    restart: unless-stopped');
      y.push('    depends_on:');
      y.push('      - vault');
      y.push('    ports:');
      y.push('      - "80:80"');
      y.push('      - "443:443"');
      y.push('    volumes:');
      y.push('      - ./Caddyfile:/etc/caddy/Caddyfile:ro');
      y.push('      - caddy-data:/data');
      y.push('      - caddy-config:/config');
    }
    if (proxy === 'tailscale') {
      y.push('  tailscale:');
      y.push('    image: tailscale/tailscale:latest');
      y.push('    hostname: subzero-vault');
      y.push('    restart: unless-stopped');
      y.push('    environment:');
      y.push('      TS_AUTHKEY: ${TS_AUTHKEY}');
      y.push('      TS_STATE_DIR: /var/lib/tailscale');
      y.push('      TS_USERSPACE: "false"');
      y.push('    volumes:');
      y.push('      - tailscale-state:/var/lib/tailscale');
      y.push('    devices:');
      y.push('      - /dev/net/tun:/dev/net/tun');
      y.push('    cap_add:');
      y.push('      - net_admin');
      y.push('      - sys_module');
    }
    if (proxy === 'caddy') {
      y.push('volumes:');
      y.push('  caddy-data:');
      y.push('  caddy-config:');
    } else if (proxy === 'tailscale') {
      y.push('volumes:');
      y.push('  tailscale-state:');
    }

    const e = [];
    e.push('# Copy to .env next to docker-compose.yml. Never commit the real file.');
    if (proxy === 'none') e.push('VAULT_PORT=' + port);
    e.push('VAULT_TOKEN=' + (token || (proxy === 'none' ? '' : 'paste-a-random-secret-token')));
    e.push('VAULT_ALLOWED_ORIGINS=https://aariv.me');
    e.push('TZ=' + tz);
    if (proxy === 'tailscale') e.push('TS_AUTHKEY=paste-your-tailscale-auth-key');

    const caddyfile = proxy === 'caddy'
      ? domain + ' {\n    encode gzip\n    reverse_proxy vault:8090\n}\n'
      : null;

    return { compose: y.join('\n') + '\n', env: e.join('\n') + '\n', caddyfile: caddyfile, backupEnabled: !!cronOk };
  }

  return {
    STOPWORDS: STOPWORDS,
    BM25_K1: BM25_K1,
    BM25_B: BM25_B,
    SUBSCRIPTION_CATALOG: SUBSCRIPTION_CATALOG,
    HARDWARE_PRESETS: HARDWARE_PRESETS,
    escapeHtml: escapeHtml,
    decodeEntities: decodeEntities,
    wordCount: wordCount,
    tokenizeDocument: tokenizeDocument,
    buildInvertedIndex: buildInvertedIndex,
    bm25Idf: bm25Idf,
    bm25Search: bm25Search,
    makeSnippet: makeSnippet,
    todayIso: todayIso,
    addDaysIso: addDaysIso,
    newCard: newCard,
    scheduleSm2Review: scheduleSm2Review,
    previewIntervals: previewIntervals,
    defaultCalcState: defaultCalcState,
    normalizeCalc: normalizeCalc,
    computeSubscriptionSavings: computeSubscriptionSavings,
    encodeCalcState: encodeCalcState,
    decodeCalcState: decodeCalcState,
    extractReadable: extractReadable,
    parseNetscapeBookmarks: parseNetscapeBookmarks,
    exportNetscapeBookmarks: exportNetscapeBookmarks,
    validateCron: validateCron,
    generateDockerCompose: generateDockerCompose
  };
}));
