import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { AnimationMixer, Clock, Color, HemisphereLight, LoopOnce, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene, SphereGeometry, Group, WebGLRenderer, type Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { FLAG_HELP, ImageAnchorTracker, buildSessionInit, describeStartError, preflight, resolveImageTrackingApi, type PreflightResult, type SessionLike, type TrackingStatus } from '@ar-creator/webxr-image';
import type { TestBuildResponse } from '@ar-creator/contracts';
import { Alert } from '../../components/form/Alert.tsx';
import formStyles from '../../components/form/Form.module.css';
import { cx } from '../../components/cx.ts';
import { effectOf, findClip, overlayButtons, tapTarget } from './interactions.ts';
import { linkKind, type Track } from '../track.ts';
import styles from './ImageViewer.module.css';

const ModelPreview = lazy(() => import('../../imageObjects/ModelPreview.tsx'));

type Phase = 'checking' | 'ready' | 'unsupported' | 'starting' | 'running' | 'unavailable';
const STATUS_TEXT: Record<TrackingStatus, string> = {
  scanning: 'Point your camera at the printed image',
  tracked: 'Image found',
  emulated: 'Image tracked (estimated)',
  lost: 'Image lost — point at the image again',
};

/**
 * Android image placement viewer (Phase 5 M17, ADR-035): Chrome's experimental WebXR image tracking via
 * @ar-creator/webxr-image (the adapter proven on a device by AND-IMG-01), drawing the build's composed GLB on the
 * tracked image in the canonical image frame (ADR-005 H3: identity correction, not yet verified on a device).
 * Interactions follow the plan (ADR-031): links as on-screen buttons (DOM overlay), taps on objects and hotspots,
 * show/hide, play animation. When image tracking is not available, it says why and shows the 3D preview instead.
 */
export default function ImageViewer({ t, track }: { t: TestBuildResponse; track?: Track }) {
  const overlay = useRef<HTMLDivElement>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  const gltf = useRef<GLTF | null>(null);
  const session = useRef<XRSession | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [pf, setPf] = useState<PreflightResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<TrackingStatus>('scanning');
  const [note, setNote] = useState<string | null>(null);

  // Taps on the overlay's buttons must not also count as taps in the AR scene.
  useEffect(() => {
    const el = overlay.current;
    const stop = (e: Event) => e.preventDefault();
    el?.addEventListener('beforexrselect', stop);
    return () => el?.removeEventListener('beforexrselect', stop);
  }, []);

  // Preflight and preload (so the tap can start the session synchronously, keeping user activation).
  useEffect(() => {
    let live = true;
    void (async () => {
      const [p, loaded] = await Promise.all([
        preflight({ isSecureContext: window.isSecureContext, xr: navigator.xr }),
        (async () => {
          if (!t.tracking || !t.glbUrl) return false;
          const [b, g] = await Promise.all([
            fetch(t.tracking.imageUrl)
              .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`tracking image ${r.status}`))))
              .then((blob) => createImageBitmap(blob)),
            new GLTFLoader().loadAsync(t.glbUrl),
          ]);
          bitmap.current = b;
          gltf.current = g;
          return true;
        })().catch(() => false),
      ]);
      if (!live) return;
      setPf(p);
      if (!loaded) {
        setMessage('The scene or the tracking image could not be loaded.');
        setPhase('unsupported');
      } else setPhase(p.canAttempt ? 'ready' : 'unsupported');
    })();
    return () => {
      live = false;
      void session.current?.end().catch(() => undefined);
    };
  }, [t.tracking, t.glbUrl]);

  const start = () => {
    if (!navigator.xr || !bitmap.current || !t.tracking || !overlay.current) return;
    setPhase('starting');
    setMessage(null);
    track?.({ event: 'ar_tap', detail: 'android_webxr_image' });
    const init = buildSessionInit([{ image: bitmap.current, widthInMeters: t.tracking.widthMeters }], overlay.current);
    // Called synchronously inside the tap handler: WebXR requires transient user activation.
    navigator.xr.requestSession('immersive-ar', init).then(
      (s) => void run(s),
      (e: unknown) => {
        setMessage(describeStartError(e));
        setPhase('ready');
      },
    );
  };

  async function run(s: XRSession) {
    session.current = s;
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    document.body.appendChild(renderer.domElement);
    let navigateTo: string | null = null;
    let endMessage: string | null = null;
    s.addEventListener('end', () => {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
      session.current = null;
      if (navigateTo) window.location.assign(navigateTo);
      setMessage(endMessage);
      setPhase(endMessage ? 'unavailable' : 'ready');
    });
    const end = (msg: string | null) => {
      endMessage = msg;
      void s.end().catch(() => undefined);
    };
    setPhase('running');
    setStatus('scanning');
    try {
      await renderer.xr.setSession(s);
    } catch (e) {
      return end(`Could not start rendering: ${String(e)}`);
    }
    const resolved = resolveImageTrackingApi(s as unknown as SessionLike);
    if (!resolved.ok) {
      return end(resolved.reason === 'feature-not-granted' ? `AR works, but this browser did not turn on image tracking. ${FLAG_HELP}` : 'This browser offers a tracking feature this viewer does not support; nothing was assumed.');
    }
    try {
      const scores = await resolved.api.getScores();
      if (scores[0] === 'untrackable') return end('Chrome rated the tracking image as untrackable. Use a more detailed, higher-contrast image.');
    } catch {
      // Scores are advisory; tracking may still work.
    }

    const scene = new Scene();
    const camera = new PerspectiveCamera();
    scene.add(new HemisphereLight(0xffffff, 0x888888, 2.5));
    const anchor = new Group();
    anchor.matrixAutoUpdate = false;
    anchor.visible = false;
    const root = gltf.current!.scene;
    anchor.add(root);
    scene.add(anchor);
    // Hotspots: the GLB has an empty node there; the viewer draws the marker (and taps find the hotspot by name).
    for (const id of t.xr.hotspots) {
      const node = root.getObjectByName(id);
      if (node) node.add(Object.assign(new Mesh(new SphereGeometry(0.02, 24, 12), new MeshStandardMaterial({ color: new Color('#215cc5'), emissive: new Color('#0b2a66') })), { name: `${id}__marker` }));
    }
    const mixer = new AnimationMixer(root);
    const clock = new Clock();
    const clips = gltf.current!.animations.map((a) => ({ name: a.name, targets: a.tracks.map((tr) => tr.name.split('.')[0]!) }));

    const apply = (actionId: string) => {
      const fx = effectOf(actionId, t.xr);
      if (!fx) return;
      if (fx.kind === 'navigate') {
        track?.({ event: 'link_tap', detail: linkKind(fx.href) });
        navigateTo = fx.href;
        return end(null);
      }
      const target = root.getObjectByName(fx.nodeId);
      if (!target) return setNote('That object is hidden in this build.');
      if (fx.kind === 'toggle') {
        target.visible = !target.visible;
        return;
      }
      const subtree = new Set<string>();
      target.traverse((o) => subtree.add(o.name));
      const i = findClip(clips, fx.clip, subtree);
      if (i === null) return setNote(`The animation “${fx.clip}” is not in this model.`);
      const action = mixer.clipAction(gltf.current!.animations[i]!);
      action.reset().setLoop(LoopOnce, 1).play();
    };

    // Screen taps arrive as XR "select" events (taps on the overlay buttons are excluded via beforexrselect).
    const controller = renderer.xr.getController(0);
    scene.add(controller);
    const ray = new Raycaster();
    controller.addEventListener('select', () => {
      if (!anchor.visible) return;
      ray.setFromXRController(controller as unknown as Parameters<Raycaster['setFromXRController']>[0]);
      const hit = ray.intersectObject(anchor, true).find((h) => shown(h.object));
      if (!hit) return;
      const chain: string[] = [];
      for (let o: Object3D | null = hit.object; o; o = o.parent) if (o.name) chain.push(o.name.replace(/__marker$/, ''));
      const target = tapTarget(chain, t.xr);
      if (target) apply(target.actionId);
    });
    overlayTap.current = apply;
    overlayExit.current = () => end(null);

    const tracker = new ImageAnchorTracker(resolved.api, { targetIndex: 0, lostAfterFrames: 15 });
    renderer.setAnimationLoop((_t, frame) => {
      if (!frame) return;
      const u = tracker.onFrame(frame, renderer.xr.getReferenceSpace());
      if (u.transition) setStatus(u.transition.to);
      if (u.anchorMatrix) {
        anchor.matrix.fromArray(u.anchorMatrix);
        anchor.matrixWorldNeedsUpdate = true;
      }
      anchor.visible = u.visible;
      mixer.update(clock.getDelta());
      renderer.render(scene, camera);
    });
  }

  const overlayTap = useRef<(actionId: string) => void>(() => undefined);
  const overlayExit = useRef<() => void>(() => undefined);
  const buttons = overlayButtons(t.xr);

  return (
    <div className={styles.viewer} data-testid="xr-viewer" data-phase={phase}>
      {phase === 'checking' && <p role="status">Checking AR support…</p>}
      {pf && phase !== 'running' && (
        <ul className={styles.checks} aria-label="AR checks">
          <li className={pf.secureContext ? styles.ok : styles.bad}>Secure page (HTTPS)</li>
          <li className={pf.webxr ? styles.ok : styles.bad}>WebXR in this browser</li>
          <li className={pf.immersiveAr === true ? styles.ok : styles.bad}>AR sessions on this device (ARCore)</li>
        </ul>
      )}
      {message && <Alert tone="error">{message}</Alert>}
      {(phase === 'ready' || phase === 'starting') && (
        <>
          <button type="button" className={cx(formStyles.button, styles.start)} onClick={start} disabled={phase === 'starting'} data-testid="xr-start">
            {phase === 'starting' ? 'Starting AR…' : 'Start AR'}
          </button>
          <p className={formStyles.hint}>Image tracking on Android is experimental: it needs Chrome with “WebXR Incubations” turned on in chrome://flags.</p>
        </>
      )}
      {(phase === 'unsupported' || phase === 'unavailable') && (
        <>
          {phase === 'unsupported' && <Alert tone="info">{pf?.messages.join(' ') || FLAG_HELP}</Alert>}
          <p className={formStyles.hint}>{FLAG_HELP}</p>
          {t.glbUrl && (
            <div className={styles.preview}>
              <Suspense fallback={<p role="status">Loading 3D preview…</p>}>
                <ModelPreview url={t.glbUrl} backdrop="light" label={`3D preview of ${t.name}. Drag to rotate, scroll to zoom.`} />
              </Suspense>
            </div>
          )}
        </>
      )}
      {/* DOM overlay: shown over the camera view while the session runs. Taps here are not XR selects. */}
      <div ref={overlay} className={styles.overlay} hidden={phase !== 'running' && phase !== 'starting'}>
        <p className={styles.status} role="status" aria-live="polite" data-status={status}>
          {STATUS_TEXT[status]}
        </p>
        {note && <p className={styles.note}>{note}</p>}
        <div className={styles.overlayButtons}>
          {buttons.map((b) => (
            <button key={b.actionId} type="button" className={cx(formStyles.button, !b.primary && formStyles.secondary)} onClick={() => overlayTap.current(b.actionId)}>
              {b.label}
            </button>
          ))}
          <button type="button" className={cx(formStyles.button, formStyles.secondary)} onClick={() => overlayExit.current()}>
            Exit AR
          </button>
        </div>
      </div>
    </div>
  );
}

function shown(o: Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}
