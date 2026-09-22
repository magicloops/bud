import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePins, pinsDrift, renderPins } from "./browser-addon-pins.mjs";

const fixture = () => ({
  nodeVersion: "v24.21.0", playwrightCore: "1.63.0", cftVersion: "153.0.8010.12", minMajor: 153,
  node: [{ target: "aarch64-apple-darwin", url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz", sha256: "a".repeat(64), size: 10, executable: "node-v24.21.0-darwin-arm64/bin/node" }],
  browser: [{ target: "aarch64-apple-darwin", url: "https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip", sha256: "b".repeat(64), size: 20, executable: "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" }],
});

test("rendered pins parse back to the same values, including after rustfmt reflows the file", () => {
  const pins = fixture();
  const rendered = renderPins(pins);
  assert.deepEqual(pinsDrift(parsePins(rendered), pins), []);
  const dir = mkdtempSync(path.join(tmpdir(), "pins-"));
  const file = path.join(dir, "pins.rs");
  writeFileSync(file, rendered);
  const fmt = spawnSync("rustfmt", ["--edition", "2021", file]);
  if (fmt.status === 0) {
    const reflowed = spawnSync("cat", [file], { encoding: "utf8" }).stdout;
    assert.notEqual(reflowed, rendered, "rustfmt should reflow the long artifact lines");
    assert.deepEqual(pinsDrift(parsePins(reflowed), pins), []);
  }
});

test("drift reports changed versions, urls, executables and missing hashes", () => {
  const pins = fixture();
  const stale = { ...pins, cftVersion: "152.0.0.0", node: [{ ...pins.node[0], sha256: "" }], browser: [{ ...pins.browser[0], executable: "chrome-mac-arm64/chrome" }] };
  const drift = pinsDrift(parsePins(renderPins(stale)), pins);
  assert.ok(drift.some(d => d.startsWith("cftVersion")));
  assert.ok(drift.some(d => d.includes("sha256 missing")));
  assert.ok(drift.some(d => d.includes("executable")));
  assert.ok(pinsDrift(parsePins(""), pins).some(d => d.includes("missing target")));
});
