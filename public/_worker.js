// musestatus — Cloudflare Pages worker.
//
// This worker does four jobs:
//   1. Gate: only requests that arrive through the armanai hub (carrying the
//      shared hub proxy key) may see the app. Anything else is bounced to the
//      hub path, and API calls without the key get a plain 401. If the secret
//      is not configured at all the gate fails closed — nobody gets in.
//   2. View state: GET/PUT api/prefs reads and writes the visitor's layout
//      (pane order, labels, column widths, stars, theme) in D1, so the view
//      follows Arman across devices. Writes happen only when the state
//      actually changed.
//   3. Published data: GET api/data, api/fs and api/prefbody serve the
//      snapshots the VM publisher cron (musestatus-publish) pushes in.
//   4. Publish: POST api/publish accepts those snapshots from the VM, guarded
//      by its own publish key and exempt from the hub gate (the publisher
//      connects directly). Everything else is a static file.
//
// Storage is D1 (binding MUSESTATUS_DB, tables prefixed musestatus_),
// NOT KV: the app's first KV-backed publish on 2026-10-23 wrote ~958 keys
// in an evening and nearly exhausted the account's daily free-tier KV
// write cap, which would have failed KV writes account-wide. The worker
// creates its tables on first use and writes a row only when its content
// actually changed, so a no-op publish costs zero writes.
//
// All links and fetches in the page are relative, because the hub strips (or
// keeps) the /musestatus prefix depending on the route — this worker strips a
// leading /musestatus itself so both cases behave the same.

const HUB_HOME = "https://armanai.pages.dev/musestatus/";
const MAX_PREFS_BYTES = 200000;
const MAX_PUBLISH_BYTES = 12 * 1024 * 1024;
// Keep IN(...) lookups and batch writes modest per call.
const SQL_CHUNK = 100;

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Remove a leading /musestatus prefix (with or without trailing slash) so the
// rest of the router always sees the app-local path.
function stripHubPrefix(pathname) {
  if (pathname === "/musestatus") return "/";
  if (pathname.startsWith("/musestatus/")) return pathname.slice("/musestatus".length);
  return pathname;
}

