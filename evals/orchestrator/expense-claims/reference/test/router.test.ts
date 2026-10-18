import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRoute, type Route } from "../src/router.ts";

const ok = () => ({ status: 200 });
const routes: Route[] = [
  { method: "GET", path: "/expenses", handler: ok },
  { method: "GET", path: "/expenses/:id", handler: ok },
  { method: "POST", path: "/expenses", handler: ok },
];

test("matchRoute matches a static path and method", () => {
  const match = matchRoute(routes, "POST", "/expenses");
  assert.equal(match?.route, routes[2]);
  assert.deepEqual(match?.params, {});
});

test("matchRoute extracts :param segments", () => {
  const match = matchRoute(routes, "GET", "/expenses/exp_7");
  assert.equal(match?.route, routes[1]);
  assert.deepEqual(match?.params, { id: "exp_7" });
});

test("matchRoute returns null when nothing matches", () => {
  assert.equal(matchRoute(routes, "DELETE", "/expenses"), null);
  assert.equal(matchRoute(routes, "GET", "/expenses/exp_7/extra"), null);
  assert.equal(matchRoute(routes, "GET", "/nope"), null);
});
