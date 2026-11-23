import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  AmbientLight,
  AxesHelper,
  Box3,
  BoxHelper,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { DraftPlacement, SceneNode, Transform } from '@ar-creator/schema';
import { effectivelyVisible } from './sceneModel.ts';
import { buildContent, contentKey, loadContentFonts } from './builtins.ts';
import type { ObjectStats } from './budgets.ts';
import { SNAP, cleanTransform, sameTransform, uniformFromDrag, type Quat, type Vec3 } from './transforms.ts';
import styles from './Editor.module.css';

export type Tool = 'select' | 'move' | 'rotate' | 'scale';
export interface NodeStats extends ObjectStats {
  size: [number, number, number];
  /** Animation clip names of a model (unnamed clips as "#index"); null for kinds without a file. */
  clips: string[] | null;
}
export type AlignKind = 'ground' | 'wall' | 'fit';

/** Measurements only the viewport can make (it has the loaded files). */
export interface ViewportApi {
  /** The transform that aligns a node (and its children) — null when its file is not loaded or hidden. */
  aligned: (id: string, kind: AlignKind) => Transform | null;
}

export interface ViewportProps {
  placement: DraftPlacement;
  /** Image placement: the tracking image (signed URL) and its printed size in meters. */
  trackingImage: { url: string | null; width: number; height: number } | null;
  nodes: SceneNode[];
  /** The GLB to draw for an image-object or model node: `key` caches the file (signed URLs change), null = not available. */
  fileFor: (node: SceneNode) => { key: string; url: string } | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** What a node draws, once drawn: size in meters before the node's own scale, and budget counts. */
  onStats: (nodeId: string, stats: NodeStats) => void;
  tool: Tool;
  snap: boolean;
  /** A finished gizmo drag: the node's new local transform (one undo step). */
  onTransform: (id: string, transform: Transform) => void;
  apiRef: RefObject<ViewportApi | null>;
}

type State = 'loading' | 'ready' | 'error' | 'unsupported';
interface Holder {
  group: Group;
  key: string | null;
  model: Object3D | null;
  /** Built-in content owns its GPU resources; GLB clones share them with the cache. */
  owned: boolean;
  /** False only when a file defines pictures that did not load. */
  textured: boolean;
}
interface Engine {
  render: () => void;
  scene: Scene;
  anchor: Group;
  content: Group;
  gizmo: TransformControls;
  frame: () => void;
  selection: BoxHelper | null;
}

const ACCENT = 0x215cc5;
const CLICK_SLOP_PX = 4;

/**
 * Editor viewport (Phase 3 M9–M10): the canonical scene in canonical axes (ADR-005) — +Y up, meters. Nodes form a real
 * hierarchy (children move with their parent); image objects are drawn from their files. Gizmos edit the selected
 * node only with an explicit tool, and a drag is committed once when it ends (one undo step). Renders on demand.
 * It is a 3D preview, not AR: lighting, transparency sorting and scale UI differ on devices.
 */
