/**
 * P0 Android WebXR image-tracking probe (AND-IMG-01). Native experimental WebXR only (ADR-002).
 * Flow: preflight → preload target bitmap + GLB (so the tap can call requestSession synchronously, keeping
 * transient user activation) → user taps Start AR → resolve API via adapter → scores → per-frame poses.
 * Produces a JSON report; captures no camera imagery (SECURITY.md privacy).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  FLAG_HELP,
  ImageAnchorTracker,
  WidthStats,
  buildSessionInit,
  describeStartError,
  preflight,
  resolveImageTrackingApi,
  type PreflightResult,
  type SessionLike,
  type TrackingStatus,
} from '@ar-creator/webxr-image';

const PROBE_VERSION = 'p0-webxr-probe@0.1.0';
const TARGET_URL = '../images/tracking_target_20cm.png';
const TARGET_WIDTH_M = 0.2;
const GLB_URL = '../glb/img-overlay.glb';
const MANIFEST_URL = '../manifest.json';

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const ui = {
  preflight: $('preflight'),
  flagHelp: $('flag-help'),
  start: $<HTMLButtonElement>('start'),
  result: $('result'),
  report: $('report'),
  copy: $<HTMLButtonElement>('copy'),
  overlay: $('overlay'),
  status: $('status'),
  width: $('width'),
  cta: $<HTMLButtonElement>('cta'),
  exit: $<HTMLButtonElement>('exit'),
};

interface Report {
  probe: string;
  date: string;
  userAgent: string;
  preflight?: PreflightResult;
  assets: { glbSha256?: string; target: string; targetWidthMeters: number };
  session?: {
    enabledFeatures: string[] | null;
    domOverlayType: string | null;
    api: string | null;
    unavailableReason?: string;
    scores?: string[];
  };
  transitions: { from: string; to: string; frame: number; ms: number }[];
  firstTrackedMs?: number;
  measuredWidth?: ReturnType<WidthStats['summary']>;
  overlayCtaTapped?: boolean;
  outcome?: string;
  error?: string;
}

const report: Report = {
  probe: PROBE_VERSION,
  date: new Date().toISOString(),
  userAgent: navigator.userAgent,
  assets: { target: TARGET_URL, targetWidthMeters: TARGET_WIDTH_M },
  transitions: [],
};
const renderReport = () => (ui.report.textContent = JSON.stringify(report, null, 2));

function showResult(text: string, bad = false) {
  ui.result.textContent = text;
  ui.result.classList.toggle('bad', bad);
}

const STATUS_TEXT: Record<TrackingStatus, string> = {
  scanning: 'Point your camera at the printed image',
  tracked: 'Image found',
  emulated: 'Image tracked (estimated)',
  lost: 'Image lost — point at the image again',
};

// ---------- preload (before any tap)
let targetBitmap: ImageBitmap | null = null;
let model: THREE.Group | null = null;

async function preload() {
  const [bitmap, gltf, manifest] = await Promise.all([
    fetch(TARGET_URL)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`target ${r.status}`))))
      .then((b) => createImageBitmap(b)),
    new GLTFLoader().loadAsync(GLB_URL),
    fetch(MANIFEST_URL)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  targetBitmap = bitmap;
  model = gltf.scene;
  const c = manifest?.cases?.find((x: { id: string }) => x.id === 'img-overlay');
  if (c) report.assets.glbSha256 = c.glb.sha256;
}

async function init() {
  ui.flagHelp.textContent = FLAG_HELP;
  // Preflight and asset preload run in parallel; each renders as soon as it settles.
  let assets: boolean | null = null;
  let pf: PreflightResult | null = null;
  const render = () => {
    const items: [boolean | null, string][] = [
      [pf ? pf.secureContext : null, 'Secure context (HTTPS or localhost)'],
      [pf ? pf.webxr : null, 'WebXR available (navigator.xr)'],
      [pf ? pf.immersiveAr === true : null, 'immersive-ar session supported'],
      [assets, 'Tracking target + probe GLB loaded'],
    ];
    ui.preflight.replaceChildren(
      ...items.map(([ok, label]) =>
        Object.assign(document.createElement('li'), { className: ok === null ? '' : ok ? 'ok' : 'bad', textContent: ok === null ? `${label} — checking…` : label }),
      ),
      ...(pf?.messages ?? []).map((m) => Object.assign(document.createElement('li'), { className: 'bad', textContent: m })),
    );
    renderReport();
  };
  render();
  const assetsDone = preload().then(
    () => (assets = true),
    (e: unknown) => {
      assets = false;
      report.error = `asset preload failed: ${String(e)}`;
    },
  );
  void assetsDone.then(render);
  pf = await preflight({ isSecureContext: window.isSecureContext, xr: navigator.xr });
  report.preflight = pf;
  render();
  await assetsDone;
  const assetsOk = assets === true;
  ui.start.disabled = !(pf.canAttempt && assetsOk);
  if (!pf.canAttempt) {
    report.outcome = 'preflight-failed';
    showResult('AR cannot start on this browser/device. This is the unsupported-device path: show 3D preview instead.', true);
  }
  renderReport();
}

// ---------- session
ui.overlay.addEventListener('beforexrselect', (e) => e.preventDefault()); // overlay taps are not XR selects
ui.start.addEventListener('click', () => {
  if (!navigator.xr || !targetBitmap) return;
  ui.start.disabled = true;
  showResult('Starting AR…');
  ui.overlay.hidden = false;
  const sessionInit = buildSessionInit([{ image: targetBitmap, widthInMeters: TARGET_WIDTH_M }], ui.overlay);
  // Called synchronously inside the click handler: transient user activation is required.
  navigator.xr.requestSession('immersive-ar', sessionInit).then(runSession, (e: unknown) => {
    ui.overlay.hidden = true;
    ui.start.disabled = false;
    report.outcome = 'session-start-failed';
    report.error = `${(e as { name?: string }).name ?? 'Error'}: ${(e as { message?: string }).message ?? ''}`;
    showResult(describeStartError(e), true);
    renderReport();
  });
});

async function runSession(session: XRSession) {
  const s = session as unknown as SessionLike;
  report.session = {
    enabledFeatures: s.enabledFeatures ? [...s.enabledFeatures] : null,
    domOverlayType: s.domOverlayState?.type ?? null,
    api: null,
  };
  report.transitions = [];
  for (const k of ['outcome', 'error', 'firstTrackedMs', 'measuredWidth', 'overlayCtaTapped'] as const) delete report[k];
  report.date = new Date().toISOString();
  let tracker: ImageAnchorTracker | null = null; // read by the end handler
  document.body.classList.add('in-xr');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  document.body.appendChild(renderer.domElement);

  let ended = false;
  const end = (outcome: string, message: string, bad: boolean) => {
    report.outcome ??= outcome;
    showResult(message, bad);
    if (!ended) session.end().catch(() => undefined);
  };

  session.addEventListener('end', () => {
    ended = true;
    renderer.setAnimationLoop(null);
    renderer.dispose();
    renderer.domElement.remove();
    document.body.classList.remove('in-xr');
    ui.overlay.hidden = true;
    ui.start.disabled = false;
    report.measuredWidth = tracker?.widths.summary(TARGET_WIDTH_M) ?? null;
    report.outcome ??= report.firstTrackedMs !== undefined ? 'tracked' : 'never-tracked';
    if (!ui.result.textContent || ui.result.textContent === 'Starting AR…') {
      showResult(report.firstTrackedMs !== undefined ? 'Session ended. Image was tracked — record the report.' : 'Session ended without tracking the image.', report.firstTrackedMs === undefined);
    }
    renderReport();
  });
  ui.exit.onclick = () => session.end().catch(() => undefined);
  ui.cta.onclick = () => {
    report.overlayCtaTapped = true;
    ui.status.textContent = 'Overlay CTA tap received';
    renderReport();
  };

  try {
    await renderer.xr.setSession(session);
  } catch (e) {
    end('renderer-failed', `Could not start rendering: ${String(e)}`, true);
    return;
  }

  const resolved = resolveImageTrackingApi(s);
  if (!resolved.ok) {
    report.session.unavailableReason = resolved.reason;
    end(
      'image-tracking-unavailable',
      resolved.reason === 'feature-not-granted'
        ? `AR works, but this browser did not grant image tracking. ${FLAG_HELP}`
        : 'This browser exposes a tracking API shape this probe does not implement; nothing was assumed. See report.',
      true,
    );
    return;
  }
  const api = resolved.api;
  report.session.api = api.kind;

  try {
    const scores = await api.getScores();
    report.session.scores = [...scores];
    if (scores[0] === 'untrackable') {
      end('target-untrackable', 'The browser rated the tracking image as untrackable. Use a more detailed, higher-contrast image.', true);
      return;
    }
  } catch (e) {
    report.session.scores = [`error: ${String(e)}`];
  }

  // Scene: anchor group driven by the image pose; content = the same GLB used for iOS (img-overlay).
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.5));
  const anchor = new THREE.Group();
  anchor.matrixAutoUpdate = false;
  anchor.visible = false;
  if (model) anchor.add(model.clone());
  anchor.add(new THREE.AxesHelper(0.1)); // red +X, green +Y, blue +Z
  scene.add(anchor);

  tracker = new ImageAnchorTracker(api, { targetIndex: 0, lostAfterFrames: 15 });
  const tr = tracker;
  const t0 = performance.now();
  const setStatus = (st: TrackingStatus) => {
    ui.status.textContent = STATUS_TEXT[st];
    ui.status.dataset.status = st;
  };
  setStatus('scanning');
  let frames = 0;

  renderer.setAnimationLoop((_t, frame) => {
    if (!frame) return;
    const u = tr.onFrame(frame, renderer.xr.getReferenceSpace());
    if (u.transition) {
      const ms = Math.round(performance.now() - t0);
      report.transitions.push({ ...u.transition, ms });
      if (u.transition.to === 'tracked' && report.firstTrackedMs === undefined) report.firstTrackedMs = ms;
      setStatus(u.transition.to);
    }
    if (u.anchorMatrix) {
      anchor.matrix.fromArray(u.anchorMatrix);
      anchor.matrixWorldNeedsUpdate = true;
    }
    anchor.visible = u.visible;
    if (++frames % 30 === 0 && u.measuredWidthMeters !== null) ui.width.textContent = `measured ${(u.measuredWidthMeters * 100).toFixed(1)} cm / 20.0 cm`;
    renderer.render(scene, camera);
  });
}

ui.copy.addEventListener('click', () => {
  const text = ui.report.textContent ?? '';
  navigator.clipboard?.writeText(text).then(
    () => (ui.copy.textContent = 'Copied'),
    () => (ui.copy.textContent = 'Copy failed — select the text manually'),
  );
});

init().catch((e) => {
  report.error = String(e);
  showResult(`Probe failed to initialise: ${String(e)}`, true);
  renderReport();
});
