const DEFAULT_INSTALL_SCRIPT = `#!/bin/sh
set -eu

echo "Bud installer is not published yet."
echo "See https://bud.dev for current setup instructions."
exit 1
`;

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);
const ARTIFACT_PATH_RE = /^\/releases\/(v[^/]+)\/(bud-(aarch64-apple-darwin|x86_64-apple-darwin|x86_64-unknown-linux-gnu)\.tar\.gz)$/;
const VERSION_MANIFEST_PATH_RE = /^\/releases\/(v[^/]+)\/manifest\.json$/;
const INSTALLER_PATHS = new Set(["/", "/install.sh"]);

export function createGetBudDevWorker(config = {}) {
  const stableManifest = parseJsonConfig(config.stableManifest, "stableManifest");
  const releaseManifests = parseRecordConfig(config.releaseManifests, "releaseManifests");
  const releaseAssets = parseRecordConfig(config.releaseAssets, "releaseAssets");
  const installScript = config.installScript ?? DEFAULT_INSTALL_SCRIPT;
  const assets = config.assets;

  async function fetch(request) {
    const url = new URL(request.url);

    if (!ALLOWED_METHODS.has(request.method)) {
      return methodNotAllowed();
    }

    if (INSTALLER_PATHS.has(url.pathname)) {
      if (!config.installScript && assets) {
        return installScriptAssetResponse(request, assets);
      }
      return bodyResponse(request, installScript, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "public, max-age=300",
      });
    }

    if (url.pathname === "/releases/stable/manifest.json") {
      const manifest =
        stableManifest ?? (await fetchAssetJson(request, assets, "/releases/stable/manifest.json"));
      if (!manifest) {
        return notFound();
      }
      return jsonResponse(request, manifest, {
        "cache-control": "public, max-age=300, must-revalidate",
      });
    }

    const versionManifestMatch = url.pathname.match(VERSION_MANIFEST_PATH_RE);
    if (versionManifestMatch) {
      const versionManifest =
        releaseManifests[versionManifestMatch[1]] ??
        (await fetchAssetJson(request, assets, `/releases/${versionManifestMatch[1]}/manifest.json`));
      if (!versionManifest) {
        return notFound();
      }
      return jsonResponse(request, versionManifest, {
        "cache-control": "public, max-age=31536000, immutable",
      });
    }

    const artifactMatch = url.pathname.match(ARTIFACT_PATH_RE);
    if (artifactMatch) {
      const releaseAssetMap =
        Object.keys(releaseAssets).length > 0
          ? releaseAssets
          : (await fetchAssetJson(request, assets, "/_release-assets.json")) ?? {};
      const assetUrl = releaseAssetMap[`${artifactMatch[1]}/${artifactMatch[2]}`];
      if (!assetUrl) {
        return notFound();
      }
      return redirectResponse(request, assetUrl);
    }

    return notFound();
  }

  return { fetch };
}

export default {
  async fetch(request, env = {}) {
    return createGetBudDevWorker({
      installScript: env.INSTALL_SCRIPT,
      stableManifest: env.STABLE_MANIFEST_JSON,
      releaseManifests: env.RELEASE_MANIFESTS_JSON,
      releaseAssets: env.RELEASE_ASSETS_JSON,
      assets: env.ASSETS,
    }).fetch(request);
  },
};

function jsonResponse(request, value, headers = {}) {
  return bodyResponse(request, `${JSON.stringify(value, null, 2)}\n`, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
}

function bodyResponse(request, body, headers = {}) {
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

function withHeaders(response, headers) {
  const mergedHeaders = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    mergedHeaders.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: mergedHeaders,
  });
}

async function installScriptAssetResponse(request, assets) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/install.sh";
  assetUrl.search = "";
  const response = await assets.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  return bodyResponse(request, await response.text(), {
    "content-type": "text/x-shellscript; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
}

async function fetchAssetJson(request, assets, pathname) {
  if (!assets) {
    return null;
  }
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  assetUrl.search = "";
  const response = await assets.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function redirectResponse(request, location) {
  const headers = {
    location,
    "cache-control": "public, max-age=31536000, immutable",
    "x-bud-release-origin": "github-release",
  };
  if (request.method === "HEAD") {
    headers["content-length"] = "0";
  }
  return new Response(null, {
    status: 302,
    headers,
  });
}

function methodNotAllowed() {
  return new Response("method not allowed\n", {
    status: 405,
    headers: {
      allow: "GET, HEAD",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function notFound() {
  return new Response("not found\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function parseJsonConfig(value, label) {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`invalid ${label} JSON: ${err.message}`);
  }
}

function parseRecordConfig(value, label) {
  const parsed = parseJsonConfig(value, label);
  if (!parsed) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed;
}
