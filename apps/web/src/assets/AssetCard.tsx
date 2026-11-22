import { Link } from 'react-router';
import { ROLE_POLICY, formatBytes, type AssetSummary, type UploadableRole } from '@ar-creator/contracts';
import { cx } from '../components/cx.ts';
import styles from './Assets.module.css';

const roleLabel = (r: AssetSummary['role']) => (r in ROLE_POLICY ? ROLE_POLICY[r as UploadableRole].label : r);

/** Preview: images via their short-lived signed URL on a checkerboard (so transparency is visible); models as a tile. */
export function AssetPreview({ asset, size = 'md' }: { asset: AssetSummary; size?: 'sm' | 'md' }) {
  return (
    <div className={cx(styles.preview, size === 'sm' && styles.previewSmall)}>
      {asset.image && asset.contentUrl ? (
        <img src={asset.contentUrl} alt="" loading="lazy" decoding="async" width={asset.image.width} height={asset.image.height} />
      ) : (
        <span className={styles.modelTile} aria-hidden="true">
          {asset.mimeType === 'model/gltf-binary' ? '3D · GLB' : 'File'}
        </span>
      )}
    </div>
  );
}

export function assetDetails(a: AssetSummary): string[] {
  const out: string[] = [];
  if (a.image) out.push(`${a.image.width} × ${a.image.height} px`);
  if (a.image?.mayHaveAlpha) out.push('may have transparency');
  if (a.model) out.push(`${a.model.meshes} mesh${a.model.meshes === 1 ? '' : 'es'}`, `${a.model.materials} material${a.model.materials === 1 ? '' : 's'}`);
  if (a.model?.animations) out.push(`${a.model.animations} animation${a.model.animations === 1 ? '' : 's'}`);
  if (a.sizeBytes !== null) out.push(formatBytes(a.sizeBytes));
  return out;
}

export function AssetCard({ asset, onDelete, error }: { asset: AssetSummary; onDelete: () => void; error?: string | undefined }) {
  return (
    <li className={styles.card} data-testid="asset-card">
      <AssetPreview asset={asset} />
      <div className={styles.cardBody}>
        <span className={styles.cardTitle} title={asset.filename ?? undefined}>
          {asset.filename ?? 'Untitled'}
        </span>
        <span className={styles.chip}>{roleLabel(asset.role)}</span>
        <span className={styles.meta}>{assetDetails(asset).join(' · ')}</span>
        {asset.warnings.map((w) => (
          <span key={w} className={styles.warning}>
            {w}
          </span>
        ))}
        {error && (
          <span className={styles.cardError} role="alert">
            {error}
          </span>
        )}
        {asset.role === 'display-image' && asset.state === 'validated' && (
          <Link className={styles.cardAction} to={`/library/${asset.id}/ar-object`} aria-label={`Make an AR object from ${asset.filename ?? 'this image'}`}>
            Make AR object
          </Link>
        )}
        <button type="button" className={styles.deleteButton} onClick={onDelete} aria-label={`Delete ${asset.filename ?? 'asset'}`}>
          Delete
        </button>
      </div>
    </li>
  );
}
