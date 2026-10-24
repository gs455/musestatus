# Changelog

## v1.0.0 — 2026-10-23

- Publish route dispatched before the hub gate (it carries its own Bearer key; the VM publisher never has the hub proxy key).
- Data layer migrated KV → D1 the same night: the first KV publish wrote ~958 keys and nearly exhausted the account's daily free-tier KV write cap (961 of 1,000 account-wide). Sections, fs rows, preference bodies and view state now live in `musestatus_*` tables (D1 database anvari-hub — the VM API token cannot create D1 databases, 401 code 10000; worker creates its tables on first use). The publisher contract is unchanged; rows are written only on change. The musestatus-data KV namespace is retired in place (no further writes; binding removed).
- Write discipline hardened (owner's fix spec): every D1 row carries a sha256 hash; the publisher sends hashes with all items and the worker writes only rows whose hash differs — a no-change publish writes zero rows. The fs tree ships as ~500-folder chunk blobs plus a manifest chunk (47 rows for the full 22.6k-folder tree), never per-folder rows; chunk hashes cover folder content only (publish stamps excluded), and the publisher's own state files are excluded from the published tree so runs don't churn themselves.

- First release of musestatus at armanai.pages.dev/musestatus/: 12 data-driven panes (Starred & pinned, File system, Preferences, Machines, Connectors, Usage & billing, Automations, Skills, Tools, Assistants & chats, Artifacts & hub, Memory), hub-gated worker with KV view-state sync and a publish endpoint for the VM publisher, claudestatus-style chrome with movable panes, editable tables, edit mode and spacing sliders.
