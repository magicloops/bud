import type { GoogleService } from "./config.js";

export type GoogleRequest = {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  etag?: string;
  upload?: boolean;
  contentType?: string;
  rawBody?: Uint8Array<ArrayBuffer>;
  bodyWithMimeType?: (existingMime: string) => Uint8Array<ArrayBuffer>;
  filePreflight?: { fileId: string; version: string; uploadedOnly?: boolean };
  responseMode?: "json" | "text";
};
export type GoogleTool = {
  name: string; description: string; access: "read" | "write";
  input_schema: Record<string, unknown>;
  prepare: (args: unknown, operationId: string) => GoogleRequest;
  transform?: (result: Record<string, unknown>) => Record<string, unknown>;
};
export type ServiceTool = GoogleTool & { service: GoogleService };
export const stringSchema = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
export const objectSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false });
