import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { formatBytes, type AssetSummary, type ImageObjectSummary } from '@ar-creator/contracts';
import type { DraftExperienceScene, SceneNode, Transform } from '@ar-creator/schema';
import type { SceneEdit } from '../experiences/useDraftEditor.ts';
import { cx } from '../components/cx.ts';
import formStyles from '../components/form/Form.module.css';
import { SUPPORT_LABEL, capability, type Feature } from '@ar-creator/capabilities';
import { Thumb, describeImageObject, newNodeId } from '../experiences/ImageObjectsPanel.tsx';
import { useAssets } from '../assets/api.ts';
import { AddContent } from './AddContent.tsx';
import { ActionsPanel } from './ActionsPanel.tsx';
import { CompatibilityPanel } from './CompatibilityPanel.tsx';
import { actionOption, removeNodeCascade, setTapAction, type Content } from './actions.ts';
import { budgetIssues, sceneTotals } from './budgets.ts';
import { ContentFields } from './ContentFields.tsx';
import { useAsset, useImageObjects } from '../imageObjects/api.ts';
import { emptyHistory, record, redo, undo } from './history.ts';
import { DRAWN_KINDS, KIND_LABEL, effectivelyVisible, formatSize, nodeLabel, setVisible, trackingImageSize, treeRows } from './sceneModel.ts';
import { LIMITS, cleanTransform, duplicateNode, eulerDegFromQuat, isUniform, quatFromEulerDeg } from './transforms.ts';
import type { AlignKind, NodeStats, Tool, ViewportApi } from './Viewport.tsx';
import styles from './Editor.module.css';

/** three.js loads only with the editor viewport (keeps it out of the main bundle). */
const Viewport = lazy(() => import('./Viewport.tsx'));

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'Q' },
  { id: 'move', label: 'Move', key: 'W' },
  { id: 'rotate', label: 'Rotate', key: 'E' },
  { id: 'scale', label: 'Scale', key: 'R' },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

/**
 * Scene editor workspace (Phase 3 M9–M10): object tree (left), 3D viewport with tools (centre), inspector (right);
 * stacked on phones. Every change is an edit of the latest canonical scene handed to `onChange` (autosaved), and
 * node edits are undoable (placement, tracking image and details are not part of undo).
 */
