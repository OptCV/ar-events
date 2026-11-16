import type { PlacementMode } from '@ar-creator/schema';
import { cx } from '../components/cx.ts';
import styles from './Experiences.module.css';

/** Copy mirrors PLATFORM_ROUTING.md / CAPABILITIES.md; Android image tracking is experimental (ADR-002). */
export const PLACEMENTS: Record<PlacementMode, { title: string; summary: string; ios: string; android: string; experimental?: string }> = {
  image: {
    title: 'Image anchored',
    summary: 'Content appears on a printed or displayed image, such as a poster or packaging.',
    ios: 'AR Quick Look (image anchor)',
    android: 'Chrome WebXR image tracking',
    experimental: 'Android image tracking is experimental and needs a supported Chrome configuration; other visitors get a 3D preview.',
  },
  floor: {
    title: 'Floor',
    summary: 'Content stands on a floor or table, sized to the real world.',
    ios: 'AR Quick Look (horizontal plane)',
    android: 'Google Scene Viewer',
  },
  wall: {
    title: 'Wall',
    summary: 'Content hangs on a wall, such as art, signage or displays.',
    ios: 'AR Quick Look (vertical plane)',
    android: 'Google Scene Viewer (vertical placement)',
  },
};

interface Props {
  value: PlacementMode;
  onChange: (mode: PlacementMode) => void;
  disabled?: boolean;
  legend?: string;
  name?: string;
}

/** Accessible radio group (fieldset/legend, native radios) styled as cards. */
export function PlacementSelector({ value, onChange, disabled = false, legend = 'Placement', name = 'placement' }: Props) {
  return (
    <fieldset className={styles.placements} disabled={disabled}>
      <legend className={styles.legend}>{legend}</legend>
      {(Object.keys(PLACEMENTS) as PlacementMode[]).map((mode) => {
        const p = PLACEMENTS[mode];
        const id = `${name}-${mode}`;
        return (
          <label key={mode} htmlFor={id} className={cx(styles.placement, value === mode && styles.placementSelected)}>
            <input id={id} type="radio" name={name} value={mode} checked={value === mode} onChange={() => onChange(mode)} className={styles.radio} />
            <span className={styles.placementTitle}>{p.title}</span>
            <span className={styles.placementSummary}>{p.summary}</span>
            <span className={styles.platforms}>
              <span>iPhone/iPad: {p.ios}</span>
              <span>
                Android: {p.android}
                {p.experimental && <span className={styles.badge}>Experimental</span>}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
