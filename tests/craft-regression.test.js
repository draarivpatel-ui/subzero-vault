'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const STYLES = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

test('CRAFT: touch controls and result rows keep accessible target boundaries', () => {
  assert.ok(APP.indexOf('<label class="sub-check"><input type="checkbox"') !== -1, 'subscription checkbox has a large label hit area');
  assert.ok(APP.indexOf('<span class="print-value">') !== -1, 'subscription controls have static print values');
  assert.match(STYLES, /\.sub-check\s*\{[\s\S]*?min-width: 2\.75rem;[\s\S]*?min-height: 2\.75rem;/);
  assert.match(STYLES, /\.btn-small\s*\{\s*min-height: 2\.75rem; min-width: 2\.75rem;/);
  assert.match(STYLES, /\.chip\s*\{\s*min-width: 2\.75rem;/);
  assert.match(STYLES, /\.result\s*\{[\s\S]*?border: 1px solid var\(--line-strong\);/);
  assert.match(STYLES, /input\[type="range"\] \{[^}]*min-height: 2\.75rem;/);
});

test('CRAFT: print output hides form drawers and keeps measured cards intact', () => {
  assert.match(STYLES, /@page \{ margin: 14mm; \}/);
  const printBlock = STYLES.slice(STYLES.indexOf('@media print'));
  assert.match(printBlock, /\.skip-link, \.site-nav, \.cta-row, button, input, select, textarea, details\.drawer, #audit-box \{ display: none !important; \}/);
  assert.match(printBlock, /\.card, \.ledger, \.code, \.table-wrap, pre, \.tile, \.chart-card, \.mode, \.result, \.hl-item \{ box-shadow: none !important; break-inside: avoid; \}/);
  assert.match(printBlock, /\.print-value \{ display: inline !important; \}/);
});
