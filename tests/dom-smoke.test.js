'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');
const S = require('../samples.js');
const App = require('../app.js');
const { createEnvironment, sleep, ROOT } = require('./helpers/fake-dom.js');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('index.html');
const CSS = read('styles.css');
const APPJS = read('app.js');

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    if (['.git', 'node_modules', '__pycache__', 'data', 'backups'].includes(d.name)) return;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else out.push(p);
  });
  return out;
}

const TEXT_FILES = walk(ROOT, []).filter((p) => /\.(html|css|js|py|md|json|yml|txt|svg|example)$|Dockerfile$|\.dockerignore$|\.gitignore$/.test(p));

// ---------------------------------------------------------------------------
// Static page checks
// ---------------------------------------------------------------------------

test('page declares doctype, language, viewport and a title', () => {
  assert.ok(/^<!doctype html>/i.test(HTML));
  assert.ok(/<html lang="en">/.test(HTML));
  assert.ok(/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(HTML));
  assert.ok(/<title>[^<]{10,}<\/title>/.test(HTML));
  assert.ok(/<meta name="description" content="[^"]{60,}">/.test(HTML));
});

test('page carries a complete Open Graph and Twitter card set', () => {
  ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt'].forEach((p) => {
    assert.ok(new RegExp('<meta property="' + p + '" content="[^"]+">').test(HTML), p);
  });
  ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].forEach((n) => {
    assert.ok(new RegExp('<meta name="' + n + '" content="[^"]+">').test(HTML), n);
  });
  assert.ok(/<link rel="canonical" href="https:\/\/aariv\.me\/subzero-vault\/">/.test(HTML));
});

test('page has an inline SVG favicon, a noscript fallback and a skip link', () => {
  assert.ok(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/.test(HTML));
  assert.ok(/<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/.test(HTML));
  assert.ok(/<a class="skip-link" href="#main">/.test(HTML));
  assert.ok(/<main id="main">/.test(HTML));
});

test('page has exactly one h1 and heading levels never skip', () => {
  assert.equal((HTML.match(/<h1\b/g) || []).length, 1);
  const levels = (HTML.match(/<h([1-6])\b/g) || []).map((m) => Number(m[2]));
  let prev = 1;
  levels.forEach((l) => { assert.ok(l <= prev + 1, 'h' + l + ' after h' + prev); prev = l; });
});

test('every id in index.html is unique', () => {
  const ids = (HTML.match(/\bid="([\w-]+)"/g) || []).map((m) => m.slice(4, -1));
  assert.equal(new Set(ids).size, ids.length);
});

test('every element app.js looks up by id exists in index.html', () => {
  const ids = new Set((HTML.match(/\bid="([\w-]+)"/g) || []).map((m) => m.slice(4, -1)));
  const wanted = new Set();
  let m;
  const re = /byId\('([\w-]+)'\)/g;
  while ((m = re.exec(APPJS))) wanted.add(m[1]);
  const dyn = /byId\('(sub-chk)-'/.exec(APPJS);
  assert.ok(dyn);
  wanted.delete('sub-chk');
  assert.ok(wanted.size > 40);
  wanted.forEach((id) => assert.ok(ids.has(id), 'missing #' + id));
});

test('every label points at a real control and every control is labelled', () => {
  const ids = new Set((HTML.match(/\bid="([\w-]+)"/g) || []).map((m) => m.slice(4, -1)));
  const forIds = (HTML.match(/<label[^>]*\bfor="([\w-]+)"/g) || []).map((m) => /for="([\w-]+)"/.exec(m)[1]);
  forIds.forEach((id) => assert.ok(ids.has(id), 'label for #' + id));
  const controls = HTML.match(/<(input|select|textarea)\b[^>]*\bid="([\w-]+)"[^>]*>/g) || [];
  controls.forEach((tag) => {
    const id = /id="([\w-]+)"/.exec(tag)[1];
    const type = (/type="(\w+)"/.exec(tag) || [])[1];
    if (type === 'radio') return;
    assert.ok(forIds.includes(id) || /aria-label/.test(tag), '#' + id + ' has no label');
  });
});

test('live regions exist for results, the chart readout and every status line', () => {
  ['audit-results', 'chart-readout'].forEach((id) => assert.ok(new RegExp('id="' + id + '"[^>]*aria-live="polite"').test(HTML), id));
  ['vault-status', 'scenario-status', 'add-status', 'import-status', 'srv-status', 'st-status', 'st-cron-msg'].forEach((id) => {
    assert.ok(new RegExp('id="' + id + '"[^>]*role="status"').test(HTML), id);
  });
});

test('decorative SVG is hidden from assistive tech and the chart has a title and description hook', () => {
  assert.ok(/<svg class="wordmark-mark"[^>]*aria-hidden="true"/.test(HTML));
  assert.ok(/id="chart-title"/.test(HTML));
  const svg = App.renderChart(E.computeSubscriptionSavings(E.defaultCalcState()), { width: 640 });
  assert.ok(/role="img"/.test(svg) && /aria-labelledby="chart-title chart-desc"/.test(svg) && /<desc id="chart-desc">/.test(svg));
});

test('no em dash or en dash appears in any text file', () => {
  const bad = TEXT_FILES.filter((p) => /[\u2013\u2014]/.test(fs.readFileSync(p, 'utf8')));
  assert.deepEqual(bad.map((p) => path.relative(ROOT, p)), []);
});

test('no emoji appears in any text file', () => {
  const bad = TEXT_FILES.filter((p) => /\p{Extended_Pictographic}/u.test(fs.readFileSync(p, 'utf8')));
  assert.deepEqual(bad.map((p) => path.relative(ROOT, p)), []);
});

test('no uppercase kicker styling or eyebrow classes', () => {
  assert.ok(!/text-transform:\s*uppercase/.test(CSS));
  assert.ok(!/class="[^"]*\b(eyebrow|kicker|overline)\b/.test(HTML));
});

