# musestatus

musestatus: one dense page showing the state of Arman's Muse setup itself — starred & pinned artifacts, the VM file system, the preference files and their change timeline, machines, connectors, usage ledgers, automations, skills, tools, chats, artifacts and memory. A sibling of claudestatus (which covers the Claude account); this one covers Muse.

Current version: **v1.1.0** (2026-10-28) — see [CHANGELOG.md](CHANGELOG.md). v1.1.0 adds ten panes (plugins, Claude Code versions, local setup, recent activity, GitHub repos, Cloudflare Pages, disk usage, CLI versions, workflows, collector error log), docs-style changelog + generated code-history pages, and an assignable shortcuts system.

Served at **https://armanai.pages.dev/musestatus/** behind the hub sign-in. Never link to the `*.pages.dev` address directly.

## Layout

| Path | What it is |
|---|---|
| `public/index.html` | The page shell and all styles. |
| `public/app.js` | The whole app: pane machinery, table editing, and the section renderers. Data comes from `api/data` at view time — nothing is baked in. |
| `public/_worker.js` | Gate (hub proxy key) + `api/prefs` (view state in D1) + `api/data` / `api/fs` / `api/prefbody` (published snapshots) + `api/publish` (publisher intake) + static files. |
| `public/changelog.html` | Release notes, newest first (Brief/Full), styled by `public/docs.css` + `public/docs-theme.js`. |
| `public/code-history.html` | Generated from git history by `scripts/build-code-history.mjs` (config: `scripts/code-history.config.json`); regenerated at each release with `--pending` before committing. |
| `wrangler.toml` | Pages config and the D1 binding `MUSESTATUS_DB`. |
| `test-worker.mjs` | Node smoke test for the worker (gate, publish auth, prefs, fs). Run: `node test-worker.mjs`. |

## How it is served

The armanai hub worker proxies `/musestatus` to `https://musestatus.pages.dev`, sending `X-Hub-Proxy-Key` = armanai secret `HUB_PROXY_KEY_23`. This project holds the same value as its `HUB_PROXY_KEY` secret. Requests without it redirect to the hub path; API requests without it get a 401. The worker strips a leading `/musestatus` prefix itself, so it behaves the same whether or not the hub strips it. Keep every link and `fetch()` in the page relative.

Two secrets gate the worker, and both fail closed when unset:

| Secret | Guards |
|---|---|
| `HUB_PROXY_KEY` | Every request (hub proxy key). |
| `PUBLISH_KEY` | `POST api/publish` only (`Authorization: Bearer …`). |

## Sync

View state (pane order, hidden panes, labels, column widths, sliders, theme, stars) is kept in the browser for a fast first paint and synced to D1 through `api/prefs` (table `musestatus_view_state`). The page waits for a 2-second pause and sends only real changes; the worker skips the write when nothing changed. All app storage is D1: the first KV-backed publish on 2026-10-23 wrote ~958 keys in one evening and nearly exhausted the account's daily free-tier KV write cap, so the data layer was migrated to D1 the same night (tables prefixed `musestatus_` in the `anvari-hub` database — the VM's API token cannot create D1 databases; the worker creates its tables on first use).

## Refreshing the data

A VM publisher cron, `musestatus-publish`, gathers the sections on the VM and POSTs them to `api/publish`:

- `sections` — one `{stamp, data}` per pane section (`machines`, `connectors`, `usage`, `prefs`, `pins`, `artifacts`, `counts`, `fsmeta`, …), stored as `sec:<name>` and served together by `api/data`. Every pane shows its own stamp, so stale data says how stale it is.
- `fsFolders` — one `{path, stamp, children}` per directory, stored as `fsdir:<path>` and fetched lazily by the File system pane via `api/fs`. Aggregate folders (node_modules, .git) carry `agg: [files, bytes]` and are never itemized.
- `prefBodies` — one `{id, name, path, body}` per preference file, stored as `prefbody:<id>` and fetched on click via `api/prefbody`.
- `fsDeleted` — directory paths whose `fsdir:` keys should be deleted.

The worker writes a key only when its serialized value changed, and answers `{written, skipped, deleted}`.

## Deploy

Deploy from this repo with the Cloudflare helper in `~/workspace/skills/cloudflare` (`cf.py` direct upload), or with wrangler: `wrangler pages deploy public --project-name musestatus --branch main`. After deploying, check the deployment stage and fetch https://armanai.pages.dev/musestatus/ signed in.
