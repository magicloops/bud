const SERVICE_PREFIXES = ["/api/", "/.well-known/"];
const SERVICE_PREFIX_LIKE_PATHS = ["/ws", "/readyz", "/healthz"];
const DEFAULT_PROXY_BASE_DOMAIN = "bud.show";

function isServicePath(pathname) {
  return (
    SERVICE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    SERVICE_PREFIX_LIKE_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  );
}

function isProxyGatewayHost(hostname, env) {
  const baseDomain = env.PROXY_BASE_DOMAIN || DEFAULT_PROXY_BASE_DOMAIN;
  return hostname !== baseDomain && hostname.endsWith(`.${baseDomain}`);
}

function forwardedPort(url) {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}

function shouldForwardToService(url, env) {
  return isServicePath(url.pathname) || isProxyGatewayHost(url.hostname, env);
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);

    if (!shouldForwardToService(incomingUrl, env)) {
      return fetch(request);
    }

    const serviceOrigin = new URL(env.SERVICE_ORIGIN);
    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = serviceOrigin.protocol;
    upstreamUrl.hostname = serviceOrigin.hostname;
    upstreamUrl.port = serviceOrigin.port;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", incomingUrl.host);
    headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
    headers.set("x-forwarded-port", forwardedPort(incomingUrl));
    headers.set("x-bud-edge-router", "cloudflare-worker");
    if (env.PROXY_EDGE_SECRET) {
      headers.set("x-bud-edge-secret", env.PROXY_EDGE_SECRET);
    }

    const upstreamRequest = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    return fetch(upstreamRequest, { cache: "no-store" });
  },
};
