/**
 * Device identification for test evidence. Chromium's reduced User-Agent freezes Android to
 * "Android 10; K" and the Chrome version to "<major>.0.0.0" (observed in AND-IMG-01, 2026-11-14), so the
 * UA string alone cannot satisfy TESTING.md's recording protocol. User-Agent Client Hints
 * (`navigator.userAgentData.getHighEntropyValues`, secure contexts only) supply model, OS version and
 * full browser versions. Values are informational evidence only; never used for routing decisions.
 */
export interface UaDataLike {
  brands?: readonly { brand: string; version: string }[];
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
}
export interface NavigatorLike {
  userAgent: string;
  userAgentData?: UaDataLike | undefined;
}

export interface DeviceInfo {
  source: 'ua-client-hints' | 'user-agent-only';
  /** True when the UA string is Chromium's frozen/reduced form, i.e. it does not identify device/OS. */
  reducedUserAgent: boolean;
  platform?: string;
  platformVersion?: string;
  model?: string;
  mobile?: boolean;
  fullVersionList?: { brand: string; version: string }[];
  /** Human-readable reasons why fields are missing. */
  gaps: string[];
}

export const HIGH_ENTROPY_HINTS = ['model', 'platformVersion', 'fullVersionList'];

export function isReducedUserAgent(ua: string): boolean {
  return /Android 10; K\)/.test(ua) || /Chrome\/\d+\.0\.0\.0/.test(ua);
}

export async function collectDeviceInfo(nav: NavigatorLike, timeoutMs = 2000): Promise<DeviceInfo> {
  const reducedUserAgent = isReducedUserAgent(nav.userAgent);
  const gaps: string[] = [];
  const uad = nav.userAgentData;
  if (!uad || typeof uad.getHighEntropyValues !== 'function') {
    gaps.push('User-Agent Client Hints unavailable; record device model, Android version and Chrome version (chrome://version) manually.');
    return { source: 'user-agent-only', reducedUserAgent, gaps };
  }
  let hev: Record<string, unknown> = {};
  try {
    hev = await Promise.race([
      uad.getHighEntropyValues(HIGH_ENTROPY_HINTS),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
  } catch (e) {
    gaps.push(`High-entropy client hints failed (${String(e)}); record device details manually.`);
  }
  const info: DeviceInfo = { source: 'ua-client-hints', reducedUserAgent, gaps };
  if (typeof uad.platform === 'string') info.platform = uad.platform;
  if (typeof uad.mobile === 'boolean') info.mobile = uad.mobile;
  if (typeof hev.platformVersion === 'string' && hev.platformVersion) info.platformVersion = hev.platformVersion;
  if (typeof hev.model === 'string' && hev.model) info.model = hev.model;
  else gaps.push('Device model not reported; record it manually.');
  if (Array.isArray(hev.fullVersionList)) {
    info.fullVersionList = (hev.fullVersionList as { brand: unknown; version: unknown }[])
      .filter((b) => typeof b.brand === 'string' && typeof b.version === 'string' && !/Not.?A.?Brand/i.test(b.brand))
      .map((b) => ({ brand: b.brand as string, version: b.version as string }));
  }
  return info;
}
