/* SubZero Vault web app. Views are pure functions that return HTML strings (testable in Node),
 * the stores hide whether data lives in this browser or on your server, and createApp wires both to the page. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./samples.js'));
  else root.SubZeroApp = factory(root.SubZero, root.SubZeroSamples);
}(typeof self !== 'undefined' ? self : this, function (E, Samples) {
  'use strict';

  const esc = E.escapeHtml;
  const STORE_KEY = 'subzero.vault.v1';
  const SERVER_KEY = 'subzero.server.v1';
  const RATINGS = [
    { quality: 1, label: 'Again' },
    { quality: 3, label: 'Hard' },
    { quality: 4, label: 'Good' },
    { quality: 5, label: 'Easy' }
  ];

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  function money(n) {
    const v = Number(n) || 0;
    return (v < 0 ? '-' : '') + '$' + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function money0(n) {
    const v = Number(n) || 0;
    return (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function scoreText(s) {
    return Number(s).toFixed(3);
  }

  // ---------------------------------------------------------------------------
  // Rent audit views
  // ---------------------------------------------------------------------------

  function renderSubRows(calc) {
    const on = new Set(calc.enabled);
    return E.SUBSCRIPTION_CATALOG.map(function (s) {
      const price = calc.prices[s.id];
      return '<tr class="' + (on.has(s.id) ? '' : 'is-off') + '">' +
        '<td><input type="checkbox" id="sub-chk-' + s.id + '" data-kind="chk" data-id="' + s.id + '" aria-labelledby="sub-name-' + s.id + '"' + (on.has(s.id) ? ' checked' : '') + '></td>' +
        '<td><span class="sub-name"><span id="sub-name-' + s.id + '">' + esc(s.name) + '</span>' +
        '<span class="sub-basis">' + esc(s.basis) + '</span></span></td>' +
        '<td class="num"><input type="number" id="sub-price-' + s.id + '" data-kind="price" data-id="' + s.id + '" min="0" step="0.01" inputmode="decimal"' +
        ' aria-label="Monthly price for ' + esc(s.name) + ' in dollars" placeholder="enter"' + (price === null ? '' : ' value="' + Number(price).toFixed(2) + '"') + '></td></tr>';
    }).join('');
  }

  function renderLedgerRows(result) {
    const active = result.lines.filter(function (l) { return l.enabled && l.monthly > 0; });
    const shown = active.slice(0, 5);
    let html = shown.map(function (l) {
      return '<tr><th scope="row">' + esc(l.name) + '</th><td class="num">' + money(l.monthly) + '</td></tr>';
    }).join('');
    if (active.length > shown.length) {
      html += '<tr><th scope="row">and ' + (active.length - shown.length) + ' more</th><td class="num">' +
        money(active.slice(5).reduce(function (a, l) { return a + l.monthly; }, 0)) + '</td></tr>';
    }
    if (!html) html = '<tr><th scope="row">Nothing ticked yet</th><td class="num">$0.00</td></tr>';
    return html;
  }

  function ledgerFoot(result, calc) {
    if (result.breakEvenDay === 0) return 'The box costs nothing up front, so every dollar of this rent is saved from day one.';
    if (result.breakEvenDay === null) return 'At ' + calc.watts + ' W the box costs more to run than this rent, so it never pays for itself.';
    return money0(result.hardwareCost) + ' of hardware drawing ' + calc.watts + ' W pays for itself by day ' + result.breakEvenDay + ' in this scenario.';
  }

  function renderResults(result, calc) {
    const never = result.breakEvenDay === null;
    const total = calc.reinvest > 0 ? result.fiveYearCompounded : result.fiveYearPlain;
    const tiles = [
      { cls: '', value: money(result.saasAnnual), label: 'Rent each year' },
      { cls: '', value: money(result.ownAnnual), label: 'Power and extras each year (' + result.powerKwhYear + ' kWh)' },
      { cls: result.netAnnual >= 0 ? 'is-good' : 'is-bad', value: money(result.netAnnual), label: 'Saved each year' },
      { cls: never ? 'is-bad' : 'is-good', value: never ? 'never' : 'day ' + result.breakEvenDay, label: 'Break-even for the box' },
      { cls: total >= 0 ? 'is-good' : 'is-bad', value: money(total), label: result.years + '-year saving after the box' + (calc.reinvest > 0 ? ', savings invested' : '') }
    ];
    return tiles.map(function (t) {
      return '<div class="tile ' + t.cls + '"><span class="tile-value">' + esc(t.value) + '</span><span class="tile-label">' + esc(t.label) + '</span></div>';
    }).join('');
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * exp;
  }

  function renderChart(result, opts) {
    const o = opts || {};
    const W = Math.max(280, Math.round(o.width || 640));
    const H = Math.max(220, Math.round(o.height || W * 0.52));
    const m = { l: 58, r: 14, t: 18, b: 46 };
    const months = Math.min(o.horizon || 36, result.series.saas.length - 1);
    const maxV = niceMax(Math.max(result.series.saas[months], result.series.own[months], result.hardwareCost, 1));
    const px = function (i) { return m.l + (W - m.l - m.r) * (i / months); };
    const py = function (v) { return H - m.b - (H - m.t - m.b) * (v / maxV); };
    const path = function (series) {
      return series.map(function (v, i) { return (i ? 'L' : 'M') + px(i).toFixed(1) + ' ' + py(v).toFixed(1); }).join(' ');
    };
    const baseY = py(0);
    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const v = maxV * g / 4;
      grid += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + py(v).toFixed(1) + '" y2="' + py(v).toFixed(1) + '"/>';
    }
    let yLabels = '';
    for (let g = 0; g <= 4; g++) {
      const v = maxV * g / 4;
      yLabels += '<text x="' + (m.l - 8) + '" y="' + (py(v) + 4).toFixed(1) + '" text-anchor="end">' + money0(v) + '</text>';
    }
    const step = months > 36 ? 12 : 6;
    let xLabels = '';
    for (let i = 0; i <= months; i += step) {
      xLabels += '<text x="' + px(i).toFixed(1) + '" y="' + (H - m.b + 18) + '" text-anchor="' + (i === 0 ? 'start' : 'middle') + '">' + i + '</text>';
    }
    xLabels += '<text x="' + (W - m.r) + '" y="' + (H - 6) + '" text-anchor="end">months from today</text>';

    const lastS = result.series.saas[months];
    const lastO = result.series.own[months];
    const upTo = function (series) { return series.slice(0, months + 1); };
    const labels =
      '<text class="chart-label chart-label-saas" x="' + (W - m.r) + '" y="' + (py(lastS) - 8).toFixed(1) + '" text-anchor="end">Cloud rent ' + money0(lastS) + '</text>' +
      '<text class="chart-label chart-label-own" x="' + (W - m.r) + '" y="' + (py(lastO) - 8).toFixed(1) + '" text-anchor="end">Your box ' + money0(lastO) + '</text>';

    let cross = '';
    let crossDesc = 'The lines never cross in this window.';
    if (result.crossMonth !== null && result.crossMonth <= months) {
      const cm = result.crossMonth;
      const i0 = Math.floor(cm);
      const i1 = Math.min(months, i0 + 1);
      const val = result.series.saas[i0] + (result.series.saas[i1] - result.series.saas[i0]) * (cm - i0);
      const cx = px(cm);
      const right = cx > W * 0.62;
      cross = '<line class="cross-line" x1="' + cx.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y1="' + py(val).toFixed(1) + '" y2="' + baseY.toFixed(1) + '"/>' +
        '<circle class="cross-dot" cx="' + cx.toFixed(1) + '" cy="' + py(val).toFixed(1) + '" r="5"/>' +
        '<text class="cross-text" x="' + (right ? cx - 8 : cx + 8).toFixed(1) + '" y="' + (m.t + 10) + '" text-anchor="' + (right ? 'end' : 'start') + '">break-even, month ' + cm.toFixed(1) + '</text>';
      crossDesc = 'The lines cross at month ' + cm.toFixed(1) + '.';
    }

    let scrub = '';
    if (o.month !== undefined && o.month >= 0 && o.month <= months) {
      const mi = Math.round(o.month);
      scrub = '<line class="scrub-line" x1="' + px(mi).toFixed(1) + '" x2="' + px(mi).toFixed(1) + '" y1="' + m.t + '" y2="' + baseY.toFixed(1) + '"/>' +
        '<circle class="scrub-dot-saas" cx="' + px(mi).toFixed(1) + '" cy="' + py(result.series.saas[mi]).toFixed(1) + '" r="4"/>' +
        '<circle class="scrub-dot-own" cx="' + px(mi).toFixed(1) + '" cy="' + py(result.series.own[mi]).toFixed(1) + '" r="4"/>';
    }

    const area = path(upTo(result.series.saas)) + ' L' + px(months).toFixed(1) + ' ' + baseY.toFixed(1) + ' L' + px(0).toFixed(1) + ' ' + baseY.toFixed(1) + ' Z';
    const desc = 'Cumulative cost over ' + months + ' months. Cloud rent grows to ' + money0(lastS) + '. Running your own box grows from ' +
      money0(result.hardwareCost) + ' to ' + money0(lastO) + '. ' + crossDesc;

    return '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-labelledby="chart-title chart-desc">' +
      '<desc id="chart-desc">' + esc(desc) + '</desc>' +
      '<g class="chart-grid" aria-hidden="true">' + grid + '</g>' +
      '<g class="chart-axis" aria-hidden="true">' + yLabels + xLabels + '</g>' +
      '<path class="area-saas" d="' + area + '"/>' +
      '<path class="line line-saas" pathLength="1" d="' + path(upTo(result.series.saas)) + '"/>' +
      '<path class="line line-own" pathLength="1" d="' + path(upTo(result.series.own)) + '"/>' +
      '<g aria-hidden="true">' + cross + labels + scrub + '</g></svg>';
  }

  function chartReadout(result, month) {
    const mi = Math.max(0, Math.min(Math.min(36, result.series.saas.length - 1), Math.round(month)));
    const rent = result.series.saas[mi];
    const own = result.series.own[mi];
    const diff = rent - own;
    const verdict = Math.abs(diff) < 0.005 ? 'Dead even.' : diff > 0 ? 'Owning is ahead by ' + money(diff) + '.' : 'Renting is ahead by ' + money(-diff) + '.';
    return 'Month ' + mi + '. Rent so far ' + money(rent) + ', box so far ' + money(own) + '. ' + verdict;
  }

  // ---------------------------------------------------------------------------
  // Vault views
  // ---------------------------------------------------------------------------

  function renderTagChips(tags, active) {
    const all = '<button type="button" class="chip" data-action="tag" data-value="" aria-pressed="' + (active ? 'false' : 'true') + '">All</button>';
    return all + tags.map(function (t) {
      return '<button type="button" class="chip" data-action="tag" data-value="' + esc(t.tag) + '" aria-pressed="' + (active === t.tag ? 'true' : 'false') + '">' + esc(t.tag) + ' ' + t.count + '</button>';
    }).join('');
  }

  function renderResultsList(results, selectedId, searching, canSeed) {
    if (!results.length) {
      if (searching) return '<li class="empty">Nothing matches. Try fewer or different words.</li>';
      return '<li class="empty">The vault is empty. Add an article below' + (canSeed ? ', or start with the samples.</li>' +
        '<li><button type="button" class="btn btn-quiet btn-small" data-action="load-samples">Load the eight sample articles</button></li>' : '.</li>');
    }
    return results.map(function (r) {
      const meta = [];
      if (r.score !== undefined) meta.push('<span class="result-score">BM25 ' + scoreText(r.score) + '</span>');
      else if (r.wordCount !== undefined) meta.push('<span>' + r.wordCount + ' words</span>');
      (r.tags || []).slice(0, 3).forEach(function (t) { meta.push('<span>#' + esc(t) + '</span>'); });
      const snippet = r.snippet !== undefined ? r.snippet : esc(r.excerpt || '');
      return '<li><button type="button" class="result" data-action="open" data-id="' + esc(r.id) + '" aria-current="' + (String(r.id) === String(selectedId) ? 'true' : 'false') + '">' +
        '<span class="result-title">' + esc(r.title) + '</span>' +
        '<span class="result-meta">' + meta.join('') + '</span>' +
        (snippet ? '<span class="result-snippet">' + snippet + '</span>' : '') + '</button></li>';
    }).join('');
  }

  function renderBody(text, highlights) {
    const blocks = String(text || '').split(/\n{2,}/).filter(Boolean);
    const marks = (highlights || []).map(function (h) { return esc(h.text); });
    function decorate(raw) {
      let html = esc(raw);
      marks.forEach(function (m) {
        if (m && html.indexOf(m) >= 0) html = html.split(m).join('<mark class="saved">' + m + '</mark>');
      });
      return html;
    }
    let out = '';
    let list = false;
    blocks.forEach(function (b) {
      const isLi = b.indexOf('- ') === 0;
      if (list && !isLi) { out += '</ul>'; list = false; }
      if (isLi) {
        if (!list) { out += '<ul>'; list = true; }
        out += '<li>' + decorate(b.slice(2)) + '</li>';
      } else if (b.indexOf('## ') === 0) {
        out += '<h4>' + decorate(b.slice(3)) + '</h4>';
      } else if (b.indexOf('> ') === 0) {
        out += '<blockquote>' + decorate(b.slice(2)) + '</blockquote>';
      } else {
        out += '<p>' + decorate(b) + '</p>';
      }
    });
    return out + (list ? '</ul>' : '');
  }

  function renderReader(article, highlights) {
    if (!article) return '<p class="empty">Pick an article to read it here.</p>';
    const meta = ['<span>' + article.wordCount + ' words</span>', '<span>saved ' + esc(article.savedAt) + '</span>']
      .concat((article.tags || []).map(function (t) { return '<span>#' + esc(t) + '</span>'; }));
    if (article.url) meta.push('<a href="' + esc(article.url) + '" rel="noopener noreferrer">original page</a>');
    return '<div class="reader-head"><h3 class="reader-title">' + esc(article.title) + '</h3>' +
      '<div class="reader-meta">' + meta.join('') + '</div></div>' +
      '<div class="reader-body">' + renderBody(article.body, highlights) + '</div>' +
      '<div class="row-actions"><button type="button" class="btn btn-quiet btn-small" data-action="del-article" data-id="' + esc(article.id) + '">Delete this article</button></div>';
  }

  function renderHighlights(list) {
    if (!list.length) return '<li class="empty">No highlights yet. Select text in the article and press the button.</li>';
    return list.map(function (h) {
      return '<li class="hl-item"><div><q>' + esc(h.text) + '</q>' + (h.note ? '<span class="hl-note">' + esc(h.note) + '</span>' : '') +
        '<span class="hl-due">next review ' + esc(h.due) + ', every ' + h.interval + ' day' + (h.interval === 1 ? '' : 's') + '</span></div>' +
        '<button type="button" class="icon-btn" data-action="hl-delete" data-id="' + esc(h.id) + '" aria-label="Delete this highlight">x</button></li>';
    }).join('');
  }

  function cueFor(h) {
    if (h.note) return h.note;
    const words = String(h.text).split(/\s+/).slice(0, 6).join(' ');
    return words + ' ...';
  }

  function renderReview(due, revealed, today) {
    if (!due.length) {
      return '<p class="empty">Nothing due. A highlight you save today comes back tomorrow, then in six days, then at longer and longer gaps.</p>';
    }
    const h = due[0];
    let html = '<div class="review-card"><div class="review-source">' + esc(h.articleTitle || '') + '</div>' +
      '<p class="review-prompt">' + esc(cueFor(h)) + '</p>';
    if (!revealed) {
      html += '<button type="button" class="btn btn-primary btn-small" data-action="show-answer">Show the highlight</button>';
    } else {
      const card = { repetitions: h.repetitions, interval: h.interval, ef: h.ef };
      const prev = E.previewIntervals(card, RATINGS.map(function (r) { return r.quality; }), today);
      html += '<div class="review-answer">' + esc(h.text) + '</div><div class="rate-grid" role="group" aria-label="How well did you remember it">' +
        RATINGS.map(function (r, i) {
          return '<button type="button" class="rate-btn" data-action="rate" data-q="' + r.quality + '">' + r.label + '<span>' + prev[i].interval + ' day' + (prev[i].interval === 1 ? '' : 's') + '</span></button>';
        }).join('') + '</div>';
    }
    return html + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Packaging studio views
  // ---------------------------------------------------------------------------

  function renderCode(text) {
    return String(text).split('\n').map(function (line) {
      return /^\s*#/.test(line) ? '<span class="dim">' + esc(line) + '</span>' : esc(line);
    }).join('\n');
  }

  function studioFiles(opts) {
    const g = E.generateDockerCompose(opts);
    const files = [{ name: 'docker-compose.yml', text: g.compose }, { name: '.env', text: g.env }];
    if (g.caddyfile) files.push({ name: 'Caddyfile', text: g.caddyfile });
    return files;
  }

  function renderTabs(files, active) {
    return files.map(function (f) {
      const on = f.name === active;
      return '<button type="button" role="tab" class="tab" id="tab-' + esc(f.name.replace(/\W/g, '')) + '" data-action="tab" data-id="' + esc(f.name) + '" aria-selected="' + on + '" tabindex="' + (on ? '0' : '-1') + '">' + esc(f.name) + '</button>';
    }).join('');
  }

  function describeCron(expr) {
    const t = String(expr || '').trim();
    if (!t) return { ok: true, text: 'Backups are off.' };
    const v = E.validateCron(t);
    if (!v.valid) return { ok: false, text: v.error };
    const m = /^(\d+) (\d+) \* \* \*$/.exec(t);
    if (m) return { ok: true, text: 'Every day at ' + ('0' + m[2]).slice(-2) + ':' + ('0' + m[1]).slice(-2) + '.' };
    return { ok: true, text: 'Valid schedule.' };
  }

  function bookmarklet(base, token) {
    const endpoint = String(base).replace(/\/+$/, '') + '/api/clip?token=' + encodeURIComponent(token);
    const code = '(function(){fetch(' + JSON.stringify(endpoint) + ',{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},' +
      'body:JSON.stringify({url:location.href,html:document.documentElement.outerHTML})});})()';
    return 'javascript:' + encodeURIComponent(code);
  }

  // ---------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------

  function summary(a) {
    return { id: a.id, title: a.title, url: a.url, tags: a.tags, savedAt: a.savedAt, folder: a.folder || '', wordCount: E.wordCount(a.body),
      excerpt: String(a.body || '').replace(/^#+ |^- |^> /gm, '').replace(/\s+/g, ' ').slice(0, 150) };
  }

  function cleanTags(tags) {
    const out = [];
    (tags || []).forEach(function (t) {
      const s = String(t).trim().toLowerCase().slice(0, 40);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out.slice(0, 20);
  }

  function LocalStore(storage, today) {
    const self = { kind: 'local' };
    let db = null;
    let idx = null;

    function seed() {
      const day = today();
      return {
        next: 1,
        articles: Samples.articles.map(function (a) {
          return { id: a.id, title: a.title, url: a.url, tags: a.tags.slice(), savedAt: a.savedAt, folder: '', note: '', body: a.body };
        }),
        highlights: Samples.highlights.map(function (h) {
          return { id: h.id, articleId: h.articleId, text: h.text, note: h.note, created: day, repetitions: 0, interval: 0, ef: 2.5, due: day };
        })
      };
    }

    function load() {
      try {
        const raw = storage && storage.getItem(STORE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.articles) && Array.isArray(parsed.highlights)) return parsed;
        }
      } catch (e) { /* fall through to a fresh seed */ }
      return seed();
    }

    function save() {
      idx = null;
      try { storage.setItem(STORE_KEY, JSON.stringify(db)); }
      catch (e) { throw new Error('Browser storage is full or blocked, so this change was not saved.'); }
    }

    function index() {
      if (!idx) idx = E.buildInvertedIndex(db.articles.map(function (a) { return { id: a.id, title: a.title, body: a.body || a.url, tags: a.tags }; }));
      return idx;
    }

    function byId(id) {
      return db.articles.find(function (a) { return String(a.id) === String(id); });
    }

    db = load();

    self.reset = async function () { db = seed(); save(); };
    self.list = async function () {
      return db.articles.map(summary).sort(function (a, b) { return a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.title < b.title ? -1 : 1; });
    };
    self.get = async function (id) {
      const a = byId(id);
      if (!a) throw new Error('That article is gone.');
      return Object.assign(summary(a), { body: a.body });
    };
    self.add = async function (input) {
      const title = String(input.title || input.url || '').trim();
      if (!title) throw new Error('Give the article a title or an address.');
      const url = String(input.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) throw new Error('The address must start with http:// or https://.');
      const existing = url ? db.articles.find(function (a) { return a.url === url; }) : null;
      const rec = existing || { id: 'u' + (db.next++), savedAt: today(), folder: '', note: '' };
      rec.title = title; rec.url = url; rec.body = String(input.body || '');
      if (input.tags !== undefined || !existing) rec.tags = cleanTags(input.tags);
      if (input.folder) rec.folder = input.folder;
      if (input.note) rec.note = input.note;
      if (!existing) db.articles.push(rec);
      save();
      return summary(rec);
    };
    self.remove = async function (id) {
      db.articles = db.articles.filter(function (a) { return String(a.id) !== String(id); });
      db.highlights = db.highlights.filter(function (h) { return String(h.articleId) !== String(id); });
      save();
    };
    self.search = async function (q, tag) {
      let rows;
      if (!String(q || '').trim()) {
        rows = await self.list();
      } else {
        rows = E.bm25Search(index(), q).map(function (h) {
          const a = byId(h.id);
          return Object.assign(summary(a), { score: h.score, terms: h.terms, snippet: E.makeSnippet(a.body || a.url, h.terms) });
        });
      }
      return tag ? rows.filter(function (r) { return r.tags.indexOf(tag) >= 0; }) : rows;
    };
    self.addHighlight = async function (articleId, text, note) {
      const t = String(text || '').trim();
      if (!t) throw new Error('Select some text first.');
      if (t.length > 4000) throw new Error('That selection is too long for a highlight.');
      if (!byId(articleId)) throw new Error('That article is gone.');
      const day = today();
      const h = { id: 'h' + (db.next++), articleId: articleId, text: t, note: String(note || '').trim().slice(0, 200), created: day, repetitions: 0, interval: 0, ef: 2.5, due: day };
      db.highlights.push(h);
      save();
      return h;
    };
    self.highlights = async function (articleId) {
      return db.highlights.filter(function (h) { return articleId === undefined || String(h.articleId) === String(articleId); });
    };
    self.removeHighlight = async function (id) {
      db.highlights = db.highlights.filter(function (h) { return String(h.id) !== String(id); });
      save();
    };
    self.due = async function (day) {
      return db.highlights.filter(function (h) { return h.due <= day; })
        .sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; })
        .map(function (h) { return Object.assign({}, h, { articleTitle: (byId(h.articleId) || {}).title || '' }); });
    };
    self.review = async function (id, quality, day) {
      const h = db.highlights.find(function (x) { return String(x.id) === String(id); });
      if (!h) throw new Error('That highlight is gone.');
      const next = E.scheduleSm2Review({ repetitions: h.repetitions, interval: h.interval, ef: h.ef }, quality, day);
      h.repetitions = next.repetitions; h.interval = next.interval; h.ef = next.ef; h.due = next.due;
      save();
      return h;
    };
    self.importBookmarks = async function (html) {
      let added = 0;
      let skipped = 0;
      E.parseNetscapeBookmarks(html).forEach(function (it) {
        if (db.articles.some(function (a) { return a.url === it.url; })) { skipped++; return; }
        db.articles.push({ id: 'u' + (db.next++), title: it.title, url: it.url, tags: cleanTags(it.tags), savedAt: it.addDate || today(), folder: it.folder, note: it.note, body: it.note });
        added++;
      });
      save();
      return { added: added, skipped: skipped };
    };
    self.exportBookmarks = async function () {
      return E.exportNetscapeBookmarks(db.articles.filter(function (a) { return a.url; }).map(function (a) {
        return { title: a.title, url: a.url, tags: a.tags, folder: a.folder, note: a.note, addDate: a.savedAt };
      }));
    };
    self.exportJson = async function () { return JSON.stringify(db, null, 2); };
    return self;
  }

  function ServerStore(baseUrl, token, fetchFn) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const self = { kind: 'server', base: base };

    async function call(method, path, body) {
      const headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetchFn(base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        throw new Error('Could not reach ' + base + '. Is it running, and does it allow this site in VAULT_ALLOWED_ORIGINS?');
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (!res.ok) throw new Error((data && data.error) || 'The server answered ' + res.status + '.');
      return { data: data, text: text };
    }

    self.ping = async function () { return (await call('GET', '/health')).data; };
    self.list = async function () { return (await call('GET', '/api/articles')).data.articles; };
    self.get = async function (id) { return (await call('GET', '/api/articles/' + encodeURIComponent(id))).data; };
    self.add = async function (input) {
      const body = { title: input.title, url: input.url, tags: input.tags };
      if (/<\s*(html|body|p|div|article)\b/i.test(input.body || '')) body.html = input.body; else body.text = input.body || '';
      return (await call('POST', '/api/articles', body)).data;
    };
    self.remove = async function (id) { await call('DELETE', '/api/articles/' + encodeURIComponent(id)); };
    self.search = async function (q, tag) {
      if (!String(q || '').trim()) {
        const rows = await self.list();
        return tag ? rows.filter(function (r) { return r.tags.indexOf(tag) >= 0; }) : rows;
      }
      const qs = '?q=' + encodeURIComponent(q) + (tag ? '&tag=' + encodeURIComponent(tag) : '');
      return (await call('GET', '/api/search' + qs)).data.results;
    };
    self.addHighlight = async function (articleId, text, note) { return (await call('POST', '/api/articles/' + encodeURIComponent(articleId) + '/highlights', { text: text, note: note })).data; };
    self.highlights = async function (articleId) { return (await call('GET', '/api/highlights' + (articleId === undefined ? '' : '?article=' + encodeURIComponent(articleId)))).data.highlights; };
    self.removeHighlight = async function (id) { await call('DELETE', '/api/highlights/' + encodeURIComponent(id)); };
    self.due = async function (day) { return (await call('GET', '/api/review/due?today=' + encodeURIComponent(day))).data.due; };
    self.review = async function (id, quality, day) { return (await call('POST', '/api/review/' + encodeURIComponent(id), { quality: quality, today: day })).data; };
    self.importBookmarks = async function (html) { return (await call('POST', '/api/import', { html: html })).data; };
    self.exportBookmarks = async function () { return (await call('GET', '/api/export?format=netscape')).text; };
    self.exportJson = async function () { return (await call('GET', '/api/export?format=json')).text; };
    self.reset = async function () { throw new Error('Resetting samples only applies to browser storage.'); };
    return self;
  }

  // ---------------------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------------------

  function createApp(doc, win, opts) {
    const o = opts || {};
    const today = o.today || function () { return E.todayIso(); };
    const storage = o.storage;
    const fetchFn = o.fetch || (win && win.fetch ? win.fetch.bind(win) : null);
    const delay = o.debounce === undefined ? 120 : o.debounce;
    const byId = function (id) { return doc.getElementById(id); };

    const state = {
      calc: E.defaultCalcState(),
      month: 12,
      store: null,
      query: '',
      tag: '',
      selectedId: null,
      revealed: false,
      due: [],
      studioTab: 'docker-compose.yml',
      studioFiles: [],
      seq: 0,
      chartAnimated: false
    };

    function say(id, text, isError) {
      const el = byId(id);
      if (!el) return;
      el.textContent = text;
      if (el.classList) { if (isError) el.classList.add('is-error'); else el.classList.remove('is-error'); }
    }

    function describe(e) { return e && e.message ? e.message : String(e); }

    // ----- audit -----------------------------------------------------------

    function readCalcInputs() {
      const c = state.calc;
      const read = function (id) { const v = parseFloat(byId(id).value); return isFinite(v) ? v : 0; };
      c.hardwareCost = read('hw-cost');
      c.watts = read('hw-watts');
      c.kwhPrice = read('hw-kwh');
      c.extraAnnual = read('hw-extra');
      c.saasGrowth = read('grow-saas') / 100;
      c.reinvest = read('grow-invest') / 100;
      state.calc = E.normalizeCalc(c);
    }

    function writeCalcInputs() {
      const c = state.calc;
      byId('hw-cost').value = String(c.hardwareCost);
      byId('hw-watts').value = String(c.watts);
      byId('hw-kwh').value = String(c.kwhPrice);
      byId('hw-extra').value = String(c.extraAnnual);
      byId('grow-saas').value = String(Math.round(c.saasGrowth * 1000) / 10);
      byId('grow-invest').value = String(Math.round(c.reinvest * 1000) / 10);
    }

    let urlTimer = null;
    function syncUrl() {
      if (!win || !win.history || !win.location) return;
      if (urlTimer) win.clearTimeout(urlTimer);
      urlTimer = win.setTimeout(function () {
        try {
          const token = E.encodeCalcState(state.calc);
          win.history.replaceState(null, '', win.location.pathname + (token ? '?c=' + token : '') + (win.location.hash || ''));
        } catch (e) { /* file:// pages may refuse; the link button still works */ }
      }, 250);
    }

    function drawChart(result) {
      const box = byId('audit-chart');
      const width = box.clientWidth || 640;
      box.innerHTML = renderChart(result, { width: width, height: Math.max(230, Math.min(380, Math.round(width * 0.54))), month: state.month });
      if (!state.chartAnimated && width > 0) {
        state.chartAnimated = true;
        const reduce = win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!reduce) {
          box.setAttribute('data-anim', '1');
          win.setTimeout(function () { box.removeAttribute('data-anim'); }, 1400);
        }
      }
    }

    function renderAudit() {
      const result = E.computeSubscriptionSavings(state.calc);
      byId('ledger-total').textContent = money(result.saasAnnual);
      byId('ledger-rows').innerHTML = renderLedgerRows(result);
      byId('ledger-foot').textContent = ledgerFoot(result, state.calc);
      byId('audit-results').innerHTML = renderResults(result, state.calc);
      const months = Math.min(36, result.series.saas.length - 1);
      const slider = byId('chart-month');
      slider.setAttribute('max', String(months));
      if (state.month > months) state.month = months;
      slider.value = String(state.month);
      drawChart(result);
      byId('chart-readout').textContent = chartReadout(result, state.month);
      return result;
    }

    function onCalcChanged() {
      readCalcInputs();
      renderAudit();
      syncUrl();
    }

    function onSubEvent(e) {
      const t = e.target;
      if (!t || !t.dataset || !t.dataset.id) return;
      const id = t.dataset.id;
      const on = new Set(state.calc.enabled);
      if (t.dataset.kind === 'chk') {
        if (t.checked) on.add(id); else on.delete(id);
        state.calc.enabled = Array.from(on);
        const row = t.closest ? t.closest('tr') : null;
        if (row && row.classList) { if (t.checked) row.classList.remove('is-off'); else row.classList.add('is-off'); }
      } else if (t.dataset.kind === 'price') {
        const v = t.value;
        state.calc.prices[id] = v === '' ? null : parseFloat(v);
        if (v !== '' && !on.has(id)) {
          on.add(id);
          state.calc.enabled = Array.from(on);
          const box = byId('sub-chk-' + id);
          if (box) box.checked = true;
          const row = t.closest ? t.closest('tr') : null;
          if (row && row.classList) row.classList.remove('is-off');
        }
      }
      state.calc = E.normalizeCalc(state.calc);
      renderAudit();
      syncUrl();
    }

    function onPreset() {
      const id = byId('hw-preset').value;
      const p = E.HARDWARE_PRESETS.find(function (x) { return x.id === id; });
      if (p) {
        byId('hw-cost').value = String(p.cost);
        byId('hw-watts').value = String(p.watts);
      }
      onCalcChanged();
    }

    function onManualHardware() {
      byId('hw-preset').value = 'custom';
      onCalcChanged();
    }

    function copyText(text) {
      if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
        return win.navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        try {
          const ta = doc.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          doc.body.appendChild(ta);
          ta.select();
          const ok = doc.execCommand && doc.execCommand('copy');
          doc.body.removeChild(ta);
          if (ok) resolve(); else reject(new Error('copy blocked'));
        } catch (e) { reject(e); }
      });
    }

    async function onCopyScenario() {
      const token = E.encodeCalcState(state.calc);
      const loc = win.location;
      const link = loc.origin + loc.pathname + (token ? '?c=' + token : '') + '#audit';
      try { await copyText(link); say('scenario-status', 'Link copied.'); }
      catch (e) { say('scenario-status', 'Copy was blocked. Copy the address bar instead.', true); }
    }

    // ----- vault -----------------------------------------------------------

    async function refreshVault(keepSelection) {
      const seq = ++state.seq;
      const store = state.store;
      try {
        const all = await store.list();
        const counts = {};
        all.forEach(function (a) { (a.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
        const tags = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); }).slice(0, 14)
          .map(function (t) { return { tag: t, count: counts[t] }; });
        const results = await store.search(state.query, state.tag);
        if (seq !== state.seq) return;
        byId('tag-filter').innerHTML = renderTagChips(tags, state.tag);
        if (!keepSelection || !results.some(function (r) { return String(r.id) === String(state.selectedId); })) {
          state.selectedId = results.length ? results[0].id : null;
        }
        byId('results').innerHTML = renderResultsList(results, state.selectedId, !!state.query.trim(), store.kind === 'server' && !state.tag);
        say('vault-status', state.query.trim()
          ? results.length + ' result' + (results.length === 1 ? '' : 's') + ' for "' + state.query.trim() + '", best match first.'
          : all.length + ' saved item' + (all.length === 1 ? '' : 's') + '.');
        await refreshReader();
        await refreshReview();
      } catch (e) {
        say('vault-status', describe(e), true);
      }
    }

    async function refreshReader() {
      if (state.selectedId === null || state.selectedId === undefined) {
        byId('reader').innerHTML = renderReader(null);
        byId('highlights').innerHTML = renderHighlights([]);
        return;
      }
      try {
        const art = await state.store.get(state.selectedId);
        const hl = await state.store.highlights(state.selectedId);
        byId('reader').innerHTML = renderReader(art, hl);
        byId('highlights').innerHTML = renderHighlights(hl);
      } catch (e) {
        state.selectedId = null;
        byId('reader').innerHTML = renderReader(null);
        byId('highlights').innerHTML = renderHighlights([]);
      }
    }

    async function refreshReview() {
      state.due = await state.store.due(today());
      byId('review-count').textContent = state.due.length + ' due';
      byId('review-card').innerHTML = renderReview(state.due, state.revealed, today());
    }

    function setMode() {
      const server = state.store.kind === 'server';
      const pill = byId('storage-pill');
      pill.setAttribute('data-mode', server ? 'server' : 'local');
      byId('storage-label').textContent = server ? 'Storage: your server' : 'Storage: this browser';
      byId('srv-disconnect').disabled = !server;
      byId('reset-demo').disabled = server;
    }

    function setClip(token) {
      const box = byId('clip-box');
      if (state.store.kind === 'server' && token) {
        byId('clip-link').setAttribute('href', bookmarklet(state.store.base, token));
        box.hidden = false;
      } else {
        box.hidden = true;
      }
    }

    async function connect(url, token, silent) {
      const candidate = ServerStore(url, token, fetchFn);
      try {
        const health = await candidate.ping();
        if (!health || !health.ok) throw new Error('That address did not answer like a SubZero Vault server.');
        if (health.auth && !token) throw new Error('This server needs a token. Paste it in the token box.');
        await candidate.list();
      } catch (e) {
        if (!silent) say('srv-status', describe(e), true);
        return false;
      }
      state.store = candidate;
      state.selectedId = null;
      state.revealed = false;
      setMode();
      setClip(token);
      say('srv-status', 'Connected to ' + candidate.base + '.');
      try {
        if (o.sessionStorage) o.sessionStorage.setItem(SERVER_KEY, JSON.stringify({ url: candidate.base, token: token || '' }));
      } catch (e) { /* private mode */ }
      await refreshVault(false);
      return true;
    }

    async function disconnect() {
      state.store = LocalStore(storage, today);
      state.selectedId = null;
      state.revealed = false;
      try { if (o.sessionStorage) o.sessionStorage.removeItem(SERVER_KEY); } catch (e) { /* ignore */ }
      setMode();
      setClip('');
      say('srv-status', 'Using this browser again.');
      await refreshVault(false);
    }

    function guarded(fn) {
      return async function (e) {
        try { await fn(e); }
        catch (err) { say('vault-status', describe(err), true); }
      };
    }

    const onLoadSamples = guarded(async function () {
      for (let i = 0; i < Samples.articles.length; i++) {
        const s = Samples.articles[i];
        const saved = await state.store.add({ title: s.title, url: '', body: s.body, tags: s.tags });
        const marks = Samples.highlights.filter(function (h) { return h.articleId === s.id; });
        for (let j = 0; j < marks.length; j++) await state.store.addHighlight(saved.id, marks[j].text, marks[j].note);
      }
      say('vault-status', 'Samples loaded.');
      await refreshVault(false);
    });

    async function onOpen(id) {
      state.selectedId = id;
      await refreshVault(true);
    }

    const onHighlightSave = guarded(async function () {
      const sel = win.getSelection ? win.getSelection() : null;
      const text = sel ? String(sel.toString()).replace(/\s+/g, ' ').trim() : '';
      const reader = byId('reader');
      const inside = sel && sel.anchorNode && reader.contains ? reader.contains(sel.anchorNode) : !!text;
      if (!text || !inside) { say('vault-status', 'Select some text inside the article first, then press the button.', true); return; }
      if (state.selectedId === null) { say('vault-status', 'Open an article first.', true); return; }
      await state.store.addHighlight(state.selectedId, text, byId('hl-note').value);
      byId('hl-note').value = '';
      if (sel.removeAllRanges) sel.removeAllRanges();
      say('vault-status', 'Highlight saved. It is due for review today.');
      await refreshReader();
      await refreshReview();
    });

    const onRate = guarded(async function (quality) {
      const h = state.due[0];
      if (!h) return;
      await state.store.review(h.id, quality, today());
      state.revealed = false;
      await refreshReview();
      await refreshReader();
    });

    const onAdd = guarded(async function (e) {
      if (e && e.preventDefault) e.preventDefault();
      const raw = byId('add-body').value;
      let body = raw;
      let title = byId('add-title').value.trim();
      const looksHtml = /<\s*(html|body|p|div|article)\b/i.test(raw);
      if (state.store.kind === 'local' && looksHtml) {
        const got = E.extractReadable(raw);
        body = got.text;
        title = title || got.title;
      }
      if (!title && !byId('add-url').value.trim()) { say('add-status', 'Add a title, an address, or paste a page that has a title.', true); return; }
      const saved = await state.store.add({ title: title, url: byId('add-url').value, body: body, tags: byId('add-tags').value.split(',') });
      byId('add-title').value = ''; byId('add-url').value = ''; byId('add-tags').value = ''; byId('add-body').value = '';
      say('add-status', 'Saved "' + saved.title + '".');
      state.query = ''; byId('q').value = ''; state.tag = '';
      state.selectedId = saved.id;
      await refreshVault(true);
    });

    const onImport = guarded(async function () {
      const input = byId('import-file');
      const file = input.files && input.files[0];
      if (!file) { say('import-status', 'Choose a bookmarks file first.', true); return; }
      const html = await file.text();
      const r = await state.store.importBookmarks(html);
      say('import-status', 'Added ' + r.added + ' bookmark' + (r.added === 1 ? '' : 's') + (r.skipped ? ', skipped ' + r.skipped + ' already saved.' : '.'));
      await refreshVault(true);
    });

    function download(name, text, type) {
      const blob = new win.Blob([text], { type: type });
      const url = win.URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url; a.download = name;
      doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
      win.setTimeout(function () { win.URL.revokeObjectURL(url); }, 2000);
    }

    const onExportHtml = guarded(async function () {
      const text = await state.store.exportBookmarks();
      if (!/<A /i.test(text)) { say('vault-status', 'Nothing to export yet. Only items saved with an address go in a bookmarks file.', true); return; }
      download('subzero-bookmarks.html', text, 'text/html');
      say('vault-status', 'Bookmarks file downloaded.');
    });

    const onExportJson = guarded(async function () {
      download('subzero-vault.json', await state.store.exportJson(), 'application/json');
      say('vault-status', 'JSON backup downloaded.');
    });

    const onReset = guarded(async function () {
      await state.store.reset();
      state.query = ''; byId('q').value = ''; state.tag = ''; state.selectedId = null; state.revealed = false;
      await refreshVault(false);
      say('vault-status', 'Samples restored.');
    });

    let searchTimer = null;
    function onSearchInput() {
      state.query = byId('q').value;
      if (searchTimer) win.clearTimeout(searchTimer);
      searchTimer = win.setTimeout(function () { state.selectedId = null; refreshVault(false); }, delay);
    }

    // ----- studio ----------------------------------------------------------

    function studioOptions() {
      const proxy = (function () {
        const radios = doc.querySelectorAll ? doc.querySelectorAll('input[name="proxy"]') : [];
        for (let i = 0; i < radios.length; i++) if (radios[i].checked) return radios[i].value;
        return byId('st-proxy').dataset && byId('st-proxy').dataset.value ? byId('st-proxy').dataset.value : 'none';
      }());
      return {
        port: parseInt(byId('st-port').value, 10),
        dataPath: byId('st-data').value,
        backupCron: byId('st-cron').value,
        backupPath: byId('st-backup-path').value,
        proxy: proxy,
        domain: byId('st-domain').value,
        token: byId('st-token').value,
        timezone: byId('st-tz').value
      };
    }

    function renderStudio() {
      const options = studioOptions();
      const cron = describeCron(options.backupCron);
      const msg = byId('st-cron-msg');
      msg.textContent = cron.text;
      if (msg.classList) { if (cron.ok) msg.classList.remove('is-error'); else msg.classList.add('is-error'); }
      byId('st-cron').setAttribute('aria-invalid', cron.ok ? 'false' : 'true');
      byId('st-domain').disabled = options.proxy !== 'caddy';
      state.studioFiles = studioFiles(options);
      if (!state.studioFiles.some(function (f) { return f.name === state.studioTab; })) state.studioTab = state.studioFiles[0].name;
      byId('st-tabs').innerHTML = renderTabs(state.studioFiles, state.studioTab);
      const file = state.studioFiles.find(function (f) { return f.name === state.studioTab; });
      byId('st-out').innerHTML = renderCode(file.text);
    }

    const onStudioCopy = guarded(async function () {
      const file = state.studioFiles.find(function (f) { return f.name === state.studioTab; });
      try { await copyText(file.text); say('st-status', 'Copied ' + file.name + '.'); }
      catch (e) { say('st-status', 'Copy was blocked. Select the text and copy it by hand.', true); }
    });

    function onStudioDownload() {
      const file = state.studioFiles.find(function (f) { return f.name === state.studioTab; });
      download(file.name, file.text, 'text/plain');
      say('st-status', 'Downloaded ' + file.name + '.');
    }

    function onGenToken() {
      const c = win && (win.crypto || {});
      if (!c.getRandomValues) { say('st-status', 'This browser cannot make a secure random token.', true); return; }
      const bytes = new Uint8Array(24);
      c.getRandomValues(bytes);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      byId('st-token').value = win.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      renderStudio();
      say('st-status', 'New token generated. Keep it out of version control.');
    }

    function onTabKey(e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const names = state.studioFiles.map(function (f) { return f.name; });
      const i = names.indexOf(state.studioTab);
      const next = names[(i + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length];
      state.studioTab = next;
      renderStudio();
      const btn = doc.querySelector ? doc.querySelector('[role="tab"][aria-selected="true"]') : null;
      if (btn && btn.focus) btn.focus();
      if (e.preventDefault) e.preventDefault();
    }

    // ----- wiring ----------------------------------------------------------

    function onClick(e) {
      const hit = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!hit) return;
      const d = hit.dataset;
      switch (d.action) {
        case 'open': onOpen(d.id); break;
        case 'tag': state.tag = d.value; state.selectedId = null; refreshVault(false); break;
        case 'del-article': guarded(async function () { await state.store.remove(d.id); state.selectedId = null; await refreshVault(false); say('vault-status', 'Article deleted.'); })(); break;
        case 'hl-delete': guarded(async function () { await state.store.removeHighlight(d.id); await refreshReader(); await refreshReview(); })(); break;
        case 'load-samples': onLoadSamples(); break;
        case 'show-answer': state.revealed = true; byId('review-card').innerHTML = renderReview(state.due, true, today()); break;
        case 'rate': onRate(parseInt(d.q, 10)); break;
        case 'tab': state.studioTab = d.id; renderStudio(); break;
        default: break;
      }
    }

    function init() {
      // audit
      if (win && win.location && win.location.search) {
        const m = /[?&]c=([A-Za-z0-9_-]+)/.exec(win.location.search);
        if (m) state.calc = E.decodeCalcState(m[1]);
      }
      byId('audit-subs').innerHTML = renderSubRows(state.calc);
      byId('hw-preset').innerHTML = '<option value="custom">Custom</option>' + E.HARDWARE_PRESETS.map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.name) + ' (' + money0(p.cost) + ', ' + p.watts + ' W)</option>';
      }).join('');
      const match = E.HARDWARE_PRESETS.find(function (p) { return p.cost === state.calc.hardwareCost && p.watts === state.calc.watts; });
      byId('hw-preset').value = match ? match.id : 'custom';
      writeCalcInputs();
      renderAudit();

      ['hw-cost', 'hw-watts'].forEach(function (id) { byId(id).addEventListener('input', onManualHardware); });
      ['hw-kwh', 'hw-extra', 'grow-saas', 'grow-invest'].forEach(function (id) { byId(id).addEventListener('input', onCalcChanged); });
      byId('hw-preset').addEventListener('change', onPreset);
      byId('audit-subs').addEventListener('input', onSubEvent);
      byId('audit-subs').addEventListener('change', onSubEvent);
      byId('chart-month').addEventListener('input', function () {
        state.month = parseInt(byId('chart-month').value, 10) || 0;
        renderAudit();
      });
      byId('copy-scenario').addEventListener('click', onCopyScenario);
      if (win && win.addEventListener) {
        let rz = null;
        win.addEventListener('resize', function () {
          if (rz) win.clearTimeout(rz);
          rz = win.setTimeout(function () { drawChart(E.computeSubscriptionSavings(state.calc)); }, 150);
        });
      }

      // vault
      state.store = LocalStore(storage, today);
      setMode();
      byId('q').addEventListener('input', onSearchInput);
      byId('hl-save').addEventListener('click', onHighlightSave);
      byId('add-form').addEventListener('submit', onAdd);
      byId('import-btn').addEventListener('click', onImport);
      byId('export-html').addEventListener('click', onExportHtml);
      byId('export-json').addEventListener('click', onExportJson);
      byId('reset-demo').addEventListener('click', onReset);
      byId('srv-connect').addEventListener('click', function () { connect(byId('srv-url').value, byId('srv-token').value, false); });
      byId('srv-disconnect').addEventListener('click', disconnect);
      byId('storage-pill').addEventListener('click', function () {
        const target = byId('srv-url');
        if (target.closest) { const dr = target.closest('details'); if (dr) dr.open = true; }
        if (target.focus) target.focus();
      });
      doc.addEventListener('click', onClick);

      // studio
      ['st-port', 'st-data', 'st-cron', 'st-backup-path', 'st-domain', 'st-token', 'st-tz'].forEach(function (id) { byId(id).addEventListener('input', renderStudio); });
      byId('st-proxy').addEventListener('change', renderStudio);
      byId('st-copy').addEventListener('click', onStudioCopy);
      byId('st-download').addEventListener('click', onStudioDownload);
      byId('st-gen-token').addEventListener('click', onGenToken);
      byId('st-tabs').addEventListener('keydown', onTabKey);
      renderStudio();

      const boot = refreshVault(false);
      return boot.then(function () { return autoConnect(); });
    }

    async function autoConnect() {
      if (!fetchFn) return;
      try {
        if (o.sessionStorage) {
          const saved = JSON.parse(o.sessionStorage.getItem(SERVER_KEY) || 'null');
          if (saved && saved.url) {
            byId('srv-url').value = saved.url;
            byId('srv-token').value = saved.token || '';
            if (await connect(saved.url, saved.token, true)) return;
          }
        }
        const proto = win && win.location ? win.location.protocol : '';
        if (proto === 'http:' || proto === 'https:') {
          const res = await fetchFn('health', { method: 'GET' });
          const ct = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
          if (res.ok && ct.indexOf('json') >= 0) {
            const data = await res.json();
            if (data && data.ok && !data.auth) await connect(new win.URL('.', win.location.href).href, '', true);
            else if (data && data.ok && data.auth) say('srv-status', 'This page is served by a vault that needs a token. Open "Connect your server" and paste it.');
          }
        }
      } catch (e) { /* no same-origin server, stay on browser storage */ }
    }

    return { state: state, init: init, renderAudit: renderAudit, renderStudio: renderStudio, refreshVault: refreshVault, connect: connect, disconnect: disconnect, handlers: { onClick: onClick, onSubEvent: onSubEvent, onAdd: onAdd, onRate: onRate, onSearchInput: onSearchInput, onGenToken: onGenToken, onTabKey: onTabKey } };
  }

  function initReveal(doc, win) {
    const targets = doc.querySelectorAll('.section-head, .panel, .tiles, .chart-card, .mode, .ledger, .vault-forms');
    const reduce = win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in win)) return;
    const io = new win.IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.04 });
    Array.prototype.forEach.call(targets, function (t) {
      const r = t.getBoundingClientRect();
      t.classList.add('reveal');
      if (r.top < win.innerHeight) t.classList.add('is-in'); else io.observe(t);
    });
    win.setTimeout(function () { Array.prototype.forEach.call(targets, function (t) { t.classList.add('is-in'); }); }, 6000);
  }

  function mount(win) {
    const doc = win.document;
    let storage = null;
    let session = null;
    try { storage = win.localStorage; } catch (e) { storage = null; }
    try { session = win.sessionStorage; } catch (e) { session = null; }
    const memory = {};
    if (!storage) storage = { getItem: function (k) { return memory[k] || null; }, setItem: function (k, v) { memory[k] = String(v); }, removeItem: function (k) { delete memory[k]; } };
    const app = createApp(doc, win, { storage: storage, sessionStorage: session });
    initReveal(doc, win);
    app.init();
    return app;
  }

  const api = {
    money: money, money0: money0, niceMax: niceMax,
    renderSubRows: renderSubRows, renderLedgerRows: renderLedgerRows, ledgerFoot: ledgerFoot, renderResults: renderResults,
    renderChart: renderChart, chartReadout: chartReadout, renderTagChips: renderTagChips, renderResultsList: renderResultsList,
    renderBody: renderBody, renderReader: renderReader, renderHighlights: renderHighlights, renderReview: renderReview,
    renderCode: renderCode, studioFiles: studioFiles, renderTabs: renderTabs, describeCron: describeCron, bookmarklet: bookmarklet,
    cueFor: cueFor, LocalStore: LocalStore, ServerStore: ServerStore, createApp: createApp, mount: mount
  };

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    const boot = function () { api.app = mount(window); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }

  return api;
}));
