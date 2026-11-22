ALTER TABLE "asset_derivatives" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "error_code" varchar(40);--> statement-breakpoint
CREATE INDEX "processing_jobs_owner_asset_idx" ON "processing_jobs" USING btree ("owner_id","asset_id","created_at");--> statement-breakpoint
ALTER TABLE "asset_derivatives" ADD CONSTRAINT "asset_derivatives_ready_has_size" CHECK ("asset_derivatives"."status" <> 'ready' OR "asset_derivatives"."size_bytes" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "asset_derivatives" ADD CONSTRAINT "asset_derivatives_sha256_format" CHECK ("asset_derivatives"."sha256" IS NULL OR "asset_derivatives"."sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "asset_derivatives" ADD CONSTRAINT "asset_derivatives_r2_key_owned_prefix" CHECK ("asset_derivatives"."r2_key" IS NULL OR "asset_derivatives"."r2_key" LIKE 'users/%');--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_failed_has_code" CHECK ("processing_jobs"."state" <> 'failed' OR "processing_jobs"."error_code" IS NOT NULL);