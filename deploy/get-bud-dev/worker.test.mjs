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
  releaseManifests: {
    "v0.1.0": stableManifest,
  },
  releaseAssets: {
    "v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz":
      "https://github.com/bud-dev/bud/releases/download/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
  },
});

function request(path, init = {}) {
  return new Request(`https://get.bud.dev${path}`, init);
}

test("serves install.sh with shell content type", async () => {
  const response = await worker.fetch(request("/install.sh"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
  assert.match(await response.text(), /^#!\/bin\/sh/);
});

test("serves root installer alias with shell content type", async () => {
  const response = await worker.fetch(request("/"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
  assert.equal(await response.text(), "#!/bin/sh\necho install\n");
});

test("HEAD root installer alias returns headers without a body", async () => {
  const response = await worker.fetch(request("/", { method: "HEAD" }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
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
  assert.equal(await response.text(), "#!/bin/sh\necho asset\n");

  const rootResponse = await assetWorker.fetch(request("/"));
  assert.equal(rootResponse.status, 200);
  assert.equal(rootResponse.headers.get("content-type"), "text/x-shellscript; charset=utf-8");
  assert.equal(await rootResponse.text(), "#!/bin/sh\necho asset\n");
});

test("serves stable manifest as JSON", async () => {
  const response = await worker.fetch(request("/releases/stable/manifest.json"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300, must-revalidate");
  assert.deepEqual(await response.json(), stableManifest);
});

test("serves stable manifest, versioned manifest, and redirects from static assets", async () => {
  const assetWorker = createGetBudDevWorker({
    assets: {
      async fetch(assetRequest) {
        const path = new URL(assetRequest.url).pathname;
        if (path === "/releases/stable/manifest.json") {
          return Response.json(stableManifest);
        }
        if (path === "/releases/v0.1.0/manifest.json") {
          return Response.json(stableManifest);
        }
        if (path === "/_release-assets.json") {
          return Response.json({
            "v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz":
              "https://github.com/bud-dev/bud/releases/download/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
          });
        }
        return new Response("not found\n", { status: 404 });
      },
    },
  });

  assert.equal(
    (await assetWorker.fetch(request("/releases/stable/manifest.json"))).status,
    200,
  );
  assert.equal((await assetWorker.fetch(request("/releases/v0.1.0/manifest.json"))).status, 200);
  const redirect = await assetWorker.fetch(
    request("/releases/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz"),
  );
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get("location"), /github\.com\/bud-dev\/bud\/releases\/download/);
});

test("serves immutable versioned manifest", async () => {
  const response = await worker.fetch(request("/releases/v0.1.0/manifest.json"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.deepEqual(await response.json(), stableManifest);
});

test("redirects versioned artifact paths to exact GitHub release asset", async () => {
  const response = await worker.fetch(
    request("/releases/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz"),
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://github.com/bud-dev/bud/releases/download/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
  );
  assert.equal(response.headers.get("x-bud-release-origin"), "github-release");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
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

test("returns 404 for unknown paths and unmapped release assets", async () => {
  assert.equal((await worker.fetch(request("/missing"))).status, 404);
  assert.equal(
    (await worker.fetch(request("/releases/v0.1.0/bud-aarch64-apple-darwin.tar.gz"))).status,
    404,
  );
});
