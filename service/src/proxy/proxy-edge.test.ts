import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { config } from "../config.js";
import {
  buildProxyRequestBody,
  buildProxyRequestHeaders,
  filterProxyResponseSetCookies,
} from "./proxy-edge.js";

test("proxy request body builder preserves buffered bodies for mutation methods", () => {
  const json = buildProxyRequestBody(
    {
      headers: { "content-type": "application/json" },
      body: { name: "Bud" },
    } as never,
    "POST",
  );

  assert.equal(json.ok, true);
  assert.equal(json.ok ? json.body.toString("utf-8") : "", "{\"name\":\"Bud\"}");

  const binary = buildProxyRequestBody(
    {
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from([1, 2, 3]),
    } as never,
    "PATCH",
  );

  assert.equal(binary.ok, true);
  assert.deepEqual(json.ok && binary.ok ? [...binary.body] : [], [1, 2, 3]);
});

test("proxy request body builder ignores GET and rejects unavailable declared bodies", () => {
  const get = buildProxyRequestBody(
    {
      headers: { "content-length": "100" },
      body: Buffer.from("ignored"),
    } as never,
    "GET",
  );
  assert.equal(get.ok, true);
  assert.equal(get.ok ? get.body.byteLength : -1, 0);

  const missing = buildProxyRequestBody(
    {
      headers: { "content-length": "5" },
      body: undefined,
    } as never,
    "POST",
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? 0 : missing.statusCode, 400);
});

test("proxy request headers forward only endpoint-host local app cookies", () => {
  const endpointHost = buildProxyRequestHeaders(
    {
      accept: "text/html",
      authorization: "Bearer secret",
      cookie: [
        `${config.proxyViewerCookieName}=viewer-token`,
        "app_session=abc",
        "bud_proxy_other=reserved",
        "__Host-bud_proxy_viewer=reserved",
        "theme=dark",
      ].join("; "),
    },
    { allowLocalAppCookies: true },
  );

  assert.equal(endpointHost.ok, true);
  assert.deepEqual(endpointHost.ok ? endpointHost.headers : {}, {
    accept: "text/html",
    cookie: "app_session=abc; theme=dark",
  });

  const rawProxy = buildProxyRequestHeaders(
    {
      cookie: "app_session=abc",
    },
    { allowLocalAppCookies: false },
  );
  assert.equal(rawProxy.ok, true);
  assert.equal(rawProxy.ok ? rawProxy.headers.cookie : "unexpected", undefined);
});

test("proxy request headers reject oversized forwarded cookie sets", () => {
  const tooManyCookies = Array.from(
    { length: config.proxyLocalAppCookieMaxCount + 1 },
    (_, index) => `c${index}=v`,
  ).join("; ");
  const result = buildProxyRequestHeaders(
    { cookie: tooManyCookies },
    { allowLocalAppCookies: true },
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? 200 : result.statusCode, 431);
  assert.equal(result.ok ? "" : result.payload.error, "proxy_cookie_count_exceeded");
});

test("proxy response set-cookie filtering keeps app cookies endpoint-host scoped", () => {
  const filtered = filterProxyResponseSetCookies(
    [
      "app_session=abc; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax",
      `${config.proxyViewerCookieName}=evil; Path=/`,
      "bad=line\r\nSet-Cookie: injected=true; Path=/",
      "theme=dark; Max-Age=3600; Secure",
    ],
    { allowLocalAppCookies: true },
  );

  assert.deepEqual(filtered, [
    "app_session=abc; Path=/; HttpOnly; SameSite=Lax",
    "theme=dark; Max-Age=3600; Secure",
  ]);
  assert.deepEqual(
    filterProxyResponseSetCookies(["app_session=abc; Path=/"], {
      allowLocalAppCookies: false,
    }),
    [],
  );
});

test("proxy response set-cookie filtering caps forwarded app cookies", () => {
  const filtered = filterProxyResponseSetCookies(
    Array.from(
      { length: config.proxyLocalAppCookieMaxCount + 1 },
      (_, index) => `c${index}=v; Path=/`,
    ),
    { allowLocalAppCookies: true },
  );

  assert.equal(filtered.length, config.proxyLocalAppCookieMaxCount);
});
