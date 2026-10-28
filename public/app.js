"use strict";

// ---------------------------------------------------------------------------
// musestatus — a data-driven sibling of the claudestatus app.
//
// The page itself holds no account data. On load it paints the saved layout
// from localStorage, then fetches api/data (snapshots the VM publisher cron
// pushed into D1) and renders each section into its pane. Every pane header
// carries its own section stamp, so a stale number always says how stale.
// View state (layout, labels, widths, stars, theme) is kept in this browser
// for an instant first paint and synced through api/prefs, exactly like
// claudestatus: 2-second debounce, writes only on change.
// ---------------------------------------------------------------------------

// Pane definitions in mockup order. "section" names the api/data section a
// generic pane reads; custom panes name their renderer instead.
const PANE_DEFS = [
  { id: "starred", title: "⭐ Starred & pinned", description: "Artifacts pinned in the Artifacts app, plus artifacts starred here.", custom: "starred" },
  { id: "fs", title: "🗂 File system", description: "This VM's file tree, walked by the publisher. Names, sizes and dates only — never contents.", custom: "fs" },
  { id: "preferences", title: "📋 Preferences", description: "The preference files that steer Muse, and the day-by-day timeline of changes.", custom: "preferences" },
  { id: "machines", title: "Machines", description: "Arman's machines and how Muse reaches them.", section: "machines" },
  { id: "connectors", title: "Connectors", description: "Connected services and their scope.", section: "connectors" },
  { id: "usage", title: "Usage & billing", description: "Plan plus the labeled usage ledgers. There is no live account-usage feed, so no single % is ever shown.", custom: "usage" },
  { id: "automations", title: "Automations", description: "Cron jobs and hooks in one table.", section: "automations" },
  { id: "skills", title: "Skills", description: "System and custom skills.", section: "skills" },
  { id: "tools", title: "Tools / namespaces", description: "Tool namespaces and what they cover.", section: "tools" },
  { id: "chats", title: "Assistants & chats", description: "Chats and their question counts.", section: "chats" },
  { id: "artifacts", title: "Artifacts & hub", description: "The Muse artifact catalog and the Artifacts app registry. Star rows here to pin them into the Starred pane.", custom: "artifacts" },
  { id: "memory", title: "Memory", description: "The memory stores behind this page.", section: "memory" },
  { id: "plugins", title: "Plugins (adapted)", description: "Muse's bundles: connectors, skill libraries and Claude Code.", section: "plugins" },
  { id: "claude-code-versions", title: "Claude Code versions", description: "The Claude Code version on each machine, probed over SSH on deep publisher runs.", section: "claude-code-versions" },
  { id: "local-setup", title: "Local setup", description: "This VM's own configuration: MCP servers, Claude Code config, instruction files.", section: "local-setup" },
  { id: "recent-activity", title: "Recent activity", description: "The latest question asked in each chat.", section: "recent-activity" },
  { id: "github-repos", title: "GitHub repos", description: "Arman's GitHub repositories and their latest commits.", section: "github-repos" },
  { id: "cloudflare-pages", title: "Cloudflare Pages", description: "Pages projects, their hub paths and latest deployments.", section: "cloudflare-pages" },
  { id: "disk-usage", title: "Disk usage", description: "The largest folders directly under /home/hatch, from the publisher's file walk.", section: "disk-usage" },
  { id: "cli-versions", title: "CLI versions", description: "Versions of the command-line tools this VM's work leans on.", section: "cli-versions" },
  { id: "workflows", title: "Workflows & playbooks", description: "Saved workflows and the custom-skill playbooks.", section: "workflows" },
  { id: "error-log", title: "Collector error log", description: "Failures recorded by Mo's own collector and publish jobs.", section: "error-log" },
];

const ARTIFACTS_BASE = "https://armanai.pages.dev/artifacts/";

// ---------------------------------------------------------------------------
// Saved view state
// ---------------------------------------------------------------------------
const STORAGE_KEY = "musestatus-view";
const DEFAULT_STATE = {
  theme: null,
  verbose: false,
  editing: false,
  spacing: { fontSize: 12, cellPad: 1, subheadGap: 6 },
  tableScale: 100,
  panesPanelOpen: true,
  panesPanelHalf: false,
  panesPanelBox: { x: null, y: 70, width: 210, height: 0 },
  panesDocked: false,
  wrapAll: false,
  paneOrder: PANE_DEFS.map((pane) => pane.id),
  hiddenPanes: [],
  collapsedPanes: [],
  labels: {}, // label key -> new text, or null when hidden
  tables: {}, // pane id -> { columnOrder, columnWidths, sort, widthMode, wrap, rowOrder, cells, scale }
  stars: [], // artifact slugs starred inside this app
  shortcuts: {}, // shortcut task id -> key string, or null when unassigned
};
let state = loadState();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) {
      const merged = Object.assign(structuredClone(DEFAULT_STATE), saved);
      merged.spacing = Object.assign({}, DEFAULT_STATE.spacing, saved.spacing || {});
      merged.shortcuts = Object.assign({}, saved.shortcuts || {});
      if (!Array.isArray(merged.stars)) merged.stars = [];
      return merged;
    }
  } catch (error) { /* storage blocked: fall back to stock */ }
  return structuredClone(DEFAULT_STATE);
}
let syncTimer = null;
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (error) { /* storage blocked */ }
  // Writes cost budget, so wait for a 2-second pause after the last change
  // and only send real changes (pushPrefs also skips identical state).
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushPrefs, 2000);
}
let lastSyncedJson = null;
function pushPrefs() {
  const json = JSON.stringify(state);
  if (json === lastSyncedJson) return;
  fetch("api/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: json })
    .then((response) => { if (response.ok) lastSyncedJson = json; })
    .catch(() => { /* offline: the next change retries */ });
}
function pullPrefs() {
  fetch("api/prefs")
    .then((response) => (response.ok ? response.json() : null))
    .then((saved) => {
      if (!saved || !saved.paneOrder) return;
      state = Object.assign(structuredClone(DEFAULT_STATE), saved);
      state.spacing = Object.assign({}, DEFAULT_STATE.spacing, saved.spacing || {});
      state.shortcuts = Object.assign({}, saved.shortcuts || {});
      if (!Array.isArray(state.stars)) state.stars = [];
      lastSyncedJson = JSON.stringify(state);
      try { localStorage.setItem(STORAGE_KEY, lastSyncedJson); } catch (error) { /* storage blocked */ }
      render();
    })
    .catch(() => { /* keep the local copy */ });
}
function tableState(paneId) {
  if (!state.tables[paneId]) {
    state.tables[paneId] = { columnOrder: null, columnWidths: {}, sort: null, widthMode: "current", wrap: false, rowOrder: null, cells: {}, scale: 1 };
  }
  if (!state.tables[paneId].scale) state.tables[paneId].scale = 1;
  return state.tables[paneId];
}
function columnWidth(model, column) {
  const table = tableState(model.id);
  const base = table.columnWidths[column.id] || column.width;
  return Math.max(24, Math.round(base * table.scale * state.tableScale / 100));
}
function update(change) { change(); saveState(); render(); }

// ---------------------------------------------------------------------------
// Published data
// ---------------------------------------------------------------------------
let DATA = { sections: {} };
function sectionEntry(name) {
  return (DATA.sections && DATA.sections[name]) || null;
}
function sectionData(name) {
  const entry = sectionEntry(name);
  return entry && entry.data !== undefined ? entry.data : null;
}
function sectionStamp(name) {
  const entry = sectionEntry(name);
  return entry ? entry.stamp : null;
}
function loadData() {
  fetch("api/data")
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (payload && payload.sections) {
        DATA = payload;
        render();
        ensureFsLoaded();
      }
    })
    .catch(() => { /* panes keep their "No data published yet" rows */ });
}

// ---------------------------------------------------------------------------
// Formatting — dates mm/dd/yy, times hh:mm am/pm, America/Chicago.
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => "&#" + char.charCodeAt(0) + ";");
}
function twoDigits(number) { return String(number).padStart(2, "0"); }
const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", month: "2-digit", day: "2-digit", year: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: true,
});
const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", month: "2-digit", day: "2-digit", year: "2-digit",
});
// A stamp may be epoch ms, epoch s, or an ISO string.
function toDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value);
  const parsed = new Date(value);
  return isNaN(parsed) ? null : parsed;
}
function formatStamp(value) {
  const date = toDate(value);
  if (!date) return "";
  const parts = {};
  dateTimeFormat.formatToParts(date).forEach((part) => { parts[part.type] = part.value; });
  return parts.month + "/" + parts.day + "/" + parts.year + ", "
    + parts.hour + ":" + parts.minute + " " + String(parts.dayPeriod || "").toLowerCase();
}
function formatDay(value) {
  const date = toDate(value);
  if (!date) return String(value || "");
  const parts = {};
  dateFormat.formatToParts(date).forEach((part) => { parts[part.type] = part.value; });
  return parts.month + "/" + parts.day + "/" + parts.year;
}
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(bytes);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return (unit === 0 ? String(size) : size.toFixed(1)) + " " + units[unit];
}
function formatCount(number) {
  if (number == null || isNaN(number)) return "";
  return Number(number).toLocaleString("en-US");
}

// Labels can be renamed or hidden in edit mode. Returns null when hidden.
function labelText(key, stockText) {
  return Object.prototype.hasOwnProperty.call(state.labels, key) ? state.labels[key] : stockText;
}
function labelHtml(key, stockText, tagClass) {
  const text = labelText(key, stockText);
  const isChanged = Object.prototype.hasOwnProperty.call(state.labels, key);
  if (text === null && !state.editing) return "";
  const shown = text === null ? stockText : text;
  const tools = '<span class="lbl-tools">'
    + '<button data-label-rename="' + escapeHtml(key) + '" data-stock="' + escapeHtml(stockText) + '" title="Rename">✎</button>'
    + (text === null ? "" : '<button data-label-hide="' + escapeHtml(key) + '" title="Hide">✕</button>')
    + (isChanged ? '<button data-label-revert="' + escapeHtml(key) + '" title="Revert">↺</button>' : "")
    + "</span>";
  return '<span class="' + (tagClass || "") + (text === null ? " lbl-hidden" : "") + '" data-lk="' + escapeHtml(key) + '">' + escapeHtml(shown) + "</span>" + tools;
}

