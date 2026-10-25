#!/usr/bin/env python3
"""SubZero Vault server.

One file, standard library only (Python 3.9 or newer). It stores articles, highlights and bookmarks in
SQLite, ranks searches with Okapi BM25, schedules highlight reviews with SM-2, extracts readable text from
pasted HTML, imports and exports Netscape bookmark files, and serves the static web app.

The maths mirrors engine.js. tests/fixtures/parity.json holds numbers both sides must agree on, and
`python3 server/app.py --selftest` checks them, then starts a real server and drives every endpoint.
"""
import argparse
import hmac
import json
import math
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "1.0.0"
MAX_BODY = 8 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Text and BM25
# ---------------------------------------------------------------------------

STOPWORDS = set((
    "a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our "
    "she so than that the their them then there these they this to too us was we were what when which who will "
    "with you your do does did been being am would could should can just also about over under up out"
).split(" "))

BM25_K1 = 1.5
BM25_B = 0.75
TITLE_WEIGHT = 3
TAG_WEIGHT = 2

_TOKEN_RE = re.compile(r"[^\W_]+")


def tokenize(text, keep_stopwords=False):
    norm = ("" if text is None else str(text)).lower().replace("'", "").replace("\u2019", "")
    raw = _TOKEN_RE.findall(norm)
    return raw if keep_stopwords else [t for t in raw if t not in STOPWORDS]


def word_count(text):
    return len(_TOKEN_RE.findall(text or ""))


