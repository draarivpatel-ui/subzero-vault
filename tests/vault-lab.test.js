'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const E = require('../engine.js');
const S = require('../samples.js');
const L = require('../vault-lab.js');
const App = require('../app.js');
const { createEnvironment, sleep } = require('./helpers/fake-dom.js');

const node256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const refCalc = () => E.defaultCalcState();

function b64ofBytes(bytes) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64[b2 & 63];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure-JS SHA-256
// ---------------------------------------------------------------------------

test('sha256: empty string matches the FIPS vector', () => {
  assert.equal(L.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256: abc matches the FIPS vector', () => {
  assert.equal(L.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256: two-block message matches the FIPS vector', () => {
  assert.equal(L.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256: one million letter a matches the FIPS vector', () => {
  assert.equal(L.sha256Hex('a'.repeat(1000000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('sha256: agrees with node:crypto on a sentence', () => {
  const s = 'The quick brown fox jumps over the lazy dog';
  assert.equal(L.sha256Hex(s), node256(s));
});

test('sha256: agrees with node:crypto at every block boundary 0-130 bytes', () => {
  for (let n = 0; n <= 130; n++) {
    const s = 'x'.repeat(n);
    assert.equal(L.sha256Hex(s), node256(s), 'length ' + n);
  }
});

test('sha256: agrees with node:crypto on multibyte text', () => {
  ['héllo wörld', 'vault € £ ¥', 'café', ''].forEach((s) => {
    assert.equal(L.sha256Hex(s), node256(s), s);
  });
});

test('sha256: agrees with node:crypto on astral characters', () => {
  const s = 'bookmark \u{1F4DA} pile';
  assert.equal(L.sha256Hex(s), node256(s));
});

test('sha256: output is always 64 lowercase hex characters', () => {
  ['', 'a', 'hello', 'x'.repeat(500)].forEach((s) => {
    assert.match(L.sha256Hex(s), /^[0-9a-f]{64}$/);
  });
});

test('sha256: number input is stringified before hashing', () => {
  assert.equal(L.sha256Hex(42), node256('42'));
  assert.equal(L.sha256Hex(true), node256('true'));
});

test('sha256: lone surrogates hash like the replacement character', () => {
  assert.equal(L.sha256Hex('\uD800'), L.sha256Hex('\uFFFD'));
  assert.equal(L.sha256Hex('\uDFFF'), L.sha256Hex('\uFFFD'));
});

test('sha256: long input matches node:crypto', () => {
  const s = Array.from({ length: 5000 }, (_, i) => 'line ' + i + ' of the vault report').join('\n');
  assert.equal(L.sha256Hex(s), node256(s));
});

// ---------------------------------------------------------------------------
// utf8Bytes, utf8Decode, base64url
// ---------------------------------------------------------------------------

test('utf8Bytes: ASCII stays one byte per character', () => {
  assert.deepEqual(Array.from(L.utf8Bytes('abc')), [97, 98, 99]);
});

test('utf8Bytes: multibyte characters match Buffer.from', () => {
  ['€', '', 'aé\u{1F4DA}'].forEach((s) => {
    assert.deepEqual(Array.from(L.utf8Bytes(s)), Array.from(Buffer.from(s, 'utf8')), s);
  });
});

test('utf8Decode: round-trips what utf8Bytes encoded', () => {
  ['', 'plain ascii', 'héllo €', '', '\u{1F4DA}'].forEach((s) => {
    assert.equal(L.utf8Decode(L.utf8Bytes(s)), s);
  });
});

test('utf8Decode: rejects overlong and truncated sequences', () => {
  assert.throws(() => L.utf8Decode(new Uint8Array([0xc0, 0x80])));
  assert.throws(() => L.utf8Decode(new Uint8Array([0xe0, 0x80, 0x80])));
  assert.throws(() => L.utf8Decode(new Uint8Array([0xf0, 0x80, 0x80, 0x80])));
  assert.throws(() => L.utf8Decode(new Uint8Array([0xe2, 0x82])));
  assert.throws(() => L.utf8Decode(new Uint8Array([0x80])));
});

test('utf8Decode: rejects surrogate halves', () => {
  assert.throws(() => L.utf8Decode(new Uint8Array([0xed, 0xa0, 0x80])));
});

test('b64urlEncodeStr: emits only url-safe characters and no padding', () => {
  const t = L.b64urlEncodeStr('{"v":1,"p":"pi5"}');
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.ok(!t.includes('='));
});

test('b64urlDecodeBytes: rejects bad characters and impossible lengths', () => {
  assert.throws(() => L.b64urlDecodeBytes('%%%'));
  assert.throws(() => L.b64urlDecodeBytes('hello world'));
  assert.throws(() => L.b64urlDecodeBytes('AAAAA'));
  assert.throws(() => L.b64urlDecodeBytes(42));
  assert.throws(() => L.b64urlDecodeBytes(''));
});

test('b64urlDecodeBytes: rejects non-canonical trailing bits', () => {
  const good = L.b64urlEncodeStr('{"v":1}');
  const last = good[good.length - 1];
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const idx = B64.indexOf(last);
  const spare = (4 - (good.length % 4)) % 4;
  const dataBits = (good.length * 6) % 8;
  const pad = (6 - dataBits) % 6;
  if (pad > 0) {
    const flipped = good.slice(0, -1) + B64[idx | ((1 << pad) - 1)];
    assert.throws(() => L.b64urlDecodeBytes(flipped), /padding/);
  } else {
    assert.ok(idx >= 0 && spare >= 0);
  }
});

test('base64url: round-trips arbitrary JSON text', () => {
  ['{"v":1}', '{"p":"nas","z":60,"k":2.2,"b":0.2,"s":"weekend","t":"diag","v":1}', '[]'].forEach((s) => {
    assert.equal(L.utf8Decode(L.b64urlDecodeBytes(L.b64urlEncodeStr(s))), s);
  });
});

// ---------------------------------------------------------------------------
// Lab state normalisation (permissive, used by live controls)
// ---------------------------------------------------------------------------

test('normalizeLabState: defaults come back for missing input', () => {
  assert.deepEqual(L.normalizeLabState(), L.defaultLabState());
  assert.deepEqual(L.normalizeLabState({}), L.defaultLabState());
});

test('normalizeLabState: non-objects are ignored', () => {
  [null, undefined, 42, 'diag', true, [], ['x']].forEach((v) => {
    assert.deepEqual(L.normalizeLabState(v), L.defaultLabState());
  });
});

test('normalizeLabState: k1 and b clamp into range', () => {
  assert.equal(L.normalizeLabState({ k1: 99 }).k1, 4);
  assert.equal(L.normalizeLabState({ k1: -3 }).k1, 0);
  assert.equal(L.normalizeLabState({ b: 2 }).b, 1);
  assert.equal(L.normalizeLabState({ b: -0.5 }).b, 0);
});

test('normalizeLabState: NaN and Infinity fall back to defaults', () => {
  const d = L.defaultLabState();
  assert.equal(L.normalizeLabState({ k1: NaN }).k1, d.k1);
  assert.equal(L.normalizeLabState({ k1: Infinity }).k1, d.k1);
  assert.equal(L.normalizeLabState({ b: -Infinity }).b, d.b);
  assert.equal(L.normalizeLabState({ horizon: NaN }).horizon, d.horizon);
});

test('normalizeLabState: negative zero normalises like zero', () => {
  const s = L.normalizeLabState({ k1: -0, b: -0 });
  assert.equal(s.k1, 0);
  assert.equal(s.b, 0);
  assert.ok(Object.is(s.k1, 0) || Object.is(s.k1, -0));
});

test('normalizeLabState: unknown enum values fall back, known ones stick', () => {
  const s = L.normalizeLabState({ profile: 'bogus', strategy: 'bogus', view: 'bogus', horizon: 13 });
  const d = L.defaultLabState();
  assert.equal(s.profile, d.profile);
  assert.equal(s.strategy, d.strategy);
  assert.equal(s.view, d.view);
  assert.equal(s.horizon, d.horizon);
  const ok = L.normalizeLabState({ profile: 'vps', strategy: 'ease', view: 'export', horizon: 60 });
  assert.equal(ok.profile, 'vps');
  assert.equal(ok.strategy, 'ease');
  assert.equal(ok.view, 'export');
  assert.equal(ok.horizon, 60);
});

test('normalizeLabState: horizon accepts the three supported values', () => {
  [12, 36, 60].forEach((h) => assert.equal(L.normalizeLabState({ horizon: h }).horizon, h));
  assert.equal(L.normalizeLabState({ horizon: '60' }).horizon, 60);
});

test('normalizeLabState: query is truncated and non-strings replaced', () => {
  assert.equal(L.normalizeLabState({ query: 'x'.repeat(500) }).query.length, 120);
  assert.equal(L.normalizeLabState({ query: 42 }).query, L.defaultLabState().query);
  assert.equal(L.normalizeLabState({ query: null }).query, L.defaultLabState().query);
});

// ---------------------------------------------------------------------------
// #szv= codec: strict decode, canonical encode
// ---------------------------------------------------------------------------

test('codec: an all-default state encodes to the empty token', () => {
  assert.equal(L.encodeLabHash(L.defaultLabState()), '');
});

test('codec: empty and missing tokens decode to defaults with ok', () => {
  ['', null, undefined].forEach((t) => {
    const d = L.decodeLabHash(t);
    assert.equal(d.ok, true);
    assert.deepEqual(d.state, L.defaultLabState());
  });
});

test('codec: round-trips every field', () => {
  const s = { view: 'diag', profile: 'nas', horizon: 60, k1: 2.2, b: 0.2, strategy: 'weekend', query: 'kept out of the link' };
  const d = L.decodeLabHash(L.encodeLabHash(s));
  assert.equal(d.ok, true);
  assert.equal(d.state.view, 'diag');
  assert.equal(d.state.profile, 'nas');
  assert.equal(d.state.horizon, 60);
  assert.equal(d.state.k1, 2.2);
  assert.equal(d.state.b, 0.2);
  assert.equal(d.state.strategy, 'weekend');
  assert.equal(d.state.query, L.defaultLabState().query);
});

test('codec: each single changed field survives the round-trip', () => {
  const cases = [
    ['view', 'export'], ['profile', 'thinkcentre'], ['horizon', 12], ['k1', 0.5], ['b', 0.95], ['strategy', 'weekday']
  ];
  cases.forEach(([key, val]) => {
    const s = Object.assign(L.defaultLabState(), { [key]: val });
    const t = L.encodeLabHash(s);
    assert.ok(t.length > 0, key);
    const d = L.decodeLabHash(t);
    assert.equal(d.ok, true, key);
    assert.equal(d.state[key], val, key);
  });
});

test('codec: encode is canonical so the same state gives the same token', () => {
  const s = L.normalizeLabState({ view: 'export', profile: 'vps', horizon: 60, k1: 2.5, b: 0.1, strategy: 'ease' });
  assert.equal(L.encodeLabHash(s), L.encodeLabHash(L.normalizeLabState(s)));
});

test('codec: plain junk tokens fail closed', () => {
  ['%%%', 'junk!!!', 'AAAA', 'AAA', 'A', '=', '#szv=', 'eyJ2IjoxfQ==', 'a-b-c'].forEach((t) => {
    const d = L.decodeLabHash(t);
    assert.equal(d.ok, false, t);
    assert.deepEqual(d.state, L.defaultLabState(), t);
  });
});

test('codec: valid base64url of non-JSON bytes fails closed', () => {
  assert.equal(L.decodeLabHash(b64ofBytes([0x00, 0x01, 0x02, 0x03])).ok, false);
  assert.equal(L.decodeLabHash(b64ofBytes([0xff, 0xfe, 0xfd])).ok, false);
  assert.equal(L.decodeLabHash(b64ofBytes([0x7b])).ok, false);
});

test('codec: invalid utf-8 inside the token fails closed', () => {
  assert.equal(L.decodeLabHash(b64ofBytes([0xc0, 0x80])).ok, false);
  assert.equal(L.decodeLabHash(b64ofBytes([0xe2, 0x82])).ok, false);
});

test('codec: JSON primitives at the top level fail closed', () => {
  ['null', 'true', '42', '"str"', '[]', '[{"v":1}]'].forEach((s) => {
    assert.equal(L.decodeLabHash(L.b64urlEncodeStr(s)).ok, false, s);
  });
});

test('codec: a version other than 1 fails closed', () => {
  assert.equal(L.decodeLabHash(L.b64urlEncodeStr('{"v":2}')).ok, false);
  assert.equal(L.decodeLabHash(L.b64urlEncodeStr('{"v":0}')).ok, false);
  assert.equal(L.decodeLabHash(L.b64urlEncodeStr('{"v":"1"}')).ok, false);
  assert.equal(L.decodeLabHash(L.b64urlEncodeStr('{"p":"pi5"}')).ok, false);
});

test('codec: unknown keys fail closed even when the rest is valid', () => {
  assert.equal(L.decodeLabHash(L.b64urlEncodeStr('{"v":1,"p":"nas","x":1}')).ok, false);
  assert.equal(L.decodeLabHash(L.b64urlEncodeStr('{"v":1,"query":"y"}')).ok, false);
});

test('codec: __proto__ keys fail closed and never pollute', () => {
  const t = L.b64urlEncodeStr('{"v":1,"__proto__":{"polluted":"yes"}}');
  assert.equal(L.decodeLabHash(t).ok, false);
  assert.equal(({}).polluted, undefined);
  const t2 = L.b64urlEncodeStr('{"v":1,"constructor":{"prototype":{}}}');
  assert.equal(L.decodeLabHash(t2).ok, false);
  assert.equal(({}).polluted, undefined);
});

test('codec: out-of-range and wrong-typed fields fail closed', () => {
  const bad = [
    '{"v":1,"k":-0.5}', '{"v":1,"k":4.5}', '{"v":1,"k":"1.5"}', '{"v":1,"k":null}', '{"v":1,"k":true}',
    '{"v":1,"b":-0.1}', '{"v":1,"b":1.1}', '{"v":1,"b":"0.5"}',
    '{"v":1,"z":13}', '{"v":1,"z":"36"}', '{"v":1,"z":36.5}',
    '{"v":1,"p":"bogus"}', '{"v":1,"p":42}',
    '{"v":1,"s":"bogus"}', '{"v":1,"t":"bogus"}'
  ];
  bad.forEach((s) => {
    const d = L.decodeLabHash(L.b64urlEncodeStr(s));
    assert.equal(d.ok, false, s);
    assert.deepEqual(d.state, L.defaultLabState(), s);
  });
});

test('codec: non-finite numbers in the JSON fail closed', () => {
  assert.equal(L.decodeLabHash(L.b64urlEncodeStr('{"v":1,"k":1e999}')).ok, false);
  assert.equal(L.decodeLabHash(L.b64urlEncodeStr('{"v":1,"b":-1e999}')).ok, false);
});

test('codec: a token over the length cap fails closed', () => {
  assert.equal(L.decodeLabHash('A'.repeat(2001)).ok, false);
});

test('codec: non-string tokens fail closed', () => {
  [42, {}, [], true, NaN].forEach((v) => assert.equal(L.decodeLabHash(v).ok, false));
});

test('codec: boundary k1 and b values are accepted', () => {
  [{ k: 0 }, { k: 4 }, { b: 0 }, { b: 1 }].forEach((extra) => {
    const o = Object.assign({ v: 1 }, extra);
    const d = L.decodeLabHash(L.b64urlEncodeStr(JSON.stringify(o)));
    assert.equal(d.ok, true, JSON.stringify(o));
  });
});

// ---------------------------------------------------------------------------
// Five hardware TCO comparator
// ---------------------------------------------------------------------------

test('comparator: returns the five named profiles in order', () => {
  const rows = L.compareHardware(refCalc(), 36);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.id), ['pi5', 'n100', 'thinkcentre', 'nas', 'vps']);
  assert.deepEqual(rows.map((r) => r.name), L.HARDWARE_PROFILES.map((p) => p.name));
});

test('comparator: pi5 break-even matches the engine for the same inputs', () => {
  const row = L.compareHardware(refCalc(), 36).find((r) => r.id === 'pi5');
  const direct = E.computeSubscriptionSavings(E.normalizeCalc(Object.assign(refCalc(), { hardwareCost: 120, watts: 6 })));
  assert.equal(row.breakEvenDay, direct.breakEvenDay);
  assert.equal(row.crossMonth, direct.crossMonth);
});

test('comparator: VPS has no up-front cost so it breaks even immediately', () => {
  const row = L.compareHardware(refCalc(), 36).find((r) => r.id === 'vps');
  assert.equal(row.cost, 0);
  assert.equal(row.breakEvenDay, 0);
  assert.equal(row.crossMonth, 0);
  assert.ok(row.net > 0);
});

test('comparator: owned power cost follows watts times 8.76 kWh', () => {
  const rows = L.compareHardware(refCalc(), 36);
  rows.filter((r) => r.watts > 0).forEach((r) => {
    assert.ok(Math.abs(r.kwhYear - r.watts * 8.76) < 0.01, r.id);
    assert.ok(Math.abs(r.powerAnnual - r.kwhYear * refCalc().kwhPrice) < 0.02, r.id);
  });
});

test('comparator: VPS fees land in feeAnnual', () => {
  const row = L.compareHardware(refCalc(), 36).find((r) => r.id === 'vps');
  assert.equal(row.feeAnnual, 6 * 12 + refCalc().extraAnnual);
});

test('comparator: tco plus saved equals rent at the horizon', () => {
  [12, 36, 60].forEach((h) => {
    L.compareHardware(refCalc(), h).forEach((r) => {
      assert.ok(Math.abs(r.tco + r.net - r.rent) < 0.02, r.id + ' at ' + h);
    });
  });
});

test('comparator: longer horizons never lower total cost', () => {
  [12, 36, 60].forEach((h) => {
    const tcos = L.compareHardware(refCalc(), h).map((r) => r.tco);
    if (h > 12) {
      const prev = L.compareHardware(refCalc(), h - 24).map((r) => r.tco);
      tcos.forEach((v, i) => assert.ok(v >= prev[i] - 0.001, 'profile ' + i));
    }
  });
});

test('comparator: an invalid horizon falls back to 36 months', () => {
  const a = L.compareHardware(refCalc(), 13);
  const b = L.compareHardware(refCalc(), 36);
  assert.deepEqual(a.map((r) => r.tco), b.map((r) => r.tco));
});

test('comparator: missing and hostile calc inputs still produce finite rows', () => {
  [null, undefined, {}, { enabled: 'x' }, { prices: 'x' }, { kwhPrice: -5, watts: NaN, hardwareCost: -10 }].forEach((c) => {
    L.compareHardware(c, 36).forEach((r) => {
      ['tco', 'rent', 'net', 'kwhYear', 'powerAnnual', 'feeAnnual', 'saasAnnual', 'netAnnual'].forEach((k) => {
        assert.ok(Number.isFinite(r[k]), k + ' for ' + r.id);
      });
    });
  });
});

test('comparator: hostile price objects cannot pollute the bill', () => {
  const hostile = { prices: JSON.parse('{"__proto__":{"polluted":1},"netflix":-50,"spotify":"junk"}'), enabled: ['netflix', 'spotify'] };
  const rows = L.compareHardware(hostile, 36);
  assert.equal(({}).polluted, undefined);
  rows.forEach((r) => assert.ok(Number.isFinite(r.tco) && r.tco >= 0));
});

test('comparator: empty subscription list still gives finite results', () => {
  const rows = L.compareHardware({ enabled: [] }, 36);
  rows.forEach((r) => {
    assert.ok(Number.isFinite(r.rent));
    assert.equal(r.rent, 0);
  });
});

test('comparator: sensitivity cells are days or null', () => {
  L.compareHardware(refCalc(), 36).forEach((r) => {
    ['powerDown', 'powerUp', 'saasDown', 'saasUp'].forEach((k) => {
      const v = r.sens[k];
      assert.ok(v === null || (Number.isInteger(v) && v >= 0), r.id + '.' + k);
    });
  });
});

test('comparator: pricier power never helps break-even', () => {
  L.compareHardware(refCalc(), 36).forEach((r) => {
    if (r.breakEvenDay === null) return;
    const up = r.sens.powerUp;
    if (up !== null) assert.ok(up >= r.breakEvenDay, r.id);
  });
});

test('comparator: dearer rent pulls break-even earlier or keeps it', () => {
  L.compareHardware(refCalc(), 36).forEach((r) => {
    if (r.breakEvenDay === null) return;
    const up = r.sens.saasUp;
    if (up !== null) assert.ok(up <= r.breakEvenDay, r.id);
  });
});

test('comparator: zero-priced power makes owned boxes unbeatable quickly', () => {
  const rows = L.compareHardware({ kwhPrice: 0 }, 36);
  const pi5 = rows.find((r) => r.id === 'pi5');
  assert.ok(pi5.breakEvenDay !== null && pi5.breakEvenDay <= 200);
});

test('comparator: a sky-high electricity price still yields finite numbers', () => {
  const rows = L.compareHardware({ kwhPrice: 9999 }, 36);
  rows.forEach((r) => assert.ok(Number.isFinite(r.tco) && Number.isFinite(r.net)));
});

test('comparator: is deterministic between calls', () => {
  assert.deepEqual(L.compareHardware(refCalc(), 60), L.compareHardware(refCalc(), 60));
});

test('comparator: subscription selection changes rent but not hardware cost', () => {
  const rows = L.compareHardware({ enabled: ['icloud'] }, 36);
  const pi5 = rows.find((r) => r.id === 'pi5');
  assert.equal(pi5.cost, 120);
  assert.ok(pi5.rent < 719);
  rows.forEach((r) => assert.equal(r.rent, pi5.rent));
});

test('comparator: every sensitivity case recomputes rather than reusing state', () => {
  const row = L.compareHardware(refCalc(), 36).find((r) => r.id === 'thinkcentre');
  const cheap = L.compareHardware(Object.assign(refCalc(), { kwhPrice: refCalc().kwhPrice * 0.7 }), 36).find((r) => r.id === 'thinkcentre');
  assert.equal(row.sens.powerDown, cheap.breakEvenDay);
});

// ---------------------------------------------------------------------------
// Kendall tau and top-k overlap
// ---------------------------------------------------------------------------

test('kendallTau: identical rankings score one', () => {
  assert.equal(L.kendallTau(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
});

test('kendallTau: a fully reversed ranking scores minus one', () => {
  assert.equal(L.kendallTau(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']), -1);
});

test('kendallTau: one adjacent swap sits between zero and one', () => {
  const t = L.kendallTau(['a', 'b', 'c'], ['a', 'c', 'b']);
  assert.ok(t > 0 && t < 1);
  assert.equal(t, 1 / 3);
});

test('kendallTau: fewer than two shared items gives null', () => {
  assert.equal(L.kendallTau(['a'], ['a']), null);
  assert.equal(L.kendallTau(['a', 'b'], ['c', 'd']), null);
  assert.equal(L.kendallTau([], []), null);
  assert.equal(L.kendallTau(null, ['a']), null);
});

test('kendallTau: only shared items are compared', () => {
  assert.equal(L.kendallTau(['a', 'b', 'x'], ['b', 'a', 'y']), -1);
});

test('topKOverlap: identical rankings overlap fully', () => {
  assert.equal(L.topKOverlap(['a', 'b', 'c'], ['a', 'b', 'c'], 3), 1);
});

test('topKOverlap: counts only the top window', () => {
  assert.equal(L.topKOverlap(['a', 'b', 'c'], ['b', 'x', 'c'], 2), 0.5);
});

test('topKOverlap: short lists divide by their own length', () => {
  assert.equal(L.topKOverlap(['a', 'b'], ['a', 'b', 'c'], 3), 1);
  assert.equal(L.topKOverlap(['a', 'b'], ['x', 'y', 'z'], 3), 0);
});

test('topKOverlap: empty and hostile inputs stay safe', () => {
  assert.equal(L.topKOverlap([], ['a'], 3), 0);
  assert.equal(L.topKOverlap(null, null, 3), 0);
  assert.equal(L.topKOverlap(['a'], ['a'], NaN), 1);
});

// ---------------------------------------------------------------------------
// BM25 diagnostics lab
// ---------------------------------------------------------------------------

test('bm25Lab: default query ranks the SQLite article first', () => {
  const r = L.bm25Lab('sqlite backup', 1.5, 0.75);
  assert.ok(r.rows.length > 0);
  assert.equal(r.rows[0].id, 's4');
});

test('bm25Lab: rows are sorted by score then id', () => {
  const r = L.bm25Lab('backup', 1.5, 0.75);
  for (let i = 1; i < r.rows.length; i++) {
    const a = r.rows[i - 1], b = r.rows[i];
    assert.ok(a.score > b.score || (a.score === b.score && a.id < b.id), 'row ' + i);
  }
});

test('bm25Lab: scores match the engine for the same query and parameters', () => {
  const r = L.bm25Lab('nas', 2.0, 0.4);
  const ix = E.buildInvertedIndex(S.articles);
  const ref = E.bm25Search(ix, 'nas', { k1: 2.0, b: 0.4 });
  assert.deepEqual(r.rows.map((x) => [x.id, x.score]), ref.map((x) => [x.id, x.score]));
});

test('bm25Lab: default parameters give tau one against the reference', () => {
  const r = L.bm25Lab('sqlite backup', 1.5, 0.75);
  assert.equal(r.tau, 1);
  assert.equal(r.overlap3, 1);
});

test('bm25Lab: moved parameters can keep order or reorder, always inside range', () => {
  [0, 0.5, 1.5, 3.9, 4].forEach((k1) => {
    [0, 0.4, 0.75, 1].forEach((b) => {
      const r = L.bm25Lab('backup', k1, b);
      if (r.tau !== null) assert.ok(r.tau >= -1 && r.tau <= 1);
      assert.ok(r.overlap3 >= 0 && r.overlap3 <= 1);
    });
  });
});

test('bm25Lab: a query with no hits reports cleanly', () => {
  const r = L.bm25Lab('zzzznomatch', 1.5, 0.75);
  assert.equal(r.rows.length, 0);
  assert.equal(r.tau, null);
  assert.equal(r.overlap3, 0);
  assert.equal(r.matches, 0);
});

test('bm25Lab: empty and hostile queries cannot crash the ranker', () => {
  ['', '  ', '__proto__', '<script>alert(1)</script>', 'x'.repeat(400), null, undefined].forEach((q) => {
    const r = L.bm25Lab(q, 1.5, 0.75);
    assert.ok(Array.isArray(r.rows));
    assert.ok(r.matches === r.rows.length);
  });
});

test('bm25Lab: hostile k1 and b clamp to safe bounds', () => {
  const a = L.bm25Lab('backup', NaN, NaN);
  assert.equal(a.k1, 1.5);
  assert.equal(a.b, 0.75);
  const b = L.bm25Lab('backup', -5, 9);
  assert.equal(b.k1, 0);
  assert.equal(b.b, 1);
  const c = L.bm25Lab('backup', Infinity, -Infinity);
  assert.equal(c.k1, 1.5);
  assert.equal(c.b, 0.75);
});

test('bm25Lab: extreme parameters still return sorted scores', () => {
  const r = L.bm25Lab('backup', 4, 0);
  for (let i = 1; i < r.rows.length; i++) {
    assert.ok(r.rows[i - 1].score >= r.rows[i].score);
  }
});

test('bm25Lab: titles resolve for every ranked article', () => {
  const r = L.bm25Lab('backup', 1.5, 0.75);
  r.rows.forEach((row) => {
    const art = S.articles.find((a) => a.id === row.id);
    assert.equal(row.title, art.title);
  });
});

test('bm25Lab: k1 zero still scores documents', () => {
  const r = L.bm25Lab('backup', 0, 0.75);
  assert.ok(r.rows.length > 0);
  r.rows.forEach((row) => assert.ok(Number.isFinite(row.score) && row.score >= 0));
  assert.ok(r.rows.every((row) => row.score === r.rows[0].score));
});

// ---------------------------------------------------------------------------
// SM-2 ninety day review simulator
// ---------------------------------------------------------------------------

test('sm2 sim: all four strategies run the same horizon and card count', () => {
  L.SM2_STRATEGIES.forEach((s) => {
    const r = L.simulateSm2(s.id);
    assert.equal(r.days, 90);
    assert.equal(r.cards, 24);
    assert.equal(r.daily.length, 90);
  });
});

test('sm2 sim: unknown strategy falls back to daily strict', () => {
  assert.deepEqual(L.simulateSm2('bogus'), L.simulateSm2('daily'));
  assert.deepEqual(L.simulateSm2(null).totalReviews, L.simulateSm2('daily').totalReviews);
});

test('sm2 sim: daily strict reviews every day and never backlogs', () => {
  const r = L.simulateSm2('daily');
  assert.equal(r.peakBacklog, 0);
  assert.ok(r.daily.every((d) => d.backlog === 0));
  assert.ok(r.daily[0].reviewed === 24);
});

test('sm2 sim: weekday strategy rests Saturday and Sunday', () => {
  const r = L.simulateSm2('weekday');
  r.daily.forEach((d) => {
    if (d.day % 7 >= 5) assert.equal(d.reviewed, 0);
  });
  assert.ok(r.daily.some((d) => d.day % 7 < 5 && d.reviewed > 0));
});

test('sm2 sim: weekend batch only reviews on weekend days', () => {
  const r = L.simulateSm2('weekend');
  r.daily.forEach((d) => {
    if (d.day % 7 < 5) assert.equal(d.reviewed, 0);
  });
  assert.ok(r.peakBacklog > 0);
});

test('sm2 sim: review totals equal the sum of daily reviews', () => {
  L.SM2_STRATEGIES.forEach((s) => {
    const r = L.simulateSm2(s.id);
    assert.equal(r.totalReviews, r.daily.reduce((a, d) => a + d.reviewed, 0));
  });
});

test('sm2 sim: backlog is never negative', () => {
  L.SM2_STRATEGIES.forEach((s) => {
    L.simulateSm2(s.id).daily.forEach((d) => assert.ok(d.backlog >= 0 && d.due >= 0));
  });
});

test('sm2 sim: mature counts only grow', () => {
  L.SM2_STRATEGIES.forEach((s) => {
    const daily = L.simulateSm2(s.id).daily;
    for (let i = 1; i < daily.length; i++) assert.ok(daily[i].mature >= daily[i - 1].mature, s.id + ' day ' + i);
  });
});

test('sm2 sim: easiness factor stays at or above 1.3 everywhere', () => {
  const r = L.simulateSm2('daily');
  let c = null;
  for (let i = 0; i < 20; i++) c = E.scheduleSm2Review(c, 3, '2026-01-05');
  assert.ok(c.ef >= 1.3);
  assert.equal(r.matureAtEnd <= r.cards, true);
});

test('sm2 sim: high-ease stretches intervals faster than daily strict', () => {
  const a = L.simulateSm2('daily');
  const b = L.simulateSm2('ease');
  assert.ok(b.daily[89].mature >= a.daily[89].mature);
  assert.ok(b.totalReviews <= a.totalReviews);
});

test('sm2 sim: weekend strategy carries a bigger peak backlog than daily', () => {
  assert.ok(L.simulateSm2('weekend').peakBacklog > L.simulateSm2('daily').peakBacklog);
});

test('sm2 sim: hostile options clamp instead of exploding', () => {
  const r = L.simulateSm2('daily', { days: -5, cards: -10 });
  assert.equal(r.days, 1);
  assert.equal(r.cards, 0);
  const big = L.simulateSm2('daily', { days: 99999, cards: 99999 });
  assert.equal(big.days, 365);
  assert.equal(big.cards, 500);
  const nan = L.simulateSm2('daily', { days: NaN, cards: NaN, matureAt: NaN });
  assert.equal(nan.days, 90);
  assert.equal(nan.cards, 24);
});

test('sm2 sim: zero cards produces an all-zero run', () => {
  const r = L.simulateSm2('daily', { cards: 0 });
  assert.equal(r.totalReviews, 0);
  assert.equal(r.matureAtEnd, 0);
  assert.ok(r.daily.every((d) => d.reviewed === 0 && d.backlog === 0 && d.mature === 0));
});

test('sm2 sim: is fully deterministic', () => {
  assert.deepEqual(L.simulateSm2('weekend'), L.simulateSm2('weekend'));
});

test('sm2 sim: card intervals come from the shared engine scheduler', () => {
  const direct = E.scheduleSm2Review({ repetitions: 0, interval: 0, ef: 2.5 }, 4, '2026-01-05');
  assert.equal(direct.interval, 1);
  const r = L.simulateSm2('daily');
  assert.equal(r.daily[1].due, 24);
});

// ---------------------------------------------------------------------------
// buildLabReport and the audited bundle
// ---------------------------------------------------------------------------

test('report: shape carries every section', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  assert.equal(rep.schema, 'subzero-lab-report/1');
  ['horizon', 'profile', 'k1', 'b', 'strategy', 'inputs', 'hardware', 'series', 'bm25', 'sm2'].forEach((k) => {
    assert.ok(k in rep, k);
  });
  assert.equal(rep.hardware.length, 5);
  assert.equal(rep.series.saas.length, 61);
  assert.equal(rep.series.own.pi5.length, 61);
  assert.equal(rep.sm2.daily.length, 90);
  assert.equal(rep.sm2.strategies.length, 4);
  ['daily', 'weekday', 'weekend', 'ease'].forEach((id) => assert.equal(rep.sm2.mature[id].length, 90));
});

test('report: subscriptions mirror the enabled audit list', () => {
  const rep = L.buildLabReport(L.defaultLabState(), { enabled: ['icloud', 'readwise'] });
  assert.deepEqual(rep.inputs.subscriptions.map((s) => s.id), ['readwise', 'icloud']);
  assert.equal(rep.inputs.subscriptions.length, 2);
});

test('report: unknown subscription ids are dropped, never crash', () => {
  const rep = L.buildLabReport(L.defaultLabState(), { enabled: ['icloud', 'bogus', 'spotify'] });
  assert.deepEqual(rep.inputs.subscriptions.map((s) => s.id), ['icloud']);
});

test('report: hostile lab state is normalised before building', () => {
  const rep = L.buildLabReport({ view: 'x', profile: 'x', horizon: 999, k1: NaN, b: Infinity, strategy: 'x' }, refCalc());
  assert.equal(rep.horizon, 36);
  assert.equal(rep.k1, 1.5);
  assert.equal(rep.b, 0.75);
  assert.equal(rep.strategy, 'daily');
  assert.equal(rep.profile, 'pi5');
});

test('report: hostile calc input still produces a finite report', () => {
  const rep = L.buildLabReport(L.defaultLabState(), { enabled: 'junk', prices: { netflix: -5 }, kwhPrice: NaN });
  rep.hardware.forEach((h) => assert.ok(Number.isFinite(h.tco)));
  assert.ok(Number.isFinite(rep.inputs.saasMonthly));
});

test('report: is deterministic for identical inputs', () => {
  const a = L.buildLabReport(L.defaultLabState(), refCalc());
  const b = L.buildLabReport(L.defaultLabState(), refCalc());
  assert.equal(E.canonicalJson(a), E.canonicalJson(b));
});

test('bundle: JSON, CSV and Markdown all carry the one SHA-256', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  assert.match(b.sha256, /^[0-9a-f]{64}$/);
  assert.ok(b.json.includes('"sha256": "' + b.sha256 + '"'));
  assert.ok(b.csv.includes('# sha256: ' + b.sha256));
  assert.ok(b.markdown.includes('SHA-256 `' + b.sha256 + '`'));
});

test('bundle: the same state returns the cached object identity', () => {
  const s = L.normalizeLabState({ view: 'diag', profile: 'nas', horizon: 60, k1: 2, b: 0.3, strategy: 'ease' });
  const a = L.auditBundle(s, refCalc());
  const b = L.auditBundle(Object.assign({}, s), Object.assign({}, refCalc()));
  assert.equal(a, b);
});

test('bundle: different lab states give different digests', () => {
  const a = L.auditBundle(L.defaultLabState(), refCalc());
  const b = L.auditBundle(L.normalizeLabState({ horizon: 60 }), refCalc());
  assert.notEqual(a.sha256, b.sha256);
});

test('bundle: different calc inputs give different digests', () => {
  const a = L.auditBundle(L.defaultLabState(), refCalc());
  const b = L.auditBundle(L.defaultLabState(), { kwhPrice: 0.5 });
  assert.notEqual(a.sha256, b.sha256);
});

test('bundle: digest equals sha256 of the canonical payload', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  assert.equal(b.sha256, L.sha256Hex(b.canonical));
});

test('bundle: JSON export parses back and re-verifies', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  const o = JSON.parse(b.json);
  assert.equal(o.sha256, b.sha256);
  assert.equal(L.verifyReportJson(b.json).ok, true);
});

test('verify: malformed inputs fail with a reason', () => {
  assert.equal(L.verifyReportJson('not json').error, 'not-json');
  assert.equal(L.verifyReportJson('[]').error, 'not-object');
  assert.equal(L.verifyReportJson('"x"').error, 'not-object');
  assert.equal(L.verifyReportJson('{"sha256":1}').error, 'no-digest');
  assert.equal(L.verifyReportJson('{"sha256":"ABC"}').error, 'no-digest');
  assert.equal(L.verifyReportJson('{}').error, 'no-digest');
});

test('verify: a wrong but well-formed digest reports the mismatch', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  const o = JSON.parse(b.json);
  o.sha256 = '0'.repeat(64);
  const v = L.verifyReportJson(JSON.stringify(o));
  assert.equal(v.ok, false);
  assert.equal(v.expected, '0'.repeat(64));
  assert.equal(v.actual, b.sha256);
});

test('verify: deleting any field breaks the checksum', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  const o = JSON.parse(b.json);
  delete o.horizon;
  assert.equal(L.verifyReportJson(JSON.stringify(o)).ok, false);
});

test('tamper: the demo edit is caught by verification', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  const t = L.tamperReportJson(b.json);
  assert.equal(t.verify.ok, false);
  const o = JSON.parse(t.json);
  assert.equal(o.hardware[0].cost, L.HARDWARE_PROFILES[0].cost + 25);
  assert.equal(o.sha256, b.sha256);
});

test('tamper: garbage input degrades gracefully', () => {
  const t = L.tamperReportJson('not json at all');
  assert.equal(t.verify.ok, false);
});

// ---------------------------------------------------------------------------
// CSV and Markdown exports
// ---------------------------------------------------------------------------

test('csvCell: formula-like strings are prefixed with a quote', () => {
  ['=CMD()', '=1+1', '+SUM(A1)', '-2-1', '@HYPERLINK("x")', '\t=cmd()', '  =x'].forEach((s) => {
    const out = L.csvCell(s);
    // The parsed cell content must begin with the quote escape, even when the
    // field itself gets quoted because it contains commas or double quotes.
    const inner = out[0] === '"' ? out.slice(1) : out;
    assert.equal(inner[0], "'", s);
  });
});

test('csvCell: plain strings and numbers stay raw', () => {
  assert.equal(L.csvCell('plain'), 'plain');
  assert.equal(L.csvCell('Raspberry Pi 5 kit'), 'Raspberry Pi 5 kit');
  assert.equal(L.csvCell(42), '42');
  assert.equal(L.csvCell(-7.5), '-7.5');
  assert.equal(L.csvCell(0), '0');
});

test('csvCell: commas and quotes are wrapped and doubled', () => {
  assert.equal(L.csvCell('a,b'), '"a,b"');
  assert.equal(L.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(L.csvCell('a,"b"'), '"a,""b"""');
});

test('csvCell: newlines trigger quoting and carriage returns go', () => {
  assert.equal(L.csvCell('a\nb'), '"a\nb"');
  assert.equal(L.csvCell('a\rb'), 'ab');
  assert.equal(L.csvCell('a\r\nb'), '"a\nb"');
});

test('csvCell: hostile values stay inert', () => {
  assert.equal(L.csvCell(NaN), '');
  assert.equal(L.csvCell(Infinity), '');
  assert.equal(L.csvCell(-Infinity), '');
  assert.equal(L.csvCell(null), '');
  assert.equal(L.csvCell(undefined), '');
  assert.equal(L.csvCell({}), '[object Object]');
});

test('csvCell: a formula hidden behind a comma is still escaped', () => {
  const out = L.csvCell('=x,y');
  assert.equal(out, '"\'=x,y"');
});

test('csv export: header carries the digest and the horizon', () => {
  const b = L.auditBundle(L.normalizeLabState({ horizon: 12 }), refCalc());
  const lines = b.csv.split('\n');
  assert.equal(lines[0], '# subzero-vault lab report');
  assert.equal(lines[1], '# sha256: ' + b.sha256);
  assert.equal(lines[2], '# horizon_months: 12');
});

test('csv export: lists every profile and every strategy', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  L.HARDWARE_PROFILES.forEach((p) => assert.ok(b.csv.includes(p.name), p.id));
  L.SM2_STRATEGIES.forEach((s) => assert.ok(b.csv.includes(s.name), s.id));
});

test('csv export: no data cell can open a spreadsheet formula', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  b.csv.split('\n').filter((l) => l && l[0] !== '#').forEach((line) => {
    line.split(',').forEach((cell) => {
      const bare = cell.replace(/^"/, '');
      assert.ok(!/^[=+\-@]/.test(bare), cell);
    });
  });
});

test('markdown export: tables render and the footer carries the digest', () => {
  const b = L.auditBundle(L.defaultLabState(), refCalc());
  assert.ok(b.markdown.startsWith('## SubZero Vault lab report'));
  assert.ok(/\| Box \| Up front \| Watts \|/.test(b.markdown));
  assert.ok(b.markdown.includes('SHA-256 `' + b.sha256 + '`'));
  L.HARDWARE_PROFILES.forEach((p) => assert.ok(b.markdown.includes(p.name), p.id));
});

test('markdown export: pipes inside names cannot break the table', () => {
  assert.equal(L.reportMarkdown({ schema: 'x', horizon: 1, inputs: { saasAnnual: 0, kwhPrice: 0 }, hardware: [{ name: 'a|b', cost: 1, watts: 1, kwhYear: 1, powerAnnual: 1, feeAnnual: 1, breakEvenDay: 1, tco: 1, rent: 1, net: 1 }], sm2: { cards: 0, strategies: [] } }, 'f'.repeat(64)).includes('a\\|b'), true);
});

// ---------------------------------------------------------------------------
// In-page self-tests
// ---------------------------------------------------------------------------

test('self-tests: at least fourteen checks exist and all pass', () => {
  const list = L.labSelfTests();
  assert.ok(list.length >= 14, list.length);
  list.forEach((t) => assert.ok(t.ok, t.name + (t.detail ? ': ' + t.detail : '')));
});

test('self-tests: every check has a unique non-empty name', () => {
  const list = L.labSelfTests();
  const names = list.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  names.forEach((n) => assert.ok(n.length > 10));
});

// ---------------------------------------------------------------------------
// HTML/SVG renderers
// ---------------------------------------------------------------------------

test('renderLabTabs: marks the active view and keeps tabs keyboard reachable', () => {
  const html = L.renderLabTabs('diag');
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.ok(/data-id="diag" aria-selected="true" tabindex="0"/.test(html));
  assert.ok(/data-id="tco" aria-selected="false" tabindex="-1"/.test(html));
});

test('renderComparatorRows: emits one row per profile with money cells', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const html = L.renderComparatorRows(rep, 'pi5');
  assert.equal((html.match(/<tr/g) || []).length, 5);
  assert.ok(html.includes('$120.00'));
  assert.ok(html.includes('aria-pressed="true"'));
  assert.ok(html.includes('data-id="vps"'));
});

test('renderComparatorRows: only the selected profile is pressed', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const html = L.renderComparatorRows(rep, 'nas');
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.ok(/data-id="nas" aria-pressed="true"/.test(html));
});

test('renderComparatorRows: escapes profile names', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  rep.hardware[0].name = '<img src=x onerror=alert(1)>';
  const html = L.renderComparatorRows(rep, 'pi5');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('renderSensitivityRows: one row per profile with four shock cells', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const html = L.renderSensitivityRows(rep, 'pi5');
  assert.equal((html.match(/<tr/g) || []).length, 5);
  assert.equal((html.match(/day 0|day \d+|never/g) || []).length, 20);
});

test('renderTcoChart: deterministic SVG labels markers without adding noninteractive tab stops', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const svg = L.renderTcoChart(rep, { width: 640 });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(/class="line line-saas"/.test(svg));
  assert.ok(/class="line line-hw hw-pi5 is-sel"/.test(svg));
  assert.equal((svg.match(/cross-dot/g) || []).length, 5);
  assert.ok(!svg.includes('tabindex'));
  assert.ok(svg.includes('<title>Raspberry Pi 5 kit breaks even at month'));
  assert.ok(svg.includes('<desc id="lab-tco-desc">'));
  assert.ok(svg.includes('scrub-line'));
  assert.equal(svg, L.renderTcoChart(rep, { width: 640 }));
});

