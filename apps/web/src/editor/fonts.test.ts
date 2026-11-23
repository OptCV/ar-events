import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The editor and the scene compiler must draw text with the same font files (ADR-032). */
const root = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const sha = (p: string) => createHash('sha256').update(readFileSync(root(p))).digest('hex');

describe('bundled content font', () => {
  it('the web copy and the converter copy are identical and match their recorded checksums', () => {
    for (const f of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']) {
      const web = sha(`apps/web/public/fonts/${f}`);
      expect(web).toBe(sha(`services/usd-processor/fonts/${f}`));
      expect(readFileSync(root('services/usd-processor/fonts/SHA256SUMS'), 'utf8')).toContain(`${web} *${f}`);
    }
  });
});
