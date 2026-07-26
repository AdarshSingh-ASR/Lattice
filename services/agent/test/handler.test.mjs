import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "../src/index.mjs";

test("rejects malformed JSON as a client error without running the agent", async () => {
  const response = await handler({
    rawPath: "/trace",
    requestContext: { http: { method: "POST" }, requestId: "malformed-json-test" },
    body: "{not-json",
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: "invalid_json",
    message: "Request body must be valid JSON.",
  });
});

test("returns a stable response for unknown routes and preflight requests", async () => {
  const unknown = await handler({
    rawPath: "/missing",
    requestContext: { http: { method: "GET" } },
  });
  const preflight = await handler({
    rawPath: "/trace",
    requestContext: { http: { method: "OPTIONS" } },
  });

  assert.equal(unknown.statusCode, 404);
  assert.equal(JSON.parse(unknown.body).error, "route_not_found");
  assert.equal(preflight.statusCode, 204);
  assert.match(preflight.headers["access-control-allow-methods"], /POST/);
});
