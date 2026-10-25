'use strict';
// A tiny stand-in for the browser, just big enough to run createApp from app.js under node:test.
// It does not parse markup. It gives the controller the elements named in index.html and records what it does to them.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function makeEl(id, tag) {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  const el = {
    id: id, tagName: (tag || 'div').toUpperCase(), value: '', checked: false, hidden: false, disabled: false,
    innerHTML: '', textContent: '', dataset: {}, files: [], clientWidth: 640, open: false,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c))
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    contains: () => true,
    closest: () => null,
    focus: () => { el.focused = true; },
    select: () => {},
    click: () => el.fire('click'),
    appendChild: () => {}, removeChild: () => {},
    fire: (type, extra) => {
      const evt = Object.assign({ type: type, target: el, preventDefault: () => {}, key: '' }, extra || {});
      (listeners[type] || []).forEach((fn) => fn(evt));
      return evt;
    },
    listenerCount: (type) => (listeners[type] || []).length,
    _classes: classes, _attrs: attrs
  };
  return el;
}

function createEnvironment(opts) {
  const o = opts || {};
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const els = {};
  const tagOf = {};
  html.replace(/<(\w+)\b[^>]*\bid="([\w-]+)"/g, (all, tag, id) => { tagOf[id] = tag; return all; });
  Object.keys(tagOf).forEach((id) => { els[id] = makeEl(id, tagOf[id]); });
  els['hw-cost'].value = '120'; els['hw-watts'].value = '6'; els['hw-kwh'].value = '0.17'; els['hw-extra'].value = '0';
  els['grow-saas'].value = '0'; els['grow-invest'].value = '0'; els['chart-month'].value = '12';
  els['st-port'].value = '8090'; els['st-data'].value = './data'; els['st-cron'].value = '0 3 * * *';
  els['st-backup-path'].value = './backups'; els['st-domain'].value = 'vault.example.com'; els['st-tz'].value = 'UTC';
  els['srv-url'].value = 'http://localhost:8090';
  els['hw-preset'].value = 'custom';
  els['srv-url'].closest = (sel) => (sel === 'details' ? els['srv-url']._details : null);
  els['srv-url']._details = { open: false };

  const radios = ['none', 'caddy', 'tailscale'].map((v) => Object.assign(makeEl('radio-' + v, 'input'), { value: v, checked: v === 'none' }));
  const docListeners = {};
  const doc = {
    getElementById: (id) => { if (!els[id] && /^sub-(chk|price)-/.test(id)) els[id] = makeEl(id, 'input'); if (!els[id]) throw new Error('index.html has no element with id "' + id + '"'); return els[id]; },
    querySelectorAll: (sel) => (sel === 'input[name="proxy"]' ? radios : []),
    querySelector: () => null,
    createElement: (t) => makeEl('', t),
    body: makeEl('body', 'body'),
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    execCommand: () => true
  };
  const copied = [];
  const downloads = [];
  const replaced = [];
  const win = {
    location: { search: o.search || '', pathname: '/subzero-vault/', origin: 'https://aariv.me', hash: '', href: 'https://aariv.me/subzero-vault/', protocol: 'file:' },
    history: { replaceState: (a, b, url) => replaced.push(url) },
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
    matchMedia: () => ({ matches: true }),
    navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } },
    getSelection: () => win._selection,
    _selection: null,
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Blob: function (parts, opt) { this.parts = parts; this.type = opt && opt.type; },
    URL: { createObjectURL: (b) => { downloads.push(b); return 'blob:x'; }, revokeObjectURL: () => {} },
    addEventListener: () => {}
  };
  doc.body.appendChild = () => {};
  const map = new Map();
  const storage = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  return {
    els: els, doc: doc, win: win, storage: storage, radios: radios, copied: copied, downloads: downloads, replaced: replaced,
    clickOn: (dataset) => {
      const target = { dataset: dataset, closest: () => ({ dataset: dataset }) };
      (docListeners.click || []).forEach((fn) => fn({ target: target }));
    },
    selectText: (text) => { win._selection = { toString: () => text, anchorNode: {}, removeAllRanges: () => { win._selection = null; } }; }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { createEnvironment, sleep, ROOT };