export function SceneEditor({ scene, busy, onChange }: { scene: DraftExperienceScene; busy: boolean; onChange: (edit: SceneEdit) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, NodeStats>>({});
  const [tool, setTool] = useState<Tool>('select');
  const [snapOn, setSnapOn] = useState(true);
  const [notice, setNoticeState] = useState<{ text: string; tone: 'status' | 'info' | 'error' } | null>(null);
  const setNotice = (text: string | null, tone: 'status' | 'info' | 'error' = 'error') => setNoticeState(text ? { text, tone } : null);
  const viewportApi = useRef<ViewportApi | null>(null);
  const history = useRef(emptyHistory());
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const imageObjects = useImageObjects();
  const placement = scene.placement;
  const tracking = useAsset(placement.mode === 'image' ? placement.trackingTargetAssetId : null);

  const models = useAssets('model');
  const byDerivative = useMemo(() => new Map((imageObjects.data?.imageObjects ?? []).map((io) => [io.id, io])), [imageObjects.data]);
  const byModel = useMemo(() => new Map((models.data?.assets ?? []).map((a) => [a.id, a])), [models.data]);
  /** The file a node draws: the GLB of an image object, or an uploaded model. Keys are stable; signed URLs are not. */
  const fileFor = useCallback(
    (n: SceneNode) => {
      if (n.kind === 'image-object') {
        const io = byDerivative.get(n.derivativeId);
        return io?.glb.contentUrl ? { key: 'io:' + n.derivativeId, url: io.glb.contentUrl, bytes: io.glb.sizeBytes } : null;
      }
      if (n.kind === 'model') {
        const a = byModel.get(n.assetId);
        return a?.contentUrl ? { key: 'model:' + n.assetId, url: a.contentUrl, bytes: a.sizeBytes } : null;
      }
      return null;
    },
    [byDerivative, byModel],
  );
  const onStats = useCallback((id: string, st: NodeStats) => setStats((m) => (JSON.stringify(m[id]) === JSON.stringify(st) ? m : { ...m, [id]: st })), []);
  const totals = useMemo(
    () => sceneTotals(scene.nodes.filter((n) => stats[n.id] && effectivelyVisible(scene.nodes, n.id)).map((n) => ({ stats: stats[n.id]!, file: fileFor(n) }))),
    [scene.nodes, stats, fileFor],
  );

  const size = trackingImageSize(placement, placement.mode === 'image' && placement.trackingTargetAssetId ? (tracking.data?.image ?? null) : null);
  const trackingImage = size ? { url: tracking.data?.contentUrl ?? null, ...size } : null;
  const selected = scene.nodes.find((n) => n.id === selectedId) ?? null;

  /**
   * Content edits (nodes, actions, primary action) apply to the latest scene — never to the copy this render saw — as
   * one unit, so references stay valid, and are recorded for undo.
   */
  const editContent = useCallback(
    (fn: (c: Content) => Content) =>
      onChange((s) => {
        const before = contentOf(s);
        const next = fn(before);
        if (next === before) return s;
        history.current = record(history.current, before, next);
        rerender();
        return withContent(s, next);
      }),
    [onChange],
  );
  const editNodes = useCallback(
    (fn: (nodes: SceneNode[]) => SceneNode[]) =>
      editContent((c) => {
        const nodes = fn(c.nodes);
        return nodes === c.nodes ? c : { ...c, nodes };
      }),
    [editContent],
  );
  const step = useCallback(
    (dir: 'undo' | 'redo') =>
      onChange((s) => {
        const r = (dir === 'undo' ? undo : redo)(history.current, contentOf(s));
        if (!r) return s;
        history.current = r.history;
        rerender();
        setNoticeState({ text: dir === 'undo' ? 'Undone.' : 'Redone.', tone: 'status' });
        return withContent(s, r.content);
      }),
    [onChange],
  );
  // A placement change re-measures everything from a new surface: earlier steps no longer apply.
  useEffect(() => {
    history.current = emptyHistory();
    rerender();
  }, [placement.mode]);

  const setTransform = useCallback((id: string, t: Transform) => editNodes((ns) => ns.map((n) => (n.id === id && !n.locked ? { ...n, transform: cleanTransform(t) } : n))), [editNodes]);
  const duplicate = (id: string) => {
    let copyId = '';
    editNodes((ns) => {
      const i = ns.findIndex((n) => n.id === id);
      if (i < 0) return ns;
      copyId = newNodeId(ns, ns[i]!.kind === 'image-object' ? 'io' : 'n');
      return [...ns.slice(0, i + 1), duplicateNode(ns[i]!, copyId), ...ns.slice(i + 1)];
    });
    if (copyId) setSelectedId(copyId);
  };
  /** Removes an object and whatever would dangle without it (actions that target it, hotspots left without one) — and says so. */
  const remove = (id: string) => {
    let removed: string[] = [];
    editContent((c) => {
      if (c.nodes.find((n) => n.id === id)?.locked) return c;
      const r = removeNodeCascade(c, id);
      removed = r.removed;
      return r.content;
    });
    setSelectedId(null);
    setNotice(removed.length ? `Also removed ${removed.join(' and ')}.` : null, 'info');
  };
  const align = (id: string, kind: AlignKind) => {
    const t = viewportApi.current?.aligned(id, kind);
    if (!t) return setNotice('This object has to be visible and loaded in the 3D view first.');
    setTransform(id, t);
    setNotice(null);
  };

  // Keyboard shortcuts (not while typing in a field, and never with a dialog open).
  const keyState = useRef({ selected, tool });
  keyState.current = { selected, tool };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], dialog[open]') || document.querySelector('dialog[open]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const sel = keyState.current.selected;
      if (mod && key === 'z') {
        e.preventDefault();
        step(e.shiftKey ? 'redo' : 'undo');
      } else if (mod && key === 'y') {
        e.preventDefault();
        step('redo');
      } else if (mod && key === 'd' && sel) {
        e.preventDefault();
        duplicate(sel.id);
      } else if ((key === 'delete' || key === 'backspace') && sel && !sel.locked) {
        e.preventDefault();
        remove(sel.id);
      } else if (key === 'escape') {
        setSelectedId(null);
      } else if (!mod && !e.altKey) {
        const t2 = TOOLS.find((x) => x.key.toLowerCase() === key);
        if (t2) setTool(t2.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const canUndo = history.current.past.length > 0;
  const canRedo = history.current.future.length > 0;

  const content = contentOf(scene);
  const clipsFor = (nodeId: string) => stats[nodeId]?.clips ?? null;

  return (
    <>
    <div className={styles.workspace} data-testid="scene-editor">
      <section className={styles.tree} aria-labelledby="tree-h">
        <h3 id="tree-h" className={styles.paneTitle}>
          Objects <span className={styles.count}>({scene.nodes.length})</span>
        </h3>
        <ObjectTree nodes={scene.nodes} selectedId={selectedId} busy={busy} imageObjects={byDerivative} onSelect={setSelectedId} onToggle={(id, v) => editNodes((ns) => setVisible(ns, id, v))} />
        <AddContent
          nodes={scene.nodes}
          actions={scene.actions}
          mode={placement.mode}
          busy={busy}
          onAdd={(node) => {
            editNodes((ns) => [...ns, node]);
            setSelectedId(node.id);
          }}
        />
        <SceneBudget totals={totals} count={scene.nodes.length} />
      </section>

      <div className={styles.stage}>
        <div className={styles.toolbar} role="toolbar" aria-label="Editing tools">
          <div className={styles.toolGroup} role="group" aria-label="Tool">
            {TOOLS.map((t) => (
              <button key={t.id} type="button" className={styles.tool} aria-pressed={tool === t.id} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
                {t.label}
              </button>
            ))}
          </div>
          <label className={styles.snap}>
            <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> Snap
          </label>
          <div className={styles.toolGroup} role="group" aria-label="History">
            <button type="button" className={styles.tool} disabled={!canUndo || busy} onClick={() => step('undo')} title={`Undo (${MOD}Z)`}>
              Undo
            </button>
            <button type="button" className={styles.tool} disabled={!canRedo || busy} onClick={() => step('redo')} title={`Redo (${MOD}Shift+Z)`}>
              Redo
            </button>
          </div>
        </div>
        <Suspense fallback={<p role="status" className={styles.viewportFallback}>Loading the 3D view…</p>}>
          <Viewport
            placement={placement}
            trackingImage={trackingImage}
            nodes={scene.nodes}
            fileFor={fileFor}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onStats={onStats}
            tool={tool}
            snap={snapOn}
            onTransform={setTransform}
            apiRef={viewportApi}
          />
        </Suspense>
        <p className={styles.srOnly} role="status" aria-live="polite">
          {notice?.text ?? ''}
        </p>
        <p className={formStyles.hint}>
          {placement.mode === 'floor'
            ? 'The grid is the floor (10 cm squares); the coloured axes mark where the experience is anchored.'
            : placement.mode === 'wall'
              ? 'The grey plane is the wall (10 cm squares); content sits in front of it.'
              : trackingImage && placement.mode === 'image' && placement.trackingTargetAssetId
                ? `The tracking image is shown at its printed size (${formatSize([trackingImage.width, trackingImage.height])}), lying flat; its top edge points away from you.`
                : 'Choose a tracking image to see it here at its printed size.'}{' '}
          Drag to orbit, scroll to zoom, click an object to select it. Choose Move, Rotate or Scale to change it with the handles
          {snapOn ? ' (snapping to 1 cm, 15° and 5%)' : ''}.
        </p>
      </div>

      <section className={styles.inspector} aria-labelledby="inspector-h">
        <h3 id="inspector-h" className={styles.paneTitle}>
          Inspector
        </h3>
        {notice && notice.tone !== 'status' && (
          <p className={notice.tone === 'error' ? formStyles.error : formStyles.hint} data-testid="editor-notice">
            {notice.text}
          </p>
        )}
        {selected ? (
          <Inspector
            key={selected.id}
            node={selected}
            nodes={scene.nodes}
            busy={busy}
            placementMode={placement.mode}
            hasTrackingImage={Boolean(trackingImage && placement.mode === 'image' && placement.trackingTargetAssetId)}
            imageObject={selected.kind === 'image-object' ? byDerivative.get(selected.derivativeId) : undefined}
            model={selected.kind === 'model' ? byModel.get(selected.assetId) : undefined}
            sourcesLoading={imageObjects.isPending || models.isPending}
            stats={stats[selected.id]}
            fileBytes={fileFor(selected)?.bytes ?? null}
            onContent={(patch) => editNodes((ns) => ns.map((n) => (n.id === selected.id && !n.locked ? ({ ...n, ...patch } as SceneNode) : n)))}
            actions={scene.actions}
            onTapAction={(actionId) => editContent((c) => setTapAction(c, selected.id, actionId))}
            onRename={(name) => editNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, name } : n)))}
            onToggle={(v) => editNodes((ns) => setVisible(ns, selected.id, v))}
            onLock={(v) => editNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, locked: v } : n)))}
            onTransform={(t) => setTransform(selected.id, t)}
            onDuplicate={() => duplicate(selected.id)}
            onAlign={(k) => align(selected.id, k)}
            onRemove={() => remove(selected.id)}
          />
        ) : (
          <p className={formStyles.hint}>{scene.nodes.length ? 'Select an object in the list or in the 3D view.' : 'Add an object to start building the scene.'}</p>
        )}
      </section>
    </div>
    <ActionsPanel content={content} busy={busy} clipsFor={clipsFor} onEdit={editContent} onNotice={(t, tone) => setNotice(t, tone)} />
    <CompatibilityPanel scene={scene} blendImageObjects={scene.nodes.filter((n) => n.kind === 'image-object' && byDerivative.get(n.derivativeId)?.resolvedAlphaMode === 'BLEND').length} />
    </>
  );
}

