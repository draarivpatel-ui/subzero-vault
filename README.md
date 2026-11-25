# SubZero Vault

A self-hosted replacement for paid read-it-later, bookmark and highlight apps like Readwise Reader and Raindrop.io Pro, plus a calculator that adds up what those subscriptions (and others, Rocket Money included) cost you each year. Run it with `docker compose up -d`, or try the whole thing in your browser at [aariv.me/subzero-vault](https://aariv.me/subzero-vault/).

![SubZero Vault hero showing the yearly rent ledger](img/hero.png)

**Reference Build Note.** Because no Hackatime or Lapse hours were tracked during development, this repository is published as a standalone open-source reference build rather than a CloudFALL program submission. See NOTES.md.

## Quickstart

```
git clone https://github.com/draarivpatel-ui/subzero-vault
cd subzero-vault
docker compose up -d
open http://localhost:8090
```

The server needs no configuration and binds to localhost by default. The database lives in `./data`, backups land in `./backups` every night at 03:00, and the container restarts itself after a reboot. Copy `.env.example` to `.env` to change the settings. An empty `VAULT_BACKUP_CRON` turns scheduled backups off.

On a fresh install the vault is empty. The results panel has a button that loads eight sample articles so you can try search, highlights and review straight away.

No Docker? The server is one file that uses only the Python standard library.

```
python3 server/app.py --port 8090
```

## What is in it

**Search.** Okapi BM25 ranking with `k1 = 1.5` and `b = 0.75`. Title words count three times and tag words twice. Results show their score and a snippet with the matching words marked.

**Highlights and review.** Select text in the reader or paste an exact passage in the highlight field. You can add a review cue before saving. Highlights come back on the SuperMemo SM-2 schedule, with four answers (again, hard, good, easy). Each button shows how long until the next review.

**Readable text.** Paste a page's HTML and a readability pass keeps the story and drops navigation, sidebars and footers. With a token set, the server also gives you a bookmarklet that saves the page you are looking at.

**Bookmarks in and out.** Imports the HTML file every browser can export (the Netscape bookmark format), keeps folders, tags, dates and notes, skips `javascript:` links and repeats. Exports the same format. JSON export too.

**Rent audit.** Twelve subscriptions, each with a tick and an editable monthly price, set against a box you own, its wattage and your electricity rate. The payback day uses starting rates; the 36-month chart also includes any projected price rises. You can share the scenario as a link.

**TCO and retention lab.** Five ways to run the vault (Raspberry Pi 5 kit, used N100 mini PC, refurbished ThinkCentre, two bay NAS, or a `$6` a month VPS) priced against the same subscription bill at 12, 36 and 60 months, with break-even recomputed under plus or minus 30% power and plus or minus 20% rent changes. A second panel stress-tests the internals: BM25 `k1` and `b` controls show how much the sample ranking moves (Kendall tau and top-3 overlap), and an SM-2 simulator plots ninety days of review backlog for four grading strategies. Every lab report exports as JSON, CSV and Markdown with one SHA-256 checksum. A `#szv=` share link restores the prices and lab settings, but omits the search query. Sixteen self-tests run inside the page.

**Packaging studio.** Pick the port, volume folder, backup schedule and front door (nothing, Caddy with automatic HTTPS, or Tailscale). Get a matching `docker-compose.yml`, `.env` and `Caddyfile` to copy or download.

| Screenshot | What it shows |
| --- | --- |
| ![Rent audit](img/audit.png) | Ticking subscriptions, the break-even chart and the box inputs |
| ![Vault](img/vault.png) | A BM25 search, the reader, a saved highlight and a review card |
| ![Packaging studio](img/studio.png) | Compose output for Caddy with a 30 minute backup schedule |
| ![Phone layout](img/mobile.png) | The same page on a 390 pixel wide phone |

## The numbers on the page

The three headline subscriptions use example prices of `$9.99`, `$3.99` and `$6.00` a month, which add up to `$239.76` a year. These are starting figures, not quotes. NOTES.md records where each came from and where sources disagreed. Rocket Money in particular lets you choose a price. Edit any figure on the page and everything recomputes.

With the default box (a `$120` Raspberry Pi 5 kit drawing 6 W at `$0.17` per kWh, which are estimates) the electricity costs `$8.94` a year, the net saving is `$230.82` a year, and the box pays for itself on day 190.

The lab's five profiles carry their own starting estimates: `$120` at 6 W for the Pi kit, `$150` at 10 W for the N100 box, `$100` at 20 W for the ThinkCentre, `$210` at 15 W for the NAS, and `$6` a month for the VPS. They are example figures to edit against, not current quotes; disks and shipping are extra.

Rocket Money's bank sync and bill negotiation are not replaced. The audit is a calculator you fill in by hand.

## How it fits together

```
  browser (index.html, app.js, engine.js)          server (server/app.py)
 +-----------------------------------+          +--------------------------+
 | views: ledger, chart, vault,      |  fetch   | HTTP API + static files  |
 | review, packaging studio          +--------->| BM25, SM-2, readability, |
 |                                   | JSON     | bookmarks, savings       |
 | LocalStore  (localStorage)        |  token   |                          |
 | ServerStore (calls the API)       |          | SQLite (WAL) + backups   |
 +-----------------------------------+          +--------------------------+
        engine.js and server/app.py implement the same maths.
        tests/fixtures/parity.json holds numbers both must agree on.
```

The page works in two modes. In browser mode everything is stored in local storage and clearing site data clears the vault. In server mode the same page talks to your server. Open the server's own address and the page connects by itself, or use the connect drawer from another site such as the hosted demo. Browsers differ on whether an https page may call a plain http address on your own machine, and some ask for permission first. If yours blocks it, open the server's own address, which serves the same app.

## API

All routes are under `/api`. With `VAULT_TOKEN` set, send `Authorization: Bearer <token>`.

| Route | Does |
| --- | --- |
| `GET /health` | status, no auth |
| `GET /api/articles?tag=` | list |
| `POST /api/articles` | add `{title, url, tags, html or text}` |
| `GET` and `DELETE /api/articles/<id>` | read, delete |
| `POST /api/articles/<id>/highlights` | add `{text, note}` |
| `GET /api/highlights?article=<id>` | list |
| `GET /api/review/due?today=YYYY-MM-DD` | highlights due |
| `POST /api/review/<id>` | rate `{quality: 0 to 5}` |
| `GET /api/search?q=&tag=&limit=` | BM25 results with snippets |
| `POST /api/import` | `{html}` bookmarks file |
| `GET /api/export?format=netscape` or `json` | download |
| `POST /api/savings` | the calculator, as JSON |
| `POST /api/clip?token=` | bookmarklet endpoint, off unless a token is set |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `VAULT_PORT` | `8090` | host port in Compose, listen port in the server |
| `VAULT_TOKEN` | empty | bearer token. Empty means the API only answers requests addressed to `localhost`, `127.0.0.1` or `::1` (other names and LAN addresses get a 403) |
| `VAULT_ALLOWED_ORIGINS` | `https://aariv.me` | websites allowed to call the API from a browser |
| `VAULT_DB` | `./data/vault.db` | SQLite file |
| `VAULT_BACKUP_DIR`, `VAULT_BACKUP_CRON` | `/backups`, `0 3 * * *` in Compose | scheduled backups, 5 field cron, 14 kept |

Take a backup by hand with `docker compose exec vault python3 server/app.py --backup /backups`.

If you expose the server beyond your own machine, set a token and put it behind Caddy or Tailscale. The studio generates both setups.

## Tests

```
nice -n 19 node --test --test-concurrency=1 tests/
nice -n 19 python3 server/app.py --selftest
```

The browser app has no build step or npm dependencies. The Node suite covers the maths, readability, bookmarks, Compose generation, page semantics and controller behavior. The lab suite checks the report checksum, comparator, diagnostics and share codec. The Python self-test replays `tests/fixtures/parity.json`, starts an HTTP server, checks the API, and loads the JavaScript referenced by the served page.

## Layout

```
index.html styles.css app.js engine.js samples.js   the web app
vault-lab.js                                        the TCO and retention lab
server/app.py                                       the server
Dockerfile docker-compose.yml .env.example          packaging
tests/                                              node:test suites and fixtures
scripts/                                            fixture and social image sources
fonts/                                              Fraunces, Plus Jakarta Sans, JetBrains Mono (SIL OFL)
```

## Licence

MIT. See `LICENSE`. Fonts are under the SIL Open Font License, noted in `fonts/LICENSE-FONTS.txt`.
