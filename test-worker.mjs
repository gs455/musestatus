// Smoke test for public/_worker.js — stubs D1 and ASSETS, no network.
// Run: node test-worker.mjs
import worker from "./public/_worker.js";

let failures = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log("ok   " + name);
  } else {
    failures += 1;
    console.log("FAIL " + name + (extra ? " — " + extra : ""));
  }
}

// --- In-memory D1 stub -------------------------------------------------------
// Implements just the SQL surface the worker uses: schema checks, CREATE /
// DROP TABLE, single-row lookups, IN(...) hash lookups, upserts and
// deletes, over Maps.
function makeDb() {
  const tables = {
    musestatus_sections: new Map(),
    musestatus_chunks: new Map(),
    musestatus_view_state: new Map(),
  };

  function runStatement(sql, params) {
    const text = sql.replace(/\s+/g, " ").trim();
    let match = text.match(/^SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'musestatus_sections'$/);
    if (match) {
      // Pretend the v2 (hashed) schema already exists.
      return { first: { sql: "CREATE TABLE musestatus_sections (name TEXT PRIMARY KEY, hash TEXT NOT NULL)" }, results: [] };
    }
    if (text.startsWith("DROP TABLE")) {
      const name = text.replace("DROP TABLE IF EXISTS ", "").trim();
      if (tables[name]) tables[name].clear();
      return { results: [] };
    }
    if (text.startsWith("CREATE TABLE")) return { results: [] };
    match = text.match(/^SELECT body FROM musestatus_view_state WHERE id = 1$/);
    if (match) {
      const row = tables.musestatus_view_state.get(1);
      return { first: row || null, results: row ? [row] : [] };
    }
    match = text.match(/^INSERT INTO musestatus_view_state \(id, body\) VALUES \(1, \?\)/);
    if (match) {
      tables.musestatus_view_state.set(1, { id: 1, body: params[0] });
      return { results: [] };
    }
    match = text.match(/^SELECT name, stamp, payload FROM musestatus_sections$/);
    if (match) return { results: [...tables.musestatus_sections.values()] };
    match = text.match(/^SELECT payload FROM musestatus_chunks WHERE chunk_id = \?$/);
    if (match) {
      const row = tables.musestatus_chunks.get(params[0]);
      return { first: row || null, results: row ? [row] : [] };
    }
    match = text.match(/^SELECT (\w+), hash FROM (musestatus_\w+) WHERE \1 IN \(/);
    if (match) {
      const table = tables[match[2]];
      const rows = params
        .map((key) => table.get(String(key)))
        .filter(Boolean)
        .map((row) => ({ [match[1]]: row[match[1]], hash: row.hash }));
      return { results: rows };
    }
    match = text.match(/^INSERT INTO (musestatus_\w+) \(([^)]+)\) VALUES/);
    if (match) {
      const table = tables[match[1]];
      const columns = match[2].split(",").map((name) => name.trim());
      const row = {};
      columns.forEach((column, index) => { row[column] = params[index]; });
      table.set(String(params[0]), row);
      return { results: [] };
    }
    match = text.match(/^DELETE FROM musestatus_chunks WHERE chunk_id = \?$/);
    if (match) {
      tables.musestatus_chunks.delete(params[0]);
      return { results: [] };
    }
    throw new Error("fake D1 does not understand SQL: " + text);
  }

  function prepare(sql) {
    const statement = {
      params: [],
      bind(...params) { statement.params = params; return statement; },
      async first() { return runStatement(sql, statement.params).first ?? null; },
      async all() { return { results: runStatement(sql, statement.params).results || [] }; },
      async run() { runStatement(sql, statement.params); return { success: true }; },
      _sql: sql,
    };
    return statement;
  }

  return {
    tables,
    prepare,
    async batch(statements) {
      return statements.map((statement) => runStatement(statement._sql, statement.params));
    },
  };
}

function makeEnv(db) {
  return {
    HUB_PROXY_KEY: "hub-key-123",
    PUBLISH_KEY: "publish-key-456",
    MUSESTATUS_DB: db,
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        return new Response("asset:" + url.pathname, { status: 200 });
      },
    },
  };
}

const GATE = { "X-Hub-Proxy-Key": "hub-key-123" };
function req(path, options) {
  return new Request("https://musestatus.pages.dev" + path, options || {});
}

const db = makeDb();
const env = makeEnv(db);

