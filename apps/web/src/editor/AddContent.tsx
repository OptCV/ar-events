import { useState } from 'react';
import { Link } from 'react-router';
import { formatBytes, type AssetSummary, type ImageObjectSummary } from '@ar-creator/contracts';
import { IDENTITY_TRANSFORM, PANEL_DEFAULTS, PRIMITIVE_START_SCALE, TEXT_DEFAULTS, type Action, type PlacementMode, type SceneNode, type Transform } from '@ar-creator/schema';
import { AssetUploader } from '../assets/AssetUploader.tsx';
import { useAssets } from '../assets/api.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { Thumb, describeImageObject, newNodeId } from '../experiences/ImageObjectsPanel.tsx';
import { useImageObjects } from '../imageObjects/api.ts';
import exp from '../experiences/Experiences.module.css';
import styles from './Editor.module.css';

type Picker = 'image' | 'model' | null;

/**
 * Starting transform for built-in content (centred on its origin, ADR-029): resting on the floor or image, or just in
 * front of the wall, so nothing starts half-buried.
 */
function startTransform(mode: PlacementMode, halfHeight: number, halfDepth: number, scale = 1): Transform {
  if (mode === 'wall') return { ...IDENTITY_TRANSFORM, position: [0, 0, halfDepth], scale: [scale, scale, scale] };
  return { ...IDENTITY_TRANSFORM, position: [0, halfHeight, 0], scale: [scale, scale, scale] };
}

const base = { visible: true, locked: false } as const;

/** "Add" in the editor (Phase 3 M11): image objects, uploaded 3D models, text, panels and shapes. */
export function AddContent({ nodes, actions, mode, busy, onAdd }: { nodes: SceneNode[]; actions: Action[]; mode: PlacementMode; busy: boolean; onAdd: (node: SceneNode) => void }) {
  const [picker, setPicker] = useState<Picker>(null);
  const add = (node: SceneNode) => {
    onAdd(node);
    setPicker(null);
  };
  const addText = () =>
    add({ ...base, id: newNodeId(nodes, 'txt'), kind: 'text', name: 'Text', text: TEXT_DEFAULTS.text, style: { color: TEXT_DEFAULTS.color, sizeMeters: TEXT_DEFAULTS.sizeMeters }, transform: startTransform(mode, TEXT_DEFAULTS.sizeMeters / 2, 0.002) });
  // A panel's height follows its text; 10 cm is a typical half height for the defaults.
  const addPanel = () => add({ ...base, id: newNodeId(nodes, 'pnl'), kind: 'panel', name: 'Panel', title: PANEL_DEFAULTS.title, body: PANEL_DEFAULTS.body, transform: startTransform(mode, 0.06, 0.002) });
  const addShape = () =>
    add({ ...base, id: newNodeId(nodes, 'shp'), kind: 'primitive', name: 'Box', shape: 'box', transform: startTransform(mode, PRIMITIVE_START_SCALE / 2, PRIMITIVE_START_SCALE / 2, PRIMITIVE_START_SCALE) });

  return (
    <div className={styles.add} data-testid="add-content">
      <h4 className={styles.addTitle}>Add</h4>
      <div className={styles.addButtons}>
        <button type="button" className={styles.addButton} disabled={busy} aria-label="Add image object" aria-expanded={picker === 'image'} onClick={() => setPicker(picker === 'image' ? null : 'image')}>
          Image object
        </button>
        <button type="button" className={styles.addButton} disabled={busy} aria-label="Add 3D model" aria-expanded={picker === 'model'} onClick={() => setPicker(picker === 'model' ? null : 'model')}>
          3D model
        </button>
        <button type="button" className={styles.addButton} disabled={busy} aria-label="Add text" onClick={addText}>
          Text
        </button>
        <button type="button" className={styles.addButton} disabled={busy} aria-label="Add panel" onClick={addPanel}>
          Panel
        </button>
        <button type="button" className={styles.addButton} disabled={busy} aria-label="Add shape" onClick={addShape}>
          Shape
        </button>
        <button
          type="button"
          className={styles.addButton}
          disabled={busy || actions.length === 0}
          aria-label="Add hotspot"
          title={actions.length ? undefined : 'Create an action first (Actions, below the 3D view)'}
          onClick={() => add({ ...base, id: newNodeId(nodes, 'hs'), kind: 'hotspot', name: 'Hotspot', actionId: actions[0]!.id, transform: startTransform(mode, 0.02, 0.02) })}
        >
          Hotspot
        </button>
      </div>
      {picker === 'image' && <ImageObjectPicker busy={busy} onPick={(io) => add({ ...base, id: newNodeId(nodes, 'io'), kind: 'image-object', derivativeId: io.id, name: (io.sourceFilename ?? 'Image object').slice(0, 120), transform: IDENTITY_TRANSFORM })} onCancel={() => setPicker(null)} />}
      {picker === 'model' && <ModelPicker busy={busy} onPick={(a) => add({ ...base, id: newNodeId(nodes, 'mdl'), kind: 'model', assetId: a.id, name: (a.filename ?? '3D model').slice(0, 120), transform: IDENTITY_TRANSFORM })} onCancel={() => setPicker(null)} />}
    </div>
  );
}

