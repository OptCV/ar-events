import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { CreateExperienceInput, type ExperienceDetail } from '@ar-creator/contracts';
import { TRACKING_WIDTH_METERS, planPlacementChange, type PlacementChangePlan, type PlacementMode } from '@ar-creator/schema';
import { ApiRequestError, fieldErrors } from '../api/client.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import { Field } from '../components/form/Field.tsx';
import formStyles from '../components/form/Form.module.css';
import { SubmitButton } from '../components/form/SubmitButton.tsx';
import { experienceKeys, useDeleteExperience, useExperience, useReadiness, useUpdateExperience } from './api.ts';
import { PlacementSelector } from './PlacementSelector.tsx';
import { TrackingImagePicker } from './TrackingImagePicker.tsx';
import { SceneEditor } from '../editor/SceneEditor.tsx';
import { TestOnDevice } from '../builds/TestOnDevice.tsx';
import { useDraftEditor, type SaveStatus } from './useDraftEditor.ts';
import styles from './Experiences.module.css';

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: 'All changes saved',
  dirty: 'Unsaved changes…',
  saving: 'Saving…',
  conflict: 'Not saved',
  error: 'Not saved',
};

export function ExperiencePage() {
  const { id = '' } = useParams();
  const q = useExperience(id);
  const [reloadKey, setReloadKey] = useState(0);
  const qc = useQueryClient();

  if (q.isPending) {
    return (
      <p role="status" aria-live="polite">
        Loading experience…
      </p>
    );
  }
  if (q.isError) {
    const missing = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <section className={styles.section} aria-labelledby="exp-error">
        <h1 id="exp-error">{missing ? 'Experience not found' : 'Could not load this experience'}</h1>
        <p>{missing ? 'It may have been deleted, or the link is wrong.' : q.error.message}</p>
        <p>
          <Link to="/dashboard">Back to your experiences</Link>
        </p>
      </section>
    );
  }
  // Remount the editor after "load latest" so local state starts from the server copy.
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: experienceKeys.detail(id) });
    setReloadKey((k) => k + 1);
  };
  return <Editor key={`${q.data.id}-${reloadKey}`} experience={q.data} onReload={reload} />;
}