test('renderTcoChart: the longest horizon label faces inward on a phone', () => {
  const rep = L.buildLabReport({ horizon: 60 }, refCalc());
  const svg = L.renderTcoChart(rep, { width: 280 });
  assert.match(svg, /class="cross-text"[^>]+text-anchor="end">60 month horizon/);
});

test('renderTcoChart: a horizon past 60 months draws no horizon marker', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  rep.horizon = 61;
  const svg = L.renderTcoChart(rep, { width: 640 });
  assert.ok(!svg.includes('scrub-line'));
});

test('renderTcoChart: names and hostile strings are escaped inside the SVG', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  rep.hardware[0].name = '<script>alert(1)</script>';
  const svg = L.renderTcoChart(rep, { width: 640 });
  assert.ok(!svg.includes('<script>'));
});

test('renderBm25Rows: renders rank, title and score', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const html = L.renderBm25Rows(rep.bm25);
  assert.ok(/<tr><td class="num">1<\/td>/.test(html));
  assert.ok(html.includes(rep.bm25.rows[0].title));
});

test('renderBm25Rows: empty ranking shows the empty message', () => {
  const html = L.renderBm25Rows({ rows: [] });
  assert.ok(html.includes('No article matches'));
});

test('renderStabilityTiles: three tiles with the tau, overlap and matches', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const html = L.renderStabilityTiles(rep.bm25);
  assert.equal((html.match(/class="tile"/g) || []).length, 3);
  assert.ok(html.includes('Kendall tau'));
  assert.ok(html.includes('1.00'));
});

