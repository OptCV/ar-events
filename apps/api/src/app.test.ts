import { describe, expect, it } from 'vitest';
import { ApiError, HealthResponse } from '@ar-creator/contracts';
import { createApp } from './app.ts';

const app = createApp({ version: '0.1.0', build: 'test-sha' });

describe('GET /api/health', () => {
  it('returns a contract-valid body with build info', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body).toMatchObject({ status: 'ok', service: 'ar-creator', version: '0.1.0', build: 'test-sha' });
    expect(body.runtime).toBe('other'); // Node test runner; workerd is asserted in the Playwright suites
  });

  it('is never cached and carries API security headers', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('errors', () => {
  it('unknown API routes return the JSON error contract', async () => {
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = ApiError.parse(await res.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('unexpected exceptions become a generic 500 without leaking internals', async () => {
    const boom = createApp({ version: 'x', build: 'y' });
    boom.get('/boom', () => {
      throw new Error('db password=hunter2 at /internal/path');
    });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      const res = await boom.request('/api/boom');
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('/internal/path');
      expect(ApiError.parse(JSON.parse(text)).error.code).toBe('internal');
      expect(errors).toHaveLength(1); // logged server-side once
    } finally {
      console.error = orig;
    }
  });

  it('paths outside /api are not handled by the API', async () => {
    const res = await app.request('/dashboard');
    expect(res.status).toBe(404);
  });
});
