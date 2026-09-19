// The User-Agent must track package.json.
//
// The edge answers a request with no User-Agent with a bare 403, so the header is
// load-bearing. It was a literal beside a version declared elsewhere, which is the
// shape that let the Python SDK serve 0.2.2 while announcing 0.2.0 on the wire.
// src/version.ts is generated at build time; these fail if it has gone stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION } from "../dist/esm/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("generated VERSION matches package.json", () => {
  assert.equal(VERSION, pkg.version);
});

test("the client sends a versioned User-Agent", async () => {
  const source = readFileSync(new URL("../dist/esm/client.js", import.meta.url), "utf8");
  assert.match(source, /speechrevolutions-node\//);
  // A hardcoded version in the built output means the generator was bypassed.
  assert.doesNotMatch(source, /speechrevolutions-node\/\d+\.\d+\.\d+/);
});
