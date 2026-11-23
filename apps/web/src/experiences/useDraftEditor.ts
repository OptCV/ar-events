import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ExperienceDetail } from '@ar-creator/contracts';
import type { DraftExperienceScene } from '@ar-creator/schema';
import { ApiRequestError } from '../api/client.ts';
import { experienceKeys, experiencesApi } from './api.ts';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
/**
 * An edit: a new scene, or a function of the LATEST scene. Use the function form from anything asynchronous (an upload
 * finishing, a dialog confirming): a scene captured earlier would silently undo edits made in the meantime.
 */
export type SceneEdit = DraftExperienceScene | ((latest: DraftExperienceScene) => DraftExperienceScene);
export const AUTOSAVE_DELAY_MS = 800;

/**
 * Local draft state with debounced autosave and optimistic concurrency (ADR-021).
 * - Edits made while a save is in flight are queued and saved next with the new version (never lost).
 * - 409 stale_draft → `conflict` (another tab/device saved); the user chooses to reload.
 */
export function useDraftEditor(initial: ExperienceDetail) {
  const qc = useQueryClient();
  const [scene, setScene] = useState<DraftExperienceScene>(initial.draft.scene);
  const latest = useRef(initial.draft.scene);
  const apply = (edit: SceneEdit) => {
    const next = typeof edit === 'function' ? edit(latest.current) : edit;
    latest.current = next;
    setScene(next);
    return next;
  };
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [error, setError] = useState<string | null>(null);
  const version = useRef(initial.draftVersion);
  const inFlight = useRef(false);
  const queued = useRef<{ scene: DraftExperienceScene; confirm: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(
    async (next: DraftExperienceScene, confirmPlacementChange = false) => {
      if (inFlight.current) {
        queued.current = { scene: next, confirm: confirmPlacementChange || (queued.current?.confirm ?? false) };
        return;
      }
      inFlight.current = true;
      setStatus('saving');
      setError(null);
      try {
        const saved = await experiencesApi.saveDraft(initial.id, { scene: next, draftVersion: version.current, ...(confirmPlacementChange ? { confirmPlacementChange: true } : {}) });
        version.current = saved.draftVersion;
        qc.setQueryData(experienceKeys.detail(initial.id), saved);
        void qc.invalidateQueries({ queryKey: experienceKeys.all, exact: true });
        setStatus(queued.current ? 'dirty' : 'saved');
      } catch (e) {
        queued.current = null;
        if (e instanceof ApiRequestError && e.code === 'conflict' && e.reason === 'stale_draft') {
          setStatus('conflict');
          setError('This draft was changed in another tab or on another device.');
        } else {
          setStatus('error');
          setError(e instanceof Error ? e.message : 'Saving failed.');
        }
      } finally {
        inFlight.current = false;
      }
      const q = queued.current;
      if (q) {
        queued.current = null;
        await flush(q.scene, q.confirm);
      }
    },
    [initial.id, qc],
  );

  /** Local edit: autosaves after a short pause. */
  const update = useCallback(
    (edit: SceneEdit) => {
      const next = apply(edit);
      setStatus((s) => (s === 'conflict' ? s : 'dirty'));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(next), AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  /** Immediate save (e.g. a confirmed placement change). */
  const saveNow = useCallback(
    async (edit: SceneEdit, opts: { confirmPlacementChange?: boolean } = {}) => {
      if (timer.current) clearTimeout(timer.current);
      const next = apply(edit);
      await flush(next, opts.confirmPlacementChange ?? false);
    },
    [flush],
  );

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (status === 'dirty' || status === 'saving') e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [status]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { scene, status, error, update, saveNow, version: () => version.current };
}