test('renderStabilityTiles: a null tau prints n/a', () => {
  const html = L.renderStabilityTiles({ tau: null, overlap3: 0, matches: 0 });
  assert.ok(html.includes('n/a'));
});

test('renderSm2Rows: one row per strategy with the four counters', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const html = L.renderSm2Rows(rep.sm2, 'weekend');
  assert.equal((html.match(/<tr/g) || []).length, 4);
  assert.ok(html.includes('Weekend batch'));
  assert.ok(html.includes('class="is-sel"'));
});

test('renderSm2Chart: bars for reviews, a backlog line and four mature curves', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const svg = L.renderSm2Chart(rep.sm2, { width: 640 });
  assert.ok(svg.includes('review-bar'));
  assert.ok(svg.includes('backlog-line'));
  assert.equal((svg.match(/mat-line/g) || []).length, 4);
  assert.ok(svg.includes('<desc id="lab-sm2-desc">'));
});

test('renderSelfTestResults: pass and FAIL marks render escaped', () => {
  const html = L.renderSelfTestResults([
    { name: 'good <b>check</b>', ok: true, detail: '' },
    { name: 'bad check', ok: false, detail: 'x < y' }
  ]);
  assert.ok(html.includes('is-ok'));
  assert.ok(html.includes('is-bad'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt;'));
});

// ---------------------------------------------------------------------------
// App integration on the fake DOM
// ---------------------------------------------------------------------------

function bootApp(extra) {
  const env = createEnvironment(extra || {});
  const app = App.createApp(env.doc, env.win, { storage: env.storage });
  return { env: env, app: app };
}

test('app: lab section unhides and renders on boot', async () => {
  const { env, app } = bootApp();
  await app.init();
  assert.equal(env.els['lab'].hidden, false);
  assert.equal(env.els['nav-lab'].hidden, false);
  assert.ok(env.els['lab-tco-table'].innerHTML.includes('Raspberry Pi 5 kit'));
  assert.equal((env.els['lab-tco-table'].innerHTML.match(/<tr/g) || []).length, 5);
});

test('app: digest on the page is a 64-hex checksum', async () => {
  const { env, app } = bootApp();
  await app.init();
  assert.match(env.els['lab-digest'].textContent, /^[0-9a-f]{64}$/);
});

test('app: selects are populated from the module, not hand-written', async () => {
  const { env, app } = bootApp();
  await app.init();
  assert.equal((env.els['lab-strategy'].innerHTML.match(/<option/g) || []).length, 4);
  assert.equal(env.els['lab-horizon'].value, '36');
});

test('app: a valid #szv= hash restores every lab field', async () => {
  const token = L.encodeLabHash({ view: 'diag', profile: 'nas', horizon: 60, k1: 2.5, b: 0.1, strategy: 'weekend' });
  const env = createEnvironment({});
  env.win.location.hash = '#szv=' + token;
  const app = App.createApp(env.doc, env.win, { storage: env.storage });
  await app.init();
  assert.equal(app.state.lab.view, 'diag');
  assert.equal(app.state.lab.profile, 'nas');
  assert.equal(app.state.lab.horizon, 60);
  assert.equal(app.state.lab.k1, 2.5);
  assert.equal(app.state.lab.b, 0.1);
  assert.equal(app.state.lab.strategy, 'weekend');
  assert.ok(env.els['lab-tco-table'].innerHTML.includes('data-id="nas" aria-pressed="true"'));
  assert.equal(env.els['lab-strategy'].value, 'weekend');
  assert.equal(env.els['lab-k1'].value, '2.5');
  assert.equal(env.els['lab-view-diag'].hidden, false);
  assert.equal(env.els['lab-view-tco'].hidden, true);
});

test('app: a malformed #szv= hash falls back to defaults and says so', async () => {
  const env = createEnvironment({});
  env.win.location.hash = '#szv=%%%junk%%%';
  const app = App.createApp(env.doc, env.win, { storage: env.storage });
  await app.init();
  assert.deepEqual(app.state.lab, L.defaultLabState());
  assert.ok(env.els['lab-status'].textContent.includes('invalid'));
  assert.ok(env.els['lab-status']._classes.has('is-error'));
});

test('app: a #szv= hash with hostile inner fields still fails closed', async () => {
  const env = createEnvironment({});
  env.win.location.hash = '#szv=' + L.b64urlEncodeStr('{"v":1,"k":99,"__proto__":{}}');
  const app = App.createApp(env.doc, env.win, { storage: env.storage });
  await app.init();
  assert.deepEqual(app.state.lab, L.defaultLabState());
  assert.equal(({}).polluted, undefined);
});

test('app: section anchors are untouched by the codec', async () => {
  const env = createEnvironment({});
  env.win.location.hash = '#vault';
  const app = App.createApp(env.doc, env.win, { storage: env.storage });
  await app.init();
  assert.deepEqual(app.state.lab, L.defaultLabState());
  assert.equal(env.els['lab-status'].textContent, '');
});

test('app: lab view tab clicks switch the visible pane', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.clickOn({ action: 'lab-view', id: 'diag' });
  assert.equal(app.state.lab.view, 'diag');
  assert.equal(env.els['lab-view-diag'].hidden, false);
  assert.equal(env.els['lab-view-tco'].hidden, true);
  env.clickOn({ action: 'lab-view', id: 'export' });
  assert.equal(env.els['lab-view-export'].hidden, false);
});

test('app: hostile view ids cannot switch the pane', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.clickOn({ action: 'lab-view', id: 'bogus' });
  assert.equal(app.state.lab.view, 'tco');
  assert.equal(env.els['lab-view-tco'].hidden, false);
});