function Editor({ experience, onReload }: { experience: ExperienceDetail; onReload: () => Promise<void> }) {
  const editor = useDraftEditor(experience);
  const [plan, setPlan] = useState<PlacementChangePlan | null>(null);
  const placement = editor.scene.placement;
  const [widthCm, setWidthCm] = useState(placement.mode === 'image' ? String(Math.round(placement.physicalWidthMeters * 1000) / 10) : '20');
  const [widthError, setWidthError] = useState<string | undefined>();
  const readiness = useReadiness(experience.id, editor.status === 'saved' ? experience.draftVersion : undefined);

  const requestMode = (mode: PlacementMode) => {
    const p = planPlacementChange(editor.scene, mode);
    if (p.changed) setPlan(p);
  };
  const confirmMode = async () => {
    if (!plan) return;
    await editor.saveNow((s) => ({ ...s, placement: plan.placement }), { confirmPlacementChange: true });
    if (plan.placement.mode === 'image') setWidthCm(String(Math.round(plan.placement.physicalWidthMeters * 1000) / 10));
    setPlan(null);
  };

  const onWidth = (value: string) => {
    setWidthCm(value);
    const cm = Number(value);
    const min = TRACKING_WIDTH_METERS.min * 100;
    const max = TRACKING_WIDTH_METERS.max * 100;
    if (!value || !Number.isFinite(cm) || cm < min || cm > max) {
      setWidthError(`Enter a width between ${min} and ${max} cm.`);
      return;
    }
    setWidthError(undefined);
    editor.update((s) => (s.placement.mode === 'image' ? { ...s, placement: { ...s.placement, physicalWidthMeters: Math.round(cm * 10) / 1000 } } : s));
  };

  return (
    <>
      <p className={styles.breadcrumb}>
        <Link to="/dashboard">← Your experiences</Link>
      </p>
      <div className={styles.pageHeader}>
        <h1>{experience.name}</h1>
        <span
          className={cx(styles.status, (editor.status === 'conflict' || editor.status === 'error') && styles.statusError)}
          role="status"
          aria-live="polite"
          data-testid="save-status"
        >
          {STATUS_TEXT[editor.status]}
        </span>
      </div>
      {editor.error && (
        <div className={styles.section} role="group" aria-label="Save problem">
          <Alert tone="error">{editor.error}</Alert>
          {editor.status === 'conflict' && (
            <button type="button" className={cx(formStyles.button, formStyles.secondary)} onClick={() => void onReload()}>
              Load the latest version
            </button>
          )}
        </div>
      )}

      <div className={styles.layout}>
        <div className={formStyles.form}>
          <section className={styles.section} aria-labelledby="placement-h">
            <h2 id="placement-h">Placement</h2>
            <PlacementSelector value={placement.mode} onChange={requestMode} disabled={editor.status === 'saving'} legend="Placement mode" />
            {placement.mode === 'image' && (
              <>
                <Field
                  label="Printed width of the tracking image (cm)"
                  name="trackingWidth"
                  type="number"
                  inputMode="decimal"
                  min={TRACKING_WIDTH_METERS.min * 100}
                  max={TRACKING_WIDTH_METERS.max * 100}
                  step={0.1}
                  value={widthCm}
                  onChange={(e) => onWidth(e.target.value)}
                  error={widthError}
                  hint="Measure the printed image edge to edge. AR content is scaled from this value."
                />
                <TrackingImagePicker
                  selectedId={placement.trackingTargetAssetId}
                  widthMeters={placement.physicalWidthMeters}
                  busy={editor.status === 'saving'}
                  onSelect={(assetId) => void editor.saveNow((s) => (s.placement.mode === 'image' ? { ...s, placement: { ...s.placement, trackingTargetAssetId: assetId } } : s))}
                />
              </>
            )}
          </section>

        </div>

        <aside className={styles.section} aria-labelledby="ready-h">
          <h2 id="ready-h">Ready to publish?</h2>
          {editor.status !== 'saved' && <p className={styles.status}>Checks run after your changes are saved.</p>}
          {readiness.isPending && editor.status === 'saved' && <p role="status">Checking…</p>}
          {readiness.data && (
            <>
              <p data-testid="readiness">{readiness.data.ready ? 'Ready to publish (publishing arrives in a later milestone).' : 'Not ready yet.'}</p>
              <ul className={styles.issues}>
                {readiness.data.issues.map((i) => (
                  <li key={`${i.code}-${i.path.join('.')}`} className={i.severity === 'error' ? styles.issueError : styles.issueWarning}>
                    {i.message}
                  </li>
                ))}
                {readiness.data.issues.length === 0 && <li className={styles.issueOk}>No issues found.</li>}
              </ul>
            </>
          )}
        </aside>
      </div>

      <div className={cx(styles.section, styles.sceneSection)}>
        <TestOnDevice experienceId={experience.id} saved={editor.status === 'saved'} />
      </div>

      <section className={cx(styles.section, styles.sceneSection)} aria-labelledby="scene-h">
        <h2 id="scene-h">Scene</h2>
        {/* Edits autosave (queued while a save is in flight); only a conflict blocks further edits. */}
        <SceneEditor scene={editor.scene} busy={editor.status === 'conflict'} onChange={editor.update} />
      </section>

      <div className={styles.layout}>
        <div className={formStyles.form}>
          <SettingsForm experience={experience} />
          <DangerZone experience={experience} />
        </div>
      </div>

      <ConfirmDialog
        open={plan !== null}
        title={plan ? `Switch to ${plan.to} placement?` : ''}
        confirmLabel="Switch placement"
        busyLabel="Switching…"
        busy={editor.status === 'saving'}
        onCancel={() => setPlan(null)}
        onConfirm={() => void confirmMode()}
      >
        {plan && (
          <>
            {plan.removed.length > 0 && <p>Removed from this experience: {plan.removed.join(', ')}.</p>}
            <ul data-testid="placement-warnings">
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

const SettingsInput = CreateExperienceInput.pick({ name: true, description: true });

function SettingsForm({ experience }: { experience: ExperienceDetail }) {
  const update = useUpdateExperience(experience.id);
  const [name, setName] = useState(experience.name);
  const [description, setDescription] = useState(experience.description ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const parsed = SettingsInput.safeParse({ name, description });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      await update.mutateAsync({ name: parsed.data.name, description: parsed.data.description ? parsed.data.description : null });
      setSaved(true);
    } catch (err) {
      setErrors(fieldErrors(err));
    }
  };
  return (
    <section className={styles.section} aria-labelledby="settings-h">
      <h2 id="settings-h">Details</h2>
      <form className={formStyles.form} onSubmit={onSubmit} noValidate>
        {saved && <Alert tone="success">Details saved.</Alert>}
        {update.isError && Object.keys(errors).length === 0 && <Alert tone="error">{update.error.message}</Alert>}
        <Field label="Name" name="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={120} />
        <div className={formStyles.field}>
          <label className={formStyles.label} htmlFor="settings-description">
            Description
          </label>
          <textarea id="settings-description" className={styles.textarea} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <SubmitButton busy={update.isPending} busyLabel="Saving…" secondary>
            Save details
          </SubmitButton>
        </div>
      </form>
    </section>
  );
}

function DangerZone({ experience }: { experience: ExperienceDetail }) {
  const navigate = useNavigate();
  const del = useDeleteExperience();
  const [open, setOpen] = useState(false);
  return (
    <section className={cx(styles.section, styles.danger)} aria-labelledby="danger-h">
      <h2 id="danger-h">Delete experience</h2>
      <p>This permanently deletes the experience and its draft.</p>
      {del.isError && <Alert tone="error">{del.error.message}</Alert>}
      <button type="button" className={styles.dangerButton} onClick={() => setOpen(true)}>
        Delete experience
      </button>
      <ConfirmDialog
        open={open}
        danger
        title={`Delete “${experience.name}”?`}
        confirmLabel="Delete permanently"
        busyLabel="Deleting…"
        busy={del.isPending}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          try {
            await del.mutateAsync(experience.id);
            navigate('/dashboard', { replace: true });
          } catch {
            setOpen(false);
          }
        }}
      >
        <p>This cannot be undone.</p>
      </ConfirmDialog>
    </section>
  );
}
