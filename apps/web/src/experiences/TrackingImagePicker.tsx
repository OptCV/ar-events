import { useState } from 'react';
import type { AssetSummary } from '@ar-creator/contracts';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { useAssets } from '../assets/api.ts';
import { AssetPreview, assetDetails } from '../assets/AssetCard.tsx';
import { AssetUploader } from '../assets/AssetUploader.tsx';
import assetStyles from '../assets/Assets.module.css';

/**
 * Tracking image for image placement (ADR-003: a tracking reference, never rendered as scene content).
 * Selecting saves the draft immediately; the server checks ownership, state and role.
 */
export function TrackingImagePicker({ selectedId, widthMeters, onSelect, busy }: { selectedId: string | null; widthMeters: number; onSelect: (id: string | null) => void; busy: boolean }) {
  const q = useAssets('tracking-image');
  const [choosing, setChoosing] = useState(false);
  const selected = q.data?.assets.find((a) => a.id === selectedId) ?? null;
  const others = (q.data?.assets ?? []).filter((a) => a.id !== selectedId);

  const printedHeightCm = (a: AssetSummary) => (a.image ? Math.round(((widthMeters * a.image.height) / a.image.width) * 1000) / 10 : null);

  return (
    <div className={assetStyles.picker} data-testid="tracking-image">
      <h3 className={assetStyles.pickerTitle}>Tracking image</h3>
      {selectedId && q.isPending && <p role="status">Loading tracking image…</p>}
      {selectedId && q.data && !selected && <Alert tone="error">The selected tracking image is no longer available. Choose another one.</Alert>}
      {selected ? (
        <div className={assetStyles.selected}>
          <AssetPreview asset={selected} />
          <div className={assetStyles.cardBody}>
            <span className={assetStyles.cardTitle}>{selected.filename}</span>
            <span className={assetStyles.meta}>{assetDetails(selected).join(' · ')}</span>
            {printedHeightCm(selected) !== null && (
              <span className={assetStyles.meta} data-testid="printed-size">
                Printed size: {Math.round(widthMeters * 1000) / 10} × {printedHeightCm(selected)} cm
              </span>
            )}
            {selected.warnings.map((w) => (
              <span key={w} className={assetStyles.warning}>
                {w}
              </span>
            ))}
            <div className={assetStyles.uploadRow}>
              <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={busy} onClick={() => setChoosing((v) => !v)} aria-expanded={choosing}>
                Change
              </button>
              <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={busy} onClick={() => onSelect(null)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        !selectedId && <p className={assetStyles.hint}>Not set yet. Upload the image that will be printed, or pick one you already uploaded.</p>
      )}

      {(!selected || choosing) && (
        <>
          <AssetUploader
            role="tracking-image"
            compact
            onUploaded={(a) => {
              setChoosing(false);
              onSelect(a.id);
            }}
          />
          {others.length > 0 && (
            <fieldset className={assetStyles.choices} disabled={busy}>
              <legend className={assetStyles.hint}>Or use an uploaded tracking image</legend>
              <ul className={assetStyles.choiceList}>
                {others.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className={assetStyles.choice}
                      onClick={() => {
                        setChoosing(false);
                        onSelect(a.id);
                      }}
                    >
                      <AssetPreview asset={a} size="sm" />
                      <span className={assetStyles.choiceName}>{a.filename}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}