test('app: hardware profile chips highlight the chosen box', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.clickOn({ action: 'lab-profile', id: 'vps' });
  assert.equal(app.state.lab.profile, 'vps');
  assert.ok(env.els['lab-tco-table'].innerHTML.includes('data-id="vps" aria-pressed="true"'));
});

test('app: audit changes flow into the lab numbers', async () => {
  const { env, app } = bootApp();
  await app.init();
  const before = env.els['lab-digest'].textContent;
  env.els['hw-kwh'].value = '0.90';
  env.els['hw-kwh'].fire('input', { target: env.els['hw-kwh'] });
  const after = env.els['lab-digest'].textContent;
  assert.notEqual(before, after);
  assert.match(after, /^[0-9a-f]{64}$/);
});

test('app: lab control inputs re-render and survive hostile typing', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.els['lab-k1'].value = 'banana';
  env.els['lab-k1'].fire('input', { target: env.els['lab-k1'] });
  assert.equal(app.state.lab.k1, 1.5);
  env.els['lab-k1'].value = '3.5';
  env.els['lab-k1'].fire('input', { target: env.els['lab-k1'] });
  assert.equal(app.state.lab.k1, 3.5);
  env.els['lab-b'].value = '99';
  env.els['lab-b'].fire('input', { target: env.els['lab-b'] });
  assert.equal(app.state.lab.b, 1);
  env.els['lab-horizon'].value = '999';
  env.els['lab-horizon'].fire('change', { target: env.els['lab-horizon'] });
  assert.equal(app.state.lab.horizon, 36);
});

