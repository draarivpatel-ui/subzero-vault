# Notes

Working notes for SubZero Vault. These are for whoever picks the project up next, so they say what was checked, what was not, and why some choices were made.

## Where the prices came from

Read on 25 October 2026 through web search summaries of public pricing guides. Vendor pricing pages were not opened, so every figure is a secondary report. Treat them as starting points.

| Service | Figure used | What was found |
| --- | --- | --- |
| Readwise Reader | `$9.99` a month | Several 2026 guides agree on `$9.99` billed annually or `$12.99` billed monthly. Reader is only sold inside the Readwise Full bundle. |
| Raindrop.io Pro | `$3.99` a month | The figure comes from the project brief. Third party listings show about `$3.54` a month, and one competitor review reports `$3` a month or `$28` a year. They disagree, so the page says so. |
| Rocket Money Premium | `$6.00` a month | The figure comes from the project brief. Rocket Money's own guide (January 2026) says Premium is pay what you think is fair, typically `$7` to `$14` a month. Other reviews give `$3` to `$14`. Billing is the user's choice, so `$6.00` is an example, and it sits below the most recent reported range. |
| Notion Plus | `$10.00` a month | Notion release notes of 26 June 2024, annual billing, per member. Not rechecked for 2026. |
| Linktree Pro | `$12.00` a month | 2026 pricing guides, annual billing. Monthly billing is reported at `$15`. |
| Instapaper, Google One, iCloud+, 1Password, Dropbox Plus, Evernote, Todoist | none | No price was found, so the page leaves the box empty and asks for yours. Nothing is counted until you type one. |

The `$239.76` a year on the hero is `$9.99 + $3.99 + $6.00` times twelve. It is arithmetic on example inputs, labelled that way on the page.

Hardware presets (`$120` and 6 W for a Raspberry Pi 5 kit, `$150` and 10 W for a used mini PC, a free laptop at 14 W) and the `$0.17` per kWh rate are starting estimates with no source. The page says "estimates, not quotes" next to them.

## Changes from the brief

- **Pocket Premium is not in the table.** Mozilla shut Pocket down on 8 July 2025 (9to5mac and Engadget both report the date). Listing a price for a discontinued product would be made up, so the twelfth slot went to Todoist Pro and the page carries a one line note. Instapaper Premium covers the read-it-later slot.
- **OPML was not built.** The brief's summary mentions OPML but its detailed spec names only Netscape bookmark HTML and JSON, which are in. Feed subscriptions (OPML) are a reader feature this project does not have. Adding it is a decision for Billy.
- **Rocket Money is not fully replaced.** The vault replaces the saved pages, bookmarks and highlights side of Readwise Reader and Raindrop. Rocket Money's bank sync and bill negotiation need account access, so the audit is a manual calculator.
- **Backups run inside the server, not in a second container.** A second container opening the same SQLite file in WAL mode is fragile on Docker Desktop bind mounts. One process with a small cron matcher is simpler and safer.
- **SM-2 leaves the easiness factor alone when the answer is below 3.** That follows the original SM-2 text. The brief's formula and the 1.3 floor apply to every answer of 3 or more.
- **The bookmarklet endpoint is off unless a token is set**, and it accepts `text/plain` so that a page on any site can post to it without a CORS preflight. The token in the address is what protects it. Pages with a strict content security policy will block the bookmarklet's request.
- **Fonts are bundled** (Latin subsets of Fraunces, Plus Jakarta Sans and JetBrains Mono, all SIL OFL) so a self-hosting project makes no requests to Google.

## What was checked, and how

| Check | Result |
| --- | --- |
| `node --test tests/` | 186 passing (100 in `engine.test.js`, 86 in `dom-smoke.test.js`) |
| `python3 server/app.py --selftest` | 229 checks, including a live server run on a random port, token and CORS handling, the localhost-only rule when no token is set, access log token redaction, import and export, backups, path traversal |
| Python 3.9 syntax | parsed with `ast.parse(feature_version=(3, 9))`, and the self test ran on Python 3.9.6 |
| Honesty harness `--audit` | 0 violations |
| Honesty harness `--planted-defects --count 150` | 132 of 150 mutations caught on the last full run (109 before the extra tests were added). The escapes that remain are mostly inside the readability scorer's tag and weight arithmetic and a few UI branch conditions. Not every one was chased down. |
| Page in real Chrome (headless, driven with Playwright and DevTools) | no console errors. No element wider than the screen at 320, 375, 414, 768, 1024 and 1440 px. Search, highlight, review, import, connecting to a second origin with a token, and the studio were exercised |
| Generated Compose files | all three proxy options parsed with PyYAML |
| Contrast of the colour tokens | ink on paper 16.6, muted text 6.6, green 5.5, deep rust 6.3. Plain rust is only used for lines, areas and large text |

**Docker was not available on the machine that built this.** `docker compose up` and the `Dockerfile` build were not run. What was done instead is the server ran natively on port 8090 from the same files, the Compose file was parsed, and every file the `Dockerfile` copies was checked to exist. The privilege drop (start as root, chown `/data`, become uid 10001) was not exercised because the dev run was not root. Run `docker compose up --build` from a clean clone before submitting.

The Tailscale and Caddy Compose output follows each project's documented pattern but has not been started.

## Things to decide before submitting to CloudFALL

These are not for an agent to settle.

- CloudFALL's review page asks that Hackatime or Lapse hours are tracked against the project and that at most 30 percent of the work is AI assisted. The code, tests and copy in this repository were written by Claude (the commits carry a `Co-Authored-By` line for that). No hours were tracked for it. Whether it can be submitted, and how to describe it, is for Aariv and Billy.
- The live demo is at `https://aariv.me/subzero-vault/`. The reviewer checklist wants a live link and a repo that runs from a clean clone.

## Honesty notes

- No test users, testimonials, customer counts or performance claims appear anywhere.
- The sample articles were written for this project and make no claims about named products beyond how the open source tools work.
- Prices on the page are labelled as editable examples next to the numbers themselves.

## Known limits

- Search indexes are built in memory per process and rebuilt when articles change. That is fine for thousands of articles and not for millions.
- Readability extraction is a heuristic scorer. It does well on article pages and poorly on pages with no paragraphs.
- The server has no user accounts. One token guards one vault.
- Bookmark import treats the note line under a bookmark as its body text. No page is fetched at import time.
