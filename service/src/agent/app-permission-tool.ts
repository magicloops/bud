import type { CanonicalTool } from "../llm/index.js";

export const APP_PERMISSION_TOOL: CanonicalTool = {
  name: "data_request_api_key",
  description: "Request the owning user's approval for a private app backend to query personal data. This pauses the turn until the user decides in Bud. First initialize the backend helper from /api/app-data/backend-helper.mjs on the main Bud API and open the app with web_view_open. Supply only the helper's public installation key and that private proxied site ID. Request only needed fields, history and precision. You cannot approve this request. The result contains public setup metadata, never the credential; use the backend helper to install it without printing secrets. Do not ask the user to paste credentials or put them in browser code.",
  parameters: {
    type: "object", additionalProperties: false,
    required: ["app_label", "purpose", "data_access", "destination"],
    properties: {
      app_label: { type: "string", minLength: 1, maxLength: 120 },
      purpose: { type: "string", minLength: 1, maxLength: 2000 },
      data_access: {
        type: "object", additionalProperties: false,
        required: ["scopes", "contact_fields", "location_precision", "history_days"],
        properties: {
          scopes: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["contacts.read", "location.read"] } },
          contact_fields: { type: "array", maxItems: 6, items: { type: "string", enum: ["names", "organization", "phones", "emails", "postal_addresses", "urls"] }, description: "Nonempty with contacts.read; otherwise empty. Addresses and website URLs require explicit approval and may be uncollected on older sources. Postal addresses are contact records, not observed location evidence." },
          location_precision: { type: "string", enum: ["none", "rounded_2_decimals", "as_collected"], description: "Use none without location.read." },
          history_days: { type: "integer", minimum: 1, maximum: 3650 },
        },
      },
      destination: {
        type: "object", additionalProperties: false, required: ["proxied_site_id", "public_key"],
        properties: {
          proxied_site_id: { type: "string", minLength: 1, maxLength: 128 },
          public_key: { type: "string", maxLength: 2048, description: "SPKI PEM RSA installation public key returned by the backend helper. Never a private key." },
        },
      },
    },
  },
};