test('app: share link carries the szv bookmark token', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.clickOn({ action: 'lab-profile', id: 'nas' });
  env.els['lab-copy-link'].fire('click');
  await sleep(0);
  assert.equal(env.copied.length, 1);
  assert.ok(env.copied[0].includes('#szv='));
  const token = env.copied[0].split('#szv=')[1];
  const back = L.decodeLabHash(token);
  assert.equal(back.ok, true);
  assert.equal(back.state.profile, 'nas');
});

test('app: szv bookmark in the address bar stays live across edits', async () => {
  const env = createEnvironment({});
  env.win.location.hash = '#szv=' + L.encodeLabHash({ profile: 'nas' });
  const app = App.createApp(env.doc, env.win, { storage: env.storage });
  await app.init();
  env.clickOn({ action: 'lab-profile', id: 'vps' });
  const last = env.replaced[env.replaced.length - 1];
  assert.ok(last.includes('#szv='));
  const back = L.decodeLabHash(last.split('#szv=')[1]);
  assert.equal(back.state.profile, 'vps');
});

test('app: verify button reports a clean export', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.els['lab-verify'].fire('click');
  assert.ok(env.els['lab-export-status'].textContent.includes('Checksum verifies'));
});

test('app: tamper button reports a caught edit', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.els['lab-tamper'].fire('click');
  assert.ok(env.els['lab-tamper'].listenerCount('click') > 0);
  assert.ok(env.els['lab-export-status'].textContent.includes('Tamper caught'));
});

