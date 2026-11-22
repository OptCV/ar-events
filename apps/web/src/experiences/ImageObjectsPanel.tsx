import { useState } from 'react';
import { Link } from 'react-router';
import type { ImageObjectSummary } from '@ar-creator/contracts';
import { IDENTITY_TRANSFORM, type SceneNode } from '@ar-creator/schema';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { useImageObjects } from '../imageObjects/api.ts';
import { ALPHA_LABEL } from '../imageObjects/labels.ts';
import styles from './Experiences.module.css';

type ImageObjectNode = Extract<SceneNode, { kind: 'image-object' }>;

const cm = (m: number) => `${Number((m * 100).toFixed(1))} cm`;
const sizeOf = (io: ImageObjectSummary) => (io.widthMeters !== null && io.heightMeters !== null ? `${cm(io.widthMeters)} × ${cm(io.heightMeters)}` : '');
const describe = (io: ImageObjectSummary) =>
  [sizeOf(io), io.resolvedAlphaMode ? ALPHA_LABEL[io.resolvedAlphaMode] : null, io.settings.doubleSided ? 'both sides' : 'front only'].filter(Boolean).join(' · ');

/** Short url-safe id, unique among the scene's nodes (schema: 1–64 of [A-Za-z0-9_-]). */
function newNodeId(nodes: SceneNode[]): string {
  for (;;) {
    const id = `io-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    if (!nodes.some((n) => n.id === id)) return id;
  }
}

/**
 * Image objects placed in this experience (Phase 2 Milestone 7). A node references the GLB of a finished GLB + USDZ
 * pair by `derivativeId`; position, rotation and scale editing arrive with the visual editor (Phase 3), so nodes are
 * placed at the anchor origin for now.
 */
export function ImageObjectsPanel({ nodes, busy, onChange }: { nodes: SceneNode[]; busy: boolean; onChange: (nodes: SceneNode[]) => void }) {
  const q = useImageObjects();
  const [picking, setPicking] = useState(false);
  const placed = nodes.filter((n): n is ImageObjectNode => n.kind === 'image-object');
  const byId = new Map((q.data?.imageObjects ?? []).map((io) => [io.id, io]));
  const available = (q.data?.imageObjects ?? []).filter((io) => !placed.some((n) => n.derivativeId === io.id));

  const add = (io: ImageObjectSummary) => {
    const node: ImageObjectNode = {
      id: newNodeId(nodes),
      kind: 'image-object',
      derivativeId: io.id,
      name: (io.sourceFilename ?? 'Image object').slice(0, 120),
      transform: IDENTITY_TRANSFORM,
      visible: true,
      locked: false,
    };
    onChange([...nodes, node]);
    setPicking(false);
  };
  const remove = (id: string) => onChange(nodes.filter((n) => n.id !== id));

  return (
    <div className={styles.imageObjects} data-testid="image-objects">
      <h3 className={styles.subheading}>Image objects</h3>
      {placed.length === 0 ? (
        <p className={formStyles.hint}>No image objects yet. Image objects are flat pictures made from your display images.</p>
      ) : (
        <ul className={styles.ioList}>
          {placed.map((n) => {
            const io = byId.get(n.derivativeId);
            return (
              <li key={n.id} className={styles.ioItem} data-testid="placed-image-object">
                <Thumb io={io} />
                <span className={styles.ioText}>
                  <span className={styles.ioName}>{n.name ?? io?.sourceFilename ?? 'Image object'}</span>
                  <span className={formStyles.hint}>{io ? describe(io) : q.isPending ? 'Loading…' : 'This image object is no longer available. Remove it.'}</span>
                </span>
                <button type="button" className={`${styles.textButton} ${styles.dangerText}`} disabled={busy} onClick={() => remove(n.id)} aria-label={`Remove ${n.name ?? 'image object'}`}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

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
              {q.data?.imageObjects.length ? 'All your image objects are already in this experience.' : 'You have no image objects yet.'}{' '}
              <Link to="/library">Make one from a display image in the Library.</Link>
            </p>
          ) : (
            <ul className={styles.ioList}>
              {available.map((io) => (
                <li key={io.id}>
                  <button type="button" className={styles.ioChoice} disabled={busy} onClick={() => add(io)} aria-label={`Add ${io.sourceFilename ?? 'image object'} (${describe(io)})`}>
                    <Thumb io={io} />
                    <span className={styles.ioText}>
                      <span className={styles.ioName}>{io.sourceFilename ?? 'Image object'}</span>
                      <span className={formStyles.hint}>{describe(io)}</span>
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

function Thumb({ io }: { io: ImageObjectSummary | undefined }) {
  return <span className={styles.ioThumb}>{io?.previewUrl && <img src={io.previewUrl} alt="" />}</span>;
}