const contentOf = (s: DraftExperienceScene): Content => ({ nodes: s.nodes, actions: s.actions, ...(s.primaryActionId !== undefined ? { primaryActionId: s.primaryActionId } : {}) });
function withContent(s: DraftExperienceScene, c: Content): DraftExperienceScene {
  const { primaryActionId: _old, ...rest } = s;
  return { ...rest, nodes: c.nodes, actions: c.actions, ...(c.primaryActionId !== undefined ? { primaryActionId: c.primaryActionId } : {}) };
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
                  {node.locked && ' · locked'}
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
  placementMode: DraftExperienceScene['placement']['mode'];
  hasTrackingImage: boolean;
  imageObject: ImageObjectSummary | undefined;
  model: AssetSummary | undefined;
  sourcesLoading: boolean;
  stats: NodeStats | undefined;
  fileBytes: number | null;
  onContent: (patch: Partial<SceneNode>) => void;
  actions: DraftExperienceScene['actions'];
  onTapAction: (actionId: string | null) => void;
  onRename: (name: string) => void;
  onToggle: (visible: boolean) => void;
  onLock: (locked: boolean) => void;
  onTransform: (t: Transform) => void;
  onDuplicate: () => void;
  onAlign: (kind: AlignKind) => void;
  onRemove: () => void;
}) {
  const { node, imageObject: io, model, stats } = props;
  const [name, setName] = useState(node.name ?? '');
  useEffect(() => setName(node.name ?? ''), [node.name]);
  const t = node.transform;
  const scaled = stats?.size.map((v, i) => v * t.scale[i]!) as [number, number, number] | undefined;
  const issues = stats ? budgetIssues(stats, props.fileBytes, 'object') : [];
  const locked = node.locked === true;
  const visible = effectivelyVisible(props.nodes, node.id);
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
            <dd>{io ? (io.sourceFilename ?? 'image') + ' (' + describeImageObject(io) + ')' : props.sourcesLoading ? 'Loading…' : 'No longer available — remove it from the scene.'}</dd>
          </>
        )}
        {node.kind === 'model' && (
          <>
            <dt>File</dt>
            <dd>{model ? (model.filename ?? '3D model') + (model.sizeBytes !== null ? ' (' + formatBytes(model.sizeBytes) + ')' : '') : props.sourcesLoading ? 'Loading…' : 'No longer available — remove it from the scene.'}</dd>
            {model?.model && model.model.animations > 0 && (
              <>
                <dt>Animations</dt>
                <dd>{model.model.animations} (not played in the editor)</dd>
              </>
            )}
          </>
        )}
        {DRAWN_KINDS.has(node.kind) && (
          <>
            <dt>Size in the scene</dt>
            <dd data-testid="inspector-size">{scaled ? formatSize(scaled) : visible ? 'Measuring…' : 'Shown when visible'}</dd>
          </>
        )}
        {stats && (
          <>
            <dt>Budget</dt>
            <dd data-testid="inspector-budget">
              {stats.triangles.toLocaleString('en-US')} triangles · {stats.materials} material{stats.materials === 1 ? '' : 's'}
              {stats.textures ? ' · ' + stats.textures + ' texture' + (stats.textures === 1 ? '' : 's') + ' (largest ' + stats.maxTexturePx + ' px)' : ''}
            </dd>
          </>
        )}
        <dt>Visible</dt>
        <dd>{node.visible === false ? 'No' : visible ? 'Yes' : 'Hidden by its parent'}</dd>
      </dl>

      {issues.length > 0 && (
        <ul className={styles.budgetIssues} data-testid="inspector-budget-issues">
          {issues.map((i) => (
            <li key={i.message} className={i.level === 'error' ? styles.issueError : styles.issueWarning}>
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <ContentFields key={node.id} node={node} disabled={props.busy || locked} onChange={props.onContent} />
      <TapAction node={node} nodes={props.nodes} actions={props.actions} disabled={props.busy} onChange={props.onTapAction} />
      <TransformFields key={JSON.stringify(t)} transform={t} disabled={props.busy || locked} onCommit={props.onTransform} />
      {locked && <p className={formStyles.hint}>Locked: unlock it to move, rotate, scale or remove it.</p>}

      <InAr kind={node.kind} />
      <div className={styles.inspectorActions} role="group" aria-label="Align">
        {props.placementMode !== 'wall' && (
          <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={props.busy || locked} onClick={() => props.onAlign('ground')}>
            {props.placementMode === 'floor' ? 'Put on floor' : 'Put on image'}
          </button>
        )}
        {props.placementMode === 'wall' && (
          <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={props.busy || locked} onClick={() => props.onAlign('wall')}>
            Flush to wall
          </button>
        )}
        {props.placementMode === 'image' && (
          <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={props.busy || locked || !props.hasTrackingImage} onClick={() => props.onAlign('fit')} title={props.hasTrackingImage ? undefined : 'Choose a tracking image first'}>
            Fit to image
          </button>
        )}
      </div>
      <div className={styles.inspectorActions}>
        <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={props.busy} onClick={() => props.onToggle(node.visible === false)}>
          {node.visible === false ? 'Show' : 'Hide'}
        </button>
        <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={props.busy} aria-pressed={locked} onClick={() => props.onLock(!locked)}>
          {locked ? 'Unlock' : 'Lock'}
        </button>
        <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={props.busy} onClick={props.onDuplicate} title={`Duplicate (${MOD}D)`}>
          Duplicate
        </button>
        <button type="button" className={styles.dangerButton} disabled={props.busy || locked} onClick={props.onRemove} aria-label={`Remove ${nodeLabel(node)}`}>
          Remove
        </button>
      </div>
    </div>
  );
}

const fmt = (v: number, digits: number) => String(Number(v.toFixed(digits)));
const AXES = ['X', 'Y', 'Z'] as const;

/**
 * Position (cm), rotation (degrees) and uniform scale (%) as typed numbers. Applied on Enter or when focus leaves the
 * whole form (moving between its fields does not apply, so a field is never replaced while typing); rotation is only recomputed when one of its fields changed, so the stored quaternion is never disturbed by
 * a round trip through degrees.
 */
function TransformFields({ transform: t, disabled, onCommit }: { transform: Transform; disabled: boolean; onCommit: (t: Transform) => void }) {
  const initial = useMemo(
    () => ({
      pos: t.position.map((v) => fmt(v * 100, 2)),
      rot: eulerDegFromQuat(t.rotation).map((v) => fmt(v, 2)),
      scale: fmt(t.scale[0] * 100, 2),
    }),
    [t],
  );
  const [pos, setPos] = useState(initial.pos);
  const [rot, setRot] = useState(initial.rot);
  const [scale, setScale] = useState(initial.scale);
  const [error, setError] = useState<string | null>(null);
  const uniform = isUniform(t.scale);

  const commit = (e?: FormEvent) => {
    e?.preventDefault();
    const num = (s: string) => Number(s.replace(',', '.').trim());
    const p = pos.map(num);
    const r = rot.map(num);
    const sc = num(scale) / 100;
    if (![...p, ...r, sc].every(Number.isFinite) || pos.some((s) => !s.trim()) || rot.some((s) => !s.trim()) || !scale.trim()) return setError('Enter a number in every field.');
    if (p.some((v) => Math.abs(v / 100) > LIMITS.positionM)) return setError(`Positions must be within ±${LIMITS.positionM} m.`);
    if (sc < LIMITS.scaleMin || sc > LIMITS.scaleMax) return setError(`Scale must be between ${LIMITS.scaleMin * 100}% and ${LIMITS.scaleMax * 100}%.`);
    setError(null);
    const rotationChanged = rot.some((s, i) => s !== initial.rot[i]);
    const scaleChanged = scale !== initial.scale;
    const next = cleanTransform({
      position: p.map((v) => v / 100) as [number, number, number],
      rotation: rotationChanged ? quatFromEulerDeg(r) : t.rotation,
      scale: scaleChanged ? [sc, sc, sc] : t.scale,
    });
    if (JSON.stringify(next) !== JSON.stringify(cleanTransform(t))) onCommit(next);
  };

  const row = (label: string, unit: string, values: string[], set: (v: string[]) => void, testid: string) => (
    <fieldset className={styles.xyz} disabled={disabled} data-testid={testid}>
      <legend className={styles.xyzLegend}>
        {label} <span className={styles.unit}>({unit})</span>
      </legend>
      {AXES.map((a, i) => (
        <label key={a} className={styles.axis}>
          <span className={styles[`axis${a}`]}>{a}</span>
          <input
            className={styles.num}
            inputMode="decimal"
            aria-label={`${label} ${a}`}
            value={values[i]}
            onChange={(e) => set(values.map((v, j) => (j === i ? e.target.value : v)))}
          />
        </label>
      ))}
    </fieldset>
  );

  return (
    <form
      className={styles.transform}
      onSubmit={commit}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
      }}
      noValidate
    >
      {row('Position', 'cm', pos, setPos, 'inspector-position')}
      {row('Rotation', '°', rot, setRot, 'inspector-rotation')}
      <fieldset className={styles.xyz} disabled={disabled}>
        <legend className={styles.xyzLegend}>
          Scale <span className={styles.unit}>(%)</span>
        </legend>
        <label className={styles.axis}>
          <span aria-hidden="true">⇔</span>
          <input className={styles.num} inputMode="decimal" aria-label="Scale" value={scale} onChange={(e) => setScale(e.target.value)} />
        </label>
        {!uniform && <span className={styles.unit}>Uneven scale from the file; a new value makes it even.</span>}
      </fieldset>
      {error && (
        <p className={formStyles.error} role="alert">
          {error}
        </p>
      )}
      {/* Enter applies the values. */}
      <button type="submit" hidden tabIndex={-1} />
    </form>
  );
}

function SceneBudget({ totals, count }: { totals: ReturnType<typeof sceneTotals>; count: number }) {
  if (!count) return null;
  const issues = budgetIssues(totals.stats, totals.bytes, 'scene');
  return (
    <div className={styles.sceneBudget} data-testid="scene-budget">
      <p className={styles.unit}>
        Scene (visible objects): {totals.stats.triangles.toLocaleString('en-US')} triangles · {totals.stats.materials} materials · {formatBytes(totals.bytes)} of files. Scene Viewer recommends at most 100,000 ·
        10 · 10 MB.
      </p>
      {issues.length > 0 && (
        <ul className={styles.budgetIssues}>
          {issues.map((i) => (
            <li key={i.message} className={i.level === 'error' ? styles.issueError : styles.issueWarning}>
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FEATURE_OF: Partial<Record<SceneNode['kind'], Feature>> = { 'image-object': 'image_object_flat', model: 'model', text: 'text_panel', panel: 'text_panel', primitive: 'shape', hotspot: 'hotspots' };
const RUNTIME_LABEL = [
  ['ios_quicklook_floor', 'iPhone, iPad (Quick Look)'],
  ['android_webxr_image', 'Android image tracking'],
  ['android_scene_viewer_floor', 'Android Scene Viewer'],
] as const;

/** How this kind of object is planned to appear in each AR viewer (capability registry: planning, not device-verified). */
function InAr({ kind }: { kind: SceneNode['kind'] }) {
  const feature = FEATURE_OF[kind];
  if (!feature) return null;
  return (
    <details className={styles.inAr} data-testid="in-ar">
      <summary>In AR</summary>
      <dl className={styles.facts}>
        {RUNTIME_LABEL.map(([runtime, label]) => {
          const e = capability(feature, runtime);
          return (
            <div key={runtime} className={styles.factRow}>
              <dt>{label}</dt>
              <dd>
                {SUPPORT_LABEL[e.status]}: {e.message}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}

/** What tapping the object does (any action); a hotspot must have one. Where taps work is shown under "In AR". */
function TapAction({ node, nodes, actions, disabled, onChange }: { node: SceneNode; nodes: SceneNode[]; actions: DraftExperienceScene['actions']; disabled: boolean; onChange: (id: string | null) => void }) {
  const hotspot = node.kind === 'hotspot';
  return (
    <div className={styles.content}>
      <label className={formStyles.label} htmlFor="tap-action">
        {hotspot ? 'Action' : 'On tap'}
      </label>
      <select id="tap-action" className={styles.input} value={node.actionId ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        {!hotspot && <option value="">Nothing</option>}
        {actions.map((a) => (
          <option key={a.id} value={a.id}>
            {actionOption(a, nodes)}
          </option>
        ))}
      </select>
      {!actions.length && <p className={formStyles.hint}>Create actions under “Actions” below the 3D view.</p>}
    </div>
  );
}