test('app: self-test runner reports every check passing', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.els['lab-run-tests'].fire('click');
  const list = L.labSelfTests();
  assert.equal(env.els['lab-tests-count'].textContent, list.length + '/' + list.length + ' checks pass');
  assert.ok((env.els['lab-tests-out'].innerHTML.match(/is-ok/g) || []).length === list.length);
  assert.ok(!env.els['lab-tests-out'].innerHTML.includes('is-bad'));
});

test('app: export buttons produce downloads', async () => {
  const { env, app } = bootApp();
  await app.init();
  env.els['lab-dl-json'].fire('click');
  env.els['lab-dl-csv'].fire('click');
  env.els['lab-dl-md'].fire('click');
  assert.equal(env.downloads.length, 3);
  const json = env.downloads[0];
  assert.match(String(json.parts[0]).slice(0, 2), /^\{/);
});

// ---------------------------------------------------------------------------
// Static wiring checks for the lab section
// ---------------------------------------------------------------------------

test('page: the lab script loads before app.js', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const iLab = html.indexOf('vault-lab.js');
  const iApp = html.indexOf('app.js');
  assert.ok(iLab > 0 && iApp > iLab);
});

test('page: the lab section starts hidden and carries its own heading', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/<section class="band band-card" id="lab" aria-labelledby="lab-title" hidden>/.test(html));
  assert.ok(/id="nav-lab" hidden/.test(html));
});

