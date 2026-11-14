-- Custom migration (ADR-004, ADR-017): immutability that the application must not be able to bypass.

-- 1. Experience revisions: only `draft` revisions are mutable. Once frozen (any other state), the scene config,
--    schema version, owner experience and revision number can never change, and a revision can never return
--    to `draft`. Lifecycle columns (state, validation_report, frozen_at) remain updatable for publishing.
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
       OR NEW.revision_number IS DISTINCT FROM OLD.revision_number THEN
      RAISE EXCEPTION 'revision % is frozen; its content is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER experience_revisions_immutable
  BEFORE UPDATE ON experience_revisions
  FOR EACH ROW EXECUTE FUNCTION ar_forbid_frozen_revision_changes();
--> statement-breakpoint

-- 2. Generated outputs and asset derivatives: once ready, the stored object identity (R2 key, checksum)
--    is immutable, so published URLs never change content underneath a live experience.
--    One function per table: PL/pgSQL resolves OLD.<column> against each table's row type.
CREATE OR REPLACE FUNCTION ar_forbid_ready_output_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'ready' AND (NEW.r2_key IS DISTINCT FROM OLD.r2_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256) THEN
    RAISE EXCEPTION 'generated output % is ready; its stored object is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER generated_outputs_immutable
  BEFORE UPDATE ON generated_outputs
  FOR EACH ROW EXECUTE FUNCTION ar_forbid_ready_output_changes();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ar_forbid_ready_derivative_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ready' AND (NEW.r2_key IS DISTINCT FROM OLD.r2_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256) THEN
    RAISE EXCEPTION 'asset derivative % is ready; its stored object is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER asset_derivatives_immutable
  BEFORE UPDATE ON asset_derivatives
  FOR EACH ROW EXECUTE FUNCTION ar_forbid_ready_derivative_changes();
