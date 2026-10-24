// musestatus — Cloudflare Pages worker.
//
// This worker does four jobs:
//   1. Gate: only requests that arrive through the armanai hub (carrying the
//      shared hub proxy key) may see the app. Anything else is bounced to the
//      hub path, and API calls without the key get a plain 401. If the secret
//      is not configured at all the gate fails closed — nobody gets in.
//   2. View state: GET/PUT api/prefs reads and writes the visitor's layout
//      (pane order, labels, column widths, stars, theme) in KV, so the view
//      follows Arman across devices. Writes are skipped when nothing changed,
//      to stay well inside KV's daily write budget.
//   3. Published data: GET api/data, api/fs and api/prefbody serve the
//      snapshots the VM publisher cron (musestatus-publish) pushes in.
//   4. Publish: POST api/publish accepts those snapshots from the VM, guarded
//      by a separate publish key. Everything else is a static file.
//
// All links and fetches in the page are relative, because the hub strips (or
// keeps) the /musestatus prefix depending on the route — this worker strips a
// leading /musestatus itself so both cases behave the same.

const HUB_HOME = "https://armanai.pages.dev/musestatus/";
const MAX_PREFS_BYTES = 200000;
const MAX_PUBLISH_BYTES = 12 * 1024 * 1024;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = stripHubPrefix(url.pathname);
    const isApi = path === "/api" || path.startsWith("/api/");

    // --- Gate -------------------------------------------------------------
    // Fail closed when the secret is unset: an unconfigured deployment must
    // never serve the app or its data.
    const expectedKey = env.HUB_PROXY_KEY;
    const givenKey = request.headers.get("X-Hub-Proxy-Key");
    if (!expectedKey || givenKey !== expectedKey) {
      if (isApi) return jsonResponse({ error: "unauthorized" }, 401);
      return Response.redirect(HUB_HOME, 302);
    }

    const kv = env.MUSESTATUS_DATA;

    // --- View state ---------------------------------------------------------
    if (path === "/api/prefs") {
      if (request.method === "GET") {
        const saved = kv ? await kv.get("view-state") : null;
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
        if (kv) {
          const current = await kv.get("view-state");
          if (current !== text) await kv.put("view-state", text);
        }
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    // --- Published sections -------------------------------------------------
    if (path === "/api/data" && request.method === "GET") {
      const sections = {};
      if (kv) {
        // List every "sec:" key and parse its stored {stamp, data} value.
        let cursor = undefined;
        do {
          const page = await kv.list({ prefix: "sec:", cursor: cursor, limit: 1000 });
          for (const entry of page.keys) {
            const raw = await kv.get(entry.name);
            if (raw == null) continue;
            let parsed = null;
            try {
              parsed = JSON.parse(raw);
            } catch (error) {
              parsed = null;
            }
            const name = entry.name.slice("sec:".length);
            sections[name] = parsed;
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
      }
      return jsonResponse({ sections: sections });
    }

    // --- One folder of the file-system snapshot -----------------------------
    if (path === "/api/fs" && request.method === "GET") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return jsonResponse({ error: "missing path" }, 400);
      const raw = kv ? await kv.get("fsdir:" + dirPath) : null;
      if (raw == null) return jsonResponse({ error: "not found" }, 404);
      return new Response(raw, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // --- One preference file body -------------------------------------------
    if (path === "/api/prefbody" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return jsonResponse({ error: "missing id" }, 400);
      const raw = kv ? await kv.get("prefbody:" + id) : null;
      if (raw == null) return jsonResponse({ error: "not found" }, 404);
      return new Response(raw, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // --- Publisher intake -----------------------------------------------------
    if (path === "/api/publish" && request.method === "POST") {
      // Fail closed when the publish key is unset.
      const publishKey = env.PUBLISH_KEY;
      const auth = request.headers.get("Authorization") || "";
      if (!publishKey || auth !== "Bearer " + publishKey) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
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

      let written = 0;
      let skipped = 0;
      let deleted = 0;

      // Put a key only when the serialized value actually changed, so a
      // no-op publish costs zero KV writes.
      async function putIfChanged(key, value) {
        const serialized = JSON.stringify(value);
        const current = await kv.get(key);
        if (current === serialized) {
          skipped += 1;
          return;
        }
        await kv.put(key, serialized);
        written += 1;
      }

      if (body.sections && typeof body.sections === "object") {
        for (const name of Object.keys(body.sections)) {
          await putIfChanged("sec:" + name, body.sections[name]);
        }
      }
      if (Array.isArray(body.fsFolders)) {
        for (const folder of body.fsFolders) {
          if (!folder || typeof folder.path !== "string") continue;
          await putIfChanged("fsdir:" + folder.path, {
            stamp: folder.stamp,
            children: folder.children,
          });
        }
      }
      if (Array.isArray(body.fsDeleted)) {
        for (const dirPath of body.fsDeleted) {
          if (typeof dirPath !== "string") continue;
          await kv.delete("fsdir:" + dirPath);
          deleted += 1;
        }
      }
      if (Array.isArray(body.prefBodies)) {
        for (const item of body.prefBodies) {
          if (!item || item.id == null) continue;
          await putIfChanged("prefbody:" + String(item.id), {
            name: item.name,
            path: item.path,
            body: item.body,
          });
        }
      }

      return jsonResponse({ written: written, skipped: skipped, deleted: deleted });
    }

    if (isApi) return jsonResponse({ error: "not found" }, 404);

    // --- Static files ---------------------------------------------------------
    // Serve the asset at the prefix-stripped path.
    const assetUrl = new URL(request.url);
    assetUrl.pathname = path;
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  },
};
