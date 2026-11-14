CREATE TYPE "public"."asset_role" AS ENUM('tracking-image', 'display-image', 'model', 'usdz-override', 'audio');--> statement-breakpoint
CREATE TYPE "public"."asset_state" AS ENUM('pending_upload', 'uploaded', 'validated', 'rejected', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."derivative_type" AS ENUM('image_object_glb', 'image_object_usdz', 'thumbnail');--> statement-breakpoint
CREATE TYPE "public"."experience_visibility" AS ENUM('draft', 'private_test', 'public');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('validate_asset', 'convert_image_to_ar', 'compile_revision', 'publish_revision');--> statement-breakpoint
CREATE TYPE "public"."output_state" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."placement_mode" AS ENUM('image', 'floor', 'wall');--> statement-breakpoint
CREATE TYPE "public"."revision_state" AS ENUM('draft', 'snapshot', 'compiling', 'partially_ready', 'published', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."runtime" AS ENUM('ios_quicklook_image', 'ios_quicklook_floor', 'ios_quicklook_wall', 'android_webxr_image', 'android_scene_viewer_floor', 'android_scene_viewer_wall');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_derivatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"output_type" "derivative_type" NOT NULL,
	"status" "output_state" DEFAULT 'pending' NOT NULL,
	"settings" jsonb NOT NULL,
	"settings_hash" char(64) NOT NULL,
	"converter_version" varchar(64) NOT NULL,
	"r2_key" text,
	"sha256" char(64),
	"diagnostics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_derivatives_r2_key_unique" UNIQUE("r2_key"),
	CONSTRAINT "asset_derivatives_provenance_unique" UNIQUE("source_asset_id","output_type","settings_hash","converter_version"),
	CONSTRAINT "asset_derivatives_settings_hash_format" CHECK ("asset_derivatives"."settings_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_derivatives_ready_complete" CHECK ("asset_derivatives"."status" <> 'ready' OR ("asset_derivatives"."r2_key" IS NOT NULL AND "asset_derivatives"."sha256" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"role" "asset_role" NOT NULL,
	"state" "asset_state" DEFAULT 'pending_upload' NOT NULL,
	"mime_type" varchar(100),
	"size_bytes" bigint,
	"sha256" char(64),
	"r2_key" text NOT NULL,
	"original_filename" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_r2_key_unique" UNIQUE("r2_key"),
	CONSTRAINT "assets_size_nonnegative" CHECK ("assets"."size_bytes" IS NULL OR "assets"."size_bytes" >= 0),
	CONSTRAINT "assets_sha256_format" CHECK ("assets"."sha256" IS NULL OR "assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assets_r2_key_owned_prefix" CHECK ("assets"."r2_key" LIKE 'users/%'),
	CONSTRAINT "assets_validated_has_checksum" CHECK ("assets"."state" NOT IN ('uploaded', 'validated') OR ("assets"."sha256" IS NOT NULL AND "assets"."size_bytes" IS NOT NULL AND "assets"."mime_type" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "experience_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"state" "revision_state" DEFAULT 'draft' NOT NULL,
	"schema_version" smallint NOT NULL,
	"config" jsonb NOT NULL,
	"validation_report" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_at" timestamp with time zone,
	CONSTRAINT "experience_revisions_number_unique" UNIQUE("experience_id","revision_number"),
	CONSTRAINT "experience_revisions_id_experience_unique" UNIQUE("id","experience_id"),
	CONSTRAINT "experience_revisions_number_positive" CHECK ("experience_revisions"."revision_number" > 0),
	CONSTRAINT "experience_revisions_schema_version_positive" CHECK ("experience_revisions"."schema_version" > 0),
	CONSTRAINT "experience_revisions_config_object" CHECK (jsonb_typeof("experience_revisions"."config") = 'object'),
	CONSTRAINT "experience_revisions_frozen_at" CHECK (("experience_revisions"."state" = 'draft') = ("experience_revisions"."frozen_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(2000),
	"slug" varchar(64) NOT NULL,
	"placement_mode" "placement_mode" NOT NULL,
	"visibility" "experience_visibility" DEFAULT 'draft' NOT NULL,
	"draft_revision_id" uuid,
	"published_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiences_slug_unique" UNIQUE("slug"),
	CONSTRAINT "experiences_name_not_blank" CHECK (length(btrim("experiences"."name")) > 0),
	CONSTRAINT "experiences_slug_format" CHECK ("experiences"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$')
);
--> statement-breakpoint
CREATE TABLE "generated_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"runtime" "runtime" NOT NULL,
	"state" "output_state" DEFAULT 'pending' NOT NULL,
	"r2_key" text,
	"sha256" char(64),
	"mime_type" varchar(100),
	"validation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generated_outputs_r2_key_unique" UNIQUE("r2_key"),
	CONSTRAINT "generated_outputs_revision_runtime_unique" UNIQUE("revision_id","runtime"),
	CONSTRAINT "generated_outputs_ready_complete" CHECK ("generated_outputs"."state" <> 'ready' OR ("generated_outputs"."r2_key" IS NOT NULL AND "generated_outputs"."sha256" IS NOT NULL)),
	CONSTRAINT "generated_outputs_sha256_format" CHECK ("generated_outputs"."sha256" IS NULL OR "generated_outputs"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"type" "job_type" NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"revision_id" uuid,
	"asset_id" uuid,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"diagnostics" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_jobs_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "processing_jobs_has_target" CHECK (num_nonnulls("processing_jobs"."revision_id", "processing_jobs"."asset_id") >= 1),
	CONSTRAINT "processing_jobs_attempts_bounded" CHECK ("processing_jobs"."attempt" >= 0 AND "processing_jobs"."max_attempts" BETWEEN 1 AND 10 AND "processing_jobs"."attempt" <= "processing_jobs"."max_attempts")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivatives" ADD CONSTRAINT "asset_derivatives_source_asset_id_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_revisions" ADD CONSTRAINT "experience_revisions_experience_id_experiences_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_revisions" ADD CONSTRAINT "experience_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_draft_revision_fk" FOREIGN KEY ("draft_revision_id","id") REFERENCES "public"."experience_revisions"("id","experience_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_published_revision_fk" FOREIGN KEY ("published_revision_id","id") REFERENCES "public"."experience_revisions"("id","experience_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_outputs" ADD CONSTRAINT "generated_outputs_revision_id_experience_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."experience_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_revision_id_experience_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."experience_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "assets_owner_created_idx" ON "assets" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "experience_revisions_one_draft_idx" ON "experience_revisions" USING btree ("experience_id") WHERE "experience_revisions"."state" = 'draft';--> statement-breakpoint
CREATE INDEX "experiences_owner_updated_idx" ON "experiences" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "processing_jobs_state_created_idx" ON "processing_jobs" USING btree ("state","created_at");