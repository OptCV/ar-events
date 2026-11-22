import { z } from 'zod';

/**
 * Asset storage contracts (Milestone 5, ADR-022). Shared by the API (authoritative checks) and the SPA
 * (early, friendlier checks). The server never trusts the declared type: it re-detects it from the bytes.
 */

/** Roles accepted for upload in this milestone. `usdz-override` and `audio` exist in the schema but are not accepted yet. */
export const UPLOADABLE_ROLES = ['tracking-image', 'display-image', 'model'] as const;
export const UploadableRole = z.enum(UPLOADABLE_ROLES);
export type UploadableRole = z.infer<typeof UploadableRole>;

export const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', glb: 'model/gltf-binary' } as const;
export type AssetMime = (typeof MIME)[keyof typeof MIME];

export interface RolePolicy {
  label: string;
  types: readonly AssetMime[];
  /** Maximum upload size in bytes. */
  maxBytes: number;
  /** Shortest image edge in pixels (images only). */
  minEdgePx?: number;
  /** File extensions the picker offers (display only; the server checks file signatures). */
  accept: string;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;
export const ROLE_POLICY: Record<UploadableRole, RolePolicy> = {
  'tracking-image': { label: 'Tracking image', types: [MIME.png, MIME.jpeg], maxBytes: 10 * MB, minEdgePx: 256, accept: '.png,.jpg,.jpeg,image/png,image/jpeg' },
  // WebP is accepted for display images only; it is prepared as PNG/JPEG before conversion (ADR-025). Tracking
  // images stay PNG/JPEG: AR Quick Look reference images and the WebXR tracker load them directly.
  'display-image': { label: 'Display image', types: [MIME.png, MIME.jpeg, MIME.webp], maxBytes: 15 * MB, minEdgePx: 1, accept: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp' },
  model: { label: '3D model (GLB)', types: [MIME.glb], maxBytes: 25 * MB, accept: '.glb,model/gltf-binary' },
};

/** Per-user limits (ADR-022). */
export const ASSET_LIMITS = {
  /** Unexpired, unfinished upload slots per user. */
  maxPendingUploads: 10,
  /** Total stored bytes per user (validated assets). */
  quotaBytes: 1024 * MB,
  /** How long an upload slot stays open. */
  uploadTtlSeconds: 15 * 60,
  /** Lifetime of signed read URLs handed to the owner. */
  readUrlTtlSeconds: 15 * 60,
} as const;

export const AssetId = z.uuid();
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256.');

/** POST /api/assets/uploads — reserve an upload slot. */
export const CreateUploadInput = z
  .object({
    role: UploadableRole,
    /** Display name only; sanitised server-side and never used in storage keys. */
    filename: z.string().trim().min(1, 'The file needs a name.').max(255),
    contentType: z.string().max(100),
    sizeBytes: z.number().int().positive('The file is empty.'),
    /** Optional client-computed checksum; when present the upload must match it exactly. */
    sha256: Sha256Hex.optional(),
  })
  .superRefine((v, ctx) => {
    const policy = ROLE_POLICY[v.role];
    if (!(policy.types as readonly string[]).includes(v.contentType)) {
      ctx.addIssue({ code: 'custom', path: ['contentType'], message: unsupportedTypeMessage(v.role, v.contentType) });
    }
    if (v.sizeBytes > policy.maxBytes) {
      ctx.addIssue({ code: 'custom', path: ['sizeBytes'], message: `${policy.label}s can be at most ${formatBytes(policy.maxBytes)}.` });
    }
  });
export type CreateUploadInput = z.infer<typeof CreateUploadInput>;

export function unsupportedTypeMessage(role: UploadableRole, type: string): string {
  if (type === 'image/webp' && role === 'tracking-image') return 'Tracking images must be PNG or JPEG.';
  if (role === 'model') return 'Upload a binary glTF file (.glb).';
  return role === 'display-image' ? 'Upload a PNG, JPEG or WebP image.' : 'Upload a PNG or JPEG image.';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < GB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${Number((n / GB).toFixed(2))} GB`;
}

export const ImageMetadata = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The container can carry transparency (PNG alpha channel or tRNS). Not a pixel analysis. */
  mayHaveAlpha: z.boolean(),
});
export const ModelMetadata = z.object({
  gltfVersion: z.string(),
  generator: z.string().optional(),
  meshes: z.number().int().nonnegative(),
  materials: z.number().int().nonnegative(),
  textures: z.number().int().nonnegative(),
  animations: z.number().int().nonnegative(),
  extensionsRequired: z.array(z.string()),
});

export const AssetState = z.enum(['pending_upload', 'uploaded', 'validated', 'rejected', 'deleted']);

export const AssetSummary = z.object({
  id: z.string(),
  role: z.enum(['tracking-image', 'display-image', 'model', 'usdz-override', 'audio']),
  state: AssetState,
  filename: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  image: ImageMetadata.optional(),
  model: ModelMetadata.optional(),
  /** Human-readable advice (e.g. a small tracking image); never blocks use. */
  warnings: z.array(z.string()),
  rejectionCode: z.string().nullable(),
  createdAt: z.string(),
  /** Short-lived signed URL for private reads (validated assets only). Works without cookies (native viewers). */
  contentUrl: z.string().nullable(),
  contentUrlExpiresAt: z.string().nullable(),
});
export type AssetSummary = z.infer<typeof AssetSummary>;

/**
 * Where and how to send the bytes. Only `worker-stream` exists today; `presigned-put` (direct to R2) and
 * `multipart` are reserved so clients can switch strategies without a contract change (ADR-015, ADR-022).
 */
export const UploadTarget = z.object({
  strategy: z.enum(['worker-stream', 'presigned-put', 'multipart']),
  method: z.literal('PUT'),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
  maxBytes: z.number().int().positive(),
});
export type UploadTarget = z.infer<typeof UploadTarget>;

export const CreateUploadResponse = z.object({ asset: AssetSummary, upload: UploadTarget });
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

export const AssetListResponse = z.object({
  assets: z.array(AssetSummary),
  usage: z.object({ bytes: z.number().int().nonnegative(), quotaBytes: z.number().int().positive() }),
});
export type AssetListResponse = z.infer<typeof AssetListResponse>;

/** Rejection codes for uploaded files (`ApiError.reason` with code `invalid_file`, and `AssetSummary.rejectionCode`). */
export const FILE_REJECTIONS = [
  'signature_mismatch',
  'type_mismatch',
  'dimensions_out_of_range',
  'size_mismatch',
  'checksum_mismatch',
  'corrupt',
  'external_reference',
  'incomplete',
] as const;
export type FileRejection = (typeof FILE_REJECTIONS)[number];
