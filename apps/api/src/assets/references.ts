import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema, type DbHandle } from '@ar-creator/db';
import type { AssetRole, DraftExperienceScene } from '@ar-creator/schema';
import { UUID } from '../http.ts';

const { assets, assetDerivatives } = schema;
type Issue = { path: (string | number)[]; message: string };

const NOUN: Record<AssetRole, string> = { 'tracking-image': 'tracking image', 'display-image': 'display image', model: '3D model', 'usdz-override': 'USDZ override', audio: 'audio file' };
const roleLabel = (r: AssetRole) => NOUN[r];

/**
 * Every asset a draft references must belong to the draft's owner, be validated, and have the role the reference
 * needs (tracking target → `tracking-image`, model node → `model`; ADR-003, ADR-022). Another user's asset is
 * reported exactly like a missing one.
 */
export async function assetReferenceIssues(db: DbHandle['db'], ownerId: string, scene: DraftExperienceScene): Promise<Issue[]> {
  const wanted: { id: string; role: AssetRole; path: Issue['path'] }[] = [];
  if (scene.placement.mode === 'image' && scene.placement.trackingTargetAssetId) {
    wanted.push({ id: scene.placement.trackingTargetAssetId, role: 'tracking-image', path: ['scene', 'placement', 'trackingTargetAssetId'] });
  }
  const derivatives: { id: string; path: Issue['path'] }[] = [];
  scene.nodes.forEach((n, i) => {
    if (n.kind === 'model') wanted.push({ id: n.assetId, role: 'model', path: ['scene', 'nodes', i, 'assetId'] });
    if (n.kind === 'image-object') derivatives.push({ id: n.derivativeId, path: ['scene', 'nodes', i, 'derivativeId'] });
  });

  const issues: Issue[] = [];
  const assetIds = [...new Set(wanted.map((w) => w.id).filter((id) => UUID.test(id)))];
  const found = new Map<string, AssetRole>();
  if (assetIds.length) {
    const rows = await db
      .select({ id: assets.id, role: assets.role })
      .from(assets)
      .where(and(eq(assets.ownerId, ownerId), eq(assets.state, 'validated'), inArray(assets.id, assetIds)));
    for (const r of rows) found.set(r.id, r.role as AssetRole);
  }
  for (const w of wanted) {
    const role = found.get(w.id);
    if (!role) issues.push({ path: w.path, message: 'This asset does not exist or is not ready.' });
    else if (role !== w.role) issues.push({ path: w.path, message: `This asset is a ${roleLabel(role)}, not a ${roleLabel(w.role)}.` });
  }

  // An image object is referenced by its GLB derivative and is usable only while its USDZ partner (same source and
  // settings) is ready too: iOS needs the USDZ, Android/web the GLB (ADR-023).
  const derivativeIds = [...new Set(derivatives.map((d) => d.id).filter((id) => UUID.test(id)))];
  const ready = new Set<string>();
  if (derivativeIds.length) {
    const usdz = alias(assetDerivatives, 'usdz');
    const rows = await db
      .select({ id: assetDerivatives.id })
      .from(assetDerivatives)
      .innerJoin(assets, eq(assets.id, assetDerivatives.sourceAssetId))
      .innerJoin(
        usdz,
        and(eq(usdz.sourceAssetId, assetDerivatives.sourceAssetId), eq(usdz.settingsHash, assetDerivatives.settingsHash), eq(usdz.outputType, 'image_object_usdz'), eq(usdz.status, 'ready')),
      )
      .where(
        and(
          eq(assets.ownerId, ownerId),
          eq(assets.state, 'validated'),
          eq(assetDerivatives.outputType, 'image_object_glb'),
          eq(assetDerivatives.status, 'ready'),
          inArray(assetDerivatives.id, derivativeIds),
        ),
      );
    for (const r of rows) ready.add(r.id);
  }
  for (const d of derivatives) if (!ready.has(d.id)) issues.push({ path: d.path, message: 'This image object does not exist or is not ready.' });
  return issues;
}
