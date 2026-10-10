import assert from "node:assert/strict";
import test from "node:test";

import { createGetBudDevWorker } from "./worker.js";

const stableManifest = {
  version: "v0.1.0",
  channel: "stable",
  published_at: "2026-05-30T00:00:00Z",
  artifacts: [
    {
      target: "x86_64-unknown-linux-gnu",
      url: "https://get.bud.dev/releases/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
      sha256: "a".repeat(64),
      min_os: "glibc 2.35",
      size: 123,
    },
  ],
};

const worker = createGetBudDevWorker({
  installScript: "#!/bin/sh\necho install\n",
  stableManifest,

});

function request(path, init = {}) {
  return new Request(`https://get.bud.dev${path}`, init);
}

test("serves install.sh with shell content type", async () => {
  const response = await worker.fetch(request("/install.sh"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /^#!\/bin\/sh/);
});

test("serves root installer alias with shell content type", async () => {
  const response = await worker.fetch(request("/"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "#!/bin/sh\necho install\n");
});

test("HEAD root installer alias returns headers without a body", async () => {
  const response = await worker.fetch(request("/", { method: "HEAD" }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
});

test("serves installer from static assets binding when no injected script is configured", async () => {
  const assetWorker = createGetBudDevWorker({
    assets: {
      async fetch(assetRequest) {
        assert.equal(new URL(assetRequest.url).pathname, "/install.sh");
        return new Response("#!/bin/sh\necho asset\n", {
          headers: {
            "content-type": "application/octet-stream",
          },
        });
      },
    },
  });

  const response = await assetWorker.fetch(request("/install.sh"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "#!/bin/sh\necho asset\n");

  const rootResponse = await assetWorker.fetch(request("/"));
  assert.equal(rootResponse.status, 200);
  assert.equal(rootResponse.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
  assert.equal(rootResponse.headers.get("cache-control"), "no-store");
  assert.equal(await rootResponse.text(), "#!/bin/sh\necho asset\n");
});

test("serves stable manifest as JSON", async () => {
  const response = await worker.fetch(request("/releases/stable/manifest.json"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), stableManifest);
});









test("HEAD returns headers without a body", async () => {
  const response = await worker.fetch(
    request("/releases/stable/manifest.json", { method: "HEAD" }),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
});

test("rejects unsupported methods", async () => {
  const response = await worker.fetch(request("/install.sh", { method: "POST" }));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("returns 404 for unknown paths and unsupported release assets", async () => {
  assert.equal((await worker.fetch(request("/missing"))).status, 404);
  assert.equal(
    (await worker.fetch(request("/releases/v0.1.0/bud-unknown.tar.gz"))).status,
    404,
  );
});
