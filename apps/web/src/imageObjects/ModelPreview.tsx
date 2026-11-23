import { useEffect, useRef, useState } from 'react';
import { AmbientLight, Box3, Color, DirectionalLight, GridHelper, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Material, type Mesh, type Object3D, type Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import styles from './ImageObjects.module.css';

export type Backdrop = 'checker' | 'light' | 'dark';
const BG: Record<Backdrop, number> = { checker: 0xe9edf2, light: 0xffffff, dark: 0x15191e };

/** no-texture: the shape loaded but its picture did not (e.g. blocked by the page's CSP) — never shown as "ready". */
type State = 'loading' | 'ready' | 'no-texture' | 'error' | 'unsupported';

/**
 * Desktop 3D preview of a generated GLB (three.js, lazy-loaded). Shows the real file the Android/web runtimes get,
 * with its alpha mode and sides as authored; it is NOT how Scene Viewer or Quick Look will render it on a device.
 * Renders only when the view changes (no animation loop), and frees every GPU resource on unmount.
 */
export default function ModelPreview({ url, backdrop, label }: { url: string; backdrop: Backdrop; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>('loading');
  const bgRef = useRef<(b: Backdrop) => void>(() => undefined);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setState('unsupported');
      return;
    }
    setState('loading');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute('aria-label', label);
    el.appendChild(renderer.domElement);

    const scene = new Scene();
    scene.background = new Color(BG[backdrop]);
    scene.add(new AmbientLight(0xffffff, 1.6));
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 3);
    scene.add(sun);
    const camera = new PerspectiveCamera(40, 1, 0.01, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    bgRef.current = (b) => {
      scene.background = new Color(BG[b]);
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

    let disposed = false;
    let root: Object3D | null = null;
    let grid: GridHelper | null = null;
    new GLTFLoader().load(
      url,
      (gltf) => {
        if (disposed) return;
        root = gltf.scene;
        scene.add(root);
        // Frame the object; a 10 cm grid under it gives a sense of real size.
        const box = new Box3().setFromObject(root);
        const size = box.getSize(new Vector3());
        const center = box.getCenter(new Vector3());
        const span = Math.max(size.x, size.y, size.z, 0.01);
        const cells = Math.max(2, Math.ceil((span * 2) / 0.1));
        grid = new GridHelper(cells * 0.1, cells, 0x8a96a3, 0xc3cbd4);
        grid.position.set(center.x, box.min.y - 0.0005, center.z);
        scene.add(grid);
        controls.target.copy(center);
        camera.position.set(center.x + span * 0.6, center.y + span * 0.4, center.z + span * 1.8);
        camera.near = span / 100;
        camera.far = span * 100;
        controls.update();
        resize();
        let textured = false;
        root.traverse((o) => {
          const m = (o as Mesh).material as (Material & { map?: Texture | null }) | undefined;
          if (m?.map?.image) textured = true;
        });
        setState(textured ? 'ready' : 'no-texture');
      },
      undefined,
      () => {
        if (!disposed) setState('error');
      },
    );

    return () => {
      disposed = true;
      ro.disconnect();
      controls.dispose();
      root?.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose();
        const mats = (Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) as Material[];
        for (const m of mats) {
          for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) (v as Texture).dispose();
          m.dispose();
        }
      });
      grid?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // The backdrop is applied through bgRef without reloading the model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, label]);

  useEffect(() => bgRef.current(backdrop), [backdrop]);

  return (
    <div className={styles.stage3d} data-testid="model-preview" data-state={state}>
      <div ref={host} className={styles.canvasHost} />
      {state !== 'ready' && (
        <p className={styles.overlayText} role={state === 'loading' ? 'status' : 'alert'}>
          {state === 'loading'
            ? 'Loading 3D preview…'
            : state === 'no-texture'
              ? 'The preview shows the shape only: the picture could not be loaded here. The downloaded files are not affected.'
              : state === 'error'
                ? 'The 3D preview could not be loaded.'
                : 'This browser cannot show 3D previews (WebGL is unavailable).'}
        </p>
      )}
    </div>
  );
}