// ---------------------------------------------------------------------------
// Generic table panes — every remaining section publishes the same shape:
// { cols: [names], rows: [[cell, ...]], note?: string }.
// ---------------------------------------------------------------------------
function slugify(text, index) {
  const slug = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? "c-" + slug : "c" + index;
}
function chipToneFor(paneId, columnTitle, value) {
  const text = String(value || "");
  if (paneId === "connectors" || /status/i.test(columnTitle)) {
    if (/^connected/i.test(text) || /^verified/i.test(text) || /^latest/i.test(text)) return "good";
    if (/^behind/i.test(text)) return "warn";
    if (/^unreachable/i.test(text) || /not connected/i.test(text)) return "bad";
    return "idle";
  }
  if (/state/i.test(columnTitle)) {
    if (/^enabled/i.test(text) || /^working/i.test(text) || /^present/i.test(text) || /^configured/i.test(text)) return "good";
    if (/^missing/i.test(text)) return "bad";
    if (/^disabled/i.test(text) || /^\d/.test(text)) return "idle";
    return "warn";
  }
  if (paneId === "skills" && /where/i.test(columnTitle)) {
    return text === "Custom" ? "Muse" : "idle";
  }
  return "idle";
}
function isChipColumn(paneId, columnTitle) {
  if (/status|state/i.test(columnTitle)) return true;
  if (paneId === "skills" && /where/i.test(columnTitle)) return true;
  return false;
}
function genericModel(def) {
  const data = sectionData(def.section);
  if (!data || !Array.isArray(data.cols) || !Array.isArray(data.rows)) return null;
  const columns = data.cols.map((title, index) => {
    // First column reads widest; numeric-looking columns stay narrow.
    let width = 180;
    if (index === 0) width = 220;
    if (/questions|count|size/i.test(title)) width = 100;
    if (/share/i.test(title)) width = 140;
    if (/what|access|scope|detail|note|covers|purpose/i.test(title)) width = 380;
    return {
      id: slugify(title, index),
      title: String(title),
      width: width,
      type: isChipColumn(def.id, title) ? "chip" : (/questions|count/i.test(title) ? "num" : "text"),
      bar: !!data.barColumn && String(title) === String(data.barColumn),
      index: index,
    };
  });
  const rows = data.rows.map((cells, rowIndex) => {
    const row = { _id: def.id + "-" + rowIndex };
    columns.forEach((column) => { row[column.id] = cells[column.index]; });
    return row;
  });
  return { id: def.id, title: def.title, columns: columns, rows: rows, note: data.note || "", isNew: data.isNew === true };
}
function orderedColumns(model) {
  const order = tableState(model.id).columnOrder;
  if (!order) return model.columns;
  return order.map((id) => model.columns.find((column) => column.id === id)).filter(Boolean);
}
function cellValue(model, row, columnId) {
  const edits = tableState(model.id).cells[row._id];
  return edits && Object.prototype.hasOwnProperty.call(edits, columnId) ? edits[columnId] : row[columnId];
}
function orderedRows(model) {
  const table = tableState(model.id);
  let rows = model.rows.slice();
  if (table.rowOrder) rows.sort((a, b) => table.rowOrder.indexOf(a._id) - table.rowOrder.indexOf(b._id));
  if (table.sort) {
    const sortColumn = table.sort.column;
    const direction = table.sort.direction;
    rows.sort((a, b) => String(cellValue(model, a, sortColumn) || "").localeCompare(String(cellValue(model, b, sortColumn) || ""), undefined, { numeric: true }) * direction);
  }
  return rows;
}
function genericCellInner(model, column, row) {
  const value = cellValue(model, row, column.id);
  if (value === "" || value == null) return "";
  if (column.bar) {
    // A percent value rendered as a small bar plus the number (disk usage).
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    return '<span class="sharebar"><span class="sharebar-fill" style="width:' + percent + '%"></span></span>'
      + escapeHtml(value) + "%";
  }
  if (column.type === "chip") {
    return '<span class="chip ' + chipToneFor(model.id, column.title, value) + '">' + escapeHtml(value) + "</span>";
  }
  if (/^https?:\/\//.test(String(value))) {
    return '<a href="' + escapeHtml(value) + '" target="_blank" rel="noopener">' + escapeHtml(String(value).replace(/^https:\/\//, "")) + "</a>";
  }
  return escapeHtml(value);
}
function genericTableHtml(model) {
  const table = tableState(model.id);
  const columns = orderedColumns(model).filter((column) => labelText("col." + model.id + "." + column.id, column.title) !== null || state.editing);
  const totalWidth = columns.reduce((sum, column) => sum + columnWidth(model, column), 18);
  const isCurrent = table.widthMode === "current";
  const tableWidth = isCurrent ? totalWidth + "px" : "100%";
  let html = '<div class="tablewrap"><table class="' + (state.wrapAll || table.wrap ? "wrap" : "") + '" style="width:' + tableWidth + '"><colgroup>';
  columns.forEach((column) => { html += '<col style="width:' + columnWidth(model, column) + 'px">'; });
  html += '<col style="width:18px"></colgroup><thead><tr>';
  columns.forEach((column) => {
    const sort = table.sort && table.sort.column === column.id ? (table.sort.direction > 0 ? " ↑" : " ↓") : "";
    html += '<th draggable="true" data-col="' + column.id + '" data-pane-id="' + model.id + '" class="' + (column.type === "num" ? "num" : "") + '">'
      + '<span class="htext" data-sort="' + column.id + '">' + labelHtml("col." + model.id + "." + column.id, column.title) + '</span><span class="arrow">' + sort + "</span>"
      + '<span class="resizer" data-resize="' + column.id + '"></span></th>';
  });
  html += '<th class="endcol"></th></tr></thead><tbody>';
  if (!model.rows.length) {
    html += '<tr><td colspan="' + (columns.length + 1) + '" class="muted">No data published yet</td></tr>';
  }
  orderedRows(model).forEach((row) => {
    html += '<tr data-row="' + row._id + '">';
    columns.forEach((column) => {
      const edits = table.cells[row._id];
      const isEdited = edits && Object.prototype.hasOwnProperty.call(edits, column.id);
      html += '<td data-cell="' + column.id + '" class="' + (column.type === "num" ? "num" : "") + (isEdited ? " edited" : "") + '">'
        + genericCellInner(model, column, row)
        + (isEdited ? '<button class="revert" data-cell-revert="' + column.id + '" title="Revert">↺</button>' : "")
        + "</td>";
    });
    html += '<td class="endcol"><span class="grab" draggable="true" data-drag-row="' + row._id + '" title="Drag to move">⠿</span></td></tr>';
  });
  html += "</tbody></table></div>";
  if (model.note) html += '<div class="panefoot">' + escapeHtml(model.note) + "</div>";
  return html;
}

// ---------------------------------------------------------------------------
// Custom pane: Starred & pinned
// ---------------------------------------------------------------------------
function starredBodyHtml() {
  const pinsEntry = sectionEntry("pins");
  const artifactsData = sectionData("artifacts");
  const pins = pinsEntry && Array.isArray(pinsEntry.data) ? pinsEntry.data : null;
  const catalog = artifactsData && Array.isArray(artifactsData.catalog) ? artifactsData.catalog : [];
  const starredRows = catalog.filter((item) => state.stars.includes(item.slug));
  if (!pinsEntry && !artifactsData) {
    return '<div class="empty-row">No data published yet</div>';
  }
  let html = '<div class="subhead">Pinned in Artifacts 📌</div>';
  if (!pins || !pins.length) {
    html += '<div class="empty-row">Nothing pinned in the Artifacts app yet</div>';
  } else {
    html += '<div class="tablewrap"><table><colgroup><col style="width:44%"><col style="width:20%"><col style="width:18%"><col style="width:18%"></colgroup>'
      + "<thead><tr><th>Name</th><th>Type</th><th>Agent</th><th>Open</th></tr></thead><tbody>";
    pins.forEach((pin) => {
      let href = String(pin.link || "");
      if (href && !/^https?:\/\//.test(href)) href = ARTIFACTS_BASE + href.replace(/^\/+/, "");
      const nameCell = href
        ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(pin.name || pin.id || "") + "</a>"
        : escapeHtml(pin.name || pin.id || "");
      html += "<tr><td>" + nameCell + "</td>"
        + '<td>' + (pin.type ? '<span class="chip idle">' + escapeHtml(pin.type) + "</span>" : "") + "</td>"
        + '<td>' + (pin.agent ? '<span class="chip Muse">' + escapeHtml(pin.agent) + "</span>" : "") + "</td>"
        + "<td>" + (href ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">Open ↗</a>' : "") + "</td></tr>";
    });
    html += "</tbody></table></div>";
  }
  html += '<div class="subhead">Starred here ★</div>';
  if (!starredRows.length) {
    html += '<div class="empty-row">Nothing starred here yet — star a row in Artifacts &amp; hub</div>';
  } else {
    html += '<div class="tablewrap"><table><colgroup><col style="width:34px"><col></colgroup>'
      + "<thead><tr><th>★</th><th>Artifact</th></tr></thead><tbody>";
    starredRows.forEach((item) => {
      const nameCell = item.url
        ? '<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener">' + escapeHtml(item.name || item.slug) + "</a>"
        : escapeHtml(item.name || item.slug);
      html += '<tr><td><button class="star on" data-star-slug="' + escapeHtml(item.slug) + '" title="Unstar" aria-label="Unstar">★</button></td><td>' + nameCell + "</td></tr>";
    });
    html += "</tbody></table></div>";
  }
  return html;
}
function starredCount() {
  const pins = sectionEntry("pins");
  const pinCount = pins && Array.isArray(pins.data) ? pins.data.length : 0;
  return String(pinCount + state.stars.length);
}

// ---------------------------------------------------------------------------
// Custom pane: file system browser
// Cascading selects (one per depth), a breadcrumb, and the current folder's
// children fetched lazily from api/fs. Aggregate rows (node_modules, .git)
// render as one line and never expand.
// ---------------------------------------------------------------------------
const fsCache = {}; // path -> { stamp, children }
const fsPending = {};
let fsParts = []; // folder names below the root
function fsRoot() {
  const meta = sectionData("fsmeta");
  return (meta && meta.root) || "/home/hatch";
}
function fsCurrentPath() {
  const root = fsRoot();
  return fsParts.length ? root.replace(/\/+$/, "") + "/" + fsParts.join("/") : root;
}
function ensureFsLoaded() {
  const path = fsCurrentPath();
  if (fsCache[path] || fsPending[path]) return;
  fsPending[path] = true;
  fetch("api/fs?path=" + encodeURIComponent(path))
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      delete fsPending[path];
      if (payload) { fsCache[path] = payload; render(); }
    })
    .catch(() => { delete fsPending[path]; });
}
function fsChildren(path) {
  const entry = fsCache[path];
  return entry && Array.isArray(entry.children) ? entry.children : null;
}
function isDirChild(child) {
  return child.d === true || child.d === 1 || child.d === "dir" || child.d === "folder";
}
function fsBodyHtml() {
  const meta = sectionData("fsmeta");
  if (!sectionEntry("fsmeta")) return '<div class="empty-row">No data published yet</div>';
  const root = fsRoot();
  const currentPath = fsCurrentPath();
  const children = fsChildren(currentPath);

  // One select per depth level: level i lists the folders inside the path
  // formed by the choices above it.
  let selectsHtml = "";
  let walkPath = root;
  for (let level = 0; level <= fsParts.length; level += 1) {
    const siblings = fsChildren(walkPath);
    if (!siblings) break;
    const folders = siblings.filter(isDirChild).filter((child) => !child.agg);
    if (!folders.length && level > 0) break;
    if (level === fsParts.length && !folders.length) break;
    const chosen = fsParts[level] || "";
    selectsHtml += '<select data-fs-level="' + level + '" aria-label="Folder level ' + (level + 1) + '">'
      + '<option value="">' + (level === 0 ? "(root)" : "(here)") + "</option>"
      + folders.map((folder) => '<option value="' + escapeHtml(folder.n) + '"' + (folder.n === chosen ? " selected" : "") + ">" + escapeHtml(folder.n) + "</option>").join("")
      + "</select>";
    if (!chosen) break;
    walkPath = walkPath.replace(/\/+$/, "") + "/" + chosen;
  }

  // Breadcrumb: root plus one button per chosen segment.
  let crumbHtml = '<button data-fs-crumb="-1">' + escapeHtml(root) + "</button>";
  fsParts.forEach((part, index) => {
    crumbHtml += ' / <button data-fs-crumb="' + index + '">' + escapeHtml(part) + "</button>";
  });

  let detail = "";
  if (meta) {
    const bits = [];
    if (meta.totalFiles != null) bits.push(formatCount(meta.totalFiles) + " files");
    if (meta.totalDirs != null) bits.push(formatCount(meta.totalDirs) + " folders");
    if (meta.totalBytes != null) bits.push(formatBytes(meta.totalBytes));
    const walkStamp = meta.stamp || sectionStamp("fsmeta");
    if (walkStamp) bits.push("walk " + formatStamp(walkStamp));
    detail = bits.join(" · ");
  }

  let tableHtml = "";
  if (!children) {
    tableHtml = '<div class="empty-row">' + (fsPending[currentPath] ? "Loading…" : "No data published yet for this folder") + "</div>";
  } else {
    tableHtml = '<div class="tablewrap"><table><colgroup><col style="width:46%"><col style="width:12%"><col style="width:20%"><col style="width:22%"></colgroup>'
      + '<thead><tr><th>Name</th><th>Type</th><th class="num">Size</th><th class="num">Modified</th></tr></thead><tbody>';
    if (!children.length) tableHtml += '<tr><td colspan="4" class="muted">Empty folder</td></tr>';
    children.forEach((child) => {
      const modified = child.m != null ? formatStamp(child.m) : "";
      if (child.agg) {
        const fileCount = Array.isArray(child.agg) ? child.agg[0] : "";
        const byteCount = Array.isArray(child.agg) ? child.agg[1] : null;
        tableHtml += "<tr><td>" + escapeHtml(child.n) + '</td><td>Folder</td><td colspan="2" class="muted">'
          + formatCount(fileCount) + " files · " + formatBytes(byteCount) + " · contents not itemized</td></tr>";
        return;
      }
      const dir = isDirChild(child);
      tableHtml += '<tr' + (dir ? ' class="fs-dir" data-fs-open="' + escapeHtml(child.n) + '"' : "") + ">"
        + "<td>" + escapeHtml(child.n) + "</td>"
        + "<td>" + (dir ? "Folder" : "File") + "</td>"
        + '<td class="num">' + (dir ? "—" : formatBytes(child.s)) + "</td>"
        + '<td class="num">' + escapeHtml(modified) + "</td></tr>";
    });
    tableHtml += "</tbody></table></div>";
  }
  return '<div class="fs-controls"><div class="fs-selects">' + selectsHtml + '</div>'
    + '<div class="fs-crumb mono">' + crumbHtml + "</div>"
    + (detail ? '<div class="fs-detail">' + escapeHtml(detail) + "</div>" : "")
    + "</div>" + tableHtml;
}
function fsCount() {
  const meta = sectionData("fsmeta");
  if (!meta) return "";
  const bits = [];
  if (meta.totalFiles != null) bits.push(formatCount(meta.totalFiles) + " files");
  if (meta.totalBytes != null) bits.push(formatBytes(meta.totalBytes));
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// Custom pane: Preferences
// Files grouped by kind; clicking a file loads its body from api/prefbody
// into a viewer at the top of the pane. Below, the change timeline grouped
// by day, with change-type filter chips and a text search.
// ---------------------------------------------------------------------------
const PREF_KIND_ORDER = ["core", "standing-rules", "profile", "synthesis", "other", "daily-log", "skill"];
const PREF_KIND_LABELS = {
  "core": "Core", "standing-rules": "Standing rules", "profile": "Profile",
  "synthesis": "Synthesis", "other": "Other", "daily-log": "Daily logs", "skill": "Skills",
};
const CHANGE_TONES = { set: "good", amended: "accent", superseded: "idle", dropped: "bad", corrected: "warn" };
const prefUi = {
  openId: null,
  openBody: null, // { name, path, body }
  openLoading: false,
  activeChanges: null, // null = all on; otherwise a Set of enabled change types
  query: "",
};
function prefChangeTypes(timeline) {
  const seen = [];
  (timeline || []).forEach((entry) => {
    if (entry.change && !seen.includes(entry.change)) seen.push(entry.change);
  });
  return seen;
}
function prefBodyHtml() {
  const data = sectionData("prefs");
  if (!data) return '<div class="empty-row">No data published yet</div>';
  const files = Array.isArray(data.files) ? data.files : [];
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  let html = "";

  // Viewer for the currently opened file body.
  if (prefUi.openId != null) {
    html += '<div class="pref-viewer"><div class="pref-viewer-head">'
      + '<span class="path">' + escapeHtml(prefUi.openBody ? (prefUi.openBody.path || prefUi.openBody.name || "") : "") + "</span>"
      + '<button class="tool" data-pref-close title="Close">✕</button></div>'
      + (prefUi.openLoading
        ? '<div class="empty-row">Loading…</div>'
        : "<pre>" + escapeHtml(prefUi.openBody ? (prefUi.openBody.body || "") : "No data published yet") + "</pre>")
      + "</div>";
  }

  // Files grouped by kind, in the fixed kind order; unknown kinds go last.
  const kinds = PREF_KIND_ORDER.concat(files.map((file) => file.kind).filter((kind) => kind && !PREF_KIND_ORDER.includes(kind)));
  const uniqueKinds = kinds.filter((kind, index) => kinds.indexOf(kind) === index);
  uniqueKinds.forEach((kind) => {
    const group = files.filter((file) => (file.kind || "other") === kind);
    if (!group.length) return;
    html += '<div class="subhead">' + escapeHtml(PREF_KIND_LABELS[kind] || kind) + "</div>";
    html += '<div class="tablewrap"><table><colgroup><col style="width:42%"><col style="width:40%"><col style="width:18%"></colgroup>'
      + '<thead><tr><th>File</th><th>Role</th><th class="num">Size</th></tr></thead><tbody>';
    group.forEach((file) => {
      const fileName = String(file.path || file.id || "").split("/").pop() || String(file.id || "");
      html += '<tr class="pref-file" data-pref-file="' + escapeHtml(file.id) + '"><td>' + escapeHtml(fileName) + "</td>"
        + "<td>" + escapeHtml(file.role || "") + '</td><td class="num">' + escapeHtml(file.size != null ? formatBytes(file.size) : "") + "</td></tr>";
    });
    html += "</tbody></table></div>";
  });

  // Timeline: filter chips + search, then entries grouped by day.
  const changeTypes = prefChangeTypes(timeline);
  html += '<div class="pref-filters">'
    + changeTypes.map((type) => {
      const on = !prefUi.activeChanges || prefUi.activeChanges.has(type);
      return '<button class="fchip" data-change="' + escapeHtml(type) + '" data-pref-filter="' + escapeHtml(type) + '" aria-pressed="' + on + '">' + escapeHtml(type) + "</button>";
    }).join("")
    + '<input type="search" id="prefSearch" placeholder="Search changes…" value="' + escapeHtml(prefUi.query) + '" aria-label="Search changes">'
    + "</div>";

  const query = prefUi.query.trim().toLowerCase();
  const visible = timeline.filter((entry) => {
    if (prefUi.activeChanges && !prefUi.activeChanges.has(entry.change)) return false;
    if (query && !(String(entry.preference || "") + " " + String(entry.detail || "")).toLowerCase().includes(query)) return false;
    return true;
  });
  const sorted = visible.slice().sort((a, b) => {
    const dateA = toDate(a.date);
    const dateB = toDate(b.date);
    return (dateB ? dateB.getTime() : 0) - (dateA ? dateA.getTime() : 0);
  });
  html += '<div class="subhead">Timeline <span class="count">showing ' + sorted.length + " of " + timeline.length + "</span></div>";
  if (!sorted.length) {
    html += '<div class="empty-row">No changes match</div>';
  } else {
    html += '<div class="tablewrap"><table><colgroup><col style="width:11%"><col style="width:24%"><col style="width:47%"><col style="width:18%"></colgroup>'
      + "<thead><tr><th>Change</th><th>Preference</th><th>Detail</th><th>Source</th></tr></thead><tbody>";
    let lastDay = null;
    sorted.forEach((entry) => {
      const day = formatDay(entry.date);
      if (day !== lastDay) {
        lastDay = day;
        html += '<tr class="group-row"><td colspan="4">' + escapeHtml(day) + "</td></tr>";
      }
      const tone = CHANGE_TONES[String(entry.change || "").toLowerCase()] || "idle";
      html += "<tr><td>" + (entry.change ? '<span class="chip ' + tone + '">' + escapeHtml(entry.change) + "</span>" : "") + "</td>"
        + "<td>" + escapeHtml(entry.preference || "") + "</td>"
        + "<td>" + escapeHtml(entry.detail || "") + "</td>"
        + "<td>" + escapeHtml(entry.source || "") + "</td></tr>";
    });
    html += "</tbody></table></div>";
  }
  return html;
}
function openPrefBody(id) {
  prefUi.openId = id;
  prefUi.openBody = null;
  prefUi.openLoading = true;
  render();
  fetch("api/prefbody?id=" + encodeURIComponent(id))
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (prefUi.openId !== id) return;
      prefUi.openLoading = false;
      prefUi.openBody = payload;
      render();
    })
    .catch(() => {
      if (prefUi.openId !== id) return;
      prefUi.openLoading = false;
      render();
    });
}
function prefCount() {
  const data = sectionData("prefs");
  if (!data) return "";
  const files = Array.isArray(data.files) ? data.files.length : 0;
  const changes = Array.isArray(data.timeline) ? data.timeline.length : 0;
  return files + " files · " + changes + " changes";
}

// ---------------------------------------------------------------------------
// Custom pane: Usage & billing — plan table plus one labeled sub-table per
// ledger. Each ledger keeps its own source and stamp; never a single %.
// ---------------------------------------------------------------------------
function usageBodyHtml() {
  const data = sectionData("usage");
  if (!data) return '<div class="empty-row">No data published yet</div>';
  let html = "";
  if (data.plan) {
    html += '<div class="tablewrap"><table><colgroup><col style="width:24%"><col></colgroup>'
      + "<thead><tr><th>Plan</th><th></th></tr></thead><tbody>";
    if (data.plan.tier) html += "<tr><td>Tier</td><td><b>" + escapeHtml(data.plan.tier) + "</b></td></tr>";
    if (data.plan.allowance) html += "<tr><td>Allowance</td><td>" + escapeHtml(data.plan.allowance) + "</td></tr>";
    if (data.plan.note) html += "<tr><td>Note</td><td>" + escapeHtml(data.plan.note) + "</td></tr>";
    html += "</tbody></table></div>";
  }
  const ledgers = Array.isArray(data.ledgers) ? data.ledgers : [];
  ledgers.forEach((ledger) => {
    const stampText = ledger.stamp ? " · as of " + formatStamp(ledger.stamp) : "";
    html += '<div class="subhead">' + escapeHtml(ledger.source || "Ledger") + ' <span class="count">' + escapeHtml(stampText.replace(/^ · /, "")) + "</span></div>";
    const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
    if (!rows.length) {
      html += '<div class="empty-row">No rows</div>';
      return;
    }
    html += '<div class="tablewrap"><table><colgroup><col style="width:38%"><col></colgroup><tbody>';
    rows.forEach((pair) => {
      if (!Array.isArray(pair)) return;
      html += "<tr><td>" + escapeHtml(pair[0]) + "</td><td>" + escapeHtml(pair[1]) + "</td></tr>";
    });
    html += "</tbody></table></div>";
  });
  if (!data.plan && !ledgers.length) html = '<div class="empty-row">No data published yet</div>';
  return html;
}
function usageCount() {
  const data = sectionData("usage");
  if (!data) return "";
  return data.plan && data.plan.tier ? String(data.plan.tier) : "";
}

// ---------------------------------------------------------------------------
// Custom pane: Artifacts & hub — registry counts, per-agent chips, and the
// Muse catalog with star toggles that feed the Starred pane.
// ---------------------------------------------------------------------------
function artifactsBodyHtml() {
  const data = sectionData("artifacts");
  if (!data) return '<div class="empty-row">No data published yet</div>';
  let html = "";
  if (data.registry) {
    const registry = data.registry;
    const stampText = registry.stamp ? " · as of " + formatStamp(registry.stamp) : "";
    html += '<div class="subhead">Registry <span class="count">' + escapeHtml(String(registry.total != null ? registry.total : "") + " Active" + stampText) + "</span></div>";
    if (registry.byAgent) {
      html += '<div style="padding:0 6px 4px">'
        + Object.keys(registry.byAgent).map((agent) => '<span class="chip Muse">' + escapeHtml(agent) + " " + escapeHtml(registry.byAgent[agent]) + "</span>").join(" ")
        + "</div>";
    }
  }
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  html += '<div class="subhead">Muse catalog <span class="count">' + catalog.length + "</span></div>";
  if (!catalog.length) {
    html += '<div class="empty-row">No data published yet</div>';
  } else {
    html += '<div class="tablewrap"><table><colgroup><col><col style="width:40px"></colgroup>'
      + "<thead><tr><th>Name</th><th>★</th></tr></thead><tbody>";
    catalog.forEach((item) => {
      const on = state.stars.includes(item.slug);
      const nameCell = item.url
        ? '<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener">' + escapeHtml(item.name || item.slug) + "</a>"
        : escapeHtml(item.name || item.slug);
      html += "<tr><td>" + nameCell + '</td><td><button class="star' + (on ? " on" : "") + '" data-star-slug="' + escapeHtml(item.slug) + '" title="' + (on ? "Unstar" : "Star") + '" aria-label="Star">' + (on ? "★" : "☆") + "</button></td></tr>";
    });
    html += "</tbody></table></div>";
  }
  if (data.hub && data.hub.note) html += '<div class="panefoot">' + escapeHtml(data.hub.note) + "</div>";
  return html;
}
function artifactsCount() {
  const data = sectionData("artifacts");
  if (!data) return "";
  const catalogCount = Array.isArray(data.catalog) ? data.catalog.length : 0;
  const total = data.registry && data.registry.total != null ? data.registry.total : "";
  return catalogCount + " in catalog" + (total !== "" ? " · " + total + " in registry" : "");
}

// ---------------------------------------------------------------------------
// Pane shell + rendering
// ---------------------------------------------------------------------------
const CUSTOM_RENDERERS = {
  starred: { body: starredBodyHtml, count: starredCount, stamp: () => latestStamp(["pins", "artifacts"]) },
  fs: { body: fsBodyHtml, count: fsCount, stamp: () => sectionStamp("fsmeta") },
  preferences: { body: prefBodyHtml, count: prefCount, stamp: () => sectionStamp("prefs") },
  usage: { body: usageBodyHtml, count: usageCount, stamp: () => sectionStamp("usage") },
  artifacts: { body: artifactsBodyHtml, count: artifactsCount, stamp: () => sectionStamp("artifacts") },
};
function latestStamp(names) {
  let best = null;
  names.forEach((name) => {
    const stamp = sectionStamp(name);
    const date = toDate(stamp);
    if (date && (!best || date.getTime() > best.time)) best = { time: date.getTime(), value: stamp };
  });
  return best ? best.value : null;
}
function paneCountText(def) {
  if (def.custom && CUSTOM_RENDERERS[def.custom]) return CUSTOM_RENDERERS[def.custom].count();
  const model = genericModel(def);
  return model ? String(model.rows.length) : "";
}
function paneStampValue(def) {
  if (def.custom && CUSTOM_RENDERERS[def.custom]) return CUSTOM_RENDERERS[def.custom].stamp();
  return sectionStamp(def.section);
}
function paneBodyHtml(def) {
  if (def.custom && CUSTOM_RENDERERS[def.custom]) return CUSTOM_RENDERERS[def.custom].body();
  const model = genericModel(def);
  if (!model) return '<div class="empty-row">No data published yet</div>';
  return genericTableHtml(model);
}
function paneHtml(def) {
  const table = tableState(def.id);
  const collapsed = state.collapsedPanes.includes(def.id);
  const widthLabels = { current: "↔", "100": "100%", "50": "50%", "25": "25%" };
  const isCurrent = table.widthMode === "current";
  // Generic panes hug their table in "current" mode; custom panes fill the row.
  const paneWidth = isCurrent ? (def.custom ? "100%" : "fit-content") : table.widthMode + "%";
  const stamp = paneStampValue(def);
  const count = paneCountText(def);
  const paneData = def.custom ? null : sectionData(def.section);
  const isNew = !!(paneData && paneData.isNew === true);
  let html = '<section class="pane' + (collapsed ? " collapsed" : "") + (isNew ? " pane-new" : "") + '" data-pane="' + def.id + '" style="width:' + paneWidth + '">'
    + '<div class="panehead">'
    + '<button class="caret" data-collapse="' + def.id + '" aria-label="Collapse">' + (collapsed ? "▶" : "▼") + "</button>"
    + labelHtml("pane." + def.id, def.title, "panetitle")
    + (isNew ? '<span class="chip new">NEW</span>' : "")
    + (count !== "" ? '<span class="count">' + escapeHtml(count) + "</span>" : "")
    + (stamp ? '<span class="panestamp">as of ' + escapeHtml(formatStamp(stamp)) + "</span>" : "")
    + '<span class="tools">'
    + '<button class="tool" data-width="' + def.id + '" title="Table width: current → 100% → 50% → 25%">' + (widthLabels[table.widthMode] || table.widthMode + "%") + "</button>"
    + '<button class="tool" data-hide-pane="' + def.id + '" title="Hide pane">✕</button>'
    + '<span class="grab" draggable="true" data-drag-pane="' + def.id + '" title="Drag to move">⠿</span>'
    + "</span></div>";
  if (state.verbose) html += '<div class="desc">' + labelHtml("desc." + def.id, def.description) + "</div>";
  html += '<div class="panebody">' + paneBodyHtml(def) + "</div>"
    + '<div class="pp-rs-e" data-table-resize="' + def.id + '" title="Drag to resize"></div>'
    + '<div class="pp-rs" data-table-resize="' + def.id + '" title="Drag to resize"></div></section>';
  return html;
}
function statsLineText() {
  const data = sectionData("counts");
  if (!data) return "";
  const bits = [];
  const vm = data.vm || {};
  if (vm.os) bits.push("VM " + vm.os);
  if (vm.kernel) bits.push("kernel " + vm.kernel);
  if (vm.cpu != null) bits.push(typeof vm.cpu === "number" ? vm.cpu + " vCPU" : String(vm.cpu));
  if (vm.ramMb != null) bits.push((Number(vm.ramMb) / 1024).toFixed(1) + " GB RAM");
  if (vm.diskUsed && vm.diskTotal) bits.push("disk " + vm.diskUsed + " / " + vm.diskTotal);
  else if (vm.diskTotal) bits.push("disk " + vm.diskTotal);
  if (vm.uptime) bits.push("up " + vm.uptime);
  if (data.files != null) bits.push(formatCount(data.files) + " files");
  if (data.artifacts != null) bits.push(formatCount(data.artifacts) + " artifacts");
  if (data.crons) bits.push("crons " + data.crons);
  return bits.join(" · ");
}
function render() {
  const root = document.documentElement;
  if (state.theme) root.setAttribute("data-theme", state.theme); else root.removeAttribute("data-theme");
  root.style.setProperty("--fs", state.spacing.fontSize + "px");
  root.style.setProperty("--cell-pad", state.spacing.cellPad + "px");
  root.style.setProperty("--subhead-gap", state.spacing.subheadGap + "px");
  document.body.classList.toggle("editing", state.editing);

  const isDark = state.theme ? state.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const themeButton = document.getElementById("themeButton");
  themeButton.textContent = isDark ? "☀️" : "🌙";
  themeButton.title = isDark ? "Light mode" : "Dark mode";

  const title = document.querySelector("h1");
  title.innerHTML = labelHtml("page.title", title.dataset.stock);
  const newest = latestStamp(Object.keys(DATA.sections || {}));
  document.getElementById("stamp").textContent = newest ? "as of " + formatStamp(newest) : "";
  document.getElementById("statsLine").textContent = statsLineText();

  // Keep the saved order complete, so panes added later still have a place.
  const order = state.paneOrder.concat(PANE_DEFS.map((pane) => pane.id).filter((id) => !state.paneOrder.includes(id)));
  state.paneOrder = order;
  renderPanesPanel(order);
  document.getElementById("panesButton").setAttribute("aria-pressed", String(state.panesPanelOpen));
  document.getElementById("panes").innerHTML = order
    .filter((id) => !state.hiddenPanes.includes(id))
    .map((id) => PANE_DEFS.find((pane) => pane.id === id))
    .filter(Boolean)
    .map(paneHtml)
    .join("");
  // The preferences search box keeps its value across renders; restore focus
  // and caret when the re-render was caused by typing in it.
  if (prefSearchHadFocus) {
    const search = document.getElementById("prefSearch");
    if (search) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
    prefSearchHadFocus = false;
  }
}
let prefSearchHadFocus = false;

// ---------------------------------------------------------------------------
// Floating panes window
// ---------------------------------------------------------------------------
const EYE_OPEN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.7M6.2 7.4A17 17 0 002 12s4 7 10 7a9 9 0 004.1-1"/></svg>';
const CLOSE_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const HALF_PANEL_MIN_WIDTH = 110;
function panelBox() {
  if (!state.panesPanelBox) state.panesPanelBox = { x: null, y: 70, width: 210, height: 0 };
  const box = state.panesPanelBox;
  const x = box.x == null ? Math.max(16, innerWidth - box.width - 16) : box.x;
  return { x: x, y: box.y, width: box.width, height: box.height };
}
function renderPanesPanel(order) {
  const host = document.getElementById("panesPanel");
  document.getElementById("layout").classList.toggle("docked", state.panesDocked);
  const box = panelBox();
  if (!state.panesPanelOpen) {
    host.className = "pp-chip";
    host.setAttribute("data-panel-move", "");
    host.setAttribute("data-panel-open", "");
    host.setAttribute("role", "button");
    host.setAttribute("tabindex", "0");
    host.style.cssText = state.panesDocked ? "" : "left:" + box.x + "px;top:" + box.y + "px;";
    host.textContent = (labelText("panel.title", "Panes") || "Panes") + " ›";
    return;
  }
  host.className = "panespanel" + (state.panesPanelHalf ? " half" : "");
  host.removeAttribute("data-panel-move");
  host.removeAttribute("data-panel-open");
  host.removeAttribute("role");
  host.removeAttribute("tabindex");
  const width = state.panesPanelHalf ? Math.max(HALF_PANEL_MIN_WIDTH, Math.round(box.width / 2)) : box.width;
  let style = (state.panesDocked ? "" : "left:" + box.x + "px;top:" + box.y + "px;") + "width:" + width + "px;";
  if (box.height) style += "height:" + (state.panesPanelHalf ? Math.max(90, Math.round(box.height / 2)) : box.height) + "px;";
  host.style.cssText = style;
  const hiddenCount = state.hiddenPanes.length;
  let html = '<div class="pp-head" data-panel-move><span class="pp-title">' + escapeHtml(labelText("panel.title", "Panes") || "Panes") + "</span>"
    + (hiddenCount ? '<span class="pp-count">' + hiddenCount + " hidden</span>" : "")
    + '<span class="pp-actions">'
    + '<button class="pp-btn" data-panel-half aria-pressed="' + state.panesPanelHalf + '" title="Half size">½</button>'
    + '<button class="pp-btn" data-panel-close title="Close" aria-label="Close panes window">' + CLOSE_ICON + "</button>"
    + '</span></div><div class="pp-body">';
  order.forEach((id) => {
    const def = PANE_DEFS.find((candidate) => candidate.id === id);
    if (!def) return;
    const isHidden = state.hiddenPanes.includes(id);
    html += '<div class="pp-row' + (isHidden ? " is-hidden" : "") + '" data-pane="' + id + '">'
      + '<button class="pp-eye" data-toggle-pane="' + id + '" title="' + (isHidden ? "Show" : "Hide") + '">' + (isHidden ? EYE_SHUT : EYE_OPEN) + "</button>"
      + '<span class="grab" draggable="true" data-drag-pane="' + id + '" title="Drag to move">⠿</span>'
      + '<button class="pp-name" data-jump="' + id + '">' + escapeHtml(labelText("pane." + id, def.title) || def.title) + "</button>"
      + '<span class="count">' + escapeHtml(paneCountText(def)) + "</span></div>";
  });
  html += "</div>"
    + '<div class="pp-rs-e" data-pp-resize="x" title="Drag to resize"></div>'
    + '<div class="pp-rs" data-pp-resize="xy" title="Drag to resize"></div>';
  host.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Moving and resizing the panes window + table resize
// ---------------------------------------------------------------------------
let panelDrag = null;
let suppressPanelClick = false;
let tableDrag = null;
function startTableResize(event, handle) {
  event.preventDefault();
  const paneId = handle.dataset.tableResize;
  const table = tableState(paneId);
  table.widthMode = "current";
  tableDrag = { paneId: paneId, startX: event.clientX, startScale: table.scale, startWidth: handle.closest(".pane").offsetWidth };
}
document.addEventListener("pointermove", (event) => {
  if (!tableDrag) return;
  const newWidth = Math.max(120, tableDrag.startWidth + event.clientX - tableDrag.startX);
  const scale = tableDrag.startScale * newWidth / tableDrag.startWidth;
  tableState(tableDrag.paneId).scale = Math.min(3, Math.max(0.3, Math.round(scale * 100) / 100));
  render();
});
document.addEventListener("pointerup", () => { if (tableDrag) { tableDrag = null; saveState(); } });
function panelFloats() { return innerWidth > 700; }
document.addEventListener("pointerdown", (event) => {
  if (event.button > 0) return;
  const tableHandle = event.target.closest("[data-table-resize]");
  if (tableHandle) { startTableResize(event, tableHandle); return; }
  if (!panelFloats()) return;
  const host = document.getElementById("panesPanel");
  const resizeHandle = event.target.closest("[data-pp-resize]");
  if (resizeHandle) {
    event.preventDefault();
    panelDrag = { mode: resizeHandle.dataset.ppResize, startX: event.clientX, startY: event.clientY, originWidth: host.offsetWidth, originHeight: host.offsetHeight };
    return;
  }
  const moveHandle = event.target.closest("[data-panel-move]");
  if (moveHandle && !state.panesDocked && !event.target.closest("button")) {
    const box = host.getBoundingClientRect();
    panelDrag = { mode: "move", startX: event.clientX, startY: event.clientY, originX: box.left, originY: box.top, moved: false };
  }
});
document.addEventListener("pointermove", (event) => {
  if (!panelDrag) return;
  const style = document.getElementById("panesPanel").style;
  const deltaX = event.clientX - panelDrag.startX;
  const deltaY = event.clientY - panelDrag.startY;
  if (Math.abs(deltaX) + Math.abs(deltaY) > 4) panelDrag.moved = true;
  if (panelDrag.mode === "move") {
    style.left = Math.max(0, Math.min(innerWidth - 60, panelDrag.originX + deltaX)) + "px";
    style.top = Math.max(0, Math.min(innerHeight - 40, panelDrag.originY + deltaY)) + "px";
  } else {
    style.width = Math.max(150, Math.min(520, panelDrag.originWidth + deltaX)) + "px";
    if (panelDrag.mode === "xy") style.height = Math.max(90, panelDrag.originHeight + deltaY) + "px";
  }
});
document.addEventListener("pointerup", () => {
  if (!panelDrag) return;
  const host = document.getElementById("panesPanel");
  const saved = state.panesPanelBox;
  if (panelDrag.mode === "move") {
    const box = host.getBoundingClientRect();
    saved.x = Math.round(box.left);
    saved.y = Math.round(box.top);
    if (panelDrag.moved) {
      suppressPanelClick = true;
      setTimeout(() => { suppressPanelClick = false; }, 0);
    }
  } else {
    const scale = state.panesPanelHalf ? 2 : 1;
    saved.width = host.offsetWidth * scale;
    if (panelDrag.mode === "xy") saved.height = host.offsetHeight * scale;
  }
  panelDrag = null;
  saveState();
});

// ---------------------------------------------------------------------------
// Shortcuts — assignable keys (artifacts / hubv2 model). Stock assignments
// live in SHORTCUT_TASKS; overrides live in state.shortcuts and sync through
// api/prefs like the rest of the view state. A key already in use is flagged
// in the dialog, never silently taken from its task.
// ---------------------------------------------------------------------------
const SHORTCUT_TASKS = [
  { id: "edit", label: "Toggle edit mode", stockKey: "e" },
  { id: "menu", label: "Toggle burger menu", stockKey: "ctrl" },
  { id: "expand", label: "Toggle expand / collapse all panes", stockKey: "a" },
  { id: "dock", label: "Toggle left task pane", stockKey: "b" },
  { id: "wrap", label: "Toggle text wrap (all tables)", stockKey: "w" },
  { id: "theme", label: "Toggle theme", stockKey: "t" },
  { id: "panes", label: "Toggle Panes panel", stockKey: "p" },
  { id: "changelog", label: "Open Changelog", stockKey: "l" },
  { id: "history", label: "Open Code history", stockKey: "h" },
  { id: "shortcuts", label: "Open Shortcuts", stockKey: "k" },
];
function shortcutKey(taskId) {
  if (Object.prototype.hasOwnProperty.call(state.shortcuts, taskId)) return state.shortcuts[taskId];
  const task = SHORTCUT_TASKS.find((candidate) => candidate.id === taskId);
  return task ? task.stockKey : null;
}
function formatKey(key) {
  if (!key) return "—";
  return key.split("+").map((part) => {
    if (part === "ctrl") return "Ctrl";
    if (part === "space") return "Space";
    return part.length === 1 ? part.toUpperCase() : part;
  }).join("+");
}
function toggleTheme() {
  const isDark = state.theme ? state.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  update(() => { state.theme = isDark ? "light" : "dark"; });
}
function toggleExpandCollapseAll() {
  const allCollapsed = PANE_DEFS.every((pane) => state.collapsedPanes.includes(pane.id));
  update(() => { state.collapsedPanes = allCollapsed ? [] : PANE_DEFS.map((pane) => pane.id); });
}
function toggleLeftTaskPane() {
  // The Panes panel docked on the left: hide it if it is showing docked,
  // otherwise dock it and show it.
  update(() => {
    if (state.panesDocked && state.panesPanelOpen) state.panesPanelOpen = false;
    else { state.panesDocked = true; state.panesPanelOpen = true; }
  });
}
function runShortcut(taskId) {
  if (taskId === "edit") update(() => { state.editing = !state.editing; });
  else if (taskId === "menu") openMenu();
  else if (taskId === "expand") toggleExpandCollapseAll();
  else if (taskId === "dock") toggleLeftTaskPane();
  else if (taskId === "wrap") update(() => { state.wrapAll = !state.wrapAll; });
  else if (taskId === "theme") toggleTheme();
  else if (taskId === "panes") update(() => { state.panesPanelOpen = !state.panesPanelOpen; });
  else if (taskId === "changelog") window.location.href = "changelog.html";
  else if (taskId === "history") window.location.href = "code-history.html";
  else if (taskId === "shortcuts") openShortcuts();
}
function shortcutsTipHtml() {
  return SHORTCUT_TASKS.map((task) => formatKey(shortcutKey(task.id)) + " — " + task.label).join("<br>");
}

let shortcutCapture = null;   // task id currently capturing a key, if any
let shortcutConflict = null;  // { a, b, key } when an assignment collides
let captureCtrlArmed = false; // bare Ctrl seen during capture, awaiting keyup
function openShortcuts() {
  closeMenu();
  renderShortcuts();
}
function closeShortcuts() {
  const host = document.getElementById("shortcutsHost");
  if (host) host.innerHTML = "";
  shortcutCapture = null;
  shortcutConflict = null;
  captureCtrlArmed = false;
}
function renderShortcuts() {
  const host = document.getElementById("shortcutsHost");
  if (!host) return;
  let rows = "";
  SHORTCUT_TASKS.forEach((task) => {
    const key = shortcutKey(task.id);
    const isCustom = Object.prototype.hasOwnProperty.call(state.shortcuts, task.id);
    const inConflict = shortcutConflict && (shortcutConflict.a === task.id || shortcutConflict.b === task.id);
    const capturing = shortcutCapture === task.id;
    rows += '<div class="sc-row' + (inConflict ? " conflict" : "") + '">'
      + '<span class="sc-label">' + escapeHtml(task.label) + "</span>"
      + '<button class="sc-key' + (capturing ? " capturing" : "") + '" data-sc-capture="' + task.id + '">'
      + (capturing ? "Press a key…" : escapeHtml(formatKey(key))) + "</button>"
      + (isCustom ? '<button class="sc-revert" data-sc-revert="' + task.id + '" title="Back to the stock key">↺</button>' : '<span class="sc-revert-slot"></span>')
      + "</div>";
  });
  let note = "Click a key to reassign it. Backspace clears a key; Esc cancels a capture.";
  if (shortcutConflict) {
    const other = SHORTCUT_TASKS.find((task) => task.id === shortcutConflict.b);
    note = formatKey(shortcutConflict.key) + " is already assigned to “" + (other ? other.label : "") + "” — pick another key.";
  }
  host.innerHTML = '<div class="sc-overlay" data-sc-overlay><div class="sc-window" role="dialog" aria-label="Shortcuts">'
    + '<div class="sc-head"><span>Shortcuts</span><button class="sc-close" data-sc-close aria-label="Close">✕</button></div>'
    + '<div class="sc-note' + (shortcutConflict ? " conflict" : "") + '">' + escapeHtml(note) + "</div>"
    + rows
    + '<div class="sc-foot"><button data-sc-reset>Reset all</button><button data-sc-close>Done</button></div>'
    + "</div></div>";
}
function assignShortcut(taskId, key) {
  if (key) {
    const other = SHORTCUT_TASKS.find((task) => task.id !== taskId && shortcutKey(task.id) === key);
    if (other) {
      // Flag the collision in red; neither assignment changes.
      shortcutConflict = { a: taskId, b: other.id, key: key };
      shortcutCapture = null;
      renderShortcuts();
      return;
    }
  }
  shortcutConflict = null;
  shortcutCapture = null;
  update(() => {
    const task = SHORTCUT_TASKS.find((candidate) => candidate.id === taskId);
    if (key === null) state.shortcuts[taskId] = null;
    else if (task && key === task.stockKey) delete state.shortcuts[taskId];
    else state.shortcuts[taskId] = key;
  });
  renderShortcuts();
}

// ---------------------------------------------------------------------------
// Burger menu
// ---------------------------------------------------------------------------
function closeMenu() { document.getElementById("menuHost").innerHTML = ""; }
function slider(key, text, min, max, step, unit, value) {
  return '<div class="slider"><span>' + text + '</span><span id="' + key + 'Value">' + value + unit + "</span>"
    + '<input type="range" id="' + key + 'Slider" data-slider="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '" aria-label="' + text + '"></div>';
}
function openMenu() {
  const host = document.getElementById("menuHost");
  if (host.innerHTML) { closeMenu(); return; }
  const hidden = state.hiddenPanes.map((id) => PANE_DEFS.find((pane) => pane.id === id)).filter(Boolean);
  const keyHint = (taskId) => '<span class="kbd">' + escapeHtml(formatKey(shortcutKey(taskId))) + "</span>";
  let html = '<div class="menu" role="menu">'
    + '<div class="h">History</div>'
    + '<a class="item" href="changelog.html">Changelog ' + keyHint("changelog") + '</a>'
    + '<a class="item" href="code-history.html">Code history ' + keyHint("history") + '</a><hr>'
    + '<label class="item">Edit mode ' + keyHint("edit") + '<input type="checkbox" id="editToggle"' + (state.editing ? " checked" : "") + "></label>"
    + '<label class="item">Verbose <input type="checkbox" id="verboseToggle"' + (state.verbose ? " checked" : "") + "></label>"
    + '<label class="item">Wrap text ' + keyHint("wrap") + '<input type="checkbox" id="wrapToggle"' + (state.wrapAll ? " checked" : "") + "></label>"
    + '<label class="item">Left task pane ' + keyHint("dock") + '<input type="checkbox" id="dockToggle"' + (state.panesDocked && state.panesPanelOpen ? " checked" : "") + "></label><hr>"
    + '<span class="btn-tip-host"><button class="item" data-menu="shortcuts">Shortcuts ' + keyHint("shortcuts") + '</button><span class="btn-tip">' + shortcutsTipHtml() + "</span></span>"
    + '<button class="item" data-menu="collapse-all">Collapse all ' + keyHint("expand") + '</button>'
    + '<button class="item" data-menu="expand-all">Expand all</button>';
  if (hidden.length) {
    html += '<div class="h">Hidden panes</div>';
    hidden.forEach((pane) => { html += '<button class="item" data-show-pane="' + pane.id + '">Show ' + escapeHtml(labelText("pane." + pane.id, pane.title) || pane.title) + "</button>"; });
  }
  html += '<hr><div class="h">Spacing</div>'
    + slider("fontSize", "Font size", 10, 16, 0.5, "px", state.spacing.fontSize)
    + slider("cellPad", "Cell padding", 0, 8, 1, "px", state.spacing.cellPad)
    + slider("subheadGap", "Subhead spacing", 0, 20, 1, "px", state.spacing.subheadGap)
    + slider("tableScale", "Table width (all)", 40, 150, 5, "%", state.tableScale)
    + '<hr><button class="item" data-menu="reset">Reset everything to stock</button></div>';
  host.innerHTML = html;
  const anchor = document.getElementById("burgerButton").getBoundingClientRect();
  const menu = host.firstChild;
  menu.style.left = Math.max(16, anchor.left) + "px";
  menu.style.top = anchor.bottom + window.scrollY + 4 + "px";
}

// ---------------------------------------------------------------------------
// Inline editing (cells, headers, labels)
// ---------------------------------------------------------------------------
function editInPlace(host, startText, onSave) {
  const input = document.createElement("input");
  input.value = startText;
  host.innerHTML = "";
  host.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  function finish(save) {
    if (finished) return;
    finished = true;
    if (save && input.value.trim() !== startText) onSave(input.value.trim());
    else render();
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}
function findDef(element) {
  const section = element.closest("[data-pane]");
  return section ? PANE_DEFS.find((pane) => pane.id === section.dataset.pane) : null;
}
function findModel(element) {
  const def = findDef(element);
  return def && !def.custom ? genericModel(def) : null;
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------
document.addEventListener("click", (event) => {
  const target = event.target;
  let match;

  if (suppressPanelClick) return;

  // Shortcuts dialog
  if ((match = target.closest("[data-sc-capture]"))) {
    shortcutCapture = match.dataset.scCapture;
    shortcutConflict = null;
    captureCtrlArmed = false;
    renderShortcuts();
    return;
  }
  if ((match = target.closest("[data-sc-revert]"))) {
    const taskId = match.dataset.scRevert;
    shortcutConflict = null;
    update(() => { delete state.shortcuts[taskId]; });
    renderShortcuts();
    return;
  }
  if (target.closest("[data-sc-reset]")) {
    shortcutConflict = null;
    update(() => { state.shortcuts = {}; });
    renderShortcuts();
    return;
  }
  if (target.closest("[data-sc-close]")) { closeShortcuts(); return; }
  if (target.closest("[data-sc-overlay]") && !target.closest(".sc-window")) { closeShortcuts(); return; }

  if (target.closest("[data-panel-open]")) { update(() => { state.panesPanelOpen = true; }); return; }
  if (target.closest("#burgerButton")) { openMenu(); return; }
  if (target.closest("#panesButton")) { update(() => { state.panesPanelOpen = !state.panesPanelOpen; }); return; }
  if (target.closest("[data-panel-half]")) { update(() => { state.panesPanelHalf = !state.panesPanelHalf; }); return; }
  if (target.closest("[data-panel-close]")) { update(() => { state.panesPanelOpen = false; }); return; }
  if ((match = target.closest("[data-toggle-pane]"))) {
    const id = match.dataset.togglePane;
    update(() => {
      state.hiddenPanes = state.hiddenPanes.includes(id) ? state.hiddenPanes.filter((paneId) => paneId !== id) : state.hiddenPanes.concat(id);
    });
    return;
  }
  if ((match = target.closest("[data-jump]"))) {
    const id = match.dataset.jump;
    if (state.hiddenPanes.includes(id)) update(() => { state.hiddenPanes = state.hiddenPanes.filter((paneId) => paneId !== id); });
    const section = document.querySelector('section[data-pane="' + id + '"]');
    if (section) section.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  if (target.closest("#themeButton")) {
    const isDark = state.theme ? state.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    update(() => { state.theme = isDark ? "light" : "dark"; });
    return;
  }
  if ((match = target.closest("[data-menu]"))) {
    const action = match.dataset.menu;
    if (action === "shortcuts") { openShortcuts(); return; }
    if (action === "collapse-all") update(() => { state.collapsedPanes = PANE_DEFS.map((pane) => pane.id); });
    if (action === "expand-all") update(() => { state.collapsedPanes = []; });
    if (action === "reset") update(() => {
      const stars = state.stars;
      state = structuredClone(DEFAULT_STATE);
      state.stars = stars;
    });
    closeMenu();
    return;
  }
  if ((match = target.closest("[data-show-pane]"))) {
    update(() => { state.hiddenPanes = state.hiddenPanes.filter((id) => id !== match.dataset.showPane); });
    closeMenu();
    return;
  }
  if (!target.closest(".menu")) closeMenu();

  // Star toggles (Starred pane + Artifacts catalog)
  if ((match = target.closest("[data-star-slug]"))) {
    const slug = match.dataset.starSlug;
    update(() => {
      state.stars = state.stars.includes(slug)
        ? state.stars.filter((item) => item !== slug)
        : state.stars.concat(slug);
    });
    return;
  }

  // File-system browser: selects, breadcrumb, folder rows
  if ((match = target.closest("[data-fs-open]"))) {
    fsParts = fsParts.concat(match.dataset.fsOpen);
    ensureFsLoaded();
    render();
    return;
  }
  if ((match = target.closest("[data-fs-crumb]"))) {
    const level = Number(match.dataset.fsCrumb);
    fsParts = level < 0 ? [] : fsParts.slice(0, level + 1);
    ensureFsLoaded();
    render();
    return;
  }

  // Preferences: open a file body, close the viewer, toggle a filter chip
  if ((match = target.closest("[data-pref-file]"))) { openPrefBody(match.dataset.prefFile); return; }
  if (target.closest("[data-pref-close]")) { prefUi.openId = null; prefUi.openBody = null; render(); return; }
  if ((match = target.closest("[data-pref-filter]"))) {
    const type = match.dataset.prefFilter;
    const timeline = (sectionData("prefs") || {}).timeline || [];
    if (!prefUi.activeChanges) prefUi.activeChanges = new Set(prefChangeTypes(timeline));
    if (prefUi.activeChanges.has(type)) prefUi.activeChanges.delete(type); else prefUi.activeChanges.add(type);
    render();
    return;
  }

  // Label controls (edit mode)
  if ((match = target.closest("[data-label-hide]"))) { update(() => { state.labels[match.dataset.labelHide] = null; }); return; }
  if ((match = target.closest("[data-label-revert]"))) { update(() => { delete state.labels[match.dataset.labelRevert]; }); return; }
  if ((match = target.closest("[data-label-rename]"))) {
    const key = match.dataset.labelRename;
    const labelElement = match.parentElement.previousElementSibling;
    editInPlace(labelElement, labelText(key, match.dataset.stock) || match.dataset.stock, (text) => update(() => { state.labels[key] = text; }));
    return;
  }

  // Pane header controls
  if ((match = target.closest("[data-collapse]"))) {
    const id = match.dataset.collapse;
    update(() => {
      state.collapsedPanes = state.collapsedPanes.includes(id) ? state.collapsedPanes.filter((paneId) => paneId !== id) : state.collapsedPanes.concat(id);
    });
    return;
  }
  if ((match = target.closest("[data-hide-pane]"))) { update(() => { state.hiddenPanes.push(match.dataset.hidePane); }); return; }
  if ((match = target.closest("[data-width]"))) {
    // current -> 100% -> 50% -> 25% -> current
    const cycle = ["current", "100", "50", "25"];
    const table = tableState(match.dataset.width);
    update(() => { table.widthMode = cycle[(cycle.indexOf(table.widthMode) + 1) % cycle.length]; });
    return;
  }

  // Revert one edited cell
  if ((match = target.closest("[data-cell-revert]"))) {
    const model = findModel(match);
    if (!model) return;
    const rowId = match.closest("tr").dataset.row;
    update(() => { delete tableState(model.id).cells[rowId][match.dataset.cellRevert]; });
    return;
  }

  // Header: text sorts, empty space edits the header name
  if ((match = target.closest("[data-sort]")) && !state.editing) {
    const model = findModel(match);
    if (!model) return;
    const table = tableState(model.id);
    const column = match.dataset.sort;
    update(() => {
      table.sort = table.sort && table.sort.column === column
        ? (table.sort.direction > 0 ? { column: column, direction: -1 } : null)
        : { column: column, direction: 1 };
    });
    return;
  }
  if ((match = target.closest("th[data-col]")) && target === match) {
    const model = findModel(match);
    if (!model) return;
    const key = "col." + model.id + "." + match.dataset.col;
    const stock = model.columns.find((column) => column.id === match.dataset.col).title;
    editInPlace(match, labelText(key, stock) || stock, (text) => update(() => { state.labels[key] = text; }));
    return;
  }

  // Cell: empty space starts editing
  if ((match = target.closest("td[data-cell]")) && target === match) {
    const model = findModel(match);
    if (!model) return;
    const rowId = match.closest("tr").dataset.row;
    const row = model.rows.find((candidate) => candidate._id === rowId);
    if (!row) return;
    const columnId = match.dataset.cell;
    editInPlace(match, String(cellValue(model, row, columnId) || ""), (text) => update(() => {
      const table = tableState(model.id);
      table.cells[rowId] = table.cells[rowId] || {};
      table.cells[rowId][columnId] = text;
    }));
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "editToggle") update(() => { state.editing = event.target.checked; });
  if (event.target.id === "verboseToggle") update(() => { state.verbose = event.target.checked; });
  if (event.target.id === "wrapToggle") update(() => { state.wrapAll = event.target.checked; });
  if (event.target.id === "dockToggle") toggleLeftTaskPane();
  const fsSelect = event.target.closest && event.target.closest("[data-fs-level]");
  if (fsSelect) {
    const level = Number(fsSelect.dataset.fsLevel);
    const value = fsSelect.value;
    fsParts = fsParts.slice(0, level);
    if (value) fsParts.push(value);
    ensureFsLoaded();
    render();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "prefSearch") {
    prefUi.query = event.target.value;
    prefSearchHadFocus = true;
    render();
    return;
  }
  const key = event.target.dataset && event.target.dataset.slider;
  if (!key) return;
  const value = Number(event.target.value);
  if (key === "tableScale") state.tableScale = value;
  else state.spacing[key] = value;
  const unit = key === "tableScale" ? "%" : "px";
  const label = document.getElementById(key + "Value");
  if (label) label.textContent = value + unit;
  saveState();
  render();
});
// ---------------------------------------------------------------------------
// Keyboard: the assignable shortcuts. A bare Control keypress (pressed and
// released with no other key in between) is itself an assignable key — it
// arms on keydown and fires on keyup. Shortcuts never fire while typing in
// an input, textarea, select or contenteditable, or during a key capture.
// Alt is left alone entirely: Arman's Alt key drives his AutoHotkey layer.
// ---------------------------------------------------------------------------
let ctrlArmed = false;
function isTypingTarget(target) {
  return !!target && (target.isContentEditable
    || /INPUT|TEXTAREA|SELECT/.test(target.tagName || ""));
}
function keyFromEvent(event) {
  if (event.altKey) return null;
  let key = event.key;
  if (!key || key === "Control" || key === "Shift" || key === "Meta" || key === "Alt") return null;
  if (key === " ") key = "space";
  else key = key.toLowerCase();
  if (event.ctrlKey || event.metaKey) return "ctrl+" + key;
  if (event.shiftKey && key.length === 1) return "shift+" + key;
  return key;
}
document.addEventListener("keydown", (event) => {
  // Key capture for the Shortcuts dialog swallows the keypress.
  if (shortcutCapture) {
    event.preventDefault();
    if (event.key === "Control") { captureCtrlArmed = true; return; }
    captureCtrlArmed = false;
    const taskId = shortcutCapture;
    if (event.key === "Escape") { shortcutCapture = null; shortcutConflict = null; renderShortcuts(); return; }
    if (event.key === "Backspace" || event.key === "Delete") { assignShortcut(taskId, null); return; }
    const candidate = keyFromEvent(event);
    if (candidate) assignShortcut(taskId, candidate);
    return;
  }
  if (event.key === "Escape") { closeMenu(); closeShortcuts(); ctrlArmed = false; return; }
  if (event.key === "Control") {
    if (!event.repeat && !isTypingTarget(event.target)) ctrlArmed = true;
    return;
  }
  // Any other key while Control is held means it was a combo, not bare Ctrl.
  ctrlArmed = false;
  if (isTypingTarget(event.target)) return;
  const candidate = keyFromEvent(event);
  if (!candidate) return;
  const task = SHORTCUT_TASKS.find((candidate2) => shortcutKey(candidate2.id) === candidate);
  if (!task) return;
  event.preventDefault();
  runShortcut(task.id);
});
document.addEventListener("keyup", (event) => {
  if (event.key !== "Control") return;
  if (shortcutCapture) {
    if (captureCtrlArmed) { captureCtrlArmed = false; assignShortcut(shortcutCapture, "ctrl"); }
    return;
  }
  const wasArmed = ctrlArmed;
  ctrlArmed = false;
  if (!wasArmed || isTypingTarget(event.target)) return;
  if (shortcutKey("menu") === "ctrl") runShortcut("menu");
});

// ---------------------------------------------------------------------------
// Column extras: double-click a header renames it; double-click its right
// edge (the resizer) clears that column's saved width.
// ---------------------------------------------------------------------------
document.addEventListener("dblclick", (event) => {
  const resizer = event.target.closest && event.target.closest("[data-resize]");
  if (resizer) {
    const model = findModel(resizer);
    if (!model) return;
    resizing = null;
    update(() => { delete tableState(model.id).columnWidths[resizer.dataset.resize]; });
    return;
  }
  const header = event.target.closest && event.target.closest("th[data-col]");
  if (!header || header.querySelector("input")) return;
  const model = findModel(header);
  if (!model) return;
  const column = model.columns.find((candidate) => candidate.id === header.dataset.col);
  if (!column) return;
  const key = "col." + model.id + "." + column.id;
  editInPlace(header, labelText(key, column.title) || column.title,
    (text) => update(() => { state.labels[key] = text; }));
});

// ---------------------------------------------------------------------------
// Instant tooltip for clipped text
// ---------------------------------------------------------------------------
const tooltip = document.getElementById("tip");
document.addEventListener("mouseover", (event) => {
  const cell = event.target.closest("td, th");
  if (!cell || cell.querySelector("input") || cell.scrollWidth <= cell.clientWidth) { tooltip.hidden = true; return; }
  tooltip.textContent = cell.textContent.replace(/[✎✕↺⠿★☆]/g, "").trim();
  const box = cell.getBoundingClientRect();
  tooltip.hidden = false;
  tooltip.style.left = Math.min(box.left, innerWidth - tooltip.offsetWidth - 16) + "px";
  tooltip.style.top = (box.bottom + 3) + "px";
});
document.addEventListener("scroll", () => { tooltip.hidden = true; }, { passive: true });

// ---------------------------------------------------------------------------
// Column resize
// ---------------------------------------------------------------------------
let resizing = null;
document.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-resize]");
  if (!handle) return;
  event.preventDefault();
  const model = findModel(handle);
  if (!model) return;
  const header = handle.closest("th");
  resizing = { model: model, columnId: handle.dataset.resize, startX: event.clientX, startWidth: header.offsetWidth };
});
document.addEventListener("pointermove", (event) => {
  if (!resizing) return;
  const table = tableState(resizing.model.id);
  const shownWidth = Math.max(24, resizing.startWidth + event.clientX - resizing.startX);
  table.columnWidths[resizing.columnId] = Math.round(shownWidth / (table.scale * state.tableScale / 100));
  render();
});
document.addEventListener("pointerup", () => { if (resizing) { resizing = null; saveState(); } });

// ---------------------------------------------------------------------------
// Drag to reorder panes, rows (dot icon at row end) and columns (header)
// ---------------------------------------------------------------------------
let dragging = null;
function clearDropMarks() {
  document.querySelectorAll(".drop-before, .drop-after, .lifted").forEach((element) => element.classList.remove("drop-before", "drop-after", "lifted"));
}
document.addEventListener("dragstart", (event) => {
  const paneHandle = event.target.closest && event.target.closest("[data-drag-pane]");
  const rowHandle = event.target.closest && event.target.closest("[data-drag-row]");
  const header = event.target.closest && event.target.closest("th[data-col]");
  if (paneHandle) dragging = { kind: "pane", id: paneHandle.dataset.dragPane, element: paneHandle.closest(".pane, .pp-row") };
  else if (rowHandle) dragging = { kind: "row", id: rowHandle.dataset.dragRow, model: findModel(rowHandle), element: rowHandle.closest("tr") };
  else if (header) dragging = { kind: "col", id: header.dataset.col, model: findModel(header), element: header };
  else return;
  if (!dragging.element) { dragging = null; return; }
  dragging.element.classList.add("lifted");
  try { event.dataTransfer.setData("text/plain", dragging.id); event.dataTransfer.effectAllowed = "move"; } catch (error) { /* some browsers refuse */ }
});
function dropTarget(event) {
  if (!dragging) return null;
  if (dragging.kind === "pane") return event.target.closest(".pane, .pp-row");
  if (!dragging.model) return null;
  if (dragging.kind === "row") {
    const row = event.target.closest("tr[data-row]");
    return row && row.closest("[data-pane]").dataset.pane === dragging.model.id ? row : null;
  }
  const header = event.target.closest("th[data-col]");
  return header && header.closest("[data-pane]").dataset.pane === dragging.model.id ? header : null;
}
document.addEventListener("dragover", (event) => {
  const target = dropTarget(event);
  if (!target || target === dragging.element) return;
  event.preventDefault();
  document.querySelectorAll(".drop-before, .drop-after").forEach((element) => element.classList.remove("drop-before", "drop-after"));
  const box = target.getBoundingClientRect();
  const isBefore = dragging.kind === "col" ? event.clientX < box.left + box.width / 2 : event.clientY < box.top + box.height / 2;
  target.classList.add(isBefore ? "drop-before" : "drop-after");
});
document.addEventListener("drop", (event) => {
  const target = document.querySelector(".drop-before, .drop-after");
  if (!dragging || !target) return;
  event.preventDefault();
  const isBefore = target.classList.contains("drop-before");
  const moving = dragging;
  function move(list, id, targetId) {
    const result = list.filter((item) => item !== id);
    const index = result.indexOf(targetId);
    result.splice(isBefore ? index : index + 1, 0, id);
    return result;
  }
  update(() => {
    if (moving.kind === "pane") state.paneOrder = move(state.paneOrder, moving.id, target.dataset.pane);
    if (moving.kind === "row" && moving.model) {
      const table = tableState(moving.model.id);
      table.sort = null; // a manual order replaces sorting
      table.rowOrder = move(orderedRows(moving.model).map((row) => row._id), moving.id, target.dataset.row);
    }
    if (moving.kind === "col" && moving.model) {
      const table = tableState(moving.model.id);
      table.columnOrder = move(orderedColumns(moving.model).map((column) => column.id), moving.id, target.dataset.col);
    }
  });
  dragging = null;
});
document.addEventListener("dragend", () => { clearDropMarks(); dragging = null; });

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
render();
pullPrefs();
loadData();