test('page: every lab input has a label', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ['lab-horizon', 'lab-strategy', 'lab-k1', 'lab-b', 'lab-query'].forEach((id) => {
    assert.ok(new RegExp('for="' + id + '"').test(html), id);
    assert.ok(new RegExp('id="' + id + '"').test(html), id);
  });
});

test('css: the new chart tokens are defined', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(/--steel:\s*#[0-9a-fA-F]{6}/.test(css));
  assert.ok(/--amber:\s*#[0-9a-fA-F]{6}/.test(css));
});

test('css: profile and strategy line classes exist', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  ['hw-pi5', 'hw-n100', 'hw-thinkcentre', 'hw-nas', 'hw-vps', 'mat-daily', 'mat-weekday', 'mat-weekend', 'mat-ease', 'review-bar', 'backlog-line'].forEach((c) => {
    assert.ok(css.includes('.' + c), c);
  });
});

// ---------------------------------------------------------------------------
// Engine hardening: hostile normalizeCalc inputs
// ---------------------------------------------------------------------------

test('engine: normalizeCalc ignores non-array enabled lists', () => {
  ['junk', 42, {}, null, undefined, NaN].forEach((v) => {
    const c = E.normalizeCalc({ enabled: v });
    assert.deepEqual(c.enabled, E.defaultCalcState().enabled, String(v));
  });
});

