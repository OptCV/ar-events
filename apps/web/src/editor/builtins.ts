import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  SphereGeometry,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { PANEL_WIDTH_METERS, PRIMITIVE_DEFAULT_COLOR, type SceneNode } from '@ar-creator/schema';
import { wrapText } from './budgets.ts';

/**
 * Built-in content drawn by the editor (Phase 3 M11, ADR-029), following the canonical geometry in
 * packages/schema/src/content.ts: centred on the node origin, in the XY plane facing +Z, meters. Text and panels are
 * drawn onto a canvas texture — the same way they will be baked for Quick Look and Scene Viewer (capabilities:
 * text_panel = compiled_visual), so fonts may differ slightly between devices.
 */
export function buildContent(n: SceneNode): Object3D | null {
  if (n.kind === 'primitive') return primitive(n.shape, n.color ?? PRIMITIVE_DEFAULT_COLOR);
  if (n.kind === 'text') return text(n.text, n.style.color, n.style.sizeMeters);
  if (n.kind === 'panel') return panel(n.title, n.body);
  return null;
}

/** Changes when what is drawn changes (the transform is applied separately). */
export function contentKey(n: SceneNode): string | null {
  if (n.kind === 'primitive') return `prim:${n.shape}:${n.color ?? ''}`;
  if (n.kind === 'text') return `text:${JSON.stringify([n.text, n.style])}`;
  if (n.kind === 'panel') return `panel:${JSON.stringify([n.title, n.body])}`;
  return null;
}

function primitive(shape: 'box' | 'sphere' | 'cylinder' | 'plane', color: string): Mesh {
  let geo: BufferGeometry;
  if (shape === 'box') geo = new BoxGeometry(1, 1, 1);
  else if (shape === 'sphere') geo = new SphereGeometry(0.5, 48, 24);
  else if (shape === 'cylinder') geo = new CylinderGeometry(0.5, 0.5, 1, 48);
  else geo = new PlaneGeometry(1, 1);
  const mat = new MeshStandardMaterial({ color: new Color(color), roughness: 0.75, metalness: 0 });
  if (shape === 'plane') mat.side = DoubleSide;
  const m = new Mesh(geo, mat);
  m.name = `shape-${shape}`;
  return m;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MAX_CANVAS = 4096;

function canvasPlane(canvas: HTMLCanvasElement, width: number, height: number, name: string): Mesh {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false });
  const m = new Mesh(new PlaneGeometry(width, height), mat);
  m.name = name;
  return m;
}

/** One line box = `lineMeters` tall; lines centred. */
function text(value: string, color: string, lineMeters: number): Mesh {
  const lines = value.split('\n');
  let fontPx = 128;
  const linePx = () => Math.round(fontPx * 1.25);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${fontPx}px ${FONT}`;
  let widest = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  // Keep the canvas within GPU limits for long text.
  const scale = Math.min(1, (MAX_CANVAS - 32) / widest, MAX_CANVAS / (linePx() * lines.length));
  if (scale < 1) {
    fontPx = Math.max(8, Math.floor(fontPx * scale));
    ctx.font = `600 ${fontPx}px ${FONT}`;
    widest = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  }
  c.width = Math.ceil(widest + fontPx * 0.25);
  c.height = linePx() * lines.length;
  ctx.font = `600 ${fontPx}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, c.width / 2, linePx() * (i + 0.5)));
  const height = lineMeters * lines.length;
  return canvasPlane(c, (height * c.width) / c.height, height, 'text');
}

/** A white card PANEL_WIDTH_METERS wide; height follows the content. */
function panel(title: string, body: string): Mesh {
  const W = 1024;
  const pad = 56;
  const titlePx = 64;
  const titleLine = 80;
  const bodyPx = 44;
  const bodyLine = 62;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `700 ${titlePx}px ${FONT}`;
  const titleLines = title.trim() ? wrapText(title, W - pad * 2, (s) => ctx.measureText(s).width) : [];
  ctx.font = `400 ${bodyPx}px ${FONT}`;
  let bodyLines = body.trim() ? wrapText(body, W - pad * 2, (s) => ctx.measureText(s).width) : [];
  const gap = titleLines.length && bodyLines.length ? 24 : 0;
  const heightFor = (b: number) => pad * 2 + titleLines.length * titleLine + gap + b * bodyLine;
  // Very long bodies are cut (with an ellipsis) at the texture limit.
  while (bodyLines.length && heightFor(bodyLines.length) > MAX_CANVAS) bodyLines = [...bodyLines.slice(0, -2), '…'];
  c.width = W;
  c.height = Math.max(pad * 2 + bodyLine, heightFor(bodyLines.length));
  const r = 40;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#dce2e8';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(3, 3, c.width - 6, c.height - 6, r);
  ctx.fill();
  ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#17202a';
  ctx.font = `700 ${titlePx}px ${FONT}`;
  let y = pad;
  for (const l of titleLines) {
    ctx.fillText(l, pad, y + titleLine / 2);
    y += titleLine;
  }
  y += gap;
  ctx.fillStyle = '#3b4652';
  ctx.font = `400 ${bodyPx}px ${FONT}`;
  for (const l of bodyLines) {
    ctx.fillText(l, pad, y + bodyLine / 2);
    y += bodyLine;
  }
  return canvasPlane(c, PANEL_WIDTH_METERS, (PANEL_WIDTH_METERS * c.height) / c.width, 'panel');
}