test('headings are never italic', () => {
  assert.ok(!/<(h[1-6])[^>]*>\s*<(em|i)\b/.test(HTML));
  assert.ok(!/h[1-6][^{]*\{[^}]*font-style:\s*italic/.test(CSS));
});

test('every CSS custom property that is used is defined', () => {
  const used = new Set((CSS.match(/var\(--([\w-]+)/g) || []).map((m) => m.slice(6)));
  const defined = new Set((CSS.match(/^\s*--([\w-]+):/gm) || []).map((m) => m.trim().slice(2, -1)));
  used.forEach((v) => assert.ok(defined.has(v), '--' + v + ' is used but not defined'));
  assert.ok(used.size > 20);
});

test('colour values live only in the token block, favicon and theme-color', () => {
  const afterRoot = CSS.slice(CSS.indexOf('}', CSS.indexOf(':root')) + 1);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(afterRoot), 'hex colour outside :root');
  assert.ok(!/\brgba?\(|\bhsla?\(/.test(afterRoot), 'rgb or hsl outside :root');
  const htmlNoFavicon = HTML.replace(/<link rel="icon"[^>]*>/, '').replace(/<meta name="theme-color"[^>]*>/, '');
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(htmlNoFavicon.replace(/href="#[\w-]+"/g, '')), 'hex colour in index.html');
  assert.ok(!/style="/.test(HTML), 'inline style attribute in index.html');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgb/.test(APPJS), 'colour literal in app.js');
});

test('the four brand tokens match the brief', () => {
  const tok = (n) => new RegExp('--' + n + ':\\s*(#[0-9A-Fa-f]{6})').exec(CSS)[1].toUpperCase();
  assert.equal(tok('paper'), '#F6F3EC');
  assert.equal(tok('card'), '#EBE6DA');
  assert.equal(tok('ink'), '#141413');
  assert.equal(tok('rust'), '#C84B31');
  assert.equal(tok('green'), '#1F6E58');
});

test('overflow guards and reduced motion support are in the stylesheet', () => {
  assert.ok(/html\s*\{[^}]*overflow-x:\s*clip/.test(CSS));
  assert.ok(/body\s*\{[^}]*overflow-x:\s*clip/.test(CSS));
  assert.ok(/prefers-reduced-motion:\s*reduce/.test(CSS));
  assert.ok(/:focus-visible/.test(CSS));
  assert.ok(!/grid-template-columns:[^;]*\b1fr\b(?!\))/.test(CSS.replace(/minmax\([^)]*\)/g, '')), 'bare 1fr track');
});

test('fonts are bundled, not fetched from a third party', () => {
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|cdn\./.test(HTML + CSS));
  ['fraunces', 'plus-jakarta-sans', 'jetbrains-mono'].forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, 'fonts', f + '.woff2')), f));
});