test('engine: normalizeCalc drops unknown ids from enabled', () => {
  const c = E.normalizeCalc({ enabled: ['readwise', 'bogus', '__proto__', 42] });
  assert.deepEqual(c.enabled, ['readwise']);
});

test('engine: normalizeCalc ignores non-object prices', () => {
  ['junk', 42, null, [], '9.99'].forEach((v) => {
    const c = E.normalizeCalc({ prices: v });
    assert.equal(c.prices.readwise, E.defaultCalcState().prices.readwise, String(v));
  });
});

test('engine: normalizeCalc never lets __proto__ prices pollute', () => {
  const c = E.normalizeCalc({ prices: JSON.parse('{"__proto__":{"polluted":1},"readwise":-5}') });
  assert.equal(({}).polluted, undefined);
  assert.equal(c.prices.readwise, 0);
});

test('engine: normalizeCalc survives non-object input entirely', () => {
  ['junk', 42, null, undefined, true, NaN].forEach((v) => {
    const c = E.normalizeCalc(v);
    assert.deepEqual(c, E.defaultCalcState(), String(v));
  });
});

test('engine: normalizeCalc clamps hostile numerics', () => {
  const c = E.normalizeCalc({ kwhPrice: -1, watts: NaN, hardwareCost: Infinity, extraAnnual: -9, years: 999 });
  assert.equal(c.kwhPrice, 0);
  assert.equal(c.watts, 6);
  assert.equal(c.hardwareCost, 120);
  assert.equal(c.extraAnnual, 0);
  assert.equal(c.years, 10);
});

// ---------------------------------------------------------------------------
// Module constants and small helpers
// ---------------------------------------------------------------------------

test('constants: hardware profiles have unique ids and sane numbers', () => {
  const ids = new Set();
  L.HARDWARE_PROFILES.forEach((p) => {
    assert.ok(!ids.has(p.id), p.id);
    ids.add(p.id);
    assert.ok(p.name.length > 3);
    assert.ok(Number.isFinite(p.cost) && p.cost >= 0);
    assert.ok(Number.isFinite(p.watts) && p.watts >= 0);
    assert.ok(Number.isFinite(p.monthlyFee) && p.monthlyFee >= 0);
  });
  assert.equal(ids.size, 5);
});

test('constants: strategies have unique ids and real schedules', () => {
  const ids = new Set();
  L.SM2_STRATEGIES.forEach((s) => {
    assert.ok(!ids.has(s.id), s.id);
    ids.add(s.id);
    assert.ok(s.name.length > 3);
    assert.ok(Array.isArray(s.days) && s.days.length >= 1);
    s.days.forEach((d) => assert.ok(Number.isInteger(d) && d >= 0 && d <= 6));
    assert.ok(s.quality >= 0 && s.quality <= 5);
  });
  assert.equal(ids.size, 4);
});

test('constants: the three views and three horizons are fixed', () => {
  assert.deepEqual(L.LAB_VIEWS.map((v) => v.id), ['tco', 'diag', 'export']);
  assert.deepEqual(L.HORIZONS, [12, 36, 60]);
});

test('helpers: fmtMoney formats negatives and non-finite safely', () => {
  assert.equal(L.fmtMoney(120), '$120.00');
  assert.equal(L.fmtMoney(-5), '-$5.00');
  assert.equal(L.fmtMoney(1234.5), '$1,234.50');
  assert.equal(L.fmtMoney(NaN), '$0.00');
  assert.equal(L.fmtMoney(Infinity), '$0.00');
  assert.equal(L.fmtMoney(-0), '$0.00');
});

test('helpers: fmtMoney0 rounds and groups', () => {
  assert.equal(L.fmtMoney0(999.4), '$999');
  assert.equal(L.fmtMoney0(1000), '$1,000');
  assert.equal(L.fmtMoney0(-42.6), '-$43');
});

test('helpers: fmtDay covers never, zero and plain days', () => {
  assert.equal(L.fmtDay(null), 'never');
  assert.equal(L.fmtDay(undefined), 'never');
  assert.equal(L.fmtDay(0), 'day 0');
  assert.equal(L.fmtDay(190), 'day 190');
});

test('renderTcoChart: tiny and huge widths clamp to a drawable range', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const small = L.renderTcoChart(rep, { width: 10 });
  assert.ok(/width="280"/.test(small));
  const huge = L.renderTcoChart(rep, { width: 4000 });
  assert.ok(/width="4000"/.test(huge));
});

test('renderTcoChart: hostile width falls back to 640', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const svg = L.renderTcoChart(rep, { width: NaN });
  assert.ok(/width="640"/.test(svg));
});

test('csv export: a null break-even prints never, not blank', () => {
  const rep = L.buildLabReport(L.defaultLabState(), { kwhPrice: 99 });
  const csv = L.reportCsv(rep, 'a'.repeat(64));
  rep.hardware.forEach((h) => {
    if (h.breakEvenDay === null) assert.ok(csv.includes('never'), h.id);
  });
});

test('markdown export: strategy table lists all four runs', () => {
  const rep = L.buildLabReport(L.defaultLabState(), refCalc());
  const md = L.reportMarkdown(rep, 'b'.repeat(64));
  ['Daily strict', 'Weekday only', 'Weekend batch', 'High-ease accelerated'].forEach((name) => {
    assert.ok(md.includes(name), name);
  });
});
