ALTER TABLE "assets" ADD COLUMN "upload_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "upload_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "rejection_code" varchar(40);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_pending_has_expiry" CHECK ("assets"."state" <> 'pending_upload' OR "assets"."upload_expires_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_rejected_has_code" CHECK ("assets"."state" <> 'rejected' OR "assets"."rejection_code" IS NOT NULL);