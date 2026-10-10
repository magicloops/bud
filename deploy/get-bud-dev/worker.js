import { deliverRelease, releasePath } from "./release-delivery.js";

const DEFAULT_INSTALL_SCRIPT = `#!/bin/sh
set -eu

echo "Bud installer is not published yet."
echo "See https://bud.dev for current setup instructions."
exit 1
`;

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);
const INSTALLER_PATHS = new Set(["/", "/install.sh"]);
const MUTABLE_RESPONSE_CACHE_CONTROL = "no-store";

export function createGetBudDevWorker(config = {}) {
  const stableManifest = parseJsonConfig(config.stableManifest, "stableManifest");
  const installScript = config.installScript ?? DEFAULT_INSTALL_SCRIPT;
  const assets = config.assets;

  async function fetch(request, context) {
    const url = new URL(request.url);

    if (!ALLOWED_METHODS.has(request.method)) {
      return methodNotAllowed(request);
    }

    if (INSTALLER_PATHS.has(url.pathname)) {
      if (!config.installScript && assets) {
        return installScriptAssetResponse(request, assets);
      }
      return bodyResponse(request, installScript, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": MUTABLE_RESPONSE_CACHE_CONTROL,
      });
    }

    if (url.pathname === "/releases/stable/manifest.json") {
      const manifest =
        stableManifest ?? (await fetchAssetJson(request, assets, "/releases/stable/manifest.json"));
      if (!manifest) {
        return notFound(request);
      }
      return jsonResponse(request, manifest, {
        "cache-control": MUTABLE_RESPONSE_CACHE_CONTROL,
      });
    }

    const route = releasePath(url.pathname);
    if (route) return deliverRelease(request, route, {
      bucket: config.releases,
      cache: config.cache,
      context,
      log: config.log,
    });

    return notFound(request);
  }

  return { fetch };
}

export default {
  async fetch(request, env = {}, context) {
    return createGetBudDevWorker({
      installScript: env.INSTALL_SCRIPT,
      stableManifest: env.STABLE_MANIFEST_JSON,
      releases: env.RELEASES,
      cache: globalThis.caches?.default,
      log: (event) => console.info(JSON.stringify(event)),
      assets: env.ASSETS,
    }).fetch(request, context);
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

async function installScriptAssetResponse(request, assets) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/install.sh";
  assetUrl.search = "";
  const response = await assets.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  return bodyResponse(request, await response.text(), {
    "content-type": "text/x-shellscript; charset=utf-8",
    "cache-control": MUTABLE_RESPONSE_CACHE_CONTROL,
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

function methodNotAllowed(request) {
  return new Response(request.method === "HEAD" ? null : "method not allowed\n", {
    status: 405,
    headers: {
      allow: "GET, HEAD",
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function notFound(request) {
  return new Response(request.method === "HEAD" ? null : "not found\n", {
    status: 404,
    headers: {
      "cache-control": "no-store",
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