function ImageObjectPicker({ busy, onPick, onCancel }: { busy: boolean; onPick: (io: ImageObjectSummary) => void; onCancel: () => void }) {
  const q = useImageObjects();
  const available = q.data?.imageObjects ?? [];
  return (
    <fieldset className={exp.ioPicker} data-testid="image-objects">
      <legend className={formStyles.label}>Choose an image object</legend>
      {q.isError && <Alert tone="error">{q.error.message}</Alert>}
      {q.isPending ? (
        <p role="status">Loading…</p>
      ) : available.length === 0 ? (
        <p className={formStyles.hint}>
          You have no image objects yet. <Link to="/library">Make one from a display image in the Library.</Link>
        </p>
      ) : (
        <ul className={exp.ioList}>
          {available.map((io) => (
            <li key={io.id}>
              <button type="button" className={exp.ioChoice} disabled={busy} onClick={() => onPick(io)} aria-label={`Add ${io.sourceFilename ?? 'image object'} (${describeImageObject(io)})`}>
                <Thumb io={io} />
                <span className={exp.ioText}>
                  <span className={exp.ioName}>{io.sourceFilename ?? 'Image object'}</span>
                  <span className={formStyles.hint}>{describeImageObject(io)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className={exp.textButton} onClick={onCancel}>
        Cancel
      </button>
    </fieldset>
  );
}

const describeModel = (a: AssetSummary) =>
  [a.sizeBytes !== null ? formatBytes(a.sizeBytes) : null, a.model ? `${a.model.meshes} mesh${a.model.meshes === 1 ? '' : 'es'}` : null, a.model?.animations ? `${a.model.animations} animation${a.model.animations === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');

function ModelPicker({ busy, onPick, onCancel }: { busy: boolean; onPick: (a: AssetSummary) => void; onCancel: () => void }) {
  const q = useAssets('model');
  const models = (q.data?.assets ?? []).filter((a) => a.state === 'validated');
  return (
    <fieldset className={exp.ioPicker} data-testid="model-picker">
      <legend className={formStyles.label}>Choose a 3D model</legend>
      {q.isError && <Alert tone="error">{q.error.message}</Alert>}
      {q.isPending ? (
        <p role="status">Loading…</p>
      ) : models.length === 0 ? (
        <p className={formStyles.hint}>No 3D models in your library yet. Upload a self-contained GLB file:</p>
      ) : (
        <ul className={exp.ioList}>
          {models.map((a) => (
            <li key={a.id}>
              <button type="button" className={exp.ioChoice} disabled={busy} onClick={() => onPick(a)} aria-label={`Add ${a.filename ?? '3D model'}`}>
                <span className={exp.ioThumb} aria-hidden="true">
                  GLB
                </span>
                <span className={exp.ioText}>
                  <span className={exp.ioName}>{a.filename ?? '3D model'}</span>
                  <span className={formStyles.hint}>{describeModel(a)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <AssetUploader role="model" compact onUploaded={(a) => onPick(a)} />
      <button type="button" className={exp.textButton} onClick={onCancel}>
        Cancel
      </button>
    </fieldset>
  );
}
