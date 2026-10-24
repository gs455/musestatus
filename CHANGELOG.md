# Changelog

## v1.0.0 — 2026-10-23

- Publish route dispatched before the hub gate (it carries its own Bearer key; the VM publisher never has the hub proxy key).

- First release of musestatus at armanai.pages.dev/musestatus/: 12 data-driven panes (Starred & pinned, File system, Preferences, Machines, Connectors, Usage & billing, Automations, Skills, Tools, Assistants & chats, Artifacts & hub, Memory), hub-gated worker with KV view-state sync and a publish endpoint for the VM publisher, claudestatus-style chrome with movable panes, editable tables, edit mode and spacing sliders.
