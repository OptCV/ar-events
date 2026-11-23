import { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import type { ImageObjectSummary } from '@ar-creator/contracts';
import type { DraftExperienceScene, SceneNode } from '@ar-creator/schema';
import type { SceneEdit } from '../experiences/useDraftEditor.ts';
import { cx } from '../components/cx.ts';
import formStyles from '../components/form/Form.module.css';
import { AddImageObject, Thumb, describeImageObject } from '../experiences/ImageObjectsPanel.tsx';
import { useAsset, useImageObjects } from '../imageObjects/api.ts';
import { DRAWN_KINDS, KIND_LABEL, effectivelyVisible, formatSize, nodeLabel, removeNode, setVisible, trackingImageSize, treeRows } from './sceneModel.ts';
import styles from './Editor.module.css';

/** three.js loads only with the editor viewport (keeps it out of the main bundle). */
const Viewport = lazy(() => import('./Viewport.tsx'));

/**
 * Scene editor workspace (Phase 3 M9): object tree (left), 3D viewport (centre), inspector (right); stacked on phones.
 * Every change is a new canonical scene handed to `onChange` (autosaved by the draft editor).
 */
export function SceneEditor({ scene, busy, onChange }: { scene: DraftExperienceScene; busy: boolean; onChange: (edit: SceneEdit) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [measured, setMeasured] = useState<Record<string, [number, number, number]>>({});
  const imageObjects = useImageObjects();
  const placement = scene.placement;
  const tracking = useAsset(placement.mode === 'image' ? placement.trackingTargetAssetId : null);

  const byDerivative = useMemo(() => new Map((imageObjects.data?.imageObjects ?? []).map((io) => [io.id, io])), [imageObjects.data]);
  const glbUrl = useCallback((id: string) => byDerivative.get(id)?.glb.contentUrl ?? null, [byDerivative]);
  const onMeasured = useCallback((id: string, size: [number, number, number]) => setMeasured((m) => (m[id] ? m : { ...m, [id]: size })), []);

  const size = trackingImageSize(placement, placement.mode === 'image' && placement.trackingTargetAssetId ? (tracking.data?.image ?? null) : null);
  const trackingImage = size ? { url: tracking.data?.contentUrl ?? null, ...size } : null;
  const selected = scene.nodes.find((n) => n.id === selectedId) ?? null;
  /** Node edits apply to the latest scene, never to the copy this render saw. */
  const editNodes = (fn: (nodes: SceneNode[]) => SceneNode[]) => onChange((s) => ({ ...s, nodes: fn(s.nodes) }));

  return (
    <div className={styles.workspace} data-testid="scene-editor">
      <section className={styles.tree} aria-labelledby="tree-h">
        <h3 id="tree-h" className={styles.paneTitle}>
          Objects <span className={styles.count}>({scene.nodes.length})</span>
        </h3>
        <ObjectTree nodes={scene.nodes} selectedId={selectedId} busy={busy} imageObjects={byDerivative} onSelect={setSelectedId} onToggle={(id, v) => editNodes((ns) => setVisible(ns, id, v))} />
        <AddImageObject
          nodes={scene.nodes}
          busy={busy}
          onAdd={(node) => {
            editNodes((ns) => [...ns, node]);
            setSelectedId(node.id);
          }}
        />
      </section>

      <div className={styles.stage}>
        <Suspense fallback={<p role="status" className={styles.viewportFallback}>Loading the 3D view…</p>}>
          <Viewport placement={placement} trackingImage={trackingImage} nodes={scene.nodes} glbUrl={glbUrl} selectedId={selectedId} onSelect={setSelectedId} onMeasured={onMeasured} />
        </Suspense>
        <p className={formStyles.hint}>
          {placement.mode === 'floor'
            ? 'The grid is the floor (10 cm squares); the coloured axes mark where the experience is anchored.'
            : placement.mode === 'wall'
              ? 'The grey plane is the wall (10 cm squares); content sits in front of it.'
              : trackingImage && placement.mode === 'image' && placement.trackingTargetAssetId
                ? `The tracking image is shown at its printed size (${formatSize([trackingImage.width, trackingImage.height])}), lying flat; its top edge points away from you.`
                : 'Choose a tracking image to see it here at its printed size.'}{' '}
          Drag to orbit, scroll to zoom, click an object to select it.
        </p>
      </div>

      <section className={styles.inspector} aria-labelledby="inspector-h">
        <h3 id="inspector-h" className={styles.paneTitle}>
          Inspector
        </h3>
        {selected ? (
          <Inspector
            key={selected.id}
            node={selected}
            nodes={scene.nodes}
            busy={busy}
            imageObject={selected.kind === 'image-object' ? byDerivative.get(selected.derivativeId) : undefined}
            imageObjectsLoading={imageObjects.isPending}
            measured={selected.kind === 'image-object' ? measured[selected.derivativeId] : undefined}
            onRename={(name) => editNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, name } : n)))}
            onToggle={(v) => editNodes((ns) => setVisible(ns, selected.id, v))}
            onRemove={() => {
              editNodes((ns) => removeNode(ns, selected.id));
              setSelectedId(null);
            }}
          />
        ) : (
          <p className={formStyles.hint}>{scene.nodes.length ? 'Select an object in the list or in the 3D view.' : 'Add an object to start building the scene.'}</p>
        )}
      </section>
    </div>
  );
}

function ObjectTree(props: {
  nodes: SceneNode[];
  selectedId: string | null;
  busy: boolean;
  imageObjects: Map<string, ImageObjectSummary>;
  onSelect: (id: string) => void;
  onToggle: (id: string, visible: boolean) => void;
}) {
  const { nodes, selectedId, busy, imageObjects, onSelect, onToggle } = props;
  if (!nodes.length) return <p className={formStyles.hint}>No objects yet.</p>;
  return (
    <ul className={styles.treeList} aria-label="Scene objects">
      {treeRows(nodes).map(({ node, depth }) => {
        const label = nodeLabel(node);
        const shown = effectivelyVisible(nodes, node.id);
        return (
          <li key={node.id} className={cx(styles.treeRow, node.id === selectedId && styles.treeRowSelected, !shown && styles.treeRowHidden)} style={{ paddingInlineStart: `${depth * 16}px` }} data-testid="tree-row">
            <button type="button" className={styles.treeSelect} aria-pressed={node.id === selectedId} onClick={() => onSelect(node.id)}>
              {node.kind === 'image-object' && <Thumb io={imageObjects.get(node.derivativeId)} />}
              <span className={styles.treeText}>
                <span className={styles.treeName}>{label}</span>
                <span className={styles.treeKind}>
                  {KIND_LABEL[node.kind]}
                  {!DRAWN_KINDS.has(node.kind) && ' · not shown in the 3D view yet'}
                </span>
              </span>
            </button>
            <button type="button" className={styles.iconButton} disabled={busy} onClick={() => onToggle(node.id, node.visible === false)} aria-label={`${node.visible === false ? 'Show' : 'Hide'} ${label}`} title={node.visible === false ? 'Show' : 'Hide'}>
              {node.visible === false ? 'Show' : 'Hide'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Inspector(props: {
  node: SceneNode;
  nodes: SceneNode[];
  busy: boolean;
  imageObject: ImageObjectSummary | undefined;
  imageObjectsLoading: boolean;
  measured: [number, number, number] | undefined;
  onRename: (name: string) => void;
  onToggle: (visible: boolean) => void;
  onRemove: () => void;
}) {
  const { node, imageObject: io, measured } = props;
  const [name, setName] = useState(node.name ?? '');
  const t = node.transform;
  const scaled = measured?.map((v, i) => v * t.scale[i]!) as [number, number, number] | undefined;
  return (
    <div className={styles.inspectorBody} data-testid="inspector">
      <label className={formStyles.label} htmlFor="node-name">
        Name
      </label>
      <input
        id="node-name"
        className={styles.input}
        value={name}
        maxLength={120}
        disabled={props.busy}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name !== (node.name ?? '') && props.onRename(name.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <dl className={styles.facts}>
        <dt>Type</dt>
        <dd>{KIND_LABEL[node.kind]}</dd>
        {node.kind === 'image-object' && (
          <>
            <dt>Made from</dt>
            <dd>{io ? `${io.sourceFilename ?? 'image'} (${describeImageObject(io)})` : props.imageObjectsLoading ? 'Loading…' : 'No longer available — remove it from the scene.'}</dd>
            <dt>Size in the scene</dt>
            <dd data-testid="inspector-size">{scaled ? formatSize(scaled) : effectivelyVisible(props.nodes, node.id) ? 'Measuring…' : 'Shown when visible'}</dd>
          </>
        )}
        <dt>Position</dt>
        <dd data-testid="inspector-position">{t.position.map((v) => Number((v * 100).toFixed(1))).join(', ')} cm</dd>
        <dt>Visible</dt>
        <dd>{node.visible === false ? 'No' : effectivelyVisible(props.nodes, node.id) ? 'Yes' : 'Hidden by its parent'}</dd>
      </dl>
      <p className={formStyles.hint}>Moving, rotating and scaling arrive in the next milestone.</p>
      <div className={styles.inspectorActions}>
        <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={props.busy} onClick={() => props.onToggle(node.visible === false)}>
          {node.visible === false ? 'Show' : 'Hide'}
        </button>
        <button type="button" className={styles.dangerButton} disabled={props.busy} onClick={props.onRemove} aria-label={`Remove ${nodeLabel(node)}`}>
          Remove
        </button>
      </div>
    </div>
  );
}
