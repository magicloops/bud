import assert from "node:assert/strict";
import test from "node:test";
import { validate as isUuid, version as uuidVersion } from "uuid";
import { generateMessageClientId } from "./message-client-id.js";

test("generateMessageClientId returns a UUIDv7", () => {
  const clientId = generateMessageClientId();

  assert.equal(isUuid(clientId), true);
  assert.equal(uuidVersion(clientId), 7);
});
