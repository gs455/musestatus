// musestatus — Cloudflare Pages worker.
//
// This worker does four jobs:
//   1. Gate: only requests that arrive through the armanai hub (carrying the
//      shared hub proxy key) may see the app. Anything else is bounced to the
//      hub path, and API calls without the key get a plain 401. If the secret
//      is not configured at all the gate fails closed — nobody gets in.
//   2. View state: GET/PUT api/prefs reads and writes the visitor's layout
//      (pane order, labels, column widths, stars, theme) in D1, so the view
//      follows Arman across devices. The write happens only when the state
//      actually changed — there are no timer-based writes anywhere.
//   3. Published data: GET api/data, api/fs and api/prefbody serve the
//      snapshots the VM publisher cron (musestatus-publish) pushes in.
//   4. Publish: POST api/publish accepts those snapshots from the VM, guarded
//      by its own publish key and exempt from the hub gate (the publisher
//      connects directly). Everything else is a static file.
//
// Storage is D1 (binding MUSESTATUS_DB), never KV: the app's first
// KV-backed publish on 2026-10-23 wrote ~958 keys in an evening and nearly
// exhausted the account's daily free-tier KV write cap (961 of 1,000
// account-wide), which would have failed KV writes for every other app.
//
// Write discipline (the point of the design):
//   - Every stored row carries a sha256 hash of its payload. The publisher
//     hashes everything it assembles and sends only items whose hash it
//     believes changed; this worker re-checks each incoming hash against
//     the stored hash and writes ONLY rows that actually differ. A
//     no-change publish writes zero rows.
//   - The file-system tree is stored as chunk rows (musestatus_chunks):
//     folders sorted by path, ~500 folders per chunk JSON blob, plus one
//     manifest chunk mapping each folder path to its chunk. A worst-case
//     full republish of the tree is ~46 chunk rows; a typical run changes
//     a chunk or two. There are no per-folder rows.
//   - Preference file bodies live in the same chunks table as pref:<id>
//     rows, one per file, hash-gated the same way.
//   - The worker creates/migrates its tables on first use (the VM's API
//     token can read D1 but cannot run DDL, so the binding owns schema).
//
// All links and fetches in the page are relative, because the hub strips (or
// keeps) the /musestatus prefix depending on the route — this worker strips a
// leading /musestatus itself so both cases behave the same.

const HUB_HOME = "https://armanai.pages.dev/musestatus/";
const MAX_PREFS_BYTES = 200000;
const MAX_PUBLISH_BYTES = 12 * 1024 * 1024;
// Keep IN(...) lookups and batch writes modest per call.
const SQL_CHUNK = 100;
const FS_MANIFEST_ID = "fs:manifest";

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

