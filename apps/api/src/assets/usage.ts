import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@ar-creator/db';

const { assets, assetDerivatives } = schema;

/**
 * Bytes of generated outputs (GLB/USDZ derivatives) owned by a user. They count toward the storage quota with
 * the originals, so trying many settings cannot grow storage without bound (ADR-023).
 */
export async function derivativeBytes(db: Pick<Database, 'select'>, ownerId: string): Promise<number> {
  const [r] = await db
    .select({ bytes: sql<number>`coalesce(sum(${assetDerivatives.sizeBytes}), 0)::bigint` })
    .from(assetDerivatives)
    .innerJoin(assets, eq(assets.id, assetDerivatives.sourceAssetId))
    .where(and(eq(assets.ownerId, ownerId), eq(assetDerivatives.status, 'ready')));
  return Number(r?.bytes ?? 0);
}