export default function Viewport(props: ViewportProps) {
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const [state, setState] = useState<State>('loading');
  const [rendered, setRendered] = useState<string[]>([]);
  /** Drawn nodes whose picture did not load (shape only) — surfaced, never silently grey. */
  const [untextured, setUntextured] = useState<string[]>([]);
  const latest = useRef(props);
  latest.current = props;
  const cache = useRef(new Map<string, Promise<GLTF>>());
  const holders = useRef(new Map<string, Holder>());
  const dragging = useRef<{ id: string; before: Transform } | null>(null);

  // ---- one renderer per mount
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true });
    } catch {
      setState('unsupported');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.setAttribute('aria-hidden', 'true');
    el.appendChild(renderer.domElement);
    const scene = new Scene();
    scene.background = new Color(0xeef1f5);
    scene.add(new AmbientLight(0xffffff, 1.6));
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 3, 2);
    scene.add(sun);
    const anchor = new Group();
    anchor.name = 'anchor-reference';
    const content = new Group();
    content.name = 'content';
    scene.add(anchor, content);
    const camera = new PerspectiveCamera(40, 1, 0.005, 200);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.size = 0.8;
    scene.add(gizmo.getHelper());

    const screenPoint = new Vector3();
    const render = () => {
      const e = engine.current;
      e?.selection?.update();
      renderer.render(scene, camera);
      // Where the selected object's origin is on screen (for keyboard-free testing and the gizmo's anchor point).
      const sel = latest.current.selectedId ? holders.current.get(latest.current.selectedId)?.group : null;
      if (sel && root.current) {
        sel.getWorldPosition(screenPoint).project(camera);
        const r = renderer.domElement.getBoundingClientRect();
        root.current.dataset.selectedScreen = `${Math.round(((screenPoint.x + 1) / 2) * r.width)},${Math.round(((1 - screenPoint.y) / 2) * r.height)}`;
      } else if (root.current) delete root.current.dataset.selectedScreen;
    };
    controls.addEventListener('change', render);
    gizmo.addEventListener('change', render);
    gizmo.addEventListener('dragging-changed', (ev) => {
      controls.enabled = !(ev as unknown as { value: boolean }).value;
    });
    gizmo.addEventListener('mouseDown', () => {
      const o = gizmo.object;
      if (o?.userData.nodeId) dragging.current = { id: o.userData.nodeId as string, before: transformOf(o) };
    });
    gizmo.addEventListener('objectChange', () => {
      const o = gizmo.object;
      const d = dragging.current;
      if (!o || !d || gizmo.mode !== 'scale') return;
      // Pictures are never stretched: whichever handle is dragged, scale stays uniform.
      const s = uniformFromDrag(d.before.scale, o.scale.toArray());
      o.scale.set(s, s, s);
    });
    gizmo.addEventListener('mouseUp', () => {
      const o = gizmo.object;
      const d = dragging.current;
      dragging.current = null;
      if (!o || !d) return;
      const after = cleanTransform(transformOf(o));
      if (!sameTransform(after, d.before)) latest.current.onTransform(d.id, after);
    });

    const frame = () => {
      // Frame what matters: the content and the tracking image — not the helper grids or the wall, which are larger.
      const box = new Box3();
      content.traverseVisible((o) => {
        if ((o as Mesh).isMesh) box.expandByObject(o);
      });
      for (const o of anchor.children) if (o.userData.frame) box.union(new Box3().setFromObject(o));
      if (box.isEmpty()) box.set(new Vector3(-0.4, 0, -0.4), new Vector3(0.4, 0.4, 0.4));
      const center = box.getCenter(new Vector3());
      const span = Math.max(...box.getSize(new Vector3()).toArray(), 0.2);
      const wall = latest.current.placement.mode === 'wall';
      controls.target.copy(center);
      // Floor/image: from the front and above. Wall: straight on, slightly from above (the wall is the XY plane).
      camera.position.set(center.x + span * (wall ? 0.15 : 0.6), center.y + span * (wall ? 0.25 : 0.9), center.z + span * (wall ? 2.2 : 1.6));
      camera.near = span / 200;
      camera.far = span * 200;
      camera.updateProjectionMatrix();
      controls.update();
      render();
    };

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // Click (not drag) selects. Orbiting, and pressing a gizmo handle, never change the selection.
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = gizmo.axis !== null ? null : { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
      down = null;
      const r = renderer.domElement.getBoundingClientRect();
      const ray = new Raycaster();
      ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(content.children, true).find((h) => shownInScene(h.object));
      let o: Object3D | null = hit?.object ?? null;
      while (o && !o.userData.nodeId) o = o.parent;
      latest.current.onSelect((o?.userData.nodeId as string | undefined) ?? null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    engine.current = { render, scene, anchor, content, gizmo, frame, selection: null };
    latest.current.apiRef.current = { aligned: (id, kind) => aligned(holders.current.get(id)?.group ?? null, kind, latest.current.trackingImage) };
    // Text and panels use the bundled font (as exported); draw once it is loaded (or after a short timeout).
    let live = true;
    void loadContentFonts().then(() => live && setState('ready'));
    return () => {
      live = false;
      engine.current = null;
      latest.current.apiRef.current = null;
      ro.disconnect();
      controls.dispose();
      gizmo.detach();
      gizmo.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  // ---- anchor reference (what the content is placed against), canonical axes per mode
  const { placement, trackingImage } = props;
  const anchorKey = JSON.stringify([placement, trackingImage]);
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    disposeTree(e.anchor);
    e.anchor.clear();
    let cancelled = false;
    if (placement.mode === 'floor') {
      e.anchor.add(grid(2, 20, 'floor'));
    } else if (placement.mode === 'wall') {
      // Wall: the XY plane at z = 0, normal +Z toward the viewer.
      const wall = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ color: 0xdfe4ea, side: DoubleSide }));
      wall.position.set(0, 0, -0.001);
      wall.name = 'wall';
      const g = grid(2, 20, 'wall-grid');
      g.rotation.x = Math.PI / 2;
      e.anchor.add(wall, g);
    } else if (trackingImage) {
      // Image: lies in the XZ plane, normal +Y; +X = image right, +Z = image bottom (ADR-005).
      const mat = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide });
      const plane = new Mesh(new PlaneGeometry(trackingImage.width, trackingImage.height), mat);
      plane.rotation.x = -Math.PI / 2; // local +Y (image top) → world −Z
      plane.position.y = -0.0005;
      plane.name = 'tracking-image';
      plane.userData.frame = true;
      e.anchor.add(plane, outline(trackingImage.width, trackingImage.height));
      e.anchor.add(grid(Math.max(1, trackingImage.width * 4), Math.max(10, Math.round(trackingImage.width * 40)), 'surface', 0.25));
      if (trackingImage.url) {
        new TextureLoader().load(trackingImage.url, (t) => {
          if (cancelled) return t.dispose();
          t.colorSpace = SRGBColorSpace;
          mat.map = t;
          mat.needsUpdate = true;
          e.render();
        });
      }
    }
    const axes = new AxesHelper(0.05); // red +X, green +Y, blue +Z at the anchor origin
    axes.name = 'origin';
    e.anchor.add(axes);
    e.frame();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, state]);

  // ---- content: one holder per node, parented like the scene; image objects get their file
  const { nodes, selectedId, tool, snap } = props;
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    let cancelled = false;
    const hs = holders.current;
    const ids = new Set(nodes.map((n) => n.id));
    for (const [id, h] of hs) {
      if (!ids.has(id)) {
        if (e.gizmo.object === h.group) e.gizmo.detach();
        h.group.removeFromParent();
        hs.delete(id);
      }
    }
    for (const n of nodes) {
      if (!hs.has(n.id)) {
        const group = new Group();
        group.name = n.id;
        group.userData.nodeId = n.id;
        hs.set(n.id, { group, key: null, model: null, owned: false, textured: true });
      }
    }
    const hadContent = rendered.length > 0;
    const pending: Promise<void>[] = [];
    for (const n of nodes) {
      const h = hs.get(n.id)!;
      const parent = (n.parentId !== undefined && hs.get(n.parentId)?.group) || e.content;
      // Never create a loop (the schema forbids cycles, but the editor must not hang on bad data).
      if (h.group.parent !== parent && !isAncestor(h.group, parent)) parent.add(h.group);
      else if (h.group.parent === null) e.content.add(h.group);
      h.group.visible = n.visible !== false;
      if (dragging.current?.id !== n.id) setTransform(h.group, n.transform);

      const file = n.kind === 'image-object' || n.kind === 'model' ? latest.current.fileFor(n) : null;
      const key = file?.key ?? contentKey(n);
      if (h.key !== key && h.model) {
        h.model.removeFromParent();
        if (h.owned) disposeTree(h.model);
        h.model = null;
        h.textured = true;
      }
      h.key = key;
      if (h.model || !key || !effectivelyVisible(nodes, n.id)) continue;
      const built = buildContent(n);
      if (built) {
        attach(h, built, true, true, n.id, null);
        continue;
      }
      if (!file) continue;
      let p = cache.current.get(file.key);
      if (!p) {
        p = new GLTFLoader().loadAsync(file.url);
        cache.current.set(file.key, p);
        p.catch(() => cache.current.delete(file.key));
      }
      const nodeId = n.id;
      pending.push(
        p.then((gltf) => {
          if (cancelled || h.model || h.key !== file.key) return;
          const model = gltf.scene.clone(true);
          const definesPictures = ((gltf.parser.json as { images?: unknown[] }).images?.length ?? 0) > 0;
          attach(h, model, false, !definesPictures || countTextures(model).textures > 0, nodeId, gltf.animations.map((a, i) => a.name.trim() || `#${i}`));
        }),
      );
    }

    function attach(h: Holder, model: Object3D, owned: boolean, textured: boolean, nodeId: string, clips: string[] | null) {
      h.model = model;
      h.owned = owned;
      h.textured = textured;
      // Measured before it joins the node, so the size excludes the node's own transform.
      const size = new Box3().setFromObject(model).getSize(new Vector3());
      h.group.add(model);
      latest.current.onStats(nodeId, { size: [size.x, size.y, size.z], clips, ...statsOf(model) });
    }

    const finish = () => {
      if (cancelled) return;
      const shown = [...hs].filter(([id, h]) => h.model && effectivelyVisible(nodes, id));
      setRendered(shown.map(([id]) => id).sort());
      setUntextured(shown.filter(([, h]) => !h.textured).map(([id]) => id).sort());
      const sel = selectedId ? hs.get(selectedId) : undefined;
      const node = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
      highlight(e, sel && effectivelyVisible(nodes, selectedId!) ? sel.group : null);
      // The gizmo appears only with an explicit tool, on a visible, unlocked selection.
      if (sel && node && tool !== 'select' && !node.locked && effectivelyVisible(nodes, node.id)) {
        if (e.gizmo.object !== sel.group) e.gizmo.attach(sel.group);
        e.gizmo.setMode(tool === 'move' ? 'translate' : tool);
      } else if (e.gizmo.object) e.gizmo.detach();
      e.gizmo.setTranslationSnap(snap ? SNAP.positionM : null);
      e.gizmo.setRotationSnap(snap ? (SNAP.rotationDeg * Math.PI) / 180 : null);
      e.gizmo.setScaleSnap(snap ? SNAP.scale : null);
      if (!hadContent && shown.length > 0) e.frame();
      e.render();
    };
    finish();
    if (pending.length) {
      Promise.allSettled(pending).then((results) => {
        if (results.some((r) => r.status === 'rejected') && !cancelled) setState('error');
        finish();
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, selectedId, tool, snap, state]);

  // ---- free cached GLB resources on unmount
  useEffect(() => {
    const c = cache.current;
    return () => {
      for (const p of c.values()) p.then((g) => disposeTree(g.scene)).catch(() => undefined);
      c.clear();
    };
  }, []);

  return (
    <div
      ref={root}
      className={styles.viewport}
      data-testid="viewport"
      data-state={state}
      data-anchor={placement.mode}
      data-tool={tool}
      data-rendered={rendered.join(',')}
      data-untextured={untextured.join(',')}
    >
      <div ref={host} className={styles.canvasHost} />
      <div className={styles.viewportBar}>
        <span className={styles.previewLabel}>3D preview — not AR</span>
        <button type="button" className={styles.barButton} onClick={() => engine.current?.frame()} disabled={state === 'unsupported'}>
          Reset view
        </button>
      </div>
      {state === 'ready' && untextured.length > 0 && (
        <p className={styles.viewportMessage} role="alert">
          Some pictures could not be loaded in this preview; those objects show their shape only. The AR files are not affected.
        </p>
      )}
      {state !== 'ready' && (
        <p className={styles.viewportMessage} role={state === 'loading' ? 'status' : 'alert'}>
          {state === 'loading' ? 'Loading the 3D view…' : state === 'error' ? 'Some objects could not be loaded. Reload the page to try again.' : 'This browser cannot show the 3D view (WebGL is unavailable).'}
        </p>
      )}
    </div>
  );
}

