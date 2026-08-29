// Run the existing API handlers on Netlify without rewriting them.
//
// The handlers in api/ are written to Vercel's Node signature — (req, res)
// with res.status().json(). Netlify Functions v2 speak Web Request/Response.
// This adapter translates between the two, so there is exactly one
// implementation of the business logic and the same 41 end-to-end tests
// cover both platforms.

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const raw = await request.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Wrap a Vercel-style handler as a Netlify Functions v2 handler. */
export function adapt(handler) {
  return async (request) => {
    const url = new URL(request.url);

    const req = {
      method: request.method,
      // Headers normalises to lowercase, which is what the handlers read
      headers: Object.fromEntries(request.headers),
      query: Object.fromEntries(url.searchParams),
      body: await readBody(request)
    };

    let status = 200;
    let payload = "";
    const headers = {};

    const res = {
      headersSent: false,
      setHeader(k, v) {
        headers[k] = v;
        return this;
      },
      status(code) {
        status = code;
        return this;
      },
      json(obj) {
        payload = JSON.stringify(obj);
        headers["Content-Type"] = "application/json; charset=utf-8";
        this.headersSent = true;
        return this;
      },
      send(text) {
        payload = String(text);
        this.headersSent = true;
        return this;
      }
    };

    await handler(req, res);

    // A handler that returned without answering is a bug, not a 200 with no body.
    if (!res.headersSent) {
      return new Response(
        JSON.stringify({ error: { code: "internal", message: "Handler produced no response." } }),
        { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    return new Response(payload, { status, headers });
  };
}