// Create the four tables on first use. The API token used from the VM can
// read D1 but cannot run DDL, so the worker — whose binding can — owns
// schema setup. Cached per isolate; CREATE TABLE IF NOT EXISTS is cheap
// and idempotent, so a cold isolate re-running it is harmless.
let schemaPromise = null;
function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS musestatus_sections (name TEXT PRIMARY KEY, stamp INTEGER NOT NULL, data TEXT NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS musestatus_fs (path TEXT PRIMARY KEY, stamp INTEGER NOT NULL, children TEXT NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS musestatus_pref_bodies (id TEXT PRIMARY KEY, name TEXT, path TEXT, body TEXT NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS musestatus_view_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)"),
    ]).catch((error) => {
      // Do not cache a failure — the next request should retry.
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

// Split an array into chunks of the given size.
function chunked(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// Fetch rows for a set of keys in chunks: one SELECT ... WHERE key IN (...)
// per chunk, returned as a Map from key to row.
async function fetchRowsByKey(db, table, keyColumn, columns, keys) {
  const rowsByKey = new Map();
  for (const group of chunked(keys, SQL_CHUNK)) {
    if (group.length === 0) continue;
    const placeholders = group.map(() => "?").join(", ");
    const result = await db
      .prepare("SELECT " + columns + " FROM " + table + " WHERE " + keyColumn + " IN (" + placeholders + ")")
      .bind(...group)
      .all();
    for (const row of result.results || []) rowsByKey.set(String(row[keyColumn]), row);
  }
  return rowsByKey;
}

// Run prepared statements in chunked batches.
async function runBatched(db, statements) {
  for (const group of chunked(statements, SQL_CHUNK)) {
    if (group.length === 0) continue;
    await db.batch(group);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = stripHubPrefix(url.pathname);
    const isApi = path === "/api" || path.startsWith("/api/");

    // Publish goes first: it has its own Bearer auth and no hub key.
    if (path === "/api/publish" && request.method === "POST") {
      return handlePublish(request, env);
    }

    // --- Gate -------------------------------------------------------------
    // Fail closed when the secret is unset: an unconfigured deployment must
    // never serve the app or its data.
    const expectedKey = env.HUB_PROXY_KEY;
    const givenKey = request.headers.get("X-Hub-Proxy-Key");
    if (!expectedKey || givenKey !== expectedKey) {
      if (isApi) return jsonResponse({ error: "unauthorized" }, 401);
      return Response.redirect(HUB_HOME, 302);
    }

    const db = env.MUSESTATUS_DB;

    // --- View state ---------------------------------------------------------
    if (path === "/api/prefs") {
      if (request.method === "GET") {
        let saved = null;
        if (db) {
          await ensureSchema(db);
          const row = await db.prepare("SELECT body FROM musestatus_view_state WHERE id = 1").first();
          saved = row ? row.body : null;
        }
        return new Response(saved || "null", {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      if (request.method === "PUT") {
        const text = await request.text();
        if (text.length > MAX_PREFS_BYTES) return jsonResponse({ error: "too large" }, 413);
        try {
          JSON.parse(text);
        } catch (error) {
          return jsonResponse({ error: "invalid json" }, 400);
        }
        if (db) {
          await ensureSchema(db);
          const row = await db.prepare("SELECT body FROM musestatus_view_state WHERE id = 1").first();
          const current = row ? row.body : null;
          if (current !== text) {
            await db
              .prepare("INSERT INTO musestatus_view_state (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body")
              .bind(text)
              .run();
          }
        }
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    // --- Published sections -------------------------------------------------
    if (path === "/api/data" && request.method === "GET") {
      const sections = {};
      if (db) {
        await ensureSchema(db);
        const result = await db.prepare("SELECT name, stamp, data FROM musestatus_sections").all();
        for (const row of result.results || []) {
          let data = null;
          try {
            data = JSON.parse(row.data);
          } catch (error) {
            data = null;
          }
          sections[row.name] = { stamp: row.stamp, data: data };
        }
      }
      return jsonResponse({ sections: sections });
    }

    // --- One folder of the file-system snapshot -----------------------------
    if (path === "/api/fs" && request.method === "GET") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return jsonResponse({ error: "missing path" }, 400);
      if (!db) return jsonResponse({ error: "not found" }, 404);
      await ensureSchema(db);
      const row = await db
        .prepare("SELECT stamp, children FROM musestatus_fs WHERE path = ?")
        .bind(dirPath)
        .first();
      if (!row) return jsonResponse({ error: "not found" }, 404);
      let children = null;
      try {
        children = JSON.parse(row.children);
      } catch (error) {
        children = null;
      }
      return jsonResponse({ stamp: row.stamp, children: children });
    }

    // --- One preference file body -------------------------------------------
    if (path === "/api/prefbody" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return jsonResponse({ error: "missing id" }, 400);
      if (!db) return jsonResponse({ error: "not found" }, 404);
      await ensureSchema(db);
      const row = await db
        .prepare("SELECT name, path, body FROM musestatus_pref_bodies WHERE id = ?")
        .bind(id)
        .first();
      if (!row) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ name: row.name, path: row.path, body: row.body });
    }

    if (isApi) return jsonResponse({ error: "not found" }, 404);

    // --- Static files ---------------------------------------------------------
    // Serve the asset at the prefix-stripped path.
    const assetUrl = new URL(request.url);
    assetUrl.pathname = path;
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  },
};

// Publisher intake. This route is dispatched BEFORE the hub gate on
// purpose: the VM publisher connects directly to this project and
// authenticates with its own Bearer key (env.PUBLISH_KEY) — it never
// carries the hub proxy key. Fail closed when the key is unset. Rows are
// written only when their content actually changed, so a repeat publish
// of the same snapshot costs zero D1 writes.
async function handlePublish(request, env) {
  const db = env.MUSESTATUS_DB;

  // Fail closed when the publish key is unset.
  const publishKey = env.PUBLISH_KEY;
  const auth = request.headers.get("Authorization") || "";
  if (!publishKey || auth !== "Bearer " + publishKey) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!db) return jsonResponse({ error: "storage not configured" }, 500);
  const text = await request.text();
  if (text.length > MAX_PUBLISH_BYTES) return jsonResponse({ error: "too large" }, 413);
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (error) {
    return jsonResponse({ error: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "invalid body" }, 400);
  }

  await ensureSchema(db);

  let written = 0;
  let skipped = 0;
  let deleted = 0;

  // --- Sections: one row per named section --------------------------------
  if (body.sections && typeof body.sections === "object") {
    const names = Object.keys(body.sections);
    const existing = await fetchRowsByKey(db, "musestatus_sections", "name", "name, stamp, data", names);
    const upserts = [];
    for (const name of names) {
      const section = body.sections[name] || {};
      const stamp = typeof section.stamp === "number" ? section.stamp : 0;
      const dataText = JSON.stringify(section.data === undefined ? null : section.data);
      const current = existing.get(name);
      if (current && current.stamp === stamp && current.data === dataText) {
        skipped += 1;
        continue;
      }
      upserts.push(
        db
          .prepare("INSERT INTO musestatus_sections (name, stamp, data) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET stamp = excluded.stamp, data = excluded.data")
          .bind(name, stamp, dataText)
      );
      written += 1;
    }
    await runBatched(db, upserts);
  }

  // --- File-system folders: one row per folder -----------------------------
  if (Array.isArray(body.fsFolders)) {
    const folders = body.fsFolders.filter((folder) => folder && typeof folder.path === "string");
    const existing = await fetchRowsByKey(db, "musestatus_fs", "path", "path, stamp, children", folders.map((folder) => folder.path));
    const upserts = [];
    for (const folder of folders) {
      const stamp = typeof folder.stamp === "number" ? folder.stamp : 0;
      const childrenText = JSON.stringify(folder.children === undefined ? null : folder.children);
      const current = existing.get(folder.path);
      if (current && current.stamp === stamp && current.children === childrenText) {
        skipped += 1;
        continue;
      }
      upserts.push(
        db
          .prepare("INSERT INTO musestatus_fs (path, stamp, children) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET stamp = excluded.stamp, children = excluded.children")
          .bind(folder.path, stamp, childrenText)
      );
      written += 1;
    }
    await runBatched(db, upserts);
  }

  // --- Folder deletions ------------------------------------------------------
  if (Array.isArray(body.fsDeleted)) {
    const deletes = [];
    for (const dirPath of body.fsDeleted) {
      if (typeof dirPath !== "string") continue;
      deletes.push(db.prepare("DELETE FROM musestatus_fs WHERE path = ?").bind(dirPath));
      deleted += 1;
    }
    await runBatched(db, deletes);
  }

  // --- Preference file bodies: one row per file ----------------------------
  if (Array.isArray(body.prefBodies)) {
    const items = body.prefBodies.filter((item) => item && item.id != null);
    const existing = await fetchRowsByKey(db, "musestatus_pref_bodies", "id", "id, name, path, body", items.map((item) => String(item.id)));
    const upserts = [];
    for (const item of items) {
      const id = String(item.id);
      const name = item.name === undefined ? null : item.name;
      const itemPath = item.path === undefined ? null : item.path;
      const itemBody = item.body === undefined ? "" : String(item.body);
      const current = existing.get(id);
      if (current && current.name === name && current.path === itemPath && current.body === itemBody) {
        skipped += 1;
        continue;
      }
      upserts.push(
        db
          .prepare("INSERT INTO musestatus_pref_bodies (id, name, path, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, body = excluded.body")
          .bind(id, name, itemPath, itemBody)
      );
      written += 1;
    }
    await runBatched(db, upserts);
  }

  return jsonResponse({ written: written, skipped: skipped, deleted: deleted });
}