// Create the tables on first use, migrating the short-lived v1 layout
// (per-folder rows, unhashed sections — deployed for under an hour on
// 2026-10-23 and never filled) when it is found. Cached per isolate;
// CREATE TABLE IF NOT EXISTS is cheap, so a cold isolate re-checking is
// harmless.
let schemaPromise = null;
function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sections = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'musestatus_sections'")
        .first();
      const statements = [];
      if (sections && !String(sections.sql || "").includes("hash")) {
        // v1 sections table (empty) — replace with the hashed layout.
        statements.push(db.prepare("DROP TABLE IF EXISTS musestatus_sections"));
      }
      // v1 per-folder tables (empty) — replaced by chunk rows.
      statements.push(db.prepare("DROP TABLE IF EXISTS musestatus_fs"));
      statements.push(db.prepare("DROP TABLE IF EXISTS musestatus_pref_bodies"));
      statements.push(db.prepare(
        "CREATE TABLE IF NOT EXISTS musestatus_sections " +
        "(name TEXT PRIMARY KEY, hash TEXT NOT NULL, stamp INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)"
      ));
      statements.push(db.prepare(
        "CREATE TABLE IF NOT EXISTS musestatus_chunks " +
        "(chunk_id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)"
      ));
      statements.push(db.prepare(
        "CREATE TABLE IF NOT EXISTS musestatus_view_state " +
        "(id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)"
      ));
      await db.batch(statements);
    })().catch((error) => {
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

// Fetch the stored hash for a set of row keys, as a Map from key to hash.
async function fetchHashes(db, table, keyColumn, keys) {
  const hashes = new Map();
  for (const group of chunked(keys, SQL_CHUNK)) {
    if (group.length === 0) continue;
    const placeholders = group.map(() => "?").join(", ");
    const result = await db
      .prepare("SELECT " + keyColumn + ", hash FROM " + table + " WHERE " + keyColumn + " IN (" + placeholders + ")")
      .bind(...group)
      .all();
    for (const row of result.results || []) hashes.set(String(row[keyColumn]), row.hash);
  }
  return hashes;
}

// Run prepared statements in chunked batches.
async function runBatched(db, statements) {
  for (const group of chunked(statements, SQL_CHUNK)) {
    if (group.length === 0) continue;
    await db.batch(group);
  }
}

// Read one chunk row's parsed payload, or null when absent/corrupt.
async function readChunk(db, chunkId) {
  const row = await db
    .prepare("SELECT payload FROM musestatus_chunks WHERE chunk_id = ?")
    .bind(chunkId)
    .first();
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch (error) {
    return null;
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
        const result = await db.prepare("SELECT name, stamp, payload FROM musestatus_sections").all();
        for (const row of result.results || []) {
          let data = null;
          try {
            data = JSON.parse(row.payload);
          } catch (error) {
            data = null;
          }
          sections[row.name] = { stamp: row.stamp, data: data };
        }
      }
      return jsonResponse({ sections: sections });
    }

    // --- One folder of the file-system snapshot -----------------------------
    // Resolved through the manifest chunk: folder path -> chunk id -> the
    // folder's entry inside that chunk's payload.
    if (path === "/api/fs" && request.method === "GET") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return jsonResponse({ error: "missing path" }, 400);
      if (!db) return jsonResponse({ error: "not found" }, 404);
      await ensureSchema(db);
      const manifest = await readChunk(db, FS_MANIFEST_ID);
      const chunkId = manifest ? manifest[dirPath] : null;
      if (!chunkId) return jsonResponse({ error: "not found" }, 404);
      const folders = await readChunk(db, chunkId);
      const entry = folders ? folders[dirPath] : null;
      if (!entry) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ stamp: entry.stamp, children: entry.children });
    }

    // --- One preference file body -------------------------------------------
    if (path === "/api/prefbody" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return jsonResponse({ error: "missing id" }, 400);
      if (!db) return jsonResponse({ error: "not found" }, 404);
      await ensureSchema(db);
      const item = await readChunk(db, "pref:" + id);
      if (!item) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ name: item.name, path: item.path, body: item.body });
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
// carries the hub proxy key. Fail closed when the key is unset.
//
// Hash gate: every incoming item carries the publisher's sha256 of its
// payload. The worker compares it with the stored hash and writes only
// rows whose hash differs, so a repeat publish of the same snapshot
// writes zero rows. The response counts {written, skipped, deleted}.
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
  const now = Date.now();

  let written = 0;
  let skipped = 0;
  let deleted = 0;

  // --- Sections: one hashed row per named section -------------------------
  if (body.sections && typeof body.sections === "object") {
    const names = Object.keys(body.sections);
    const stored = await fetchHashes(db, "musestatus_sections", "name", names);
    const upserts = [];
    for (const name of names) {
      const section = body.sections[name] || {};
      const hash = typeof section.hash === "string" ? section.hash : "";
      if (stored.get(name) === hash && hash !== "") {
        skipped += 1;
        continue;
      }
      const stamp = typeof section.stamp === "number" ? section.stamp : 0;
      const payload = JSON.stringify(section.data === undefined ? null : section.data);
      upserts.push(
        db
          .prepare("INSERT INTO musestatus_sections (name, hash, stamp, payload, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, stamp = excluded.stamp, payload = excluded.payload, updated_at = excluded.updated_at")
          .bind(name, hash, stamp, payload, now)
      );
      written += 1;
    }
    await runBatched(db, upserts);
  }

  // --- Chunks: fs chunk blobs, the fs manifest, preference bodies ---------
  // body.fsChunks carries [{id, hash, payload}] for tree chunks + manifest;
  // body.prefBodies carries [{id, hash, name, path, body}] stored as
  // pref:<id> chunk rows. Both land in musestatus_chunks behind the same
  // hash gate.
  const chunkItems = [];
  if (Array.isArray(body.fsChunks)) {
    for (const chunk of body.fsChunks) {
      if (!chunk || typeof chunk.id !== "string") continue;
      chunkItems.push({
        chunkId: chunk.id,
        hash: typeof chunk.hash === "string" ? chunk.hash : "",
        payload: JSON.stringify(chunk.payload === undefined ? null : chunk.payload),
      });
    }
  }
  if (Array.isArray(body.prefBodies)) {
    for (const item of body.prefBodies) {
      if (!item || item.id == null) continue;
      chunkItems.push({
        chunkId: "pref:" + String(item.id),
        hash: typeof item.hash === "string" ? item.hash : "",
        payload: JSON.stringify({
          name: item.name === undefined ? null : item.name,
          path: item.path === undefined ? null : item.path,
          body: item.body === undefined ? "" : String(item.body),
        }),
      });
    }
  }
  if (chunkItems.length > 0) {
    const stored = await fetchHashes(db, "musestatus_chunks", "chunk_id", chunkItems.map((item) => item.chunkId));
    const upserts = [];
    for (const item of chunkItems) {
      if (stored.get(item.chunkId) === item.hash && item.hash !== "") {
        skipped += 1;
        continue;
      }
      upserts.push(
        db
          .prepare("INSERT INTO musestatus_chunks (chunk_id, hash, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET hash = excluded.hash, payload = excluded.payload, updated_at = excluded.updated_at")
          .bind(item.chunkId, item.hash, item.payload, now)
      );
      written += 1;
    }
    await runBatched(db, upserts);
  }

  // --- Chunk deletions (chunks that no longer exist) -----------------------
  if (Array.isArray(body.fsChunksDeleted)) {
    const deletes = [];
    for (const chunkId of body.fsChunksDeleted) {
      if (typeof chunkId !== "string") continue;
      deletes.push(db.prepare("DELETE FROM musestatus_chunks WHERE chunk_id = ?").bind(chunkId));
      deleted += 1;
    }
    await runBatched(db, deletes);
  }

  return jsonResponse({ written: written, skipped: skipped, deleted: deleted });
}
