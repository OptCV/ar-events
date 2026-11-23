import { useState } from 'react';
import { Link } from 'react-router';
import type { ImageObjectSummary } from '@ar-creator/contracts';
import { IDENTITY_TRANSFORM, type SceneNode } from '@ar-creator/schema';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { useImageObjects } from '../imageObjects/api.ts';
import { ALPHA_LABEL } from '../imageObjects/labels.ts';
import styles from './Experiences.module.css';

export type ImageObjectNode = Extract<SceneNode, { kind: 'image-object' }>;

const cm = (m: number) => `${Number((m * 100).toFixed(1))} cm`;
const sizeOf = (io: ImageObjectSummary) => (io.widthMeters !== null && io.heightMeters !== null ? `${cm(io.widthMeters)} × ${cm(io.heightMeters)}` : '');
export const describeImageObject = (io: ImageObjectSummary) =>
  [sizeOf(io), io.resolvedAlphaMode ? ALPHA_LABEL[io.resolvedAlphaMode] : null, io.settings.doubleSided ? 'both sides' : 'front only'].filter(Boolean).join(' · ');

/** Short url-safe id, unique among the scene's nodes (schema: 1–64 of [A-Za-z0-9_-]). */
export function newNodeId(nodes: SceneNode[], prefix = 'io'): string {
  for (;;) {
    const id = `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    if (!nodes.some((n) => n.id === id)) return id;
  }
}

/**
 * "Add image object" (Phase 2 M7, editor since Phase 3 M9). A node references the GLB of a finished GLB + USDZ pair by
 * `derivativeId` and starts at the anchor origin. The same image object may be added more than once.
 */
export function AddImageObject({ nodes, busy, onAdd }: { nodes: SceneNode[]; busy: boolean; onAdd: (node: ImageObjectNode) => void }) {
  const q = useImageObjects();
  const [picking, setPicking] = useState(false);
  const available = q.data?.imageObjects ?? [];

  const add = (io: ImageObjectSummary) => {
    onAdd({
      id: newNodeId(nodes),
      kind: 'image-object',
      derivativeId: io.id,
      name: (io.sourceFilename ?? 'Image object').slice(0, 120),
      transform: IDENTITY_TRANSFORM,
      visible: true,
      locked: false,
    });
    setPicking(false);
  };

  return (
    <div className={styles.imageObjects} data-testid="image-objects">
      {q.isError && <Alert tone="error">{q.error.message}</Alert>}
      {!picking ? (
        <button type="button" className={`${formStyles.button} ${formStyles.secondary}`} disabled={busy || q.isPending} onClick={() => setPicking(true)}>
          Add image object
        </button>
      ) : (
        <fieldset className={styles.ioPicker}>
          <legend className={formStyles.label}>Choose an image object</legend>
          {available.length === 0 ? (
            <p className={formStyles.hint}>
              You have no image objects yet. <Link to="/library">Make one from a display image in the Library.</Link>
            </p>
          ) : (
            <ul className={styles.ioList}>
              {available.map((io) => (
                <li key={io.id}>
                  <button type="button" className={styles.ioChoice} disabled={busy} onClick={() => add(io)} aria-label={`Add ${io.sourceFilename ?? 'image object'} (${describeImageObject(io)})`}>
                    <Thumb io={io} />
                    <span className={styles.ioText}>
                      <span className={styles.ioName}>{io.sourceFilename ?? 'Image object'}</span>
                      <span className={formStyles.hint}>{describeImageObject(io)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className={styles.textButton} onClick={() => setPicking(false)}>
            Cancel
          </button>
        </fieldset>
      )}
    </div>
  );
}

export function Thumb({ io }: { io: ImageObjectSummary | undefined }) {
  return <span className={styles.ioThumb}>{io?.previewUrl && <img src={io.previewUrl} alt="" />}</span>;
}
