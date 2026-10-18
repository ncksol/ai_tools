import type { IncomingHttpHeaders } from "node:http";
import type { Store } from "./store.ts";

export interface Ctx {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: string;
  store: Store;
}

export interface Result {
  status: number;
  body?: unknown;
}

export type Handler = (ctx: Ctx) => Result | Promise<Result>;

export interface Route {
  method: string;
  path: string;
  handler: Handler;
}

export interface Match {
  route: Route;
  params: Record<string, string>;
}

export function matchRoute(routes: Route[], method: string, path: string): Match | null {
  const parts = segments(path);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = segments(route.path);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const matched = pattern.every((segment, i) => {
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeSegment(parts[i]);
        return true;
      }
      return segment === parts[i];
    });
    if (matched) return { route, params };
  }
  return null;
}

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
