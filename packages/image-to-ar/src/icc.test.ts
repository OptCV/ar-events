import { describe, expect, it } from 'vitest';
import { embeddedIccProfile, iccDescription, isSrgbProfile, needsColorConversion } from './icc.ts';
import { iccProfile, tagJpeg, taggedPng } from './iccFixture.ts';

const LINEAR = iccProfile('Linear RGB (test)', 1);
const SRGB_NAMED = iccProfile('sRGB IEC61966-2.1', 2.2);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI: enough for the marker walk

describe('ICC profile detection (ADR-039)', () => {
  it('reads the description and recognises sRGB by name and colour space', () => {
    expect(iccDescription(LINEAR)).toBe('Linear RGB (test)');
    expect(isSrgbProfile(LINEAR)).toBe(false);
    expect(isSrgbProfile(SRGB_NAMED)).toBe(true);
    expect(iccDescription(new Uint8Array(200))).toBeNull(); // no 'acsp' signature
  });

  it('PNG: inflates iCCP; an sRGB chunk or no tag needs no conversion', async () => {
    expect(await embeddedIccProfile(taggedPng(2, 2, [128, 128, 128], LINEAR))).toEqual(LINEAR);
    expect(await needsColorConversion(taggedPng(2, 2, [128, 128, 128], LINEAR))).toBe(true);
    expect(await needsColorConversion(taggedPng(2, 2, [128, 128, 128], SRGB_NAMED))).toBe(false);
    expect(await embeddedIccProfile(taggedPng(2, 2, [128, 128, 128], 'srgb'))).toBe('srgb');
    expect(await needsColorConversion(taggedPng(2, 2, [128, 128, 128], 'srgb'))).toBe(false);
    expect(await needsColorConversion(taggedPng(2, 2, [128, 128, 128], null))).toBe(false);
  });

  it('JPEG: joins APP2 ICC_PROFILE segments in sequence order', async () => {
    expect(await embeddedIccProfile(tagJpeg(JPEG, LINEAR, 3))).toEqual(LINEAR);
    expect(await needsColorConversion(tagJpeg(JPEG, LINEAR))).toBe(true);
    expect(await needsColorConversion(tagJpeg(JPEG, SRGB_NAMED))).toBe(false);
    expect(await needsColorConversion(JPEG)).toBe(false);
  });
});
