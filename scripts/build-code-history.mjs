// Generates public/code-history.html from this repo's git history.
//
// Modeled on the hub's scripts/build-code-history.mjs (armanai). It reads
// the version sections from CHANGELOG.md (## vX.Y.Z — YYYY-MM-DD headers)
// and renders, per version, its changelog bullets followed by every commit
// that belongs to it — commits dated on or before the version's date and
// after the previous version's date — newest first, each with a sha link
// to GitHub and its files with +/- line counts from git's numstat.
//
// Release ritual: stage the release's changes, then run
//   node scripts/build-code-history.mjs --pending "vX.Y.Z: short line"
// so the not-yet-committed work appears under the new version, then
// commit. Without --pending, only committed history is rendered.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts", "code-history.config.json"), "utf8"));

const pendingIndex = process.argv.indexOf("--pending");
const pendingArg = pendingIndex >= 0 ? process.argv[pendingIndex + 1] : null;

function git(...args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => "&#" + ch.charCodeAt(0) + ";");
}
function formatDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "/" + p(d.getDate()) + "/" + String(d.getFullYear()).slice(2);
}
// Changelog dates are local (America/Chicago) release dates, while git's
// %aI on this VM carries +00:00 — band commits by their Chicago date.
const chicagoDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
function localDate(iso) {
  return chicagoDay.format(new Date(iso)); // en-CA gives YYYY-MM-DD
}

// --- Versions from CHANGELOG.md -------------------------------------------
// Headers look like: ## v1.1.0 — 2026-10-28
const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
const versions = [];
{
  const re = /^## (v[\d.]+) — (\d{4}-\d{2}-\d{2})\s*$([\s\S]*?)(?=^## v|\s*$)/gm;
  let m;
  while ((m = re.exec(changelog)) !== null) {
    const bullets = [...m[3].matchAll(/^- (.+)$/gm)].map((b) => b[1].trim());
    versions.push({ version: m[1], date: m[2], bullets, commits: [] });
  }
  versions.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
}

// --- Commits ----------------------------------------------------------------
// \x1e starts each record (so a record is: header line, blank line, then
// the numstat lines); \x1f separates the header fields. The body is the
// last field and may itself span lines, up to the blank line.
const raw = git("log", "--numstat", "--format=%x1e%H%x1f%h%x1f%aI%x1f%s%x1f%b");
const commits = [];
for (const record of raw.split("\x1e")) {
  const trimmed = record.replace(/^\n+/, "");
  if (!trimmed.trim()) continue;
  const splitAt = trimmed.indexOf("\n\n");
  const head = splitAt >= 0 ? trimmed.slice(0, splitAt) : trimmed;
  const fields = head.split("\x1f");
  const [fullSha, shortSha, isoDate, subject] = fields;
  const body = fields.slice(4).join("\x1f").trim();
  const files = [];
  if (splitAt >= 0) {
    for (const line of trimmed.slice(splitAt + 2).split("\n")) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match) files.push({ add: match[1], del: match[2], name: match[3] });
    }
  }
  commits.push({ fullSha, shortSha, isoDate, date: localDate(isoDate), subject, body, files });
}

// --- Pending (staged, not yet committed) changes ---------------------------
let pending = null;
if (pendingArg) {
  const label = pendingArg.replace(/^v[\d.]+:\s*/, "");
  const stat = git("diff", "--cached", "--numstat");
  const files = stat.split("\n").filter(Boolean).map((line) => {
    const [add, del, ...rest] = line.split("\t");
    return { add, del, name: rest.join("\t") };
  });
  pending = { label, files };
}

// --- Assign commits to versions by date ------------------------------------
// Versions are newest first. A commit belongs to version v when its date is
// on or before v's date and after the next-older version's date (so work
// done the day after v1.0.0 counts toward v1.1.0). Commits newer than every
// version land in the newest one; older ones default to the oldest.
for (const commit of commits) {
  let owner = versions[versions.length - 1];
  if (commit.date > versions[0].date) {
    owner = versions[0];
  } else {
    for (let i = 0; i < versions.length; i++) {
      const older = versions[i + 1];
      if (commit.date <= versions[i].date && (!older || commit.date > older.date)) {
        owner = versions[i];
        break;
      }
    }
  }
  owner.commits.push(commit);
}

// --- Render -------------------------------------------------------------------
function filesHtml(files) {
  if (!files.length) return "";
  const items = files.map((f) =>
    `<li><span class="fname">${escapeHtml(f.name)}</span><span class="fstat"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span></li>`);
  return `<ul class="files">${items.join("")}</ul>`;
}
function commitHtml(commit) {
  const shaUrl = `https://github.com/${config.githubRepo}/commit/${commit.fullSha}`;
  const body = commit.body ? `<p class="body">${escapeHtml(commit.body)}</p>` : "";
  return `<div class="commit"><span class="subject">${escapeHtml(commit.subject)}</span>`
    + `<span class="meta">${formatDate(commit.isoDate)} · <a href="${shaUrl}" target="_blank" rel="noopener">${commit.shortSha}</a></span>`
    + body + filesHtml(commit.files) + `</div>`;
}

let sectionsHtml = "";
versions.forEach((v, index) => {
  const bullets = v.bullets.map((b) => `<p>${escapeHtml(b)}</p>`).join("");
  let commitsHtml = v.commits.map(commitHtml).join("");
  if (index === 0 && pending) {
    commitsHtml = `<div class="commit"><span class="subject">${escapeHtml(pending.label)}</span>`
      + `<span class="meta">pending</span>` + filesHtml(pending.files) + `</div>` + commitsHtml;
  }
  sectionsHtml += `<section class="version-section"><h2>${escapeHtml(v.version)}<span class="date">${formatDate(v.date + "T12:00:00")}</span></h2>`
    + bullets + commitsHtml + `</section>\n`;
});

const now = new Date();
const generated = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${String(now.getFullYear()).slice(2)}`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>${escapeHtml(config.title)} — Code history</title>
<link rel="stylesheet" href="docs.css">
</head>
<body>
<main>
  <div class="docs-bar">
    <a class="docs-home" href="./" title="${escapeHtml(config.title)}" aria-label="${escapeHtml(config.title)}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>
    </a>
    <span class="title">${escapeHtml(config.title)} — Code history</span>
    <span class="spacer"></span>
    <button class="docs-theme" type="button" aria-label="Toggle dark mode"></button>
  </div>
  <p class="subtitle">Every committed change, grouped by release. Generated from git history on ${generated}; regenerating is part of the release ritual (see <code>scripts/build-code-history.mjs</code>). <a href="./">← ${escapeHtml(config.title)}</a> · <a href="changelog.html">Changelog →</a></p>
${sectionsHtml}</main>
<script src="docs-theme.js"></script>
</body>
</html>
`;

const outPath = path.join(repoRoot, "public", "code-history.html");
fs.writeFileSync(outPath, html);
console.log(`wrote ${path.relative(repoRoot, outPath)} — ${versions.map((v) => `${v.version} (${v.commits.length} commits)`).join(", ")}${pending ? " + pending" : ""}`);