test('local files referenced from index.html and the Dockerfile exist', () => {
  const refs = (HTML.match(/(?:src|href)="([^"#:]+\.[a-z0-9]+)"/g) || []).map((m) => /"([^"]+)"/.exec(m)[1]);
  refs.forEach((r) => assert.ok(fs.existsSync(path.join(ROOT, r)), r));
  const docker = read('Dockerfile');
  docker.split('\n').filter((l) => /^COPY /.test(l)).forEach((l) => {
    l.replace(/^COPY\s+/, '').split(/\s+/).slice(0, -1).forEach((src) => assert.ok(fs.existsSync(path.join(ROOT, src)), 'Dockerfile COPY ' + src));
  });
});

test('the hero ledger in the static HTML matches the engine defaults', () => {
  const r = E.computeSubscriptionSavings(E.defaultCalcState());
  assert.ok(HTML.includes('id="ledger-total">' + App.money(r.saasAnnual) + '<'));
  ['9.99', '3.99', '6.00'].forEach((p) => assert.ok(HTML.includes('$' + p + '</td>'), p));
  assert.ok(HTML.includes('by day ' + r.breakEvenDay));
});

test('compose file, env example and gitignore keep secrets out', () => {
  const compose = read('docker-compose.yml');
  assert.ok(/restart: unless-stopped/.test(compose) && /healthcheck:/.test(compose) && /build: \./.test(compose));
  assert.ok(!/\t/.test(compose));
  assert.ok(/^VAULT_TOKEN=$/m.test(read('.env.example')));
  assert.ok(/^\.env$/m.test(read('.gitignore')));
  assert.ok(/^data\/$/m.test(read('.gitignore')));
  assert.ok(/^MIT License/.test(read('LICENSE')));
});

test('the backups sample keeps its 3-2-1 rule heading', () => {
  assert.ok(S.articles.find((a) => a.id === 's7').body.includes('## The 3-2-1 rule'));
});

test('sample highlights are quoted from the sample articles', () => {
  assert.equal(S.articles.length, 8);
  S.highlights.forEach((h) => {
    const a = S.articles.find((x) => x.id === h.articleId);
    assert.ok(a.body.includes(h.text), h.id);
  });
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

test('money formats with separators, cents and sign', () => {
  assert.equal(App.money(1034.1), '$1,034.10');
  assert.equal(App.money(-355.92), '-$355.92');
  assert.equal(App.money0(1199.6), '$1,200');
});

test('renderChart draws two lines, a break-even marker and the end labels', () => {
  const svg = App.renderChart(E.computeSubscriptionSavings(E.defaultCalcState()), { width: 640, month: 12 });
  assert.equal((svg.match(/class="line line-/g) || []).length, 2);
  assert.ok(svg.includes('break-even, month 6.2'));
  assert.ok(svg.includes('Cloud rent $719'));
  assert.ok(svg.includes('scrub-line'));
  assert.ok(svg.includes('viewBox="0 0 640 '));
});

test('renderChart omits the marker when the lines never cross', () => {
  const s = E.defaultCalcState();
  s.watts = 400;
  const svg = App.renderChart(E.computeSubscriptionSavings(s), { width: 640 });
  assert.ok(!svg.includes('break-even, month'));
  assert.ok(svg.includes('never cross'));
});

test('chartReadout names who is ahead at a month', () => {
  const r = E.computeSubscriptionSavings(E.defaultCalcState());
  assert.ok(App.chartReadout(r, 0).includes('Renting is ahead by $120.00'));
  assert.ok(App.chartReadout(r, 12).includes('Owning is ahead by $110.82'));
});

test('renderResults flags a box that never pays off', () => {
  const s = E.defaultCalcState();
  s.watts = 400;
  const html = App.renderResults(E.computeSubscriptionSavings(s), E.normalizeCalc(s));
  assert.ok(html.includes('never') && html.includes('is-bad'));
});

test('renderSubRows lists every catalog entry with a labelled price box', () => {
  const html = App.renderSubRows(E.defaultCalcState());
  assert.equal((html.match(/<tr/g) || []).length, 12);
  assert.ok(html.includes('aria-label="Monthly price for Readwise Reader in dollars"'));
  assert.ok(html.includes('value="9.99"') && html.includes('value="6.00"'));
  assert.equal((html.match(/ checked>/g) || []).length, 3);
});

test('renderBody turns the markers into headings, lists and quotes and escapes markup', () => {
  const html = App.renderBody('## Head\n\nPlain <b>text</b>\n\n- one\n\n- two\n\n> quoted', []);
  assert.ok(html.includes('<h4>Head</h4>'));
  assert.ok(html.includes('Plain &lt;b&gt;text&lt;/b&gt;'));
  assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'));
  assert.ok(html.includes('<blockquote>quoted</blockquote>'));
});

test('renderBody marks saved highlights inside paragraphs', () => {
  const html = App.renderBody('Alpha beta gamma', [{ text: 'beta' }]);
  assert.ok(html.includes('<mark class="saved">beta</mark>'));
});

test('renderReader escapes a hostile title and url', () => {
  const html = App.renderReader({ id: 1, title: '<img src=x onerror=alert(1)>', url: 'https://x.test/?a="b"', body: 'text', tags: ['<t>'], savedAt: '2026-01-01', wordCount: 1 }, []);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&quot;b&quot;'));
  assert.ok(html.includes('#&lt;t&gt;'));
});

test('renderResultsList shows scores, tags and the selected item', () => {
  const html = App.renderResultsList([{ id: 'a', title: 'A', score: 1.23456, tags: ['x'], snippet: 'hi <mark>there</mark>' }, { id: 'b', title: 'B', wordCount: 5, tags: [], excerpt: '<b>' }], 'a', true, false);
  assert.ok(html.includes('BM25 1.235'));
  assert.ok(html.includes('aria-current="true"'));
  assert.ok(html.includes('hi <mark>there</mark>'));
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(App.renderResultsList([], null, true, false).includes('Nothing matches'));
  assert.ok(App.renderResultsList([], null, false, true).includes('data-action="load-samples"'));
});

test('renderReview moves from prompt to answer to rating buttons with intervals', () => {
  const due = [{ id: 1, text: 'The full text', note: 'cue', articleTitle: 'T', repetitions: 2, interval: 6, ef: 2.5 }];
  const front = App.renderReview(due, false, '2026-10-25');
  assert.ok(front.includes('cue') && !front.includes('The full text') && front.includes('show-answer'));
  const back = App.renderReview(due, true, '2026-10-25');
  assert.ok(back.includes('The full text'));
  assert.equal((back.match(/data-action="rate"/g) || []).length, 4);
  assert.ok(back.includes('1 day') && back.includes('15 days'));
  assert.ok(App.renderReview([], false, '2026-10-25').includes('Nothing due'));
});

test('cueFor falls back to the first words when there is no note', () => {
  assert.equal(App.cueFor({ text: 'one two three four five six seven eight', note: '' }), 'one two three four five six ...');
});

test('describeCron explains common schedules and rejects bad ones', () => {
  assert.deepEqual(App.describeCron('0 3 * * *'), { ok: true, text: 'Every day at 03:00.' });
  assert.deepEqual(App.describeCron(''), { ok: true, text: 'Backups are off.' });
  assert.equal(App.describeCron('nope').ok, false);
});

test('bookmarklet embeds the encoded endpoint and token and posts text/plain', () => {
  const href = App.bookmarklet('http://localhost:8090/', 'a b&c');
  assert.ok(href.startsWith('javascript:'));
  const code = decodeURIComponent(href.slice('javascript:'.length));
  assert.ok(code.includes('http://localhost:8090/api/clip?token=a%20b%26c'));
  assert.ok(code.includes('text/plain') && code.includes('no-cors'));
});

test('renderCode dims comment lines and escapes the rest', () => {
  const html = App.renderCode('# note\na: "<b>"');
  assert.ok(html.includes('<span class="dim"># note</span>'));
  assert.ok(html.includes('&lt;b&gt;'));
});

// ---------------------------------------------------------------------------
// Controller against the fake DOM
// ---------------------------------------------------------------------------

async function boot(opts) {
  const env = createEnvironment(opts);
  const app = App.createApp(env.doc, env.win, { storage: env.storage, today: () => '2026-10-25', debounce: 0 });
  await app.init();
  return { env: env, app: app };
}

test('init fills the audit tables from the engine defaults', async () => {
  const { env } = await boot();
  assert.equal((env.els['audit-subs'].innerHTML.match(/<tr/g) || []).length, 12);
  assert.equal(env.els['ledger-total'].textContent, '$239.76');
  assert.ok(env.els['ledger-foot'].textContent.includes('day 190'));
  assert.equal((env.els['audit-results'].innerHTML.match(/class="tile /g) || []).length, 5);
  assert.ok(env.els['audit-chart'].innerHTML.startsWith('<svg'));
  assert.equal(env.els['chart-month']._attrs.max, '36');
  assert.ok(env.els['hw-preset'].innerHTML.includes('Raspberry Pi 5 kit'));
  assert.equal(env.els['hw-preset'].value, 'pi5');
});

test('ticking a subscription changes the ledger and writes the URL state', async () => {
  const { env } = await boot();
  env.els['audit-subs'].fire('change', { target: { dataset: { kind: 'chk', id: 'notion' }, checked: true, closest: () => null } });
  assert.equal(env.els['ledger-total'].textContent, '$359.76');
  assert.equal(env.replaced.length >= 1, true);
  assert.ok(/\?c=[A-Za-z0-9_-]+/.test(env.replaced[env.replaced.length - 1]));
});

test('typing a price for an unticked service ticks it', async () => {
  const { env } = await boot();
  env.els['audit-subs'].fire('input', { target: { dataset: { kind: 'price', id: 'googleone' }, value: '1.99', closest: () => null } });
  assert.equal(env.els['sub-chk-googleone'].checked, true);
  assert.equal(env.els['ledger-total'].textContent, '$263.64');
});

test('clearing a price removes it from the total', async () => {
  const { env } = await boot();
  env.els['audit-subs'].fire('input', { target: { dataset: { kind: 'price', id: 'readwise' }, value: '', closest: () => null } });
  assert.equal(env.els['ledger-total'].textContent, '$119.88');
});

test('hardware inputs move the break-even tile and the chart', async () => {
  const { env } = await boot();
  env.els['hw-watts'].value = '400';
  env.els['hw-watts'].fire('input');
  assert.equal(env.els['hw-preset'].value, 'custom');
  assert.ok(env.els['audit-results'].innerHTML.includes('never'));
  assert.ok(env.els['ledger-foot'].textContent.includes('never pays for itself'));
});

test('choosing a preset fills the cost and watts', async () => {
  const { env } = await boot();
  env.els['hw-preset'].value = 'spare';
  env.els['hw-preset'].fire('change');
  assert.equal(env.els['hw-cost'].value, '0');
  assert.ok(env.els['ledger-foot'].textContent.includes('costs nothing up front'));
});

test('an empty numeric box counts as zero instead of snapping back', async () => {
  const { env } = await boot();
  env.els['hw-cost'].value = '';
  env.els['hw-cost'].fire('input');
  assert.ok(env.els['ledger-foot'].textContent.includes('costs nothing up front'));
});

test('the month scrubber updates the readout', async () => {
  const { env } = await boot();
  env.els['chart-month'].value = '24';
  env.els['chart-month'].fire('input');
  assert.ok(env.els['chart-readout'].textContent.startsWith('Month 24.'));
});

test('a scenario link in the URL is restored on load', async () => {
  const s = E.defaultCalcState();
  s.enabled = ['readwise'];
  s.watts = 12;
  const { env } = await boot({ search: '?c=' + E.encodeCalcState(s) });
  assert.equal(env.els['ledger-total'].textContent, '$119.88');
  assert.equal(env.els['hw-watts'].value, '12');
});

test('copy scenario puts a link on the clipboard', async () => {
  const { env } = await boot();
  env.els['copy-scenario'].fire('click');
  await sleep(10);
  assert.ok(env.copied[0].startsWith('https://aariv.me/subzero-vault/'));
  assert.ok(env.copied[0].endsWith('#audit'));
  assert.equal(env.els['scenario-status'].textContent, 'Link copied.');
});

test('the vault starts with eight samples, three highlights due, and opens the first article', async () => {
  const { env } = await boot();
  assert.equal((env.els.results.innerHTML.match(/class="result"/g) || []).length, 8);
  assert.equal(env.els['review-count'].textContent, '3 due');
  assert.ok(env.els.reader.innerHTML.includes('reader-title'));
  assert.equal(env.els['vault-status'].textContent, '8 saved items.');
});

test('searching ranks by BM25 and shows scores and highlighted snippets', async () => {
  const { env } = await boot();
  env.els.q.value = 'sqlite backup';
  env.els.q.fire('input');
  await sleep(20);
  assert.ok(/BM25 \d+\.\d{3}/.test(env.els.results.innerHTML));
  assert.ok(env.els.results.innerHTML.indexOf('SQLite is enough') < env.els.results.innerHTML.indexOf('Backups you have'));
  assert.ok(env.els.results.innerHTML.includes('<mark>'));
  assert.ok(env.els['vault-status'].textContent.includes('best match first'));
  assert.ok(env.els.reader.innerHTML.includes('SQLite is enough for a personal server'));
});

test('a search with no hits says so', async () => {
  const { env } = await boot();
  env.els.q.value = 'zebra';
  env.els.q.fire('input');
  await sleep(20);
  assert.ok(env.els.results.innerHTML.includes('Nothing matches'));
  assert.ok(env.els.reader.innerHTML.includes('Pick an article'));
});

test('tag chips filter the list', async () => {
  const { env } = await boot();
  assert.ok(env.els['tag-filter'].innerHTML.includes('aria-pressed="true">All'));
  env.clickOn({ action: 'tag', value: 'sqlite' });
  await sleep(20);
  assert.equal((env.els.results.innerHTML.match(/class="result"/g) || []).length, 1);
  assert.ok(env.els['tag-filter'].innerHTML.includes('data-value="sqlite" aria-pressed="true"'));
});

test('clicking a result opens it in the reader', async () => {
  const { env } = await boot();
  env.clickOn({ action: 'open', id: 's3' });
  await sleep(20);
  assert.ok(env.els.reader.innerHTML.includes('How a DNS sinkhole'));
  assert.ok(env.els.results.innerHTML.includes('data-id="s3" aria-current="true"'));
});

test('selecting text and pressing the button saves a highlight that is due today', async () => {
  const { env } = await boot();
  env.clickOn({ action: 'open', id: 's3' });
  await sleep(20);
  env.selectText('A sinkhole is a filter, not a firewall.');
  env.els['hl-note'].value = 'filter';
  env.els['hl-save'].fire('click');
  await sleep(20);
  assert.ok(env.els.highlights.innerHTML.includes('A sinkhole is a filter, not a firewall.'));
  assert.equal(env.els['review-count'].textContent, '4 due');
  assert.ok(env.els.reader.innerHTML.includes('<mark class="saved">'));
});

test('pressing highlight with nothing selected explains what to do', async () => {
  const { env } = await boot();
  env.win._selection = null;
  env.els['hl-save'].fire('click');
  await sleep(10);
  assert.ok(env.els['vault-status'].textContent.includes('Select some text'));
  assert.ok(env.els['vault-status']._classes.has('is-error'));
});

test('review reveals the answer, rates it with SM-2 and moves to the next card', async () => {
  const { env } = await boot();
  env.clickOn({ action: 'show-answer' });
  assert.ok(env.els['review-card'].innerHTML.includes('rate-grid'));
  env.clickOn({ action: 'rate', q: '5' });
  await sleep(20);
  assert.equal(env.els['review-count'].textContent, '2 due');
  assert.ok(!env.els['review-card'].innerHTML.includes('rate-grid'));
});

test('adding pasted HTML runs readability and saves the article', async () => {
  const { env, app } = await boot();
  env.els['add-body'].value = '<html><title>Pasted page</title><body><nav><a href="/">x</a></nav><article><p>This pasted paragraph is long enough, with commas, to be treated as the main story of the page.</p></article></body></html>';
  env.els['add-tags'].value = 'Pasted, Test';
  await app.handlers.onAdd({ preventDefault: () => {} });
  await sleep(20);
  assert.ok(env.els['add-status'].textContent.includes('Saved "Pasted page"'));
  assert.ok(env.els.reader.innerHTML.includes('Pasted page'));
  assert.ok(env.els.reader.innerHTML.includes('#pasted'));
  assert.ok(!env.els.reader.innerHTML.includes('<nav'));
  assert.equal(env.els['add-body'].value, '');
});

test('adding with no title or address is refused', async () => {
  const { env, app } = await boot();
  env.els['add-body'].value = 'plain text only';
  await app.handlers.onAdd({ preventDefault: () => {} });
  assert.ok(env.els['add-status'].textContent.includes('Add a title'));
});

test('data survives a reload because it is written to storage', async () => {
  const first = await boot();
  first.env.els['add-title'].value = 'Kept across reload';
  first.env.els['add-body'].value = 'body text';
  await first.app.handlers.onAdd({ preventDefault: () => {} });
  const store = App.LocalStore(first.env.storage, () => '2026-10-25');
  const all = await store.list();
  assert.ok(all.some((a) => a.title === 'Kept across reload'));
  assert.equal(all.length, 9);
});

test('importing a bookmarks file adds items and repeats are skipped', async () => {
  const { env } = await boot();
  const file = { text: async () => '<DL><DT><A HREF="https://example.com/x" TAGS="a,b">Imported X</A></DL>' };
  env.els['import-file'].files = [file];
  env.els['import-btn'].fire('click');
  await sleep(30);
  assert.equal(env.els['import-status'].textContent, 'Added 1 bookmark.');
  env.els['import-btn'].fire('click');
  await sleep(30);
  assert.equal(env.els['import-status'].textContent, 'Added 0 bookmarks, skipped 1 already saved.');
});

test('importing without a file says so', async () => {
  const { env } = await boot();
  env.els['import-btn'].fire('click');
  await sleep(10);
  assert.ok(env.els['import-status'].textContent.includes('Choose a bookmarks file'));
});

test('export refuses an empty bookmarks file but downloads JSON', async () => {
  const { env } = await boot();
  env.els['export-html'].fire('click');
  await sleep(10);
  assert.ok(env.els['vault-status'].textContent.includes('Nothing to export'));
  env.els['export-json'].fire('click');
  await sleep(10);
  assert.equal(env.downloads.length, 1);
  assert.ok(env.downloads[0].parts[0].includes('"articles"'));
});

test('reset restores the samples after a delete', async () => {
  const { env } = await boot();
  env.clickOn({ action: 'del-article', id: 's1' });
  await sleep(20);
  assert.equal((env.els.results.innerHTML.match(/class="result"/g) || []).length, 7);
  env.els['reset-demo'].fire('click');
  await sleep(20);
  assert.equal((env.els.results.innerHTML.match(/class="result"/g) || []).length, 8);
});

test('deleting an article removes its highlights from the review queue', async () => {
  const { env } = await boot();
  env.clickOn({ action: 'del-article', id: 's1' });
  await sleep(20);
  assert.equal(env.els['review-count'].textContent, '2 due');
});

test('the studio renders compose, env and a caddyfile tab on demand', async () => {
  const { env, app } = await boot();
  assert.ok(env.els['st-out'].innerHTML.includes('services:'));
  assert.equal((env.els['st-tabs'].innerHTML.match(/role="tab"/g) || []).length, 2);
  env.radios[1].checked = true; env.radios[0].checked = false;
  env.els['st-proxy'].fire('change');
  assert.equal((env.els['st-tabs'].innerHTML.match(/role="tab"/g) || []).length, 3);
  assert.equal(env.els['st-domain'].disabled, false);
  env.clickOn({ action: 'tab', id: 'Caddyfile' });
  assert.ok(env.els['st-out'].innerHTML.includes('reverse_proxy vault:8090'));
  assert.equal(app.state.studioTab, 'Caddyfile');
});

test('the studio falls back to the first tab when the active one disappears', async () => {
  const { env, app } = await boot();
  app.state.studioTab = 'Caddyfile';
  app.renderStudio();
  assert.equal(app.state.studioTab, 'docker-compose.yml');
});

test('the studio validates the cron box and marks it invalid', async () => {
  const { env } = await boot();
  env.els['st-cron'].value = '99 * * * *';
  env.els['st-cron'].fire('input');
  assert.equal(env.els['st-cron']._attrs['aria-invalid'], 'true');
  assert.ok(env.els['st-cron-msg']._classes.has('is-error'));
  assert.ok(!env.els['st-out'].innerHTML.includes('VAULT_BACKUP_CRON'));
  env.els['st-cron'].value = '*/30 * * * *';
  env.els['st-cron'].fire('input');
  assert.equal(env.els['st-cron']._attrs['aria-invalid'], 'false');
  assert.ok(env.els['st-out'].innerHTML.includes('VAULT_BACKUP_CRON'));
});

test('port and volume edits flow into the generated file', async () => {
  const { env } = await boot();
  env.els['st-port'].value = '9100';
  env.els['st-data'].value = '/srv/sz';
  env.els['st-port'].fire('input');
  assert.ok(env.els['st-out'].innerHTML.includes('VAULT_PORT:-9100'));
  assert.ok(env.els['st-out'].innerHTML.includes('/srv/sz:/data'));
});

test('generate token fills a url safe secret and the env tab carries it', async () => {
  const { env } = await boot();
  env.els['st-gen-token'].fire('click');
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(env.els['st-token'].value));
  env.clickOn({ action: 'tab', id: '.env' });
  assert.ok(env.els['st-out'].innerHTML.includes('VAULT_TOKEN=' + env.els['st-token'].value));
});

test('copy and download act on the visible file', async () => {
  const { env } = await boot();
  env.els['st-copy'].fire('click');
  await sleep(10);
  assert.ok(env.copied[0].includes('name: subzero-vault'));
  env.els['st-download'].fire('click');
  assert.equal(env.downloads.length, 1);
  assert.equal(env.els['st-status'].textContent, 'Downloaded docker-compose.yml.');
});

test('arrow keys move between studio tabs', async () => {
  const { env, app } = await boot();
  env.els['st-tabs'].fire('keydown', { key: 'ArrowRight' });
  assert.equal(app.state.studioTab, '.env');
  env.els['st-tabs'].fire('keydown', { key: 'ArrowLeft' });
  assert.equal(app.state.studioTab, 'docker-compose.yml');
});

// ---------------------------------------------------------------------------
// Server mode
// ---------------------------------------------------------------------------

function fakeServer(options) {
  const o = options || {};
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: url, init: init });
    const respond = (status, obj) => ({ ok: status < 400, status: status, text: async () => JSON.stringify(obj), json: async () => obj });
    if (o.down) throw new Error('refused');
    if (/\/health$/.test(url)) return respond(200, { ok: true, version: '1.0.0', auth: !!o.token });
    if (o.token && !(init.headers && init.headers.Authorization === 'Bearer ' + o.token)) return respond(401, { error: 'missing or wrong token' });
    if (/\/api\/articles$/.test(url) && init.method === 'GET') return respond(200, { articles: [{ id: 7, title: 'Server article', url: '', tags: ['srv'], savedAt: '2026-10-01', wordCount: 3, excerpt: 'hello' }] });
    if (/\/api\/articles\/7$/.test(url)) return respond(200, { id: 7, title: 'Server article', url: '', tags: ['srv'], savedAt: '2026-10-01', wordCount: 3, body: 'hello server' });
    if (/\/api\/highlights/.test(url)) return respond(200, { highlights: [] });
    if (/\/api\/review\/due/.test(url)) return respond(200, { due: [] });
    if (/\/api\/search/.test(url)) return respond(200, { results: [{ id: 7, title: 'Server article', tags: ['srv'], score: 2.5, snippet: '<mark>hello</mark>' }] });
    return respond(404, { error: 'unexpected ' + url });
  };
  fn.calls = calls;
  return fn;
}

test('connecting to a server switches the store and the pill', async () => {
  const env = createEnvironment();
  const fetchFn = fakeServer({ token: 'tok' });
  const app = App.createApp(env.doc, env.win, { storage: env.storage, today: () => '2026-10-25', debounce: 0, fetch: fetchFn });
  await app.init();
  env.els['srv-url'].value = 'http://localhost:8090/';
  env.els['srv-token'].value = 'tok';
  assert.equal(await app.connect('http://localhost:8090/', 'tok', false), true);
  assert.equal(env.els['storage-label'].textContent, 'Storage: your server');
  assert.equal(env.els['storage-pill']._attrs['data-mode'], 'server');
  assert.ok(env.els.results.innerHTML.includes('Server article'));
  assert.equal(env.els['clip-box'].hidden, false);
  assert.ok(fetchFn.calls.some((c) => c.init.headers && c.init.headers.Authorization === 'Bearer tok'));
  assert.equal(env.els['reset-demo'].disabled, true);
});

test('a server that needs a token explains it when none is given', async () => {
  const env = createEnvironment();
  const app = App.createApp(env.doc, env.win, { storage: env.storage, today: () => '2026-10-25', debounce: 0, fetch: fakeServer({ token: 'tok' }) });
  await app.init();
  assert.equal(await app.connect('http://localhost:8090', '', false), false);
  assert.ok(env.els['srv-status'].textContent.includes('needs a token'));
});

test('an unreachable server leaves browser storage in place and says why', async () => {
  const env = createEnvironment();
  const app = App.createApp(env.doc, env.win, { storage: env.storage, today: () => '2026-10-25', debounce: 0, fetch: fakeServer({ down: true }) });
  await app.init();
  assert.equal(await app.connect('http://localhost:8090', '', false), false);
  assert.ok(env.els['srv-status'].textContent.includes('Could not reach'));
  assert.equal(env.els['storage-label'].textContent, 'Storage: this browser');
});

test('disconnecting returns to browser storage with the samples intact', async () => {
  const env = createEnvironment();
  const app = App.createApp(env.doc, env.win, { storage: env.storage, today: () => '2026-10-25', debounce: 0, fetch: fakeServer({}) });
  await app.init();
  await app.connect('http://localhost:8090', '', false);
  await app.disconnect();
  assert.equal(env.els['storage-label'].textContent, 'Storage: this browser');
  assert.equal((env.els.results.innerHTML.match(/class="result"/g) || []).length, 8);
  assert.equal(env.els['clip-box'].hidden, true);
});

test('ServerStore sends json with a bearer token and surfaces server errors', async () => {
  const f = fakeServer({ token: 'tok' });
  const good = App.ServerStore('http://h:1/', 'tok', f);
  assert.equal((await good.list()).length, 1);
  assert.equal(f.calls[0].url, 'http://h:1/api/articles');
  const bad = App.ServerStore('http://h:1', 'nope', f);
  await assert.rejects(() => bad.list(), /missing or wrong token/);
});

test('ServerStore search encodes the query and tag', async () => {
  const f = fakeServer({});
  const st = App.ServerStore('http://h:1', '', f);
  await st.search('a b&c', 'x y');
  assert.ok(f.calls[0].url.endsWith('/api/search?q=a%20b%26c&tag=x%20y'));
});

test('LocalStore reports a full browser storage instead of failing silently', async () => {
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const st = App.LocalStore(full, () => '2026-10-25');
  await assert.rejects(() => st.add({ title: 'x', body: 'y' }), /storage is full or blocked/);
});

test('LocalStore refuses non http addresses', async () => {
  const st = App.LocalStore(createEnvironment().storage, () => '2026-10-25');
  await assert.rejects(() => st.add({ title: 'x', url: 'javascript:alert(1)' }), /http/);
});

test('LocalStore ignores a corrupted saved vault and reseeds', async () => {
  const bad = { getItem: () => '{not json', setItem: () => {} };
  const st = App.LocalStore(bad, () => '2026-10-25');
  assert.equal((await st.list()).length, 8);
});

// ---------------------------------------------------------------------------
// Store details
// ---------------------------------------------------------------------------

test('only the active studio tab is selected and focusable', () => {
  const html = App.renderTabs([{ name: 'docker-compose.yml' }, { name: '.env' }], '.env');
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.ok(/data-id="\.env" aria-selected="true" tabindex="0"/.test(html));
  assert.ok(/data-id="docker-compose\.yml" aria-selected="false" tabindex="-1"/.test(html));
});

test('saving the same address again updates the article instead of duplicating it', async () => {
  const st = App.LocalStore(createEnvironment().storage, () => '2026-10-25');
  const a = await st.add({ title: 'First', url: 'https://x.test/p', body: 'one', tags: ['keep'] });
  const b = await st.add({ title: 'Second', url: 'https://x.test/p', body: 'two' });
  assert.equal(a.id, b.id);
  assert.equal((await st.list()).filter((x) => x.url === 'https://x.test/p').length, 1);
  const got = await st.get(a.id);
  assert.equal(got.title, 'Second');
  assert.equal(got.body, 'two');
  assert.deepEqual(got.tags, ['keep'], 'tags are kept when the update carries none');
});

test('highlights are listed per article and reviews touch only the chosen one', async () => {
  const st = App.LocalStore(createEnvironment().storage, () => '2026-10-25');
  assert.deepEqual((await st.highlights('s1')).map((h) => h.id), ['h1']);
  assert.equal((await st.highlights()).length, 3);
  await st.review('h2', 5, '2026-10-25');
  const all = await st.highlights();
  assert.equal(all.find((h) => h.id === 'h2').interval, 1);
  assert.equal(all.find((h) => h.id === 'h1').interval, 0);
  assert.equal((await st.due('2026-10-25')).length, 2);
});

test('a new highlight reads as new and a reviewed one shows its interval', () => {
  const html = App.renderHighlights([{ id: 'a', text: 'x', note: '', due: '2026-10-25', interval: 0 }, { id: 'b', text: 'y', note: '', due: '2026-11-01', interval: 6 }]);
  assert.ok(html.includes('new, due 2026-10-25'));
  assert.ok(html.includes('next review 2026-11-01, every 6 days'));
});

test('ServerStore sends no body on reads and no query when listing every highlight', async () => {
  const f = fakeServer({});
  const st = App.ServerStore('http://h:1', '', f);
  await st.highlights();
  await st.highlights(7);
  assert.ok(f.calls[0].url.endsWith('/api/highlights') && f.calls[0].init.body === undefined);
  assert.ok(f.calls[1].url.endsWith('/api/highlights?article=7'));
  assert.ok(!('Content-Type' in f.calls[0].init.headers));
});

test('the search box waits for the debounce delay before searching', async () => {
  const env = createEnvironment();
  const timers = [];
  env.win.setTimeout = (fn, ms) => { timers.push(ms); fn(); return 1; };
  const app = App.createApp(env.doc, env.win, { storage: env.storage, today: () => '2026-10-25' });
  await app.init();
  env.els.q.value = 'dns';
  env.els.q.fire('input');
  assert.ok(timers.includes(120));
});

test('a pointer over the chart picks the month under it and clamps at both ends', () => {
  // the drawn chart keeps 58 px on the left and 14 px on the right for labels
  assert.equal(App.monthAtX(58, 640, 36), 0);
  assert.equal(App.monthAtX(0, 640, 36), 0);
  assert.equal(App.monthAtX(640, 640, 36), 36);
  assert.equal(App.monthAtX(58 + (640 - 58 - 14) / 2, 640, 36), 18);
  assert.equal(App.monthAtX(100, 50, 36), 0);
  assert.equal(App.monthAtX(300, 640, 0), 0);
});

test('dragging across the chart moves the month and the readout', async () => {
  const { env } = await boot();
  const box = env.els['audit-chart'];
  assert.ok(box.listenerCount('pointermove') >= 1 && box.listenerCount('pointerdown') >= 1);
  box.querySelector = () => ({ getBoundingClientRect: () => ({ left: 0, width: 640 }), getAttribute: () => '640' });
  box.fire('pointerdown', { clientX: 58 + (640 - 58 - 14) * 0.5 });
  assert.ok(env.els['chart-readout'].textContent.startsWith('Month 18.'));
  box.fire('pointermove', { clientX: 640 });
  assert.ok(env.els['chart-readout'].textContent.startsWith('Month 36.'));
});

test('the quickstart commands copy in one press', async () => {
  const { env } = await boot();
  env.els['qs-code'].textContent = 'git clone x\ncd x\n';
  env.els['qs-copy'].fire('click');
  await sleep(10);
  assert.equal(env.copied[0], 'git clone x\ncd x');
  assert.equal(env.els['qs-status'].textContent, 'Copied the four commands.');
});

test('the chart label halo, sticky results and touch sizes are in the stylesheet', () => {
  assert.ok(/\.chart-label,\s*\.cross-text\s*\{[^}]*paint-order:\s*stroke/.test(CSS));
  assert.ok(/\.audit-out\s*\{\s*position:\s*sticky/.test(CSS));
  assert.ok(/@media \(pointer: coarse\)/.test(CSS));
});