// 1. Gate: page request without the key redirects to the hub path.
{
  const res = await worker.fetch(req("/"), env);
  check("gate 302 on page without key", res.status === 302 && res.headers.get("location") === "https://armanai.pages.dev/musestatus/", "status=" + res.status);
}
// 2. Gate: API request without the key is a 401 JSON.
{
  const res = await worker.fetch(req("/api/data"), env);
  const body = await res.json();
  check("gate 401 on api without key", res.status === 401 && body.error === "unauthorized", "status=" + res.status);
}
// 3. Gate: wrong key also fails, and an unset secret fails closed.
{
  const res = await worker.fetch(req("/", { headers: { "X-Hub-Proxy-Key": "wrong" } }), env);
  check("gate 302 on wrong key", res.status === 302);
  const openEnv = makeEnv(makeDb());
  delete openEnv.HUB_PROXY_KEY;
  const res2 = await worker.fetch(req("/api/data", { headers: GATE }), openEnv);
  check("gate fails closed when secret unset", res2.status === 401, "status=" + res2.status);
}
// 4. Static asset passes through with the hub prefix stripped.
{
  const res = await worker.fetch(req("/musestatus/app.js", { headers: GATE }), env);
  const text = await res.text();
  check("assets served at stripped path", res.status === 200 && text === "asset:/app.js", text);
}
// 5. Publish: missing / wrong bearer key is a 401 (publish has its own auth,
// no hub key involved).
{
  const res = await worker.fetch(req("/api/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env);
  check("publish 401 without bearer", res.status === 401, "status=" + res.status);
  const res2 = await worker.fetch(req("/api/publish", { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" }), env);
  check("publish 401 with wrong bearer", res2.status === 401);
}
// 6. Publish: a full payload writes sections, fs chunks and bodies behind
// the hash gate; a repeat publish of the same hashes writes zero rows.
{
  const payload = {
    sections: {
      machines: { stamp: 1700000000000, hash: "hash-machines", data: { cols: ["Label"], rows: [["Geekom"]] } },
      fsmeta: { stamp: 1700000000000, hash: "hash-fsmeta", data: { root: "/home/hatch", totalFiles: 3 } },
    },
    fsChunks: [
      { id: "fs:manifest", hash: "hash-manifest", payload: { "/home/hatch": "fs:00000" } },
      { id: "fs:00000", hash: "hash-chunk0", payload: { "/home/hatch": { stamp: 1700000000000, children: [{ n: "a.txt", d: false, s: 10, m: 1700000000000 }] } } },
    ],
    prefBodies: [{ id: "f1", hash: "hash-body1", name: "MEMORY.md", path: "/home/hatch/MEMORY.md", body: "hello" }],
  };
  const init = { method: "POST", headers: { Authorization: "Bearer publish-key-456", "content-type": "application/json" }, body: JSON.stringify(payload) };
  const res = await worker.fetch(req("/api/publish", init), env);
  const body = await res.json();
  check("publish writes 5 rows", res.status === 200 && body.written === 5 && body.skipped === 0 && body.deleted === 0, JSON.stringify(body));
  const res2 = await worker.fetch(req("/api/publish", init), env);
  const body2 = await res2.json();
  check("publish repeat skips all (hash gate)", body2.written === 0 && body2.skipped === 5, JSON.stringify(body2));
  // A changed hash writes exactly that one row.
  const changed = JSON.parse(JSON.stringify(payload));
  changed.sections.machines = { stamp: 1700000001000, hash: "hash-machines-2", data: { cols: ["Label"], rows: [["Omnist"]] } };
  const res3 = await worker.fetch(req("/api/publish", { ...init, body: JSON.stringify(changed) }), env);
  const body3 = await res3.json();
  check("publish changed hash writes 1 row", body3.written === 1 && body3.skipped === 4, JSON.stringify(body3));
}
// 7. Prefs roundtrip: empty is "null", PUT stores, GET returns it.
{
  const res = await worker.fetch(req("/api/prefs", { headers: GATE }), env);
  check("prefs empty reads null", (await res.text()) === "null");
  const state = JSON.stringify({ paneOrder: ["machines"], stars: ["x"] });
  const put = await worker.fetch(req("/api/prefs", { method: "PUT", headers: { ...GATE, "content-type": "application/json" }, body: state }), env);
  check("prefs PUT is 204", put.status === 204, "status=" + put.status);
  const res2 = await worker.fetch(req("/api/prefs", { headers: GATE }), env);
  check("prefs roundtrip", (await res2.text()) === state);
  const bad = await worker.fetch(req("/api/prefs", { method: "PUT", headers: { ...GATE }, body: "{nope" }), env);
  check("prefs PUT rejects bad json", bad.status === 400, "status=" + bad.status);
}
// 8. Data assembly: sections come back keyed by name, fsmeta included.
{
  const res = await worker.fetch(req("/api/data", { headers: GATE }), env);
  const body = await res.json();
  check("data assembles sections", body.sections && body.sections.machines && body.sections.machines.data.rows[0][0] === "Omnist" && body.sections.fsmeta.data.root === "/home/hatch", JSON.stringify(Object.keys(body.sections || {})));
  check("data is no-store", (res.headers.get("cache-control") || "").includes("no-store"));
}
// 9. FS get: folder resolves through manifest + chunk; unknown is a 404.
{
  const res = await worker.fetch(req("/api/fs?path=" + encodeURIComponent("/home/hatch"), { headers: GATE }), env);
  const body = await res.json();
  check("fs get returns children", res.status === 200 && body.children[0].n === "a.txt", "status=" + res.status);
  const res2 = await worker.fetch(req("/api/fs?path=" + encodeURIComponent("/nope"), { headers: GATE }), env);
  check("fs get 404 when absent", res2.status === 404, "status=" + res2.status);
}
// 10. Prefbody get + chunk delete path.
{
  const res = await worker.fetch(req("/api/prefbody?id=f1", { headers: GATE }), env);
  const body = await res.json();
  check("prefbody get", res.status === 200 && body.body === "hello", "status=" + res.status);
  const del = await worker.fetch(req("/api/publish", {
    method: "POST",
    headers: { Authorization: "Bearer publish-key-456", "content-type": "application/json" },
    body: JSON.stringify({ fsChunksDeleted: ["fs:00000"] }),
  }), env);
  const delBody = await del.json();
  check("publish deletes chunk rows", delBody.deleted === 1, JSON.stringify(delBody));
  const res2 = await worker.fetch(req("/api/fs?path=" + encodeURIComponent("/home/hatch"), { headers: GATE }), env);
  check("fs get 404 after chunk delete", res2.status === 404);
}

console.log(failures ? "\n" + failures + " failure(s)" : "\nAll tests passed");
process.exit(failures ? 1 : 0);
