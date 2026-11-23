import { useEffect, useRef, useState } from 'react';
import {
  AmbientLight,
  AxesHelper,
  Box3,
  BoxHelper,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineLoop,
  BufferGeometry,
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
import type { DraftPlacement, SceneNode } from '@ar-creator/schema';
import { DRAWN_KINDS, effectivelyVisible } from './sceneModel.ts';
import styles from './Editor.module.css';

export interface ViewportProps {
  placement: DraftPlacement;
  /** Image placement: the tracking image (signed URL) and its printed size in meters. */
  trackingImage: { url: string | null; width: number; height: number } | null;
  nodes: SceneNode[];
  /** GLB URL for an image-object node, keyed by derivative id (URLs are re-signed; the id is the cache key). */
  glbUrl: (derivativeId: string) => string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Size of a drawn node's file in meters (x, y, z, before node scale), reported after it loads. */
  onMeasured: (derivativeId: string, size: [number, number, number]) => void;
}

type State = 'loading' | 'ready' | 'error' | 'unsupported';
interface Engine {
  render: () => void;
  scene: Scene;
  anchor: Group;
  content: Group;
  frame: () => void;
  selection: BoxHelper | null;
}

const ACCENT = 0x215cc5;
const CLICK_SLOP_PX = 4;

/**
 * Editor viewport (Phase 3 M9): the canonical scene in canonical axes (ADR-005) — +Y up, meters. The anchor reference
 * shows what the content is placed against; nodes are drawn from their real files. Renders on demand only, frees every
 * GPU resource on unmount. It is a 3D preview, not AR: lighting, transparency sorting and scale UI differ on devices.
 */
export default function Viewport(props: ViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const [state, setState] = useState<State>('loading');
  const [rendered, setRendered] = useState<string[]>([]);
  /** Drawn nodes whose picture did not load (shape only) — surfaced, never silently grey. */
  const [untextured, setUntextured] = useState<string[]>([]);
  const latest = useRef(props);
  latest.current = props;
  const cache = useRef(new Map<string, Promise<GLTF>>());
  const drawn = useRef(new Map<string, { key: string; object: Object3D; textured: boolean }>());

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
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);

    const frame = () => {
      // Frame what matters: the content and the tracking image — not the helper grids or the wall, which are larger.
      const box = new Box3().setFromObject(content);
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

    // Click (not drag) selects: orbiting never changes the selection or moves anything.
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
      down = null;
      const r = renderer.domElement.getBoundingClientRect();
      const ray = new Raycaster();
      ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(content.children, true)[0];
      let o: Object3D | null = hit?.object ?? null;
      while (o && !o.userData.nodeId) o = o.parent;
      latest.current.onSelect((o?.userData.nodeId as string | undefined) ?? null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    engine.current = { render, scene, anchor, content, frame, selection: null };
    setState('ready');
    return () => {
      engine.current = null;
      ro.disconnect();
      controls.dispose();
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
      const geo = new PlaneGeometry(trackingImage.width, trackingImage.height);
      const mat = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide });
      const plane = new Mesh(geo, mat);
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

  // ---- content: one object per drawable, visible node; files cached by derivative id
  const { nodes, selectedId } = props;
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    let cancelled = false;
    const wanted = new Map<string, { node: SceneNode; key: string; url: string }>();
    for (const n of nodes) {
      if (!DRAWN_KINDS.has(n.kind) || n.kind !== 'image-object' || !effectivelyVisible(nodes, n.id)) continue;
      const url = latest.current.glbUrl(n.derivativeId);
      if (url) wanted.set(n.id, { node: n, key: n.derivativeId, url });
    }
    for (const [id, d] of drawn.current) {
      if (wanted.get(id)?.key !== d.key) {
        e.content.remove(d.object);
        drawn.current.delete(id);
      }
    }
    const firstContent = drawn.current.size === 0 && wanted.size > 0;
    const pending: Promise<void>[] = [];
    for (const [id, w] of wanted) {
      const existing = drawn.current.get(id);
      if (existing) {
        applyTransform(existing.object, w.node);
        continue;
      }
      let p = cache.current.get(w.key);
      if (!p) {
        p = new GLTFLoader().loadAsync(w.url);
        cache.current.set(w.key, p);
        p.catch(() => cache.current.delete(w.key));
      }
      pending.push(
        p.then((gltf) => {
          if (cancelled || drawn.current.has(id)) return;
          const object = new Group();
          object.userData.nodeId = id;
          object.name = id;
          const model = gltf.scene.clone(true);
          object.add(model);
          const size = new Box3().setFromObject(model).getSize(new Vector3());
          latest.current.onMeasured(w.key, [size.x, size.y, size.z]);
          applyTransform(object, w.node);
          e.content.add(object);
          let textured = false;
          model.traverse((o) => {
            const m = (o as Mesh).material as (Material & { map?: Texture | null }) | undefined;
            if (m?.map?.image) textured = true;
          });
          drawn.current.set(id, { key: w.key, object, textured });
        }),
      );
    }
    const finish = () => {
      if (cancelled) return;
      highlight(e, selectedId ? drawn.current.get(selectedId)?.object ?? null : null);
      setRendered([...drawn.current.keys()].sort());
      setUntextured([...drawn.current].filter(([, d]) => !d.textured).map(([id]) => id).sort());
      if (firstContent) e.frame();
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
  }, [nodes, selectedId, state]);

  // ---- free cached GLB resources on unmount
  useEffect(() => {
    const c = cache.current;
    return () => {
      for (const p of c.values()) p.then((g) => disposeTree(g.scene)).catch(() => undefined);
      c.clear();
    };
  }, []);

  return (
    <div className={styles.viewport} data-testid="viewport" data-state={state} data-anchor={placement.mode} data-rendered={rendered.join(',')} data-untextured={untextured.join(',')}>
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

function applyTransform(o: Object3D, n: SceneNode) {
  const t = n.transform;
  o.position.set(...t.position);
  o.quaternion.set(...t.rotation);
  o.scale.set(...t.scale);
  o.updateMatrixWorld(true);
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
