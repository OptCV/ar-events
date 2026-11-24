/**
 * Application tables (DATA_MODEL.md). Users are Better Auth's `user` table (ADR-013); every owned row
 * references `user.id` (text). Enum values are imported from the TypeScript sources of truth so the
 * database cannot drift from `packages/schema` (asset roles) and `packages/platform-launch` (runtimes).
 * Revision/output immutability is enforced by triggers in migration 0001 (see migrations/).
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  date,
  primaryKey,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { AssetRole } from '@ar-creator/schema';
import { RUNTIMES } from '@ar-creator/platform-launch/runtime';
import { user } from './auth.ts';

type NonEmpty = [string, ...string[]];
const tuple = (v: readonly string[]) => v as unknown as NonEmpty;

// ---------- enums
export const placementModeEnum = pgEnum('placement_mode', ['image', 'floor', 'wall']);
export const experienceVisibilityEnum = pgEnum('experience_visibility', ['draft', 'private_test', 'public']);
/** `draft` is the only mutable state; every other state is a frozen snapshot (trigger-enforced). */
export const revisionStateEnum = pgEnum('revision_state', [
  'draft',
  'snapshot',
  'compiling',
  'partially_ready',
  'published',
  /** A test build whose every output is ready (Phase 5 M16, ADR-034). */
  'ready',
  'failed',
  'superseded',
]);
export const assetRoleEnum = pgEnum('asset_role', tuple(AssetRole.options));
export const assetStateEnum = pgEnum('asset_state', ['pending_upload', 'uploaded', 'validated', 'rejected', 'deleted']);
export const derivativeTypeEnum = pgEnum('derivative_type', ['image_object_glb', 'image_object_usdz', 'thumbnail', 'image_object_texture']);
export const outputStateEnum = pgEnum('output_state', ['pending', 'ready', 'failed']);
export const jobTypeEnum = pgEnum('job_type', ['validate_asset', 'convert_image_to_ar', 'compile_revision', 'publish_revision']);
export const jobStateEnum = pgEnum('job_state', ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const runtimeEnum = pgEnum('runtime', tuple(RUNTIMES));

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};
const SHA256 = (col: SQL | AnyPgColumn) => sql`${col} ~ '^[0-9a-f]{64}$'`;