function setTransform(o: Object3D, t: Transform) {
  o.position.set(...t.position);
  o.quaternion.set(...t.rotation);
  o.scale.set(...t.scale);
  o.updateMatrixWorld(true);
}

function transformOf(o: Object3D): Transform {
  return { position: o.position.toArray() as Vec3, rotation: o.quaternion.toArray() as Quat, scale: o.scale.toArray() as Vec3 };
}

function countTextures(root: Object3D) {
  const textures = new Set<Texture>();
  const materials = new Set<Material>();
  root.traverse((o) => {
    const m = o as Mesh;
    for (const mat of (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as Material[]) {
      materials.add(mat);
      for (const v of Object.values(mat)) if ((v as Texture | null)?.isTexture) textures.add(v as Texture);
    }
  });
  return { textures: textures.size, materials: materials.size, set: textures };
}

/** Budget counts of what a node draws (ADR-029): triangles, materials, textures, longest texture edge. */
function statsOf(root: Object3D): ObjectStats {
  let triangles = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangles += Math.floor((g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3);
  });
  const t = countTextures(root);
  let maxTexturePx = 0;
  for (const tex of t.set) {
    const img = tex.image as { width?: number; height?: number } | null;
    maxTexturePx = Math.max(maxTexturePx, img?.width ?? 0, img?.height ?? 0);
  }
  return { triangles, materials: t.materials, textures: t.textures, maxTexturePx };
}

