import { z } from "zod";
import { automationBootstrapPreviewSchema, automationDefinitionSchema, AUTOMATION_LIMITS } from "./automation-contracts.js";

/** Selection only: owner, grant, active revision and frozen members are server-bound. */
export const automationBootstrapReviewRequestSchema = automationBootstrapPreviewSchema
  .omit({ expected_grant_version: true, use_draft: true })
  .extend({ automation_id: z.string().min(1).max(128) })
  .strict();

export type AutomationBootstrapReviewRequest = z.infer<typeof automationBootstrapReviewRequestSchema>;

/** Distinct kind prevents an existing-contact review from being treated as activation. */
export const automationReviewKindSchema = z.enum(["activation", "existing_contacts"]);
export type AutomationReviewKind = z.infer<typeof automationReviewKindSchema>;

/** Internal persisted evidence, never a model or human decision body. */
export const frozenBootstrapReviewSchema = z.object({
  owner: z.string().min(1),
  selection: automationBootstrapReviewRequestSchema,
  revision: z.number().int().positive().safe(),
  grant_version: z.number().int().nonnegative().safe(),
  publication_boundary: z.number().int().nonnegative().safe(),
  definition: automationDefinitionSchema,
  contact_revision_ids: z.array(z.string().min(1).max(128)).max(AUTOMATION_LIMITS.bootstrap_contacts)
    .refine(ids => new Set(ids).size === ids.length, "Duplicate membership"),
}).strict().refine(value => value.contact_revision_ids.length <= value.selection.max_contacts,
  "Membership exceeds reviewed limit");
export type FrozenBootstrapReview = z.infer<typeof frozenBootstrapReviewSchema>;
