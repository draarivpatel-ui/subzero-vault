/* SubZero Vault lab. Pure functions only: no DOM, no network, no clock.
 * Loads as a browser global (SubZeroLab) and as a CommonJS module for node:test.
 * Holds the five hardware TCO comparator, the BM25 and SM-2 diagnostics, the
 * SHA-256 audited exporters and the #szv= share codec. All maths go through
 * engine.js so the numbers match the audit panel and the Python server. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'), require('./samples.js'));
  } else {
    root.SubZeroLab = factory(root.SubZero, root.SubZeroSamples);
  }
}(typeof self !== 'undefined' ? self : this, function (E, Samples) {
  'use strict';

  const esc = E.escapeHtml;
  const round2 = function (x) { return Math.floor(x * 100 + 0.5) / 100; };

  function fmtMoney(n) {
    const v = Number(n);
    const safe = isFinite(v) ? v : 0;
    return (safe < 0 ? '-' : '') + '$' + Math.abs(safe).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtMoney0(n) {
    const v = Number(n);
    const safe = isFinite(v) ? v : 0;
    return (safe < 0 ? '-' : '') + '$' + Math.round(Math.abs(safe)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtDay(d) {
    if (d === null || d === undefined) return 'never';
    return d === 0 ? 'day 0' : 'day ' + d;
  }

  function niceMax(v) {
    if (!(v > 0) || !isFinite(v)) return 1;
    const ex = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / ex;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * ex;
  }

  // ---------------------------------------------------------------------------
  // Pure-JS SHA-256 (FIPS 180-4) over UTF-8 input
  // ---------------------------------------------------------------------------

  function utf8Bytes(str) {
    const s = String(str);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let cp = s.codePointAt(i);
      if (cp > 0xffff) { i++; }
      else if (cp >= 0xd800 && cp <= 0xdfff) { cp = 0xfffd; }
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return new Uint8Array(out);
  }

  const SHA_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Hex(text) {
    const msg = utf8Bytes(text);
    const bitLen = msg.length * 8;
    const total = msg.length + 9 + ((64 - (msg.length + 9) % 64) % 64);
    const m = new Uint8Array(total);
    m.set(msg);
    m[msg.length] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(total - 4, bitLen >>> 0);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
      for (let i = 0; i < 64; i++) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ ((~e) & g);
        const t1 = (hh + s1 + ch + SHA_K[i] + w[i]) | 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
    }
    const words = [h0, h1, h2, h3, h4, h5, h6, h7];
    let hex = '';
    for (let i = 0; i < 8; i++) hex += (words[i] >>> 0).toString(16).padStart(8, '0');
    return hex;
  }

  // ---------------------------------------------------------------------------
  // base64url and strict UTF-8 decode for the #szv= codec
  // ---------------------------------------------------------------------------

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function b64urlEncodeStr(str) {
    const bytes = utf8Bytes(str);
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)];
      if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)];
      if (i + 2 < bytes.length) out += B64[b2 & 63];
    }
    return out;
  }

  function b64urlDecodeBytes(tok) {
    if (typeof tok !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tok) || tok.length % 4 === 1) {
      throw new Error('bad base64url');
    }
    const out = [];
    let acc = 0, bits = 0;
    for (let i = 0; i < tok.length; i++) {
      acc = (acc << 6) | B64.indexOf(tok[i]);
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    /* Canonical encoders leave the spare bits zero. Rejecting nonzero padding
       stops a second spelling of the same state. */
    if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error('bad base64url padding');
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      let v = 0, need = 0;
      if (c < 0x80) { v = c; }
      else if ((c & 0xe0) === 0xc0) { v = c & 0x1f; need = 1; }
      else if ((c & 0xf0) === 0xe0) { v = c & 0x0f; need = 2; }
      else if ((c & 0xf8) === 0xf0) { v = c & 0x07; need = 3; }
      else { throw new Error('bad utf-8'); }
      for (let j = 0; j < need; j++) {
        const cc = bytes[++i];
        if (cc === undefined || (cc & 0xc0) !== 0x80) throw new Error('bad utf-8');
        v = (v << 6) | (cc & 0x3f);
      }
      if ((need === 1 && v < 0x80) || (need === 2 && v < 0x800) || (need === 3 && v < 0x10000) ||
          v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) throw new Error('bad utf-8');
      out += v > 0xffff ? String.fromCodePoint(v) : String.fromCharCode(v);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Lab state and the #szv= hash codec
  // ---------------------------------------------------------------------------

  const HARDWARE_PROFILES = [
    { id: 'pi5', name: 'Raspberry Pi 5 kit', cost: 120, watts: 6, monthlyFee: 0, note: 'Board, case, supply and card at example prices.' },
    { id: 'n100', name: 'Used mini PC N100', cost: 150, watts: 10, monthlyFee: 0, note: 'Second hand Intel N100 box. Faster, draws more.' },
    { id: 'thinkcentre', name: 'Refurbished ThinkCentre', cost: 100, watts: 20, monthlyFee: 0, note: 'Older one litre office PC. Cheap but thirsty.' },
    { id: 'nas', name: 'Low-power NAS, 2 bay', cost: 210, watts: 15, monthlyFee: 0, note: 'Ready made two bay NAS, disks not included.' },
    { id: 'vps', name: 'Cloud VPS baseline', cost: 0, watts: 0, monthlyFee: 6, note: 'Smallest rented virtual machine. A fee instead of a box.' }
  ];

  const SM2_STRATEGIES = [
    { id: 'daily', name: 'Daily strict', days: [0, 1, 2, 3, 4, 5, 6], quality: 4, note: 'Reviews every day, honest grades.' },
    { id: 'weekday', name: 'Weekday only', days: [0, 1, 2, 3, 4], quality: 4, note: 'Skips Saturday and Sunday.' },
    { id: 'weekend', name: 'Weekend batch', days: [5, 6], quality: 4, note: 'Clears the pile on Saturday and Sunday.' },
    { id: 'ease', name: 'High-ease accelerated', days: [0, 1, 2, 3, 4, 5, 6], quality: 5, note: 'Every card graded easy, intervals stretch.' }
  ];

  const LAB_VIEWS = [
    { id: 'tco', name: 'Costs' },
    { id: 'diag', name: 'Diagnostics' },
    { id: 'export', name: 'Exports' }
  ];

  const HORIZONS = [12, 36, 60];
  const PROFILE_IDS = HARDWARE_PROFILES.map(function (p) { return p.id; });
  const STRATEGY_IDS = SM2_STRATEGIES.map(function (s) { return s.id; });
  const VIEW_IDS = LAB_VIEWS.map(function (v) { return v.id; });

  function defaultLabState() {
    return { view: 'tco', profile: 'pi5', horizon: 36, k1: 1.5, b: 0.75, strategy: 'daily', query: 'sqlite backup' };
  }

  function pickEnum(v, list, fallback) {
    return list.indexOf(v) >= 0 ? v : fallback;
  }

  function pickNum(v, lo, hi, fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }

  /* Permissive merge used for live controls. The codec below is the strict one. */
  function normalizeLabState(input) {
    const d = defaultLabState();
    const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      view: pickEnum(s.view, VIEW_IDS, d.view),
      profile: pickEnum(s.profile, PROFILE_IDS, d.profile),
      horizon: pickEnum(Number(s.horizon), HORIZONS, d.horizon),
      k1: pickNum(s.k1, 0, 4, d.k1),
      b: pickNum(s.b, 0, 1, d.b),
      strategy: pickEnum(s.strategy, STRATEGY_IDS, d.strategy),
      query: typeof s.query === 'string' ? s.query.slice(0, 120) : d.query
    };
  }

  function encodeLabHash(state) {
    const s = normalizeLabState(state);
    const d = defaultLabState();
    const o = {};
    if (s.profile !== d.profile) o.p = s.profile;
    if (s.horizon !== d.horizon) o.z = s.horizon;
    if (s.k1 !== d.k1) o.k = s.k1;
    if (s.b !== d.b) o.b = s.b;
    if (s.strategy !== d.strategy) o.s = s.strategy;
    if (s.view !== d.view) o.t = s.view;
    if (!Object.keys(o).length) return '';
    o.v = 1;
    return b64urlEncodeStr(JSON.stringify(o));
  }

  /* Fail closed: anything malformed, hostile or non-canonical returns defaults
     with ok false and never throws. Fields are whitelisted one at a time so a
     crafted key like __proto__ is simply rejected. */
  function decodeLabHash(token) {
    const fail = { state: defaultLabState(), ok: false };
    if (token === '' || token === null || token === undefined) return { state: defaultLabState(), ok: true };
    if (typeof token !== 'string' || token.length > 2000) return fail;
    let o;
    try { o = JSON.parse(utf8Decode(b64urlDecodeBytes(token))); }
    catch (e) { return fail; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return fail;
    const allowed = new Set(['v', 'p', 'z', 'k', 'b', 's', 't']);
    const keys = Object.keys(o);
    for (let i = 0; i < keys.length; i++) if (!allowed.has(keys[i])) return fail;
    if (o.v !== 1) return fail;
    const st = defaultLabState();
    if ('p' in o) { if (PROFILE_IDS.indexOf(o.p) < 0) return fail; st.profile = o.p; }
    if ('z' in o) { if (HORIZONS.indexOf(o.z) < 0) return fail; st.horizon = o.z; }
    if ('k' in o) { if (typeof o.k !== 'number' || !isFinite(o.k) || o.k < 0 || o.k > 4) return fail; st.k1 = o.k; }
    if ('b' in o) { if (typeof o.b !== 'number' || !isFinite(o.b) || o.b < 0 || o.b > 1) return fail; st.b = o.b; }
    if ('s' in o) { if (STRATEGY_IDS.indexOf(o.s) < 0) return fail; st.strategy = o.s; }
    if ('t' in o) { if (VIEW_IDS.indexOf(o.t) < 0) return fail; st.view = o.t; }
    return { state: st, ok: true };
  }

  // ---------------------------------------------------------------------------
  // Five hardware TCO comparator, built on the audit maths
  // ---------------------------------------------------------------------------

  function profileInput(calc, p, mods) {
    const prices = {};
    E.SUBSCRIPTION_CATALOG.forEach(function (s) {
      const v = calc.prices[s.id];
      prices[s.id] = v === null ? null : v * (mods && mods.priceFactor ? mods.priceFactor : 1);
    });
    return {
      enabled: calc.enabled.slice(),
      prices: prices,
      hardwareCost: p.cost,
      watts: p.watts,
      kwhPrice: calc.kwhPrice * (mods && mods.powerFactor ? mods.powerFactor : 1),
      extraAnnual: calc.extraAnnual + p.monthlyFee * 12,
      saasGrowth: calc.saasGrowth,
      powerGrowth: calc.powerGrowth,
      reinvest: calc.reinvest,
      years: 5
    };
  }

  /* Each profile is priced with the same subscription bill, electricity rate
     and growth settings. The VPS swaps the box cost for a monthly fee. */
  function compareHardware(calcInput, horizon) {
    const calc = E.normalizeCalc(calcInput || {});
    const h = HORIZONS.indexOf(Number(horizon)) >= 0 ? Number(horizon) : 36;
    const saasSeries = E.computeSubscriptionSavings(profileInput(calc, HARDWARE_PROFILES[0])).series.saas;
    return HARDWARE_PROFILES.map(function (p) {
      const r = E.computeSubscriptionSavings(profileInput(calc, p));
      const tco = r.series.own[h];
      const rent = saasSeries[h];
      return {
        id: p.id, name: p.name, cost: p.cost, watts: p.watts, monthlyFee: p.monthlyFee, note: p.note,
        kwhYear: r.powerKwhYear,
        powerAnnual: r.powerAnnual,
        feeAnnual: round2(p.monthlyFee * 12 + calc.extraAnnual),
        saasAnnual: r.saasAnnual,
        netAnnual: r.netAnnual,
        breakEvenDay: r.breakEvenDay,
        crossMonth: r.crossMonth,
        tco: round2(tco),
        rent: round2(rent),
        net: round2(rent - tco),
        ownSeries: r.series.own,
        sens: {
          powerDown: E.computeSubscriptionSavings(profileInput(calc, p, { powerFactor: 0.7 })).breakEvenDay,
          powerUp: E.computeSubscriptionSavings(profileInput(calc, p, { powerFactor: 1.3 })).breakEvenDay,
          saasDown: E.computeSubscriptionSavings(profileInput(calc, p, { priceFactor: 0.8 })).breakEvenDay,
          saasUp: E.computeSubscriptionSavings(profileInput(calc, p, { priceFactor: 1.2 })).breakEvenDay
        }
      };
    });
  }

  // ---------------------------------------------------------------------------
  // BM25 parameter sensitivity over the eight sample articles
  // ---------------------------------------------------------------------------

  let cachedIndex = null;
  function labIndex() {
    if (!cachedIndex) {
      const docs = (Samples && Samples.articles ? Samples.articles : []).map(function (a) {
        return { id: a.id, title: a.title, body: a.body, tags: a.tags };
      });
      cachedIndex = E.buildInvertedIndex(docs);
    }
    return cachedIndex;
  }

  function sampleTitle(id) {
    const a = (Samples && Samples.articles ? Samples.articles : []).find(function (x) { return x.id === id; });
    return a ? a.title : String(id);
  }

  /* Kendall tau over the items both rankings share. Returns null when fewer
     than two items overlap, so the panel prints n/a instead of a fake number. */
  function kendallTau(rankA, rankB) {
    const a = Array.isArray(rankA) ? rankA : [];
    const b = Array.isArray(rankB) ? rankB : [];
    const posB = new Map();
    b.forEach(function (id, i) { posB.set(id, i); });
    const common = a.filter(function (id) { return posB.has(id); });
    const n = common.length;
    if (n < 2) return null;
    let agree = 0, disagree = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (posB.get(common[i]) < posB.get(common[j])) agree++; else disagree++;
      }
    }
    return (agree - disagree) / (n * (n - 1) / 2);
  }

  function topKOverlap(rankA, rankB, k) {
    const kk = Math.max(1, Math.floor(Number.isFinite(k) ? k : 3));
    const a = Array.isArray(rankA) ? rankA : [];
    if (!a.length) return 0;
    const inB = new Set((Array.isArray(rankB) ? rankB : []).slice(0, kk));
    let hit = 0;
    a.slice(0, kk).forEach(function (id) { if (inB.has(id)) hit++; });
    return hit / Math.min(kk, a.length);
  }

  function bm25Lab(query, k1, b) {
    const kk = pickNum(k1, 0, 4, 1.5);
    const bb = pickNum(b, 0, 1, 0.75);
    const q = typeof query === 'string' ? query.slice(0, 120) : '';
    const ix = labIndex();
    const rows = E.bm25Search(ix, q, { k1: kk, b: bb });
    const ref = E.bm25Search(ix, q, {});
    const ids = rows.map(function (r) { return r.id; });
    const refIds = ref.map(function (r) { return r.id; });
    return {
      query: q, k1: kk, b: bb,
      rows: rows.map(function (r) { return { id: r.id, title: sampleTitle(r.id), score: r.score }; }),
      refIds: refIds,
      refK1: 1.5, refB: 0.75,
      tau: kendallTau(ids, refIds),
      overlap3: topKOverlap(ids, refIds, 3),
      matches: rows.length
    };
  }

  // ---------------------------------------------------------------------------
  // SM-2 ninety day review-load simulator
  // ---------------------------------------------------------------------------

  const SIM_BASE = '2026-01-05'; /* a Monday, so day % 7 marks the weekday */
  const SIM_CARDS = 24;
  const SIM_DAYS = 90;
  const SIM_MATURE = 21;

  function strategyById(id) {
    return SM2_STRATEGIES.find(function (s) { return s.id === id; }) || SM2_STRATEGIES[0];
  }

  /* Every strategy starts with the same pile of new cards due on day zero and
     grades them the same way. Only the review days and the grade differ, so the
     curves stay comparable. */
  function simulateSm2(strategyId, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const st = strategyById(strategyId);
    const days = Math.min(365, Math.max(1, Math.floor(Number.isFinite(o.days) ? o.days : SIM_DAYS)));
    const nCards = Math.min(500, Math.max(0, Math.floor(Number.isFinite(o.cards) ? o.cards : SIM_CARDS)));
    const matureAt = Math.max(1, Math.floor(Number.isFinite(o.matureAt) ? o.matureAt : SIM_MATURE));
    const active = new Set(st.days);
    const cards = [];
    for (let i = 0; i < nCards; i++) cards.push({ repetitions: 0, interval: 0, ef: 2.5, due: 0 });
    const daily = [];
    let reviews = 0, peakBacklog = 0;
    for (let d = 0; d < days; d++) {
      let due = 0;
      for (let i = 0; i < cards.length; i++) if (cards[i].due <= d) due++;
      let reviewed = 0;
      if (active.has(d % 7)) {
        const iso = E.addDaysIso(SIM_BASE, d);
        for (let i = 0; i < cards.length; i++) {
          const c = cards[i];
          if (c.due <= d) {
            const nx = E.scheduleSm2Review(c, st.quality, iso);
            c.repetitions = nx.repetitions;
            c.interval = nx.interval;
            c.ef = nx.ef;
            c.due = d + nx.interval;
            reviewed++;
          }
        }
      }
      const backlog = due - reviewed;
      let mature = 0;
      for (let i = 0; i < cards.length; i++) if (cards[i].interval >= matureAt) mature++;
      reviews += reviewed;
      if (backlog > peakBacklog) peakBacklog = backlog;
      daily.push({ day: d, due: due, reviewed: reviewed, backlog: backlog, mature: mature });
    }
    let endMature = 0, endBacklog = 0;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].interval >= matureAt) endMature++;
      if (cards[i].due <= days - 1) endBacklog++;
    }
    return {
      strategy: st.id, name: st.name, quality: st.quality,
      days: days, cards: nCards, matureAt: matureAt,
      totalReviews: reviews, peakBacklog: peakBacklog,
      matureAtEnd: endMature, backlogAtEnd: endBacklog,
      daily: daily
    };
  }

  // ---------------------------------------------------------------------------
  // The canonical lab report and the audited exporters
  // ---------------------------------------------------------------------------

  function buildLabReport(state, calcInput) {
    const st = normalizeLabState(state);
    const calc = E.normalizeCalc(calcInput || {});
    const on = new Set(calc.enabled);
    const subscriptions = E.SUBSCRIPTION_CATALOG.filter(function (s) { return on.has(s.id); }).map(function (s) {
      return { id: s.id, name: s.name, monthly: round2(calc.prices[s.id] || 0) };
    });
    const saasMonthly = round2(subscriptions.reduce(function (a, s) { return a + s.monthly; }, 0));
    const hardware = compareHardware(calc, st.horizon);
    const series = { saas: hardware[0] ? E.computeSubscriptionSavings(profileInput(calc, HARDWARE_PROFILES[0])).series.saas : [], own: {} };
    hardware.forEach(function (h) { series.own[h.id] = h.ownSeries; });
    const bm = bm25Lab(st.query, st.k1, st.b);
    const runs = SM2_STRATEGIES.map(function (s) { return simulateSm2(s.id); });
    const sel = runs.find(function (r) { return r.strategy === st.strategy; }) || runs[0];
    const mature = {};
    runs.forEach(function (r) { mature[r.strategy] = r.daily.map(function (d) { return d.mature; }); });
    return {
      schema: 'subzero-lab-report/1',
      horizon: st.horizon,
      profile: st.profile,
      k1: st.k1,
      b: st.b,
      strategy: st.strategy,
      inputs: {
        saasMonthly: saasMonthly,
        saasAnnual: round2(saasMonthly * 12),
        kwhPrice: calc.kwhPrice,
        extraAnnual: calc.extraAnnual,
        saasGrowth: calc.saasGrowth,
        subscriptions: subscriptions
      },
      hardware: hardware.map(function (h) {
        const copy = Object.assign({}, h);
        delete copy.ownSeries;
        return copy;
      }),
      series: series,
      bm25: bm,
      sm2: {
        days: sel.days,
        cards: sel.cards,
        matureAt: sel.matureAt,
        strategies: runs.map(function (r) {
          return { id: r.strategy, name: r.name, quality: r.quality, totalReviews: r.totalReviews,
            peakBacklog: r.peakBacklog, matureAtEnd: r.matureAtEnd, backlogAtEnd: r.backlogAtEnd };
        }),
        selected: sel.strategy,
        daily: sel.daily,
        mature: mature
      }
    };
  }

  function csvCell(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    let s = v === null || v === undefined ? '' : String(v);
    s = s.replace(/\r/g, '');
    if (/^[\t ]*[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function reportCsv(payload, sha) {
    const lines = [];
    lines.push('# subzero-vault lab report');
    lines.push('# sha256: ' + sha);
    lines.push('# horizon_months: ' + payload.horizon);
    lines.push(['box', 'upfront_usd', 'watts', 'kwh_per_year', 'power_usd_year', 'fees_extras_usd_year',
      'break_even_day', 'tco_usd', 'rent_usd', 'saved_usd'].join(','));
    payload.hardware.forEach(function (h) {
      lines.push([csvCell(h.name), csvCell(h.cost), csvCell(h.watts), csvCell(h.kwhYear), csvCell(h.powerAnnual),
        csvCell(h.feeAnnual), csvCell(h.breakEvenDay === null ? 'never' : h.breakEvenDay),
        csvCell(h.tco), csvCell(h.rent), csvCell(h.net)].join(','));
    });
    lines.push('# sm2 review simulation: ' + payload.sm2.cards + ' new cards over ' + payload.sm2.days + ' days');
    lines.push(['strategy', 'reviews', 'peak_backlog', 'mature_at_end', 'backlog_at_end'].join(','));
    payload.sm2.strategies.forEach(function (s) {
      lines.push([csvCell(s.name), csvCell(s.totalReviews), csvCell(s.peakBacklog), csvCell(s.matureAtEnd), csvCell(s.backlogAtEnd)].join(','));
    });
    return lines.join('\n') + '\n';
  }

  function mdCell(s) {
    return String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  }

  function reportMarkdown(payload, sha) {
    const o = [];
    o.push('## SubZero Vault lab report');
    o.push('');
    o.push('Horizon ' + payload.horizon + ' months. Rent ' + fmtMoney(payload.inputs.saasAnnual) +
      ' a year at the listed prices, electricity ' + payload.inputs.kwhPrice + ' per kWh.');
    o.push('');
    o.push('| Box | Up front | Watts | kWh a year | Power a year | Fees | Break even | TCO | Rent | Saved |');
    o.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    payload.hardware.forEach(function (h) {
      o.push('| ' + mdCell(h.name) + ' | ' + fmtMoney(h.cost) + ' | ' + h.watts + ' | ' + h.kwhYear.toFixed(2) +
        ' | ' + fmtMoney(h.powerAnnual) + ' | ' + fmtMoney(h.feeAnnual) + ' | ' + fmtDay(h.breakEvenDay) +
        ' | ' + fmtMoney(h.tco) + ' | ' + fmtMoney(h.rent) + ' | ' + fmtMoney(h.net) + ' |');
    });
    o.push('');
    o.push('| Strategy | Reviews | Peak backlog | Mature at day 90 |');
    o.push('| --- | ---: | ---: | ---: |');
    payload.sm2.strategies.forEach(function (s) {
      o.push('| ' + mdCell(s.name) + ' | ' + s.totalReviews + ' | ' + s.peakBacklog + ' | ' + s.matureAtEnd + ' |');
    });
    o.push('');
    o.push('SHA-256 `' + sha + '`');
    return o.join('\n') + '\n';
  }

  /* One digest-stamped bundle per canonical payload. The fingerprint on the
     page, the JSON body, the CSV header and the Markdown footer all reuse this
     object, so the four can never drift apart. */
  const bundleCache = new Map();

  function auditBundle(state, calcInput) {
    const payload = buildLabReport(state, calcInput);
    const canonical = E.canonicalJson(payload);
    const cached = bundleCache.get(canonical);
    if (cached) return cached;
    const sha = sha256Hex(canonical);
    const stamped = {};
    Object.keys(payload).forEach(function (k) { stamped[k] = payload[k]; });
    stamped.sha256 = sha;
    const bundle = {
      payload: payload,
      canonical: canonical,
      sha256: sha,
      json: JSON.stringify(stamped, null, 2) + '\n',
      csv: reportCsv(payload, sha),
      markdown: reportMarkdown(payload, sha)
    };
    if (bundleCache.size >= 24) bundleCache.delete(bundleCache.keys().next().value);
    bundleCache.set(canonical, bundle);
    return bundle;
  }

  function verifyReportJson(jsonText) {
    let o = null;
    try { o = JSON.parse(String(jsonText)); }
    catch (e) { return { ok: false, error: 'not-json' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'not-object' };
    const claimed = o.sha256;
    if (typeof claimed !== 'string' || !/^[0-9a-f]{64}$/.test(claimed)) return { ok: false, error: 'no-digest' };
    const rest = {};
    Object.keys(o).forEach(function (k) { if (k !== 'sha256') rest[k] = o[k]; });
    const actual = sha256Hex(E.canonicalJson(rest));
    return { ok: actual === claimed, expected: claimed, actual: actual };
  }

  /* Change one numeric field in a copy of the export, keep the old checksum,
     and show the verify step catching it. */
  function tamperReportJson(jsonText) {
    let o = null;
    try { o = JSON.parse(String(jsonText)); } catch (e) { o = null; }
    if (!o || typeof o !== 'object') return { json: String(jsonText), verify: verifyReportJson(jsonText) };
    if (Array.isArray(o.hardware) && o.hardware.length && typeof o.hardware[0].cost === 'number') {
      o.hardware[0].cost += 25;
    } else {
      o.tampered = true;
    }
    const text = JSON.stringify(o, null, 2) + '\n';
    return { json: text, verify: verifyReportJson(text) };
  }

  // ---------------------------------------------------------------------------
  // In-page self-tests: deterministic checks a visitor can run
  // ---------------------------------------------------------------------------

  function labSelfTests() {
    const out = [];
    const add = function (name, fn) {
      let ok = false, detail = '';
      try { const r = fn(); ok = r === true ? true : !!r.ok; detail = r && r.detail ? r.detail : ''; }
      catch (e) { ok = false; detail = String(e && e.message || e).slice(0, 80); }
      out.push({ name: name, ok: ok, detail: detail });
    };

    add('SHA-256 of the empty string matches the FIPS test vector', function () {
      return sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    });
    add('SHA-256 of abc matches the FIPS test vector', function () {
      return sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    });
    add('SHA-256 handles a multi block message', function () {
      return sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') ===
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';
    });
    add('SHA-256 handles the one million letter a vector', function () {
      return sha256Hex('a'.repeat(1000000)) === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';
    });
    add('Canonical JSON is key order independent', function () {
      return sha256Hex(E.canonicalJson({ b: 2, a: 1 })) === sha256Hex(E.canonicalJson({ a: 1, b: 2 }));
    });
    add('TCO break-even matches the engine to the day', function () {
      const row = compareHardware(E.defaultCalcState(), 36).find(function (h) { return h.id === 'pi5'; });
      return row && row.breakEvenDay === E.computeSubscriptionSavings(E.defaultCalcState()).breakEvenDay;
    });
    add('VPS row prices the monthly fee and breaks even at day zero', function () {
      const row = compareHardware(E.defaultCalcState(), 36).find(function (h) { return h.id === 'vps'; });
      return row && row.breakEvenDay === 0 && row.net > 0;
    });
    add('Cheaper power or pricier rent can only pull break-even earlier', function () {
      const row = compareHardware(E.defaultCalcState(), 36).find(function (h) { return h.id === 'thinkcentre'; });
      if (!row || row.breakEvenDay === null) return false;
      const le = function (x) { return x === null ? Infinity : x; };
      return le(row.sens.powerDown) <= row.breakEvenDay && le(row.sens.saasUp) <= row.breakEvenDay;
    });
    add('BM25 ranks the SQLite article first for the default query', function () {
      const r = bm25Lab('sqlite backup', 1.5, 0.75);
      return r.rows.length > 0 && r.rows[0].id === 's4';
    });
    add('BM25 scores are sorted and Kendall tau is one against itself', function () {
      const r = bm25Lab('backup', 2.5, 0.2);
      if (r.tau !== 1) return false;
      for (let i = 1; i < r.rows.length; i++) {
        if (r.rows[i - 1].score < r.rows[i].score) return false;
        if (r.rows[i - 1].score === r.rows[i].score && String(r.rows[i - 1].id) > String(r.rows[i].id)) return false;
      }
      return true;
    });
    add('SM-2 easiness factor never drops below 1.3', function () {
      let c = null;
      for (let i = 0; i < 20; i++) c = E.scheduleSm2Review(c, 3, '2026-01-05');
      return c.ef >= 1.3;
    });
    add('Weekday strategy rests on Saturday and Sunday', function () {
      const r = simulateSm2('weekday');
      return r.daily.every(function (d) { return d.day % 7 < 5 || d.reviewed === 0; });
    });
    add('CSV cells escape spreadsheet formulas', function () {
      return csvCell('=CMD()') === "'=CMD()" && csvCell('+1+1') === "'+1+1" &&
        csvCell('@SUM(1)') === "'@SUM(1)" && csvCell('plain') === 'plain';
    });
    add('One digest appears in the JSON, CSV and Markdown exports', function () {
      const b = auditBundle(defaultLabState(), E.defaultCalcState());
      const inJson = b.json.indexOf(b.sha256) >= 0;
      const inCsv = b.csv.indexOf('# sha256: ' + b.sha256) >= 0;
      const inMd = b.markdown.indexOf(b.sha256) >= 0;
      return inJson && inCsv && inMd;
    });
    add('Verify accepts the export and tamper detection rejects an edit', function () {
      const b = auditBundle(defaultLabState(), E.defaultCalcState());
      if (!verifyReportJson(b.json).ok) return false;
      return tamperReportJson(b.json).verify.ok === false;
    });
    add('The #szv= hash round trips every field and rejects junk', function () {
      const s = { view: 'diag', profile: 'nas', horizon: 60, k1: 2.2, b: 0.2, strategy: 'weekend', query: 'x' };
      const back = decodeLabHash(encodeLabHash(s));
      const same = back.ok && back.state.view === 'diag' && back.state.profile === 'nas' &&
        back.state.horizon === 60 && Math.abs(back.state.k1 - 2.2) < 1e-9 &&
        Math.abs(back.state.b - 0.2) < 1e-9 && back.state.strategy === 'weekend';
      return same && !decodeLabHash('%%%junk%%%').ok && !decodeLabHash('AAAA').ok;
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // HTML and SVG renderers (strings, testable in Node)
  // ---------------------------------------------------------------------------

  function renderLabTabs(active) {
    return LAB_VIEWS.map(function (v) {
      const on = v.id === active;
      return '<button type="button" role="tab" class="tab" id="lab-tab-' + v.id + '" aria-controls="lab-view-' + v.id + '" data-action="lab-view" data-id="' + v.id +
        '" aria-selected="' + on + '" tabindex="' + (on ? '0' : '-1') + '">' + esc(v.name) + '</button>';
    }).join('');
  }

  function renderComparatorRows(report, selected) {
    return report.hardware.map(function (h) {
      const on = h.id === selected;
      return '<tr' + (on ? ' class="is-sel"' : '') + '>' +
        '<th scope="row"><button type="button" class="chip lab-pick" data-action="lab-profile" data-id="' + esc(h.id) +
        '" aria-pressed="' + on + '" title="' + esc(h.note) + '">' + esc(h.name) + '</button></th>' +
        '<td class="num">' + fmtMoney(h.cost) + '</td>' +
        '<td class="num">' + h.watts + '</td>' +
        '<td class="num">' + h.kwhYear.toFixed(2) + '</td>' +
        '<td class="num">' + fmtMoney(h.powerAnnual) + '</td>' +
        '<td class="num">' + fmtMoney(h.feeAnnual) + '</td>' +
        '<td class="num">' + fmtDay(h.breakEvenDay) + '</td>' +
        '<td class="num">' + fmtMoney(h.tco) + '</td>' +
        '<td class="num">' + fmtMoney(h.rent) + '</td>' +
        '<td class="num">' + fmtMoney(h.net) + '</td></tr>';
    }).join('');
  }

  function renderSensitivityRows(report, selected) {
    return report.hardware.map(function (h) {
      const on = h.id === selected;
      return '<tr' + (on ? ' class="is-sel"' : '') + '><th scope="row">' + esc(h.name) + '</th>' +
        '<td class="num">' + fmtDay(h.sens.powerDown) + '</td>' +
        '<td class="num">' + fmtDay(h.sens.powerUp) + '</td>' +
        '<td class="num">' + fmtDay(h.sens.saasDown) + '</td>' +
        '<td class="num">' + fmtDay(h.sens.saasUp) + '</td></tr>';
    }).join('');
  }

  const CHART_M = { l: 58, r: 14, t: 18, b: 46 };

  /* The 60 month cumulative cost chart: the rent line plus one line per
     profile, a marker where each line catches the rent, and a dashed marker on
     the chosen horizon. Break-even markers carry pointer titles and chart descriptions. */
  function renderTcoChart(report, opts) {
    const o = opts || {};
    const W = Math.max(280, Math.round(o.width || 640));
    const H = Math.max(230, Math.round(o.height || W * 0.52));
    const months = 60;
    const m = CHART_M;
    let maxV = 1;
    (report.series.saas || []).forEach(function (v, i) { if (i <= months && v > maxV) maxV = v; });
    PROFILE_IDS.forEach(function (pid) {
      const s = report.series.own[pid] || [];
      s.forEach(function (v, i) { if (i <= months && v > maxV) maxV = v; });
    });
    maxV = niceMax(maxV);
    const px = function (i) { return m.l + (W - m.l - m.r) * (i / months); };
    const py = function (v) { return H - m.b - (H - m.t - m.b) * (v / maxV); };
    const path = function (series) {
      return series.slice(0, months + 1).map(function (v, i) {
        return (i ? 'L' : 'M') + px(i).toFixed(1) + ' ' + py(v).toFixed(1);
      }).join(' ');
    };
    const at = function (series, cm) {
      const i0 = Math.floor(cm), i1 = Math.min(months, i0 + 1);
      return series[i0] + (series[i1] - series[i0]) * (cm - i0);
    };

    let grid = '', yLabels = '', xLabels = '';
    for (let g = 0; g <= 4; g++) {
      const v = maxV * g / 4;
      grid += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + py(v).toFixed(1) + '" y2="' + py(v).toFixed(1) + '"/>';
      yLabels += '<text x="' + (m.l - 8) + '" y="' + (py(v) + 4).toFixed(1) + '" text-anchor="end">' + E.axisDollars(v) + '</text>';
    }
    for (let i = 0; i <= months; i += 12) {
      xLabels += '<text x="' + px(i).toFixed(1) + '" y="' + (H - m.b + 18) + '" text-anchor="' + (i === 0 ? 'start' : 'middle') + '">' + i + '</text>';
    }
    xLabels += '<text x="' + (W - m.r) + '" y="' + (H - 6) + '" text-anchor="end">months from today</text>';

    let lines = '<path class="line line-saas" d="' + path(report.series.saas) + '"/>';
    let endLabels = '<text class="chart-label chart-label-saas" x="' + (W - m.r) + '" y="' + (py(report.series.saas[months]) - 8).toFixed(1) +
      '" text-anchor="end">Cloud rent ' + E.axisDollars(report.series.saas[months]) + '</text>';
    report.hardware.forEach(function (h) {
      const s = report.series.own[h.id];
      if (!s) return;
      const sel = h.id === report.profile;
      lines += '<path class="line line-hw hw-' + h.id + (sel ? ' is-sel' : '') + '" d="' + path(s) + '"/>';
      if (sel) {
        const rentY = py(report.series.saas[months]) - 8;
        const ownY = py(s[months]) - 8;
        const y = Math.abs(ownY - rentY) < 16 ? rentY + 16 : ownY;
        endLabels += '<text class="chart-label chart-label-own" x="' + (W - m.r) + '" y="' + y.toFixed(1) +
          '" text-anchor="end">' + (W < 380 ? 'Selected box' : esc(h.name)) + ' ' + E.axisDollars(s[months]) + '</text>';
      }
    });

    let marks = '';
    const crossDesc = [];
    report.hardware.forEach(function (h) {
      if (h.crossMonth === null || h.crossMonth > months) return;
      const cm = h.crossMonth;
      const cx = px(cm), cy = py(at(report.series.saas, cm));
      crossDesc.push(h.name + ' at month ' + cm.toFixed(1));
      marks += '<circle class="cross-dot lab-mark" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) +
        '" r="5"><title>' + esc(h.name + ' breaks even at month ' + cm.toFixed(1) +
        (h.breakEvenDay !== null ? ' (day ' + h.breakEvenDay + ')' : '')) + '</title></circle>';
    });
    const hMonth = report.horizon;
    let horizonMark = '';
    if (hMonth > 0 && hMonth <= months) {
      const right = px(hMonth) > W * 0.53;
      horizonMark = '<line class="scrub-line" x1="' + px(hMonth).toFixed(1) + '" x2="' + px(hMonth).toFixed(1) +
        '" y1="' + m.t + '" y2="' + py(0).toFixed(1) + '"/>' +
        '<text class="cross-text" x="' + (px(hMonth) + (right ? -6 : 6)).toFixed(1) + '" y="' + (m.t + 10) +
        '" text-anchor="' + (right ? 'end' : 'start') + '">' + hMonth + ' month horizon</text>';
    }

    const desc = 'Cumulative cost over 60 months. Cloud rent reaches ' + fmtMoney0(report.series.saas[months]) +
      '. ' + (crossDesc.length ? 'Break-even: ' + crossDesc.join(', ') + '.' : 'No hardware line catches the rent.');
    return '<svg class="chart-svg lab-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-labelledby="lab-tco-chart-title lab-tco-desc">' +
      '<desc id="lab-tco-desc">' + esc(desc) + '</desc>' +
      '<g class="chart-grid" aria-hidden="true">' + grid + '</g>' +
      '<g class="chart-axis" aria-hidden="true">' + yLabels + xLabels + '</g>' +
      lines + '<g aria-hidden="true">' + endLabels + '</g>' + horizonMark + marks + '</svg>';
  }

  function renderBm25Rows(bm) {
    if (!bm.rows.length) return '<tr><td colspan="3" class="empty">No article matches that query.</td></tr>';
    return bm.rows.map(function (r, i) {
      return '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(r.title) + '</td><td class="num">' + r.score.toFixed(3) + '</td></tr>';
    }).join('');
  }

  function renderStabilityTiles(bm) {
    const tiles = [
      { v: bm.tau === null ? 'n/a' : bm.tau.toFixed(2), l: 'Kendall tau against k1 1.5, b 0.75' },
      { v: Math.round(bm.overlap3 * 100) + '%', l: 'Top 3 overlap with the default ranking' },
      { v: String(bm.matches), l: 'Articles matching this query' }
    ];
    return tiles.map(function (t) {
      return '<div class="tile"><span class="tile-value">' + esc(t.v) + '</span><span class="tile-label">' + esc(t.l) + '</span></div>';
    }).join('');
  }

  function renderSm2Rows(sm2, selected) {
    return sm2.strategies.map(function (s) {
      const on = s.id === selected;
      return '<tr' + (on ? ' class="is-sel"' : '') + '><th scope="row">' + esc(s.name) + '</th>' +
        '<td class="num">' + s.totalReviews + '</td>' +
        '<td class="num">' + s.peakBacklog + '</td>' +
        '<td class="num">' + s.matureAtEnd + '</td>' +
        '<td class="num">' + s.backlogAtEnd + '</td></tr>';
    }).join('');
  }

  /* The 90 day review load chart: bars for the selected strategy's daily
     reviews, its backlog line, and all four mature-card curves for contrast. */
  function renderSm2Chart(sm2, opts) {
    const o = opts || {};
    const W = Math.max(280, Math.round(o.width || 640));
    const H = Math.max(230, Math.round(o.height || W * 0.52));
    const m = CHART_M;
    const days = sm2.days;
    let maxV = sm2.cards;
    sm2.daily.forEach(function (d) {
      if (d.due > maxV) maxV = d.due;
      if (d.reviewed > maxV) maxV = d.reviewed;
    });
    maxV = niceMax(maxV);
    const px = function (i) { return m.l + (W - m.l - m.r) * (i / (days - 1)); };
    const py = function (v) { return H - m.b - (H - m.t - m.b) * (v / maxV); };

    let grid = '', yLabels = '', xLabels = '';
    for (let g = 0; g <= 4; g++) {
      const v = Math.round(maxV * g / 4);
      grid += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + py(v).toFixed(1) + '" y2="' + py(v).toFixed(1) + '"/>';
      yLabels += '<text x="' + (m.l - 8) + '" y="' + (py(v) + 4).toFixed(1) + '" text-anchor="end">' + v + '</text>';
    }
    for (let i = 0; i < days; i += 30) {
      xLabels += '<text x="' + px(i).toFixed(1) + '" y="' + (H - m.b + 18) + '" text-anchor="' + (i === 0 ? 'start' : 'middle') + '">' + i + '</text>';
    }
    xLabels += '<text x="' + (W - m.r) + '" y="' + (H - 6) + '" text-anchor="end">days</text>';

    const bw = Math.max(1, (W - m.l - m.r) / days - 1.5);
    let bars = '';
    sm2.daily.forEach(function (d) {
      if (!d.reviewed) return;
      const x = px(d.day) - bw / 2;
      bars += '<rect class="review-bar" x="' + x.toFixed(1) + '" y="' + py(d.reviewed).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + (py(0) - py(d.reviewed)).toFixed(1) + '"/>';
    });
    const backlog = '<path class="line backlog-line" d="' + sm2.daily.map(function (d, i) {
      return (i ? 'L' : 'M') + px(d.day).toFixed(1) + ' ' + py(d.backlog).toFixed(1);
    }).join(' ') + '"/>';

    let curves = '', labels = '';
    const endUsed = [];
    SM2_STRATEGIES.forEach(function (st) {
      const arr = sm2.mature[st.id];
      if (!arr) return;
      curves += '<path class="line mat-line mat-' + st.id + '" d="' + arr.map(function (v, i) {
        return (i ? 'L' : 'M') + px(i).toFixed(1) + ' ' + py(v).toFixed(1);
      }).join(' ') + '"/>';
      let y = py(arr[arr.length - 1]);
      for (let i = 0; i < endUsed.length; i++) { if (Math.abs(y - endUsed[i]) < 13) y = endUsed[i] + 14; }
      endUsed.push(y);
      labels += '<text class="chart-label lab-mat lab-mat-' + st.id + '" x="' + (W - m.r) + '" y="' + (y - 5).toFixed(1) +
        '" text-anchor="end">' + esc(st.name) + ' ' + arr[arr.length - 1] + '</text>';
    });

    const desc = 'Review load over ' + days + ' days for ' + sm2.cards + ' new cards. Bars show daily reviews for the ' +
      'selected strategy, the line shows its backlog, and the four curves count mature cards per strategy.';
    return '<svg class="chart-svg lab-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-labelledby="lab-sm2-chart-title lab-sm2-desc">' +
      '<desc id="lab-sm2-desc">' + esc(desc) + '</desc>' +
      '<g class="chart-grid" aria-hidden="true">' + grid + '</g>' +
      '<g class="chart-axis" aria-hidden="true">' + yLabels + xLabels + '</g>' +
      '<g aria-hidden="true">' + bars + '</g>' + backlog + curves +
      '<g aria-hidden="true">' + labels + '</g></svg>';
  }

  function renderSelfTestResults(list) {
    return list.map(function (t) {
      return '<li class="lab-test ' + (t.ok ? 'is-ok' : 'is-bad') + '"><span class="lab-test-mark">' +
        (t.ok ? 'pass' : 'FAIL') + '</span> ' + esc(t.name) + (t.detail ? ' <span class="lab-test-detail">' + esc(t.detail) + '</span>' : '') + '</li>';
    }).join('');
  }

  return {
    HARDWARE_PROFILES: HARDWARE_PROFILES,
    SM2_STRATEGIES: SM2_STRATEGIES,
    LAB_VIEWS: LAB_VIEWS,
    HORIZONS: HORIZONS,
    SIM_CARDS: SIM_CARDS,
    SIM_DAYS: SIM_DAYS,
    utf8Bytes: utf8Bytes,
    utf8Decode: utf8Decode,
    sha256Hex: sha256Hex,
    b64urlEncodeStr: b64urlEncodeStr,
    b64urlDecodeBytes: b64urlDecodeBytes,
    defaultLabState: defaultLabState,
    normalizeLabState: normalizeLabState,
    encodeLabHash: encodeLabHash,
    decodeLabHash: decodeLabHash,
    compareHardware: compareHardware,
    kendallTau: kendallTau,
    topKOverlap: topKOverlap,
    bm25Lab: bm25Lab,
    simulateSm2: simulateSm2,
    buildLabReport: buildLabReport,
    auditBundle: auditBundle,
    verifyReportJson: verifyReportJson,
    tamperReportJson: tamperReportJson,
    csvCell: csvCell,
    reportCsv: reportCsv,
    reportMarkdown: reportMarkdown,
    labSelfTests: labSelfTests,
    fmtMoney: fmtMoney,
    fmtMoney0: fmtMoney0,
    fmtDay: fmtDay,
    renderLabTabs: renderLabTabs,
    renderComparatorRows: renderComparatorRows,
    renderSensitivityRows: renderSensitivityRows,
    renderTcoChart: renderTcoChart,
    renderBm25Rows: renderBm25Rows,
    renderStabilityTiles: renderStabilityTiles,
    renderSm2Rows: renderSm2Rows,
    renderSm2Chart: renderSm2Chart,
    renderSelfTestResults: renderSelfTestResults
  };
}));
