import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { DataRequestError, INGEST_LIMITS, validateEvent, type IngestContext, type ParsedBatch } from "./contracts.js";

const unzip = promisify(gunzip);
const utf8 = new TextDecoder("utf-8", { fatal: true });

// Fastify bounds the incoming buffer before this function. Decode fully before
// persistence so corrupt gzip / oversized batches can never produce a partial ACK.
export async function parseBatch(body: Buffer, encoding: string, context: IngestContext): Promise<ParsedBatch> {
  if (body.length > INGEST_LIMITS.compressed_bytes)
    throw new DataRequestError(413, "payload_too_large", "Encoded batch exceeds byte limit");
  let decoded: Buffer;
  if (encoding === "gzip") {
    try { decoded = await unzip(body, { maxOutputLength: INGEST_LIMITS.decoded_bytes }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
        throw new DataRequestError(413, "payload_too_large", "Decoded batch exceeds byte limit");
      throw new DataRequestError(400, "invalid_gzip", "Invalid or truncated gzip batch");
    }
  } else if (encoding === "identity" || encoding === "") decoded = body;
  else throw new DataRequestError(415, "unsupported_encoding", "Use gzip or identity encoding");
  const result: ParsedBatch = { events: [], rejected: [] };
  let start = 0;
  let line = 0;
  let count = 0;
  while (start < decoded.length) {
    const end = decoded.indexOf(10, start);
    const bytes = decoded.subarray(start, end < 0 ? decoded.length : end);
    start = end < 0 ? decoded.length : end + 1;
    line++;
    if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 13)) continue;
    if (++count > INGEST_LIMITS.events)
      throw new DataRequestError(413, "payload_too_large", "Too many events in batch");
    if (bytes.length > INGEST_LIMITS.line_bytes) {
      result.rejected.push({ line, code: "event_too_large", message: "Event line exceeds byte limit", retryable: false });
      continue;
    }
    let value: unknown;
    try { value = JSON.parse(utf8.decode(bytes)); }
    catch {
      result.rejected.push({ line, code: "invalid_json", message: "Line must be UTF-8 JSON", retryable: false });
      continue;
    }
    const event = validateEvent(value, line, context);
    if ("envelope" in event) result.events.push(event);
    else result.rejected.push(event);
  }
  return result;
}
