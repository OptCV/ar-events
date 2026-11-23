ALTER TYPE "public"."revision_state" ADD VALUE 'ready' BEFORE 'failed';--> statement-breakpoint
ALTER TABLE "experience_revisions" ADD COLUMN "content_hash" char(64);--> statement-breakpoint
ALTER TABLE "generated_outputs" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "experience_revisions_content_hash_idx" ON "experience_revisions" USING btree ("experience_id","content_hash") WHERE "experience_revisions"."content_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "experience_revisions" ADD CONSTRAINT "experience_revisions_content_hash_format" CHECK ("experience_revisions"."content_hash" IS NULL OR "experience_revisions"."content_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "generated_outputs" ADD CONSTRAINT "generated_outputs_ready_sized" CHECK ("generated_outputs"."state" <> 'ready' OR "generated_outputs"."size_bytes" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "generated_outputs" ADD CONSTRAINT "generated_outputs_size_positive" CHECK ("generated_outputs"."size_bytes" IS NULL OR "generated_outputs"."size_bytes" > 0);--> statement-breakpoint
-- Builds (ADR-034): a frozen revision's content hash is as immutable as its scene.
CREATE OR REPLACE FUNCTION ar_forbid_frozen_revision_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    IF NEW.state = 'draft' THEN
      RAISE EXCEPTION 'revision % is frozen and cannot return to draft', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.config IS DISTINCT FROM OLD.config
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.experience_id IS DISTINCT FROM OLD.experience_id
       OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
       OR NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
      RAISE EXCEPTION 'revision % is frozen; its content is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
