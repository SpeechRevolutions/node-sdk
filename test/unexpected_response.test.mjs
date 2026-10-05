import { test } from "node:test";
import assert from "node:assert/strict";
import { unexpectedResponseMessage } from "../dist/esm/client.js";

test("an edge-firewall HTML 403 says why, instead of a bare status", () => {
  const msg = unexpectedResponseMessage(403, "<html><body><h1>403 Forbidden</h1></body></html>");
  assert.match(msg, /edge firewall/);
  assert.match(msg, /callbackUrl or audioUrl/);
});

test("a JSON detail from the API is passed through", () => {
  assert.equal(unexpectedResponseMessage(402, '{"detail":"Insufficient balance"}'), "HTTP 402: Insufficient balance");
});

test("anything else keeps the status and a cleaned snippet", () => {
  assert.equal(unexpectedResponseMessage(502, "<p>Bad   gateway</p>"), "Unexpected response (HTTP 502): Bad gateway");
});
