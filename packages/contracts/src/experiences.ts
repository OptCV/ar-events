import { z } from 'zod';
import { DraftExperienceScene, PLACEMENT_MODES } from '@ar-creator/schema';

export const PlacementModeSchema = z.enum(PLACEMENT_MODES);
export const ExperienceId = z.uuid();

const name = z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.');
const description = z.string().trim().max(2000, 'Use at most 2000 characters.');

/** POST /api/experiences */
export const CreateExperienceInput = z.object({
  name,
  description: description.optional(),
  placementMode: PlacementModeSchema,
});
export type CreateExperienceInput = z.infer<typeof CreateExperienceInput>;

/** PATCH /api/experiences/:id — metadata only. `public` requires publishing (later milestone). */
export const UpdateExperienceInput = z
  .object({
    name: name.optional(),
    description: description.nullable().optional(),
    visibility: z.enum(['draft', 'private_test']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');
export type UpdateExperienceInput = z.infer<typeof UpdateExperienceInput>;

/** PUT /api/experiences/:id/draft — whole draft scene with optimistic concurrency. */
export const SaveDraftInput = z.object({
  scene: DraftExperienceScene,
  /** The `draftVersion` the client last loaded; a mismatch → 409 `conflict`. */
  draftVersion: z.number().int().positive(),
  /** Required when the placement mode changes (explicit, non-destructive migration review). */
  confirmPlacementChange: z.boolean().optional(),
});
export type SaveDraftInput = z.infer<typeof SaveDraftInput>;

export const ExperienceSummary = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  placementMode: PlacementModeSchema,
  visibility: z.enum(['draft', 'private_test', 'public']),
  published: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ExperienceSummary = z.infer<typeof ExperienceSummary>;

export const ExperienceDetail = ExperienceSummary.extend({
  description: z.string().nullable(),
  draftVersion: z.number().int().positive(),
  draft: z.object({ revisionId: z.string(), revisionNumber: z.number().int().positive(), scene: DraftExperienceScene }),
});
export type ExperienceDetail = z.infer<typeof ExperienceDetail>;

export const ExperienceListResponse = z.object({ experiences: z.array(ExperienceSummary) });
export type ExperienceListResponse = z.infer<typeof ExperienceListResponse>;

export const ReadinessResponse = z.object({
  ready: z.boolean(),
  issues: z.array(z.object({ severity: z.enum(['error', 'warning']), code: z.string(), message: z.string(), path: z.array(z.union([z.string(), z.number()])) })),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
