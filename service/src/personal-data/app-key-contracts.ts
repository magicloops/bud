import { z } from "zod";
import { appKeyRecipient } from "./app-key-crypto.js";
import { DataRequestError } from "./contracts.js";

export const APP_KEY_LIMITS = {
  pending_requests_per_owner: 20,
  active_keys_per_owner: 100,
  setup_seconds: 86_400,
  history_days: 3650,
  page_size: 100,
} as const;

const unique = (values: string[]) => new Set(values).size === values.length;
export const appDataPolicySchema = z.object({
  scopes: z.array(z.enum(["contacts.read", "location.read"])).min(1).max(2).refine(unique),
  contact_fields: z.array(z.enum(["names", "organization", "phones", "emails", "postal_addresses", "urls"])).max(6).refine(unique),
  location_precision: z.enum(["none", "rounded_2_decimals", "as_collected"]),
  history_days: z.number().int().min(1).max(APP_KEY_LIMITS.history_days),
}).strict().superRefine((value, ctx) => {
  if (value.scopes.includes("contacts.read") !== (value.contact_fields.length > 0))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contact_fields"], message: "Contact fields must match contacts scope" });
  if (value.scopes.includes("location.read") !== (value.location_precision !== "none"))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["location_precision"], message: "Location precision must match location scope" });
});
export type AppDataPolicy = z.infer<typeof appDataPolicySchema>;

const publicKeySchema = z.string().max(2048).transform((value, ctx) => {
  try { return appKeyRecipient(value); }
  catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A supported installation public key is required" });
    return z.NEVER;
  }
});

/** All execution and ownership identities are supplied separately by the server. */
export const appKeyRequestSchema = z.object({
  app_label: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(2000),
  data_access: appDataPolicySchema,
  destination: z.object({
    proxied_site_id: z.string().min(1).max(128),
    public_key: publicKeySchema,
  }).strict(),
}).strict();
export type AppKeyRequestDefinition = z.infer<typeof appKeyRequestSchema>;

export const appKeyDecisionSchema = z.object({
  decision: z.enum(["approve", "decline"]),
  expected_version: z.number().int().nonnegative().safe(),
  idempotency_key: z.string().min(1).max(256),
}).strict();

export const appKeyRevokeSchema = z.object({
  expected_version: z.number().int().nonnegative().safe(),
  idempotency_key: z.string().min(1).max(256),
}).strict();

// Fixed schemas prevent arbitrary app data from becoming logs or state changes.
export const appKeyProofSchema = z.object({ signature: z.string().regex(/^[A-Za-z0-9_-]{512,683}$/) }).strict();

export function parseAppKeyInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DataRequestError(400, "invalid_app_key_request", "Check the app data permissions and setup destination");
  return parsed.data;
}
