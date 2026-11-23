/** Shared helpers for image objects in experiences (the picker itself lives in the editor: editor/AddContent.tsx). */
import type { ImageObjectSummary } from '@ar-creator/contracts';
import type { SceneNode } from '@ar-creator/schema';
import { ALPHA_LABEL } from '../imageObjects/labels.ts';
import styles from './Experiences.module.css';

export type ImageObjectNode = Extract<SceneNode, { kind: 'image-object' }>;

const cm = (m: number) => `${Number((m * 100).toFixed(1))} cm`;
const sizeOf = (io: ImageObjectSummary) => (io.widthMeters !== null && io.heightMeters !== null ? `${cm(io.widthMeters)} × ${cm(io.heightMeters)}` : '');
export const describeImageObject = (io: ImageObjectSummary) =>
  [sizeOf(io), io.resolvedAlphaMode ? ALPHA_LABEL[io.resolvedAlphaMode] : null, io.settings.doubleSided ? 'both sides' : 'front only'].filter(Boolean).join(' · ');

/** Short url-safe id, unique among the scene's nodes (schema: 1–64 of [A-Za-z0-9_-]). */
export function newNodeId(nodes: SceneNode[], prefix = 'io'): string {
  for (;;) {
    const id = `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    if (!nodes.some((n) => n.id === id)) return id;
  }
}

export function Thumb({ io }: { io: ImageObjectSummary | undefined }) {
  return <span className={styles.ioThumb}>{io?.previewUrl && <img src={io.previewUrl} alt="" />}</span>;
}