def escape_html(s):
    return (str("" if s is None else s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def _weighted_tokens(doc):
    title = tokenize(doc.get("title", ""))
    tags = tokenize(" ".join(doc.get("tags") or []))
    body = tokenize(doc.get("body", ""))
    return title * TITLE_WEIGHT + tags * TAG_WEIGHT + body


def build_index(docs):
    postings = {}
    lengths = {}
    total = 0
    for doc in docs:
        toks = _weighted_tokens(doc)
        lengths[doc["id"]] = len(toks)
        total += len(toks)
        tf = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        for term, count in tf.items():
            postings.setdefault(term, {})[doc["id"]] = count
    n = len(lengths)
    return {"N": n, "avgdl": (total / n) if n else 0, "lengths": lengths, "postings": postings}


def bm25_idf(n_docs, n):
    return math.log(1 + (n_docs - n + 0.5) / (n + 0.5))


def bm25_search(index, query, limit=None, k1=BM25_K1, b=BM25_B, require_all=False):
    terms = list(dict.fromkeys(tokenize(query)))
    if not terms or not index["N"]:
        return []
    scores = {}
    matched = {}
    for term in terms:
        plist = index["postings"].get(term)
        if not plist:
            continue
        idf = bm25_idf(index["N"], len(plist))
        for doc_id, tf in plist.items():
            dl = index["lengths"][doc_id]
            denom = tf + k1 * (1 - b + b * dl / index["avgdl"])
            scores[doc_id] = scores.get(doc_id, 0) + idf * tf * (k1 + 1) / denom
            matched.setdefault(doc_id, []).append(term)
    rows = []
    for doc_id, score in scores.items():
        if require_all and len(matched[doc_id]) != len(terms):
            continue
        rows.append({"id": doc_id, "score": score, "terms": matched[doc_id]})
    rows.sort(key=lambda r: (-r["score"], str(r["id"])))
    return rows[:limit] if limit else rows


def make_snippet(text, terms, width=180):
    src = re.sub(r"\s+", " ", text or "").strip()
    if not src:
        return ""
    lower = src.lower()
    first = -1
    for t in terms or []:
        at = lower.find(str(t).lower())
        if at >= 0 and (first < 0 or at < first):
            first = at
    start = 0 if first < 0 else max(0, first - width // 3)
    if start > 0:
        sp = src.find(" ", start)
        if 0 <= sp < start + 20:
            start = sp + 1
    end = min(len(src), start + width)
    if end < len(src):
        sp = src.rfind(" ", 0, end + 1)
        if sp > start + 20:
            end = sp
    html = escape_html(src[start:end])
    pats = [re.escape(escape_html(t)) for t in (terms or []) if t]
    if pats:
        rx = re.compile(r"(^|[^\w&#;])(" + "|".join(pats) + r")(?![^\W_])", re.I)
        html = rx.sub(lambda m: m.group(1) + "<mark>" + m.group(2) + "</mark>", html)
    return ("..." if start > 0 else "") + html + ("..." if end < len(src) else "")


# ---------------------------------------------------------------------------
# SM-2
# ---------------------------------------------------------------------------

def today_iso():
    return date.today().isoformat()


def add_days_iso(iso, days):
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


def schedule_sm2(card, quality, today=None):
    """One SM-2 step. Below quality 3 the card restarts and EF is left alone, as in the original text."""
    if isinstance(quality, bool) or not isinstance(quality, int) or quality < 0 or quality > 5:
        raise ValueError("quality must be an integer from 0 to 5")
    day = today or today_iso()
    base = card or {"repetitions": 0, "interval": 0, "ef": 2.5}
    n, interval, ef = base["repetitions"], base["interval"], base["ef"]
    if quality >= 3:
        if n == 0:
            interval = 1
        elif n == 1:
            interval = 6
        else:
            interval = int(math.floor(interval * ef + 0.5))
        n += 1
        d = 5 - quality
        ef = max(1.3, math.floor((ef + (0.1 - d * (0.08 + d * 0.02))) * 1e6 + 0.5) / 1e6)
    else:
        n = 0
        interval = 1
    return {"repetitions": n, "interval": interval, "ef": ef, "due": add_days_iso(day, interval), "lastQuality": quality}


# ---------------------------------------------------------------------------
# Subscription savings
# ---------------------------------------------------------------------------

CATALOG = [
    ("readwise", 9.99), ("raindrop", 3.99), ("rocketmoney", 6.00), ("notion", 10.00), ("linktree", 12.00),
    ("instapaper", None), ("googleone", None), ("icloud", None), ("onepassword", None), ("dropbox", None),
    ("evernote", None), ("todoist", None),
]
DEFAULT_ENABLED = ["readwise", "raindrop", "rocketmoney"]
_NUM_RE = re.compile(r"\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?")


def _round2(x):
    return math.floor(x * 100 + 0.5) / 100


def _num(v, fallback):
    if isinstance(v, bool):
        return fallback
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else fallback
    if isinstance(v, str):
        m = _NUM_RE.match(v)
        return float(m.group(0)) if m else fallback
    return fallback


def _clamp(v, lo, hi):
    return min(hi, max(lo, v))


def normalize_calc(inp):
    s = inp or {}
    known = set(c[0] for c in CATALOG)
    prices = {}
    sp = s.get("prices") or {}
    for cid, default in CATALOG:
        raw = sp[cid] if cid in sp else default
        prices[cid] = None if raw is None or raw == "" else max(0.0, _num(raw, 0.0))
    return {
        "enabled": [i for i in (s.get("enabled") if s.get("enabled") is not None else DEFAULT_ENABLED) if i in known],
        "prices": prices,
        "hardwareCost": max(0.0, _num(s.get("hardwareCost"), 120.0)),
        "watts": max(0.0, _num(s.get("watts"), 6.0)),
        "kwhPrice": max(0.0, _num(s.get("kwhPrice"), 0.17)),
        "extraAnnual": max(0.0, _num(s.get("extraAnnual"), 0.0)),
        "saasGrowth": _clamp(_num(s.get("saasGrowth"), 0.0), 0.0, 1.0),
        "powerGrowth": _clamp(_num(s.get("powerGrowth"), 0.0), 0.0, 1.0),
        "reinvest": _clamp(_num(s.get("reinvest"), 0.0), 0.0, 1.0),
        "years": int(_clamp(math.floor(_num(s.get("years"), 5.0) + 0.5), 1, 10)),
    }


def compute_savings(inp):
    c = normalize_calc(inp)
    on = set(c["enabled"])
    saas_monthly = 0.0
    for cid, _ in CATALOG:
        monthly = c["prices"][cid] if (cid in on and c["prices"][cid]) else 0
        saas_monthly += _round2(monthly)
    saas_annual = saas_monthly * 12
    power_kwh_year = c["watts"] / 1000 * 24 * 365
    power_annual = power_kwh_year * c["kwhPrice"]
    own_annual = power_annual + c["extraAnnual"]
    net_annual = saas_annual - own_annual

    compounded = 0.0
    plain = 0.0
    for y in range(c["years"]):
        saas_y = saas_annual * math.pow(1 + c["saasGrowth"], y)
        own_y = power_annual * math.pow(1 + c["powerGrowth"], y) + c["extraAnnual"]
        net = saas_y - own_y
        plain += net
        compounded += net * math.pow(1 + c["reinvest"], c["years"] - 1 - y)

    daily_net = net_annual / 365
    if c["hardwareCost"] <= 0:
        break_even = 0
    else:
        break_even = int(math.ceil(c["hardwareCost"] / daily_net)) if daily_net > 0 else None

    months = c["years"] * 12
    cs, co = 0.0, c["hardwareCost"]
    saas_series, own_series = [0.0], [co]
    for m in range(1, months + 1):
        yi = (m - 1) // 12
        cs += saas_monthly * math.pow(1 + c["saasGrowth"], yi)
        co += power_annual / 12 * math.pow(1 + c["powerGrowth"], yi) + c["extraAnnual"] / 12
        saas_series.append(cs)
        own_series.append(co)
    cross = None
    for m in range(months + 1):
        if saas_series[m] >= own_series[m]:
            if m == 0:
                cross = 0
            else:
                gap_prev = own_series[m - 1] - saas_series[m - 1]
                gap_now = own_series[m] - saas_series[m]
                cross = (m - 1) + gap_prev / (gap_prev - gap_now)
            break

    return {
        "saasMonthly": _round2(saas_monthly),
        "saasAnnual": _round2(saas_annual),
        "powerKwhYear": _round2(power_kwh_year),
        "powerAnnual": _round2(power_annual),
        "ownAnnual": _round2(own_annual),
        "netAnnual": _round2(net_annual),
        "hardwareCost": _round2(c["hardwareCost"]),
        "years": c["years"],
        "fiveYearPlain": _round2(plain - c["hardwareCost"]),
        "fiveYearCompounded": _round2(compounded - c["hardwareCost"]),
        "breakEvenDay": break_even,
        "crossMonth": None if cross is None else math.floor(cross * 1000 + 0.5) / 1000,
    }


# ---------------------------------------------------------------------------
# Readability style extraction
# ---------------------------------------------------------------------------

NAMED_ENTITIES = {
    "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " ", "hellip": "...", "rsquo": "\u2019",
    "lsquo": "\u2018", "ldquo": "\u201c", "rdquo": "\u201d", "copy": "\u00a9", "reg": "\u00ae", "trade": "\u2122",
    "middot": "\u00b7", "bull": "\u2022", "laquo": "\u00ab", "raquo": "\u00bb", "times": "\u00d7",
    "mdash": "\u2014", "ndash": "\u2013",
}
_ENTITY_RE = re.compile(r"&(#x[0-9a-f]+|#[0-9]+|[a-z]+);", re.I)


def decode_entities(s):
    def sub(m):
        body = m.group(1)
        if body[0] == "#":
            try:
                code = int(body[2:], 16) if body[1].lower() == "x" else int(body[1:], 10)
                if code < 1 or code > 0x10FFFF:
                    return m.group(0)
                return chr(code)
            except (ValueError, OverflowError):
                return m.group(0)
        return NAMED_ENTITIES.get(body.lower(), m.group(0))
    return _ENTITY_RE.sub(sub, "" if s is None else str(s))


VOID_TAGS = set("area base br col embed hr img input link meta param source track wbr".split())
DROP_TAGS = set("nav aside footer header form dialog menu".split())
BLOCK_TAGS = set("p h1 h2 h3 h4 h5 h6 li blockquote pre".split())
MAX_DEPTH = 120
NOISE_RE = re.compile(r"(^|[\s_-])(comment|comments|sidebar|share|sharing|social|promo|advert|ad|ads|cookie|menu|related|subscribe|newsletter|breadcrumb|pagination|popup|modal)([\s_-]|$)", re.I)
ATTR_RE = re.compile(r"""([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""")
TAG_RE = re.compile(r"""<(/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)""")
DROP_BLOCK_RE = re.compile(r"<(script|style|noscript|svg|template|iframe|canvas|object|select|button)\b[\s\S]*?</\1\s*>", re.I)


def parse_attrs(s):
    out = {}
    for m in ATTR_RE.finditer(s):
        val = m.group(2) if m.group(2) is not None else (m.group(3) if m.group(3) is not None else m.group(4))
        out[m.group(1).lower()] = val
    return out


class Node(object):
    __slots__ = ("tag", "attrs", "children", "parent", "score", "drop", "text", "depth")

    def __init__(self, tag, parent=None, attrs=None, text=""):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []
        self.parent = parent
        self.score = 0.0
        self.drop = False
        self.text = text
        self.depth = (parent.depth + 1) if parent else 0


def parse_html_tree(html):
    src = re.sub(r"<!--[\s\S]*?-->", "", "" if html is None else str(html))
    src = DROP_BLOCK_RE.sub(" ", src)
    root = Node("#root")
    cur = root
    for m in TAG_RE.finditer(src):
        if m.group(4) is not None:
            cur.children.append(Node("#text", cur, text=m.group(4)))
            continue
        closing = m.group(1) == "/"
        tag = m.group(2).lower()
        if closing:
            n = cur
            while n is not None and n.tag != tag:
                n = n.parent
            if n is not None and n.parent is not None:
                cur = n.parent
            continue
        if tag == "p" and cur.tag == "p":
            cur = cur.parent
        if tag == "li" and cur.tag == "li":
            cur = cur.parent
        if (tag in ("div", "ul", "ol", "blockquote", "pre") or re.match(r"^h[1-6]$", tag)) and cur.tag == "p":
            cur = cur.parent
        attrs = parse_attrs(m.group(3))
        node = Node(tag, cur, attrs)
        node.drop = tag in DROP_TAGS or bool(NOISE_RE.search((attrs.get("class") or "") + " " + (attrs.get("id") or "")))
        cur.children.append(node)
        if tag not in VOID_TAGS and not re.search(r"/\s*$", m.group(3)) and node.depth < MAX_DEPTH:
            cur = node
    return root


def _node_text(node, pre):
    if node.tag == "#text":
        return node.text if pre else re.sub(r"\s+", " ", node.text)
    if node.drop:
        return ""
    if node.tag == "br":
        return "\n"
    in_pre = pre or node.tag == "pre"
    return "".join(_node_text(c, in_pre) for c in node.children)


def _clean_text(node):
    raw = decode_entities(_node_text(node, node.tag == "pre"))
    if node.tag == "pre":
        return re.sub(r"\s+$", "", re.sub(r"^\n+", "", raw))
    return re.sub(r"\s+", " ", raw).strip()


def _link_text_len(node):
    if node.tag == "#text" or node.drop:
        return 0
    if node.tag == "a":
        return len(_clean_text(node))
    return sum(_link_text_len(c) for c in node.children)


def _link_density(node):
    n = len(_clean_text(node))
    return (_link_text_len(node) / n) if n else 0


def _walk(node, fn):
    fn(node)
    for c in node.children:
        _walk(c, fn)


def _inside_dropped(node):
    n = node
    while n is not None:
        if n.drop:
            return True
        n = n.parent
    return False


def _has_block_descendant(node):
    for c in node.children:
        if c.tag == "#text":
            continue
        if c.tag in BLOCK_TAGS or _has_block_descendant(c):
            return True
    return False


def _find_meta(html, name):
    for m in re.finditer(r"""<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>""", html, re.I):
        a = parse_attrs(m.group(1))
        if (a.get("property") or a.get("name") or "").lower() == name and a.get("content"):
            return decode_entities(a["content"]).strip()
    return ""


def extract_readable(html):
    source = "" if html is None else str(html)
    tree = parse_html_tree(source)
    title_tag = re.search(r"<title\b[^>]*>([\s\S]*?)</title>", source, re.I)
    title = _find_meta(source, "og:title") or (re.sub(r"\s+", " ", decode_entities(title_tag.group(1))).strip() if title_tag else "")
    holder = {"h1": None, "best": None, "score": 0.0}

    def find_h1(n):
        if holder["h1"] is None and n.tag == "h1" and not _inside_dropped(n):
            holder["h1"] = n
    _walk(tree, find_h1)
    h1 = holder["h1"]
    if not title and h1:
        title = _clean_text(h1)

    def score(n):
        if n.tag in ("p", "pre", "blockquote") and not _inside_dropped(n):
            text = _clean_text(n)
            if len(text) < 25:
                return
            points = 1 + text.count(",") + min(len(text) // 100, 3)
            anc, level = n.parent, 1
            while anc is not None and anc.tag != "#root":
                anc.score += points / (1 if level == 1 else 2 if level == 2 else level * 3)
                anc = anc.parent
                level += 1
    _walk(tree, score)

    def pick(n):
        if n.tag in ("#text", "#root") or n.drop or not n.score or _inside_dropped(n):
            return
        bonus = 5 if n.tag in ("article", "main") else 2 if n.tag in ("div", "section") else 0
        adj = (n.score + bonus) * (1 - _link_density(n))
        if adj > holder["score"]:
            holder["best"], holder["score"] = n, adj
    _walk(tree, pick)
    best = holder["best"]
    if best is None:
        def find_body(n):
            if holder["best"] is None and n.tag == "body":
                holder["best"] = n
        _walk(tree, find_body)
        best = holder["best"] or tree

    blocks = []

    def collect(n):
        if n.tag == "#text" or n.drop:
            return
        if n.tag in BLOCK_TAGS and not _has_block_descendant(n):
            text = _clean_text(n)
            if not text:
                return
            if n is h1 and text == title:
                return
            if _link_density(n) > 0.5 and len(text) < 100:
                return
            kind = "li" if n.tag == "li" else "quote" if n.tag == "blockquote" else "pre" if n.tag == "pre" else "h" if re.match(r"^h[1-6]$", n.tag) else "p"
            blocks.append({"type": kind, "text": text})
            return
        for c in n.children:
            collect(c)
    collect(best)

    def render(b):
        if b["type"] == "h":
            return "## " + b["text"]
        if b["type"] == "li":
            return "- " + b["text"]
        if b["type"] == "quote":
            return "> " + b["text"]
        return b["text"]
    text = "\n\n".join(render(b) for b in blocks)
    return {"title": title, "text": text, "blocks": blocks, "wordCount": word_count(text)}


# ---------------------------------------------------------------------------
# Netscape bookmark files
# ---------------------------------------------------------------------------

_NS_TAG_RE = re.compile(r"""<(/?)(dl|h3|a|dd)\b((?:[^>"']|"[^"]*"|'[^']*')*)>""", re.I)


def _strip_tags(s):
    return re.sub(r"<[^>]*>", "", s)


def _epoch_to_iso(sec):
    try:
        n = int(re.match(r"\s*([-+]?\d+)", str(sec)).group(1))
        if n <= 0:
            return ""
        return datetime.fromtimestamp(n, timezone.utc).strftime("%Y-%m-%d")
    except (AttributeError, ValueError, OverflowError, OSError):
        return ""


def _iso_to_epoch(iso):
    try:
        d = datetime.strptime(str(iso or "")[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return int(d.timestamp())
    except ValueError:
        return 0


def parse_netscape(html):
    src = "" if html is None else str(html)
    items, stack = [], []
    pending, last = None, None
    pos = 0
    while True:
        m = _NS_TAG_RE.search(src, pos)
        if not m:
            break
        pos = m.end()
        closing = m.group(1) == "/"
        tag = m.group(2).lower()
        if tag == "dl":
            if closing:
                if stack:
                    stack.pop()
            else:
                stack.append(pending)
                pending = None
        elif tag == "h3" and not closing:
            end = re.compile(r"</h3>", re.I).search(src, pos)
            stop = end.start() if end else len(src)
            pending = decode_entities(_strip_tags(src[pos:stop])).strip()
            pos = end.end() if end else stop
        elif tag == "a" and not closing:
            end = re.compile(r"</a>", re.I).search(src, pos)
            stop = end.start() if end else len(src)
            attrs = parse_attrs(m.group(3))
            text = re.sub(r"\s+", " ", decode_entities(_strip_tags(src[pos:stop]))).strip()
            pos = end.end() if end else stop
            url = decode_entities(attrs.get("href") or "").strip()
            if re.match(r"^https?://", url, re.I):
                tags = [t.strip() for t in decode_entities(attrs["tags"]).split(",")] if attrs.get("tags") else []
                last = {
                    "title": text or url,
                    "url": url,
                    "addDate": _epoch_to_iso(attrs.get("add_date")),
                    "tags": [t for t in tags if t],
                    "folder": "/".join(f for f in stack if f),
                    "note": "",
                }
                items.append(last)
            else:
                last = None
        elif tag == "dd" and not closing and last is not None:
            nxt = src.find("<", pos)
            stop = len(src) if nxt < 0 else nxt
            last["note"] = re.sub(r"\s+", " ", decode_entities(src[pos:stop])).strip()
    return items


def export_netscape(items):
    by_folder = {}
    for it in items or []:
        by_folder.setdefault(it.get("folder") or "", []).append(it)

    def line(it, pad):
        attrs = ['HREF="' + escape_html(it["url"]) + '"']
        when = _iso_to_epoch(it.get("addDate") or it.get("savedAt"))
        if when:
            attrs.append('ADD_DATE="%d"' % when)
        if it.get("tags"):
            attrs.append('TAGS="' + escape_html(",".join(it["tags"])) + '"')
        out = pad + "<DT><A " + " ".join(attrs) + ">" + escape_html(it.get("title") or it["url"]) + "</A>\n"
        if it.get("note"):
            out += pad + "<DD>" + escape_html(it["note"]) + "\n"
        return out

    out = ("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n"
           "<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n"
           '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n'
           "<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n")
    for it in by_folder.get("", []):
        out += line(it, "    ")
    for folder, lst in by_folder.items():
        if not folder:
            continue
        out += "    <DT><H3>" + escape_html(folder) + "</H3>\n    <DL><p>\n"
        for it in lst:
            out += line(it, "        ")
        out += "    </DL><p>\n"
    return out + "</DL><p>\n"


# ---------------------------------------------------------------------------
# Cron
# ---------------------------------------------------------------------------

_CRON_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]


def parse_cron(expr):
    parts = str(expr or "").split()
    if len(parts) != 5:
        raise ValueError("a cron schedule needs exactly 5 fields")
    fields = []
    for i, part in enumerate(parts):
        lo, hi = _CRON_RANGES[i]
        values = set()
        for item in part.split(","):
            m = re.match(r"^(\*|(\d+)(?:-(\d+))?)(?:/(\d+))?$", item)
            if not m:
                raise ValueError("bad cron field %r" % part)
            step = int(m.group(4)) if m.group(4) else 1
            if step < 1:
                raise ValueError("a step must be 1 or more")
            if m.group(1) == "*":
                a, z = lo, hi
            else:
                a = int(m.group(2))
                z = int(m.group(3)) if m.group(3) else (hi if m.group(4) else a)
                if a < lo or z > hi or a > z:
                    raise ValueError("cron value out of range in %r" % part)
            values.update(range(a, z + 1, step))
        fields.append(values)
    fields[4] = set(0 if v == 7 else v for v in fields[4])
    return {"fields": fields, "dom_star": parts[2].startswith("*"), "dow_star": parts[4].startswith("*")}


def cron_matches(spec, dt):
    minute, hour, dom, month, dow = spec["fields"]
    cron_dow = (dt.weekday() + 1) % 7
    if dt.minute not in minute or dt.hour not in hour or dt.month not in month:
        return False
    dom_ok, dow_ok = dt.day in dom, cron_dow in dow
    if spec["dom_star"] or spec["dow_star"]:
        return dom_ok and dow_ok
    return dom_ok or dow_ok


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  folder TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  saved_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url ON articles(url) WHERE url <> '';
CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  repetitions INTEGER NOT NULL DEFAULT 0,
  interval_days INTEGER NOT NULL DEFAULT 0,
  ef REAL NOT NULL DEFAULT 2.5,
  due TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_due ON highlights(due);
"""


class ApiError(Exception):
    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status
        self.message = message


def clean_tags(tags):
    out = []
    for t in tags or []:
        s = str(t).strip().lower()[:40]
        if s and s not in out:
            out.append(s)
    return out[:20]


class Store(object):
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self._index = None
        self._index_version = 0
        if path != ":memory:":
            parent = os.path.dirname(os.path.abspath(path))
            os.makedirs(parent, exist_ok=True)
        with closing(self._conn()) as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(SCHEMA)
            c.commit()

    def _conn(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        return c

    def _bump(self):
        self._index_version += 1

    @staticmethod
    def _article(row, with_body):
        d = {
            "id": row["id"], "url": row["url"], "title": row["title"], "tags": json.loads(row["tags"]),
            "folder": row["folder"], "note": row["note"], "savedAt": row["saved_at"],
            "wordCount": word_count(row["body"]),
        }
        if with_body:
            d["body"] = row["body"]
        else:
            d["excerpt"] = re.sub(r"\s+", " ", re.sub(r"(?m)^(## |- |> )", "", row["body"] or ""))[:150]
        return d

    @staticmethod
    def _highlight(row):
        return {
            "id": row["id"], "articleId": row["article_id"], "text": row["text"], "note": row["note"],
            "created": row["created"], "repetitions": row["repetitions"], "interval": row["interval_days"],
            "ef": row["ef"], "due": row["due"],
        }

    def add_article(self, title, body, url="", tags=None, folder="", note="", saved_at=None):
        title = (title or url or "").strip()
        if not title:
            raise ApiError(400, "an article needs a title or a url")
        keep_tags = tags is None
        tags = clean_tags(tags)
        saved_at = saved_at or today_iso()
        with self.lock, closing(self._conn()) as c:
            created = True
            row = c.execute("SELECT id FROM articles WHERE url = ? AND url <> ''", (url,)).fetchone() if url else None
            if row:
                created = False
                art_id = row["id"]
                c.execute("UPDATE articles SET title=?, body=?, folder=?, note=? WHERE id=?", (title, body, folder, note, art_id))
                if not keep_tags:
                    c.execute("UPDATE articles SET tags=? WHERE id=?", (json.dumps(tags), art_id))
            else:
                cur = c.execute("INSERT INTO articles (url, title, body, tags, folder, note, saved_at) VALUES (?,?,?,?,?,?,?)",
                                (url, title, body, json.dumps(tags), folder, note, saved_at))
                art_id = cur.lastrowid
            c.commit()
            self._bump()
            return self._article(c.execute("SELECT * FROM articles WHERE id=?", (art_id,)).fetchone(), True), created

    def list_articles(self, tag=None):
        with closing(self._conn()) as c:
            rows = c.execute("SELECT * FROM articles ORDER BY saved_at DESC, id DESC").fetchall()
            counts = dict((r["article_id"], r["n"]) for r in c.execute("SELECT article_id, COUNT(*) AS n FROM highlights GROUP BY article_id"))
        out = []
        for r in rows:
            a = self._article(r, False)
            if tag and tag.lower() not in a["tags"]:
                continue
            a["highlightCount"] = counts.get(a["id"], 0)
            out.append(a)
        return out

    def get_article(self, art_id):
        with closing(self._conn()) as c:
            row = c.execute("SELECT * FROM articles WHERE id=?", (art_id,)).fetchone()
        if not row:
            raise ApiError(404, "no such article")
        return self._article(row, True)

    def delete_article(self, art_id):
        with self.lock, closing(self._conn()) as c:
            n = c.execute("DELETE FROM articles WHERE id=?", (art_id,)).rowcount
            c.commit()
            self._bump()
        if not n:
            raise ApiError(404, "no such article")

    def add_highlight(self, art_id, text, note=""):
        text = (text or "").strip()
        if not text:
            raise ApiError(400, "a highlight needs text")
        if len(text) > 4000:
            raise ApiError(400, "highlight is too long")
        self.get_article(art_id)
        with self.lock, closing(self._conn()) as c:
            day = today_iso()
            cur = c.execute("INSERT INTO highlights (article_id, text, note, created, due) VALUES (?,?,?,?,?)",
                            (art_id, text, (note or "").strip()[:1000], day, day))
            c.commit()
            return self._highlight(c.execute("SELECT * FROM highlights WHERE id=?", (cur.lastrowid,)).fetchone())

    def list_highlights(self, art_id=None):
        with closing(self._conn()) as c:
            if art_id is None:
                rows = c.execute("SELECT * FROM highlights ORDER BY id").fetchall()
            else:
                rows = c.execute("SELECT * FROM highlights WHERE article_id=? ORDER BY id", (art_id,)).fetchall()
        return [self._highlight(r) for r in rows]

    def delete_highlight(self, hid):
        with self.lock, closing(self._conn()) as c:
            n = c.execute("DELETE FROM highlights WHERE id=?", (hid,)).rowcount
            c.commit()
        if not n:
            raise ApiError(404, "no such highlight")

    def due(self, today=None):
        day = today or today_iso()
        with closing(self._conn()) as c:
            rows = c.execute("SELECT h.*, a.title AS article_title FROM highlights h JOIN articles a ON a.id = h.article_id "
                             "WHERE h.due <= ? ORDER BY h.due, h.id", (day,)).fetchall()
        out = []
        for r in rows:
            h = self._highlight(r)
            h["articleTitle"] = r["article_title"]
            out.append(h)
        return out

    def review(self, hid, quality, today=None):
        with self.lock, closing(self._conn()) as c:
            row = c.execute("SELECT * FROM highlights WHERE id=?", (hid,)).fetchone()
            if not row:
                raise ApiError(404, "no such highlight")
            try:
                nxt = schedule_sm2({"repetitions": row["repetitions"], "interval": row["interval_days"], "ef": row["ef"]},
                                   quality, today)
            except ValueError as e:
                raise ApiError(400, str(e))
            c.execute("UPDATE highlights SET repetitions=?, interval_days=?, ef=?, due=? WHERE id=?",
                      (nxt["repetitions"], nxt["interval"], nxt["ef"], nxt["due"], hid))
            c.commit()
            return self._highlight(c.execute("SELECT * FROM highlights WHERE id=?", (hid,)).fetchone())

    def _search_index(self):
        with self.lock:
            if self._index is None or self._index[0] != self._index_version:
                with closing(self._conn()) as c:
                    rows = c.execute("SELECT id, title, body, tags, url FROM articles").fetchall()
                docs = [{"id": r["id"], "title": r["title"], "body": r["body"] or r["url"], "tags": json.loads(r["tags"])} for r in rows]
                self._index = (self._index_version, build_index(docs), dict((r["id"], r) for r in rows))
            return self._index

    def search(self, query, tag=None, limit=20):
        _, index, rows = self._search_index()
        hits = bm25_search(index, query)
        out = []
        for h in hits:
            r = rows[h["id"]]
            tags = json.loads(r["tags"])
            if tag and tag.lower() not in tags:
                continue
            out.append({
                "id": h["id"], "score": h["score"], "terms": h["terms"], "title": r["title"], "url": r["url"], "tags": tags,
                "snippet": make_snippet(re.sub(r"(?m)^(## |- |> )", "", r["body"] or r["url"]), h["terms"]),
            })
            if len(out) >= limit:
                break
        return out

    def import_bookmarks(self, html):
        added = skipped = 0
        for it in parse_netscape(html):
            if self._has_url(it["url"]):
                skipped += 1
                continue
            self.add_article(it["title"], it["note"], it["url"], it["tags"], it["folder"], it["note"], it["addDate"] or None)
            added += 1
        return {"added": added, "skipped": skipped}

    def _has_url(self, url):
        with closing(self._conn()) as c:
            return c.execute("SELECT 1 FROM articles WHERE url=?", (url,)).fetchone() is not None

    def export_items(self):
        with closing(self._conn()) as c:
            rows = c.execute("SELECT * FROM articles ORDER BY id").fetchall()
        return [{"title": r["title"], "url": r["url"], "tags": json.loads(r["tags"]), "folder": r["folder"],
                 "note": r["note"], "addDate": r["saved_at"], "body": r["body"]} for r in rows if r["url"]]

    def export_json(self):
        with closing(self._conn()) as c:
            articles = [dict(r) for r in c.execute("SELECT * FROM articles ORDER BY id")]
            highlights = [dict(r) for r in c.execute("SELECT * FROM highlights ORDER BY id")]
        return {"version": 1, "articles": articles, "highlights": highlights}

    def backup(self, directory, keep=14):
        os.makedirs(directory, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(directory, "vault-%s.db" % stamp)
        with closing(self._conn()) as src, closing(sqlite3.connect(dest)) as dst:
            src.backup(dst)
        files = sorted(f for f in os.listdir(directory) if re.match(r"^vault-\d{8}-\d{6}\.db$", f))
        for old in files[:-keep] if keep > 0 else []:
            os.remove(os.path.join(directory, old))
        return dest


def backup_loop(store, directory, cron_expr, stop=None):
    spec = parse_cron(cron_expr)
    last = None
    while not (stop and stop.is_set()):
        now = datetime.now().replace(second=0, microsecond=0)
        if now != last and cron_matches(spec, now):
            last = now
            try:
                print("backup written to %s" % store.backup(directory, int(os.environ.get("VAULT_BACKUP_KEEP", "14"))), flush=True)
            except Exception as e:  # keep the loop alive; the next tick tries again
                print("backup failed: %s" % e, file=sys.stderr, flush=True)
        time.sleep(max(1, 60 - datetime.now().second))


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

STATIC_RE = re.compile(r"^/(index\.html|styles\.css|engine\.js|app\.js|samples\.js|favicon\.svg|fonts/[\w.-]+\.woff2|img/[\w.-]+\.(png|svg|jpg|webp))$")
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}


class Config(object):
    def __init__(self, store, token="", origins=None, web_dir=None):
        self.store = store
        self.token = token or ""
        self.origins = set(o.strip().rstrip("/") for o in (origins or []) if o.strip())
        self.web_dir = os.path.realpath(web_dir or os.path.dirname(HERE))


def make_handler(cfg):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SubZeroVault/" + VERSION
        protocol_version = "HTTP/1.0"  # one request per connection, so an unread body can never poison the next request

        def log_message(self, fmt, *args):
            if os.environ.get("VAULT_QUIET") != "1":
                sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

        # -- helpers --------------------------------------------------------
        def _origin_state(self):
            origin = (self.headers.get("Origin") or "").rstrip("/")
            if not origin:
                return None, True
            host = self.headers.get("Host") or ""
            same = origin in ("http://" + host, "https://" + host)
            return origin, same or origin in cfg.origins or "*" in cfg.origins

        def _cors(self):
            origin, ok = self._origin_state()
            if origin and ok:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self._cors()
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status, obj):
            self._send(status, json.dumps(obj))

        def _error(self, status, message):
            self._json(status, {"error": message})

        def _read_json(self, allow_text=False):
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json" and not (allow_text and ctype == "text/plain"):
                raise ApiError(415, "send Content-Type: application/json")
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                raise ApiError(411, "Content-Length is required")
            if length < 0 or length > MAX_BODY:
                raise ApiError(413, "request body is too large")
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode("utf-8") or "null")
            except (ValueError, UnicodeDecodeError):
                raise ApiError(400, "body is not valid JSON")
            if not isinstance(data, dict):
                raise ApiError(400, "body must be a JSON object")
            return data

        def _authorized(self, query):
            if not cfg.token:
                return True
            header = self.headers.get("Authorization") or ""
            given = header[7:] if header.lower().startswith("bearer ") else ""
            return hmac.compare_digest(given.encode(), cfg.token.encode())

        # -- verbs ----------------------------------------------------------
        def do_OPTIONS(self):
            origin, ok = self._origin_state()
            if not (origin and ok):
                return self._send(204, b"")
            extra = {
                "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Max-Age": "600",
            }
            if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
                extra["Access-Control-Allow-Private-Network"] = "true"
            self.send_response(204)
            self._cors()
            for k, v in extra.items():
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_HEAD(self):
            self._dispatch("GET")

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def _dispatch(self, method):
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            try:
                if path == "/health":
                    return self._json(200, {"ok": True, "version": VERSION, "auth": bool(cfg.token)})
                if path.startswith("/api/"):
                    return self._api(method, path, query)
                if method == "GET":
                    return self._static(path)
                raise ApiError(405, "method not allowed")
            except ApiError as e:
                self._error(e.status, e.message)
            except Exception as e:  # last resort so one bad request never kills the thread
                sys.stderr.write("internal error: %r\n" % (e,))
                self._error(500, "internal error")

        def _static(self, path):
            if path == "/":
                path = "/index.html"
            if not STATIC_RE.match(path):
                raise ApiError(404, "not found")
            full = os.path.realpath(os.path.join(cfg.web_dir, path.lstrip("/")))
            if not full.startswith(cfg.web_dir + os.sep) or not os.path.isfile(full):
                raise ApiError(404, "not found")
            with open(full, "rb") as fh:
                data = fh.read()
            ext = os.path.splitext(full)[1]
            if path == "/index.html":
                # Tells the page it is being served by a vault, so it can skip probing on static hosts.
                data = data.replace(b'<meta charset="utf-8">', b'<meta charset="utf-8">\n<meta name="subzero-server" content="same-origin">', 1)
            cache = "public, max-age=86400" if ext in (".woff2", ".png") else "no-cache"
            self._send(200, data, MIME.get(ext, "application/octet-stream"), {"Cache-Control": cache})

        def _api(self, method, path, query):
            origin, ok = self._origin_state()
            if path == "/api/clip":
                return self._clip(method, query)
            if origin and not ok:
                raise ApiError(403, "origin not allowed; add it to VAULT_ALLOWED_ORIGINS")
            if not self._authorized(query):
                return self._send(401, json.dumps({"error": "missing or wrong token"}), extra={"WWW-Authenticate": "Bearer"})
            store = cfg.store
            seg = [s for s in path.split("/") if s][1:]
            if seg == ["articles"]:
                if method == "GET":
                    return self._json(200, {"articles": store.list_articles((query.get("tag") or [None])[0])})
                if method == "POST":
                    return self._add_article(self._read_json())
            if len(seg) == 2 and seg[0] == "articles" and seg[1].isdigit():
                if method == "GET":
                    return self._json(200, store.get_article(int(seg[1])))
                if method == "DELETE":
                    store.delete_article(int(seg[1]))
                    return self._json(200, {"deleted": True})
            if len(seg) == 3 and seg[0] == "articles" and seg[1].isdigit() and seg[2] == "highlights" and method == "POST":
                body = self._read_json()
                return self._json(201, store.add_highlight(int(seg[1]), body.get("text"), body.get("note")))
            if seg == ["highlights"] and method == "GET":
                art = (query.get("article") or [""])[0]
                return self._json(200, {"highlights": store.list_highlights(int(art) if art.isdigit() else None)})
            if len(seg) == 2 and seg[0] == "highlights" and seg[1].isdigit() and method == "DELETE":
                store.delete_highlight(int(seg[1]))
                return self._json(200, {"deleted": True})
            if seg == ["review", "due"] and method == "GET":
                today = (query.get("today") or [None])[0]
                if today and not re.match(r"^\d{4}-\d{2}-\d{2}$", today):
                    raise ApiError(400, "today must be YYYY-MM-DD")
                return self._json(200, {"due": store.due(today)})
            if len(seg) == 2 and seg[0] == "review" and seg[1].isdigit() and method == "POST":
                body = self._read_json()
                today = body.get("today")
                if today is not None and not re.match(r"^\d{4}-\d{2}-\d{2}$", str(today)):
                    raise ApiError(400, "today must be YYYY-MM-DD")
                return self._json(200, store.review(int(seg[1]), body.get("quality"), today))
            if seg == ["search"] and method == "GET":
                q = (query.get("q") or [""])[0]
                try:
                    limit = max(1, min(100, int((query.get("limit") or ["20"])[0])))
                except ValueError:
                    raise ApiError(400, "limit must be a number")
                return self._json(200, {"query": q, "results": store.search(q, (query.get("tag") or [None])[0], limit)})
            if seg == ["import"] and method == "POST":
                body = self._read_json()
                return self._json(200, store.import_bookmarks(body.get("html") or ""))
            if seg == ["export"] and method == "GET":
                fmt = (query.get("format") or ["netscape"])[0]
                if fmt == "json":
                    return self._json(200, store.export_json())
                if fmt == "netscape":
                    return self._send(200, export_netscape(store.export_items()), "text/html; charset=utf-8",
                                      {"Content-Disposition": 'attachment; filename="subzero-bookmarks.html"'})
                raise ApiError(400, "format must be netscape or json")
            if seg == ["savings"] and method == "POST":
                return self._json(200, compute_savings(self._read_json()))
            raise ApiError(404, "no such endpoint")

        def _add_article(self, body):
            url = str(body.get("url") or "").strip()
            if url and not re.match(r"^https?://", url, re.I):
                raise ApiError(400, "url must start with http:// or https://")
            title = str(body.get("title") or "").strip()
            text = body.get("text")
            if body.get("html"):
                got = extract_readable(str(body["html"]))
                text = got["text"]
                title = title or got["title"]
            if not isinstance(text, str):
                text = ""
            art, created = cfg.store.add_article(title, text, url, body.get("tags") if isinstance(body.get("tags"), list) else None,
                                                 str(body.get("folder") or ""), str(body.get("note") or ""))
            self._json(201 if created else 200, art)

        def _clip(self, method, query):
            if method != "POST":
                raise ApiError(405, "use POST")
            if not cfg.token:
                raise ApiError(403, "the bookmarklet is off until VAULT_TOKEN is set")
            given = (query.get("token") or [""])[0]
            if not hmac.compare_digest(given.encode(), cfg.token.encode()):
                raise ApiError(401, "missing or wrong token")
            self._add_article(self._read_json(allow_text=True))

    return Handler


def serve(cfg, host, port):
    httpd = ThreadingHTTPServer((host, port), make_handler(cfg))
    httpd.daemon_threads = True
    return httpd


# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------

class Checks(object):
    def __init__(self):
        self.n = 0
        self.failed = []

    def ok(self, cond, label):
        self.n += 1
        if not cond:
            self.failed.append(label)
            print("  FAIL  " + label)

    def eq(self, got, want, label):
        self.ok(got == want, "%s (got %r, want %r)" % (label, got, want))

    def near(self, got, want, label, eps=1e-9):
        self.ok(got is not None and abs(got - want) <= eps, "%s (got %r, want %r)" % (label, got, want))


def _call(base, method, path, body=None, token=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            payload = r.read()
            return r.status, dict(r.headers), payload
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def selftest():
    ck = Checks()

    # Hand computed values
    c = schedule_sm2(None, 5, "2026-10-25")
    ck.eq((c["repetitions"], c["interval"], c["due"]), (1, 1, "2026-10-26"), "sm2 first perfect review")
    ck.near(c["ef"], 2.6, "sm2 ef after q5")
    c2 = schedule_sm2(c, 5, "2026-10-26")
    ck.eq(c2["interval"], 6, "sm2 second review is six days")
    c3 = schedule_sm2(c2, 5, "2026-11-01")
    ck.eq(c3["interval"], 16, "sm2 round(6 * 2.7)")
    lapse = schedule_sm2({"repetitions": 5, "interval": 80, "ef": 2.2}, 2, "2026-01-01")
    ck.eq((lapse["repetitions"], lapse["interval"]), (0, 1), "sm2 lapse restarts")
    ck.near(lapse["ef"], 2.2, "sm2 lapse keeps ef")
    floor_card = None
    for _ in range(20):
        floor_card = schedule_sm2(floor_card, 3, "2026-01-01")
    ck.near(floor_card["ef"], 1.3, "sm2 ef floor")
    try:
        schedule_sm2(None, 9)
        ck.ok(False, "sm2 rejects quality 9")
    except ValueError:
        ck.ok(True, "sm2 rejects quality 9")

    docs = [{"id": "a", "body": "apple banana apple"}, {"id": "b", "body": "banana cherry"}, {"id": "c", "body": "cherry date elder fig"}]
    hits = bm25_search(build_index(docs), "apple")
    ck.near(hits[0]["score"], math.log(8 / 3) * 5 / 3.5, "bm25 hand computed score")
    ck.near(bm25_idf(3, 1), math.log(8 / 3), "bm25 idf")

    sav = compute_savings({})
    ck.eq((sav["saasAnnual"], sav["powerAnnual"], sav["netAnnual"], sav["breakEvenDay"], sav["fiveYearPlain"]),
          (239.76, 8.94, 230.82, 190, 1034.12), "default savings scenario")

    spec = parse_cron("*/15 2-4 * * 1-5")
    ck.ok(cron_matches(spec, datetime(2026, 10, 26, 3, 30)), "cron matches monday 03:30")
    ck.ok(not cron_matches(spec, datetime(2026, 10, 25, 3, 30)), "cron skips sunday")
    ck.ok(not cron_matches(spec, datetime(2026, 10, 26, 3, 31)), "cron skips minute 31")
    for bad in ("", "* * * *", "60 * * * *", "*/0 * * * *", "5-2 * * * *"):
        try:
            parse_cron(bad)
            ck.ok(False, "cron rejects %r" % bad)
        except ValueError:
            ck.ok(True, "cron rejects %r" % bad)

    # Shared parity fixtures
    fx_path = os.path.join(os.path.dirname(HERE), "tests", "fixtures", "parity.json")
    if os.path.exists(fx_path):
        with open(fx_path, encoding="utf-8") as fh:
            fx = json.load(fh)
        for case in fx["tokenize"]:
            ck.eq(tokenize(case["in"]), case["out"], "parity tokenize %r" % case["in"])
        for case in fx["bm25"]:
            idx = build_index(case["docs"])
            got = bm25_search(idx, case["query"])
            ck.eq([h["id"] for h in got], [e["id"] for e in case["expect"]], "parity bm25 order %r" % case["query"])
            for h, e in zip(got, case["expect"]):
                ck.near(h["score"], e["score"], "parity bm25 score %r/%s" % (case["query"], e["id"]))
        for case in fx["sm2"]:
            card = None
            for q, e in zip(case["qualities"], case["expect"]):
                card = schedule_sm2(card, q, case["today"])
                ck.eq((card["interval"], card["repetitions"]), (e["interval"], e["repetitions"]), "parity sm2 step")
                ck.near(card["ef"], e["ef"], "parity sm2 ef")
        for case in fx["savings"]:
            got = compute_savings(case["input"])
            for k, v in case["expect"].items():
                if v is None:
                    ck.ok(got[k] is None, "parity savings %s is null" % k)
                else:
                    ck.near(got[k], v, "parity savings %s" % k)
        for case in fx["readability"]:
            r = extract_readable(case["html"])
            ck.eq(r["title"], case["title"], "parity readability title")
            ck.eq(r["text"], case["text"], "parity readability text")
        for case in fx["netscape"]:
            ck.eq(parse_netscape(case["html"]), case["items"], "parity netscape items")
    else:
        ck.ok(False, "tests/fixtures/parity.json is missing")

    # Live server
    tmp = tempfile.mkdtemp(prefix="subzero-selftest-")
    os.environ["VAULT_QUIET"] = "1"
    store = Store(os.path.join(tmp, "vault.db"))
    token = "selftest-token"
    cfg = Config(store, token=token, origins=["https://aariv.me"])
    httpd = serve(cfg, "127.0.0.1", 0)
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        st, _, body = _call(base, "GET", "/health")
        ck.eq(st, 200, "health status")
        ck.eq(json.loads(body)["auth"], True, "health reports auth on")
        st, _, _ = _call(base, "GET", "/api/articles")
        ck.eq(st, 401, "api without token is refused")
        st, _, _ = _call(base, "GET", "/api/articles", token="wrong")
        ck.eq(st, 401, "api with wrong token is refused")
        st, _, _ = _call(base, "GET", "/api/articles", token=token, headers={"Origin": "https://evil.example"})
        ck.eq(st, 403, "disallowed origin is refused")
        st, hdr, _ = _call(base, "OPTIONS", "/api/articles", headers={"Origin": "https://aariv.me", "Access-Control-Request-Method": "POST",
                                                                       "Access-Control-Request-Private-Network": "true"})
        ck.eq(st, 204, "preflight status")
        ck.eq(hdr.get("Access-Control-Allow-Origin"), "https://aariv.me", "preflight echoes allowed origin")
        ck.eq(hdr.get("Access-Control-Allow-Private-Network"), "true", "preflight allows private network access")
        st, hdr, _ = _call(base, "OPTIONS", "/api/articles", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        ck.ok("Access-Control-Allow-Origin" not in hdr, "preflight hides CORS from other origins")

        page = ("<html><head><title>Compose notes</title></head><body><nav><a href='/'>x</a></nav><article>"
                "<p>Compose files describe services, volumes and networks, and one command starts the lot of them together.</p>"
                "<p>A healthcheck lets the engine know when a container is ready, which is more than just running.</p>"
                "</article></body></html>")
        st, _, body = _call(base, "POST", "/api/articles", {"url": "https://example.com/compose", "html": page, "tags": ["Docker", "docker"]}, token)
        art = json.loads(body)
        ck.eq(st, 201, "add article status")
        ck.eq(art["title"], "Compose notes", "add article title from html")
        ck.eq(art["tags"], ["docker"], "tags are lowercased and de-duplicated")
        ck.ok("healthcheck" in art["body"] and "nav" not in art["body"].lower().split(), "extraction kept body, dropped nav")
        st, _, body = _call(base, "POST", "/api/articles", {"url": "https://example.com/compose", "title": "Compose notes v2", "text": "Updated body about volumes"}, token)
        ck.eq(st, 200, "same url updates instead of duplicating")
        st, _, body = _call(base, "POST", "/api/articles", {"title": "SQLite notes", "text": "Write ahead logging lets readers continue while a writer commits.", "tags": ["sqlite"]}, token)
        second = json.loads(body)
        st, _, body = _call(base, "GET", "/api/articles", token=token)
        ck.eq(len(json.loads(body)["articles"]), 2, "two articles listed")
        st, _, body = _call(base, "GET", "/api/search?q=write+logging", token=token)
        results = json.loads(body)["results"]
        ck.eq(results[0]["id"], second["id"], "search ranks the SQLite article first")
        ck.ok("<mark>" in results[0]["snippet"], "search snippet marks hits")
        st, _, body = _call(base, "GET", "/api/search?q=volumes&tag=docker", token=token)
        ck.eq([r["id"] for r in json.loads(body)["results"]], [art["id"]], "search honours tag filter and sees the updated body")
        st, _, _ = _call(base, "GET", "/api/search?q=x&limit=abc", token=token)
        ck.eq(st, 400, "bad limit is a 400")

        st, _, body = _call(base, "POST", "/api/articles/%d/highlights" % art["id"], {"text": "Healthchecks tell the engine when a container is ready.", "note": "ready"}, token)
        hl = json.loads(body)
        ck.eq(st, 201, "add highlight status")
        st, _, body = _call(base, "GET", "/api/review/due", token=token)
        ck.eq(len(json.loads(body)["due"]), 1, "new highlight is due today")
        st, _, body = _call(base, "POST", "/api/review/%d" % hl["id"], {"quality": 5, "today": "2026-10-25"}, token)
        rv = json.loads(body)
        ck.eq((rv["interval"], rv["due"]), (1, "2026-10-26"), "review schedules one day")
        st, _, body = _call(base, "POST", "/api/review/%d" % hl["id"], {"quality": 5, "today": "2026-10-26"}, token)
        ck.eq(json.loads(body)["interval"], 6, "second review is six days")
        st, _, _ = _call(base, "POST", "/api/review/%d" % hl["id"], {"quality": 9}, token)
        ck.eq(st, 400, "review rejects quality 9")
        st, _, body = _call(base, "GET", "/api/review/due?today=2026-10-26", token=token)
        ck.eq(len(json.loads(body)["due"]), 0, "reviewed highlight is no longer due")
        st, _, body = _call(base, "GET", "/api/review/due?today=2026-11-02", token=token)
        ck.eq(len(json.loads(body)["due"]), 1, "highlight returns when its interval ends")

        st, _, _ = _call(base, "POST", "/api/articles", raw=b'{"title":"x"}', token=token, headers={"Content-Type": "text/plain"})
        ck.eq(st, 415, "text/plain is refused on the main endpoint")
        st, _, _ = _call(base, "POST", "/api/articles", raw=b"{not json", token=token)
        ck.eq(st, 400, "invalid JSON is a 400")
        st, _, _ = _call(base, "POST", "/api/articles", {"title": "", "text": "no title"}, token)
        ck.eq(st, 400, "missing title is a 400")
        st, _, _ = _call(base, "POST", "/api/articles", {"title": "x", "url": "javascript:alert(1)"}, token)
        ck.eq(st, 400, "javascript urls are refused")
        st, _, _ = _call(base, "GET", "/api/articles/9999", token=token)
        ck.eq(st, 404, "unknown article is a 404")

        marks = ('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://example.org/one" TAGS="net,tools" ADD_DATE="1700000000">One</A>'
                 '<DT><H3>Reading</H3><DL><p><DT><A HREF="https://example.org/two">Two</A></DL><p></DL><p>')
        st, _, body = _call(base, "POST", "/api/import", {"html": marks}, token)
        ck.eq(json.loads(body), {"added": 2, "skipped": 0}, "import adds two bookmarks")
        st, _, body = _call(base, "POST", "/api/import", {"html": marks}, token)
        ck.eq(json.loads(body), {"added": 0, "skipped": 2}, "import skips repeats")
        st, hdr, body = _call(base, "GET", "/api/export?format=netscape", token=token)
        text = body.decode()
        ck.ok(text.startswith("<!DOCTYPE NETSCAPE-Bookmark-file-1>") and "https://example.org/two" in text, "export netscape")
        ck.eq(sorted(i["url"] for i in parse_netscape(text) if "example.org" in i["url"]), ["https://example.org/one", "https://example.org/two"], "export re-imports")
        st, _, body = _call(base, "GET", "/api/export?format=json", token=token)
        ck.ok(len(json.loads(body)["articles"]) >= 4, "export json holds the articles")

        st, _, body = _call(base, "POST", "/api/savings", {"hardwareCost": 0}, token)
        ck.eq(json.loads(body)["breakEvenDay"], 0, "savings endpoint")

        st, _, _ = _call(base, "POST", "/api/clip?token=wrong", raw=b'{"url":"https://e.test/","html":"<p>x</p>"}', headers={"Content-Type": "text/plain"})
        ck.eq(st, 401, "clip refuses a wrong token")
        clip = ('{"url":"https://example.net/clip","html":"<html><title>Clipped</title><body><article><p>' +
                'A clipped page with enough words, commas, and length to be treated as a paragraph by the scorer.' + '</p></article></body></html>"}').encode()
        st, _, body = _call(base, "POST", "/api/clip?token=" + token, raw=clip, headers={"Content-Type": "text/plain"})
        ck.eq(st, 201, "clip accepts a good token with text/plain")
        ck.eq(json.loads(body)["title"], "Clipped", "clip extracts the title")

        st, _, body = _call(base, "DELETE", "/api/articles/%d" % art["id"], token=token)
        ck.eq(st, 200, "delete article")
        st, _, body = _call(base, "GET", "/api/highlights", token=token)
        ck.eq(json.loads(body)["highlights"], [], "highlights go with their article")

        for static in ("/", "/index.html", "/styles.css", "/engine.js", "/app.js"):
            st, hdr, body = _call(base, "GET", static)
            if os.path.exists(os.path.join(cfg.web_dir, "index.html")):
                ck.eq(st, 200, "static %s" % static)
        st, _, body = _call(base, "GET", "/")
        if os.path.exists(os.path.join(cfg.web_dir, "index.html")):
            ck.ok(b'name="subzero-server"' in body, "served index tells the page a vault is behind it")
        st, _, _ = _call(base, "GET", "/server/app.py")
        ck.eq(st, 404, "server source is not served")
        st, _, _ = _call(base, "GET", "/..%2fetc%2fpasswd")
        ck.eq(st, 404, "path traversal is refused")
        st, _, _ = _call(base, "GET", "/fonts/../server/app.py")
        ck.eq(st, 404, "dot segments are refused")

        backup_file = store.backup(os.path.join(tmp, "bk"), keep=2)
        with closing(sqlite3.connect(backup_file)) as bc:
            n = bc.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
        ck.ok(n >= 3, "backup file holds the data")
    finally:
        httpd.shutdown()
        httpd.server_close()

    # A server with no token leaves the bookmarklet off
    cfg2 = Config(Store(os.path.join(tmp, "open.db")), token="")
    httpd2 = serve(cfg2, "127.0.0.1", 0)
    base2 = "http://127.0.0.1:%d" % httpd2.server_address[1]
    threading.Thread(target=httpd2.serve_forever, daemon=True).start()
    try:
        st, _, _ = _call(base2, "GET", "/api/articles")
        ck.eq(st, 200, "no token means open api on localhost")
        st, _, _ = _call(base2, "POST", "/api/clip", raw=b"{}", headers={"Content-Type": "text/plain"})
        ck.eq(st, 403, "clip is off without a token")
    finally:
        httpd2.shutdown()
        httpd2.server_close()

    print("selftest: %d checks, %d failed" % (ck.n, len(ck.failed)))
    return 0 if not ck.failed else 1


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def drop_privileges(paths):
    """When started as root (the container default) hand the data folders to an unprivileged user, then become it.

    This is what lets a plain `./data:/data` bind mount work on Linux without a manual chown."""
    if os.name != "posix" or os.geteuid() != 0:
        return
    uid = int(os.environ.get("VAULT_UID", "10001"))
    gid = int(os.environ.get("VAULT_GID", str(uid)))
    for p in paths:
        if not p:
            continue
        os.makedirs(p, exist_ok=True)
        try:
            os.chown(p, uid, gid)
            for name in os.listdir(p):
                os.chown(os.path.join(p, name), uid, gid)
        except OSError as e:
            print("could not chown %s: %s" % (p, e), file=sys.stderr, flush=True)
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def main(argv=None):
    ap = argparse.ArgumentParser(description="SubZero Vault server")
    ap.add_argument("--host", default=os.environ.get("VAULT_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("VAULT_PORT", "8090")))
    ap.add_argument("--db", default=os.environ.get("VAULT_DB", os.path.join(os.path.dirname(HERE), "data", "vault.db")))
    ap.add_argument("--selftest", action="store_true", help="run the built-in checks and exit")
    ap.add_argument("--backup", metavar="DIR", help="write one backup of the database into DIR and exit")
    ap.add_argument("--version", action="store_true")
    args = ap.parse_args(argv)

    if args.version:
        print(VERSION)
        return 0
    if args.selftest:
        return selftest()
    drop_privileges([os.path.dirname(os.path.abspath(args.db)), os.environ.get("VAULT_BACKUP_DIR", "").strip() or args.backup])
    store = Store(args.db)
    if args.backup:
        print(store.backup(args.backup))
        return 0

    origins = os.environ.get("VAULT_ALLOWED_ORIGINS", "https://aariv.me").split(",")
    cfg = Config(store, os.environ.get("VAULT_TOKEN", ""), origins, os.environ.get("VAULT_WEB_DIR"))
    cron = os.environ.get("VAULT_BACKUP_CRON", "").strip()
    bdir = os.environ.get("VAULT_BACKUP_DIR", "").strip()
    if cron and bdir:
        parse_cron(cron)
        threading.Thread(target=backup_loop, args=(store, bdir, cron), daemon=True).start()
        print("backups: %r into %s" % (cron, bdir), flush=True)
    httpd = serve(cfg, args.host, args.port)
    print("SubZero Vault %s on http://%s:%d (token %s)" % (VERSION, args.host, args.port, "on" if cfg.token else "off"), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