// ---------- experiences
export const experiences = pgTable(
  'experiences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    description: varchar('description', { length: 2000 }),
    /** Public URL slug; lowercase, 3–64 chars, stable once published. */
    slug: varchar('slug', { length: 64 }).notNull().unique('experiences_slug_unique'),
    /** Denormalised from the draft revision for dashboard filtering; updated in the same transaction (M4). */
    placementMode: placementModeEnum('placement_mode').notNull(),
    visibility: experienceVisibilityEnum('visibility').notNull().default('draft'),
    /** Optimistic concurrency for draft saves (ADR-021): bumped on every save; stale writers get 409. */
    draftVersion: integer('draft_version').notNull().default(1),
    draftRevisionId: uuid('draft_revision_id'),
    publishedRevisionId: uuid('published_revision_id'),
    ...timestamps,
  },
  (t) => [
    index('experiences_owner_updated_idx').on(t.ownerId, t.updatedAt),
    check('experiences_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('experiences_slug_format', sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$'`),
    check('experiences_draft_version_positive', sql`${t.draftVersion} > 0`),
    // Pointers must reference revisions of THIS experience (composite FK; NULL skips the check).
    foreignKey({
      name: 'experiences_draft_revision_fk',
      columns: [t.draftRevisionId, t.id],
      foreignColumns: [experienceRevisions.id, experienceRevisions.experienceId],
    }).onDelete('no action'),
    foreignKey({
      name: 'experiences_published_revision_fk',
      columns: [t.publishedRevisionId, t.id],
      foreignColumns: [experienceRevisions.id, experienceRevisions.experienceId],
    }).onDelete('no action'),
  ],
);

// ---------- revisions
export const experienceRevisions = pgTable(
  'experience_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    experienceId: uuid('experience_id')
      .notNull()
      .references((): AnyPgColumn => experiences.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    state: revisionStateEnum('state').notNull().default('draft'),
    schemaVersion: smallint('schema_version').notNull(),
    /** Canonical scene JSON validated by packages/schema `ExperienceScene` at the API boundary. */
    config: jsonb('config').notNull(),
    validationReport: jsonb('validation_report'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    /**
     * Builds (ADR-034): SHA-256 over the scene, the files it uses and the compiler versions. An unchanged draft reuses
     * its build. Immutable once frozen (trigger).
     */
    contentHash: char('content_hash', { length: 64 }),
  },
  (t) => [
    unique('experience_revisions_number_unique').on(t.experienceId, t.revisionNumber),
    unique('experience_revisions_id_experience_unique').on(t.id, t.experienceId),
    uniqueIndex('experience_revisions_one_draft_idx').on(t.experienceId).where(sql`${t.state} = 'draft'`),
    check('experience_revisions_number_positive', sql`${t.revisionNumber} > 0`),
    check('experience_revisions_schema_version_positive', sql`${t.schemaVersion} > 0`),
    check('experience_revisions_config_object', sql`jsonb_typeof(${t.config}) = 'object'`),
    check('experience_revisions_frozen_at', sql`(${t.state} = 'draft') = (${t.frozenAt} IS NULL)`),
    check('experience_revisions_content_hash_format', sql`${t.contentHash} IS NULL OR ${SHA256(t.contentHash)}`),
    uniqueIndex('experience_revisions_content_hash_idx').on(t.experienceId, t.contentHash).where(sql`${t.contentHash} IS NOT NULL`),
  ],
);

// ---------- assets
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Explicit role; never inferred from MIME type (ADR-003). */
    role: assetRoleEnum('role').notNull(),
    state: assetStateEnum('state').notNull().default('pending_upload'),
    mimeType: varchar('mime_type', { length: 100 }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: char('sha256', { length: 64 }),
    /** Server-generated R2 key (DATA_MODEL.md layout); never derived from user filenames. */
    r2Key: text('r2_key').notNull().unique('assets_r2_key_unique'),
    /** Sanitised display name only. */
    originalFilename: varchar('original_filename', { length: 255 }),
    metadata: jsonb('metadata').notNull().default({}),
    /** Upload slot (ADR-022): a pending asset accepts exactly one upload attempt before this time. */
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }),
    /** Set atomically when an upload attempt starts; a claimed slot can never be reused. */
    uploadClaimedAt: timestamp('upload_claimed_at', { withTimezone: true }),
    /** Machine-readable reason for `rejected` (safe to show; never contains file contents). */
    rejectionCode: varchar('rejection_code', { length: 40 }),
    ...timestamps,
  },
  (t) => [
    index('assets_owner_created_idx').on(t.ownerId, t.createdAt),
    check('assets_pending_has_expiry', sql`${t.state} <> 'pending_upload' OR ${t.uploadExpiresAt} IS NOT NULL`),
    check('assets_rejected_has_code', sql`${t.state} <> 'rejected' OR ${t.rejectionCode} IS NOT NULL`),
    check('assets_size_nonnegative', sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} >= 0`),
    check('assets_sha256_format', sql`${t.sha256} IS NULL OR ${SHA256(t.sha256)}`),
    check('assets_r2_key_owned_prefix', sql`${t.r2Key} LIKE 'users/%'`),
    check(
      'assets_validated_has_checksum',
      sql`${t.state} NOT IN ('uploaded', 'validated') OR (${t.sha256} IS NOT NULL AND ${t.sizeBytes} IS NOT NULL AND ${t.mimeType} IS NOT NULL)`,
    ),
  ],
);

export const assetDerivatives = pgTable(
  'asset_derivatives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceAssetId: uuid('source_asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    outputType: derivativeTypeEnum('output_type').notNull(),
    status: outputStateEnum('status').notNull().default('pending'),
    settings: jsonb('settings').notNull(),
    /** SHA-256 of canonical settings JSON: same input + settings + converter → reuse (IMAGE_TO_AR.md). */
    settingsHash: char('settings_hash', { length: 64 }).notNull(),
    converterVersion: varchar('converter_version', { length: 64 }).notNull(),
    r2Key: text('r2_key').unique('asset_derivatives_r2_key_unique'),
    sha256: char('sha256', { length: 64 }),
    /** Output size in bytes (ready outputs). Phase 2 (ADR-023). */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    diagnostics: jsonb('diagnostics'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('asset_derivatives_provenance_unique').on(t.sourceAssetId, t.outputType, t.settingsHash, t.converterVersion),
    check('asset_derivatives_settings_hash_format', SHA256(t.settingsHash)),
    check('asset_derivatives_ready_complete', sql`${t.status} <> 'ready' OR (${t.r2Key} IS NOT NULL AND ${t.sha256} IS NOT NULL)`),
    check('asset_derivatives_ready_has_size', sql`${t.status} <> 'ready' OR ${t.sizeBytes} IS NOT NULL`),
    check('asset_derivatives_sha256_format', sql`${t.sha256} IS NULL OR ${SHA256(t.sha256)}`),
    check('asset_derivatives_r2_key_owned_prefix', sql`${t.r2Key} IS NULL OR ${t.r2Key} LIKE 'users/%'`),
  ],
);