function shownInScene(o: Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function isAncestor(maybeAncestor: Object3D, o: Object3D | null): boolean {
  for (; o; o = o.parent) if (o === maybeAncestor) return true;
  return false;
}

/**
 * Align a node by its real bounds (all its drawn content, children included), in anchor space:
 *  ground — lowest point on the surface (y = 0; floor and image placement);
 *  wall   — back flush against the wall (z = 0; wall placement);
 *  fit    — uniformly scaled to the tracking image's width, centred on it and resting on it (image placement).
 * Returns the node's new local transform; the object itself is left as it was (the scene update moves it).
 */
function aligned(g: Group | null, kind: AlignKind, target: { width: number; height: number } | null): Transform | null {
  if (!g || !shownInScene(g)) return null;
  const before = transformOf(g);
  const bounds = () => {
    g.updateMatrixWorld(true);
    const b = new Box3();
    g.traverseVisible((o) => {
      if ((o as Mesh).isMesh) b.expandByObject(o);
    });
    return b;
  };
  let box = bounds();
  if (box.isEmpty()) return null;
  if (kind === 'fit') {
    const width = box.max.x - box.min.x;
    if (!target || width <= 1e-9) return null;
    g.scale.multiplyScalar(target.width / width);
    box = bounds();
  }
  const delta = kind === 'ground' ? new Vector3(0, -box.min.y, 0) : kind === 'wall' ? new Vector3(0, 0, -box.min.z) : new Vector3(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const world = g.getWorldPosition(new Vector3()).add(delta);
  const local = g.parent ? g.parent.worldToLocal(world) : world;
  const result = cleanTransform({ position: local.toArray() as Vec3, rotation: before.rotation, scale: g.scale.toArray() as Vec3 });
  setTransform(g, before);
  return result;
}

function highlight(e: Engine, target: Object3D | null) {
  if (e.selection) {
    e.scene.remove(e.selection);
    e.selection.geometry.dispose();
    (e.selection.material as Material).dispose();
    e.selection = null;
  }
  if (!target) return;
  e.selection = new BoxHelper(target, ACCENT);
  e.selection.name = 'selection';
  e.scene.add(e.selection);
}

function grid(size: number, divisions: number, name: string, opacity = 1) {
  const g = new GridHelper(size, divisions, 0x8a96a3, 0xc3cbd4);
  g.name = name;
  if (opacity < 1) {
    for (const m of [g.material].flat() as Material[]) {
      m.transparent = true;
      m.opacity = opacity;
    }
  }
  return g;
}

function outline(w: number, h: number) {
  const pts = [new Vector3(-w / 2, 0, -h / 2), new Vector3(w / 2, 0, -h / 2), new Vector3(w / 2, 0, h / 2), new Vector3(-w / 2, 0, h / 2)];
  const line = new LineLoop(new BufferGeometry().setFromPoints(pts), new LineBasicMaterial({ color: ACCENT }));
  line.name = 'tracking-image-outline';
  return line;
}

function disposeTree(root: Object3D) {
  root.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    const mats = (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as Material[];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if ((v as Texture | null)?.isTexture) (v as Texture).dispose();
      mat.dispose();
    }
  });
}
