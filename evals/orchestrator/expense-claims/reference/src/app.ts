import { createServer, type Server } from "node:http";
import { HttpError, errorBody, readBody, sendJson } from "./http.ts";
import { matchRoute, type Ctx } from "./router.ts";
import { routes } from "./routes.ts";
import { Store } from "./store.ts";

export function createApp(): Server {
  const store = new Store();
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const match = matchRoute(routes, method, url.pathname);
      if (!match) throw new HttpError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
      const ctx: Ctx = {
        method,
        path: url.pathname,
        params: match.params,
        query: url.searchParams,
        headers: req.headers,
        rawBody: await readBody(req),
        store,
      };
      const result = await match.route.handler(ctx);
      sendJson(res, result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, errorBody(err));
      } else {
        console.error(err);
        sendJson(res, 500, errorBody(new HttpError(500, "INTERNAL", "Internal error")));
      }
    }
  });
}