// ---------- processing jobs
export const processingJobs = pgTable(
  'processing_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: jobTypeEnum('type').notNull(),
    state: jobStateEnum('state').notNull().default('queued'),
    /** Client/workflow-supplied key; duplicates are rejected so retries never double-process. */
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull().unique('processing_jobs_idempotency_unique'),
    revisionId: uuid('revision_id').references(() => experienceRevisions.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** What to do (e.g. Image-to-AR settings + their hash). Immutable once queued. Phase 2 (ADR-023). */
    input: jsonb('input'),
    /** Machine-readable failure reason (contracts CONVERSION_ERRORS); set only when state = failed. */
    errorCode: varchar('error_code', { length: 40 }),
    diagnostics: jsonb('diagnostics'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('processing_jobs_state_created_idx').on(t.state, t.createdAt),
    check('processing_jobs_has_target', sql`num_nonnulls(${t.revisionId}, ${t.assetId}) >= 1`),
    check('processing_jobs_failed_has_code', sql`${t.state} <> 'failed' OR ${t.errorCode} IS NOT NULL`),
    index('processing_jobs_owner_asset_idx').on(t.ownerId, t.assetId, t.createdAt),
    check('processing_jobs_attempts_bounded', sql`${t.attempt} >= 0 AND ${t.maxAttempts} BETWEEN 1 AND 10 AND ${t.attempt} <= ${t.maxAttempts}`),
  ],
);

// ---------- generated outputs (one per revision × runtime)
export const generatedOutputs = pgTable(
  'generated_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => experienceRevisions.id, { onDelete: 'cascade' }),
    runtime: runtimeEnum('runtime').notNull(),
    state: outputStateEnum('state').notNull().default('pending'),
    r2Key: text('r2_key').unique('generated_outputs_r2_key_unique'),
    sha256: char('sha256', { length: 64 }),
    mimeType: varchar('mime_type', { length: 100 }),
    validation: jsonb('validation'),
    /** Bytes of the stored object (ADR-034); required once ready. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('generated_outputs_revision_runtime_unique').on(t.revisionId, t.runtime),
    check('generated_outputs_ready_complete', sql`${t.state} <> 'ready' OR (${t.r2Key} IS NOT NULL AND ${t.sha256} IS NOT NULL)`),
    check('generated_outputs_sha256_format', sql`${t.sha256} IS NULL OR ${SHA256(t.sha256)}`),
    check('generated_outputs_ready_sized', sql`${t.state} <> 'ready' OR ${t.sizeBytes} IS NOT NULL`),
    check('generated_outputs_size_positive', sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} > 0`),
  ],
);

// ---------- analytics (Phase 6 M19, ADR-037): anonymous daily counts per published experience
/**
 * view: the public page was opened (detail = ios | android | desktop);
 * ar_tap: a visitor tapped the AR button — an observable INTENT, not proof that AR started (detail = runtime);
 * link_tap: a visitor tapped one of the experience's links (detail = web | email | phone).
 * Only counts: no IP address, user agent, cookie or other per-visitor data is stored.
 */
export const analyticsEventEnum = pgEnum('analytics_event', ['view', 'ar_tap', 'link_tap']);
export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    experienceId: uuid('experience_id')
      .notNull()
      .references(() => experiences.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    event: analyticsEventEnum('event').notNull(),
    detail: varchar('detail', { length: 40 }).notNull().default(''),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.experienceId, t.day, t.event, t.detail] }),
    check('analytics_daily_count_nonnegative', sql`${t.count} >= 0`),
    check('analytics_daily_detail_format', sql`${t.detail} ~ '^[a-z_]{0,40}$'`),
  ],
);
