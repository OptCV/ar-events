import { useState } from 'react';
import { PRIMITIVE_DEFAULT_COLOR, type SceneNode } from '@ar-creator/schema';
import formStyles from '../components/form/Form.module.css';
import styles from './Editor.module.css';

const SHAPES = [
  { value: 'box', label: 'Box' },
  { value: 'sphere', label: 'Sphere' },
  { value: 'cylinder', label: 'Cylinder' },
  { value: 'plane', label: 'Flat square' },
] as const;

/** Line height limits for text (schema allows up to 2 m). */
const TEXT_CM = { min: 0.5, max: 200 } as const;

/**
 * What a text, panel or shape shows (Phase 3 M11). Text fields apply when they lose focus (one undo step per change);
 * colour and shape apply immediately.
 */
export function ContentFields({ node, disabled, onChange }: { node: SceneNode; disabled: boolean; onChange: (patch: Partial<SceneNode>) => void }) {
  if (node.kind === 'text') return <TextFields node={node} disabled={disabled} onChange={onChange} />;
  if (node.kind === 'panel') return <PanelFields node={node} disabled={disabled} onChange={onChange} />;
  if (node.kind === 'primitive') {
    return (
      <fieldset className={styles.content} disabled={disabled}>
        <label className={formStyles.label} htmlFor="shape-kind">
          Shape
        </label>
        <select id="shape-kind" className={styles.input} value={node.shape} onChange={(e) => onChange({ shape: e.target.value as typeof node.shape, name: node.name && SHAPES.some((s) => s.label === node.name) ? SHAPES.find((s) => s.value === e.target.value)!.label : node.name } as Partial<SceneNode>)}>
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <ColorField label="Colour" value={node.color ?? PRIMITIVE_DEFAULT_COLOR} onChange={(color) => onChange({ color } as Partial<SceneNode>)} />
        <p className={formStyles.hint}>Size: use Scale (100 % = 1 m).</p>
      </fieldset>
    );
  }
  return null;
}

function TextFields({ node, disabled, onChange }: { node: Extract<SceneNode, { kind: 'text' }>; disabled: boolean; onChange: (patch: Partial<SceneNode>) => void }) {
  const [text, setText] = useState(node.text);
  const [size, setSize] = useState(String(Number((node.style.sizeMeters * 100).toFixed(2))));
  const [error, setError] = useState<string | null>(null);
  const commitText = () => {
    if (!text.trim()) return setError('Text cannot be empty.');
    setError(null);
    if (text !== node.text) onChange({ text: text.slice(0, 500) } as Partial<SceneNode>);
  };
  const commitSize = () => {
    const cm = Number(size.replace(',', '.'));
    if (!Number.isFinite(cm) || cm < TEXT_CM.min || cm > TEXT_CM.max) return setError(`Line height must be between ${TEXT_CM.min} and ${TEXT_CM.max} cm.`);
    setError(null);
    const m = Math.round(cm * 1e4) / 1e6;
    if (m !== node.style.sizeMeters) onChange({ style: { ...node.style, sizeMeters: m } } as Partial<SceneNode>);
  };
  return (
    <fieldset className={styles.content} disabled={disabled}>
      <label className={formStyles.label} htmlFor="text-value">
        Text
      </label>
      <textarea id="text-value" className={styles.textarea} rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} />
      <div className={styles.contentRow}>
        <ColorField label="Colour" value={node.style.color} onChange={(color) => onChange({ style: { ...node.style, color } } as Partial<SceneNode>)} />
        <label className={styles.axis}>
          <span className={formStyles.label}>Line height (cm)</span>
          <input className={styles.num} inputMode="decimal" aria-label="Line height (cm)" value={size} onChange={(e) => setSize(e.target.value)} onBlur={commitSize} onKeyDown={(e) => e.key === 'Enter' && commitSize()} />
        </label>
      </div>
      {error && (
        <p className={formStyles.error} role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function PanelFields({ node, disabled, onChange }: { node: Extract<SceneNode, { kind: 'panel' }>; disabled: boolean; onChange: (patch: Partial<SceneNode>) => void }) {
  const [title, setTitle] = useState(node.title);
  const [body, setBody] = useState(node.body);
  return (
    <fieldset className={styles.content} disabled={disabled}>
      <label className={formStyles.label} htmlFor="panel-title">
        Title
      </label>
      <input id="panel-title" className={styles.input} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== node.title && onChange({ title } as Partial<SceneNode>)} />
      <label className={formStyles.label} htmlFor="panel-body">
        Text
      </label>
      <textarea id="panel-body" className={styles.textarea} rows={4} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => body !== node.body && onChange({ body } as Partial<SceneNode>)} />
      <p className={formStyles.hint}>The card is 30 cm wide at 100 % scale; its height follows the text.</p>
    </fieldset>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  return (
    <label className={styles.color}>
      <span className={formStyles.label}>{label}</span>
      <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value.toLowerCase())} />
    </label>
  );
}
