// Local dev server — serves public/ and runs api/*.js the way Vercel does.
//   npm run dev
//
// This exists so you can develop and test without the Vercel CLI. It mimics
// Vercel's Node handler contract: req.query, parsed req.body, and a res with
// .status().json(). Production still runs the same files unchanged.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import "../lib/env.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Vercel-shaped response object over a bare Node ServerResponse. */
function shim(res) {
  let code = 200;
  return Object.assign(res, {
    status(c) {
      code = c;
      return this;
    },
    json(body) {
      const out = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(out);
    },
    send(body) {
      res.writeHead(code);
      res.end(body);
    }
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, "");
    try {
      const mod = await import(pathToFileURL(join(root, "api", `${name}.js`)).href);
      req.query = Object.fromEntries(url.searchParams);
      req.body = await readBody(req);
      await mod.default(req, shim(res));
    } catch (err) {
      if (err.code === "ERR_MODULE_NOT_FOUND") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "no_route", message: `No /api/${name}` } }));
      } else {
        console.error(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "internal", message: "Handler threw." } }));
      }
    }
    return;
  }

  // static files out of public/, with directory traversal blocked
  const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, "public", rel);
  if (!file.startsWith(join(root, "public"))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Daily Spend running at http://localhost:${PORT}`);
});
