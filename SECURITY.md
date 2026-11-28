# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/subzero-vault/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the SubZero Vault browser application, Python server, HTTP API, SQLite storage and backup paths, bookmark import and export, readability processing, share links, report exports and packaging output.

In scope:

- A cross-site scripting or HTML injection path through article HTML, highlights, notes, search snippets, bookmark imports, share links or exported reports.
- An authorization flaw that bypasses the bearer token or the documented localhost-only boundary, or exposes another user's vault data.
- A path traversal, backup disclosure, database exposure, unsafe redirect or request-method flaw in the Python server.
- A CSV, JSON, Markdown, bookmark or package export flaw that makes generated output execute a formula or script when opened.

Out of scope:

- Vulnerabilities in Docker, Caddy, Tailscale, a reverse proxy or the host operating system that are outside this repository.
- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Example subscription prices and planning calculations, unless a report shows a specific validation or output integrity failure.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
