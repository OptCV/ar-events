# Phase 2 device checklist — Image-to-AR on real phones

**Purpose:** the Phase 2 gate (ROADMAP: "acceptance fixtures and native visual tests pass"). Every file opened here must be
**made by the product** on the dev environment, not by the P0 kit. Results go into TESTING.md → *Physical-device matrix*
(rows IOS-ALPHA-01, AND-ALPHA-01 and the P2-* rows below) and *Device results*. A case is **device verified** only when a
tester saw it on the phone; anything not observed stays NOT TESTED.

Target: `https://ar-creator-dev.quiet-dawn-af59.workers.dev` (dev Worker, Neon development, R2 `ar-creator-assets-dev`).

## 0. Before you start

### 0.1 How the phone opens the files

Sign in on the phone (Safari on iPhone, Chrome on Android) with the same account, open **Library → the image → Make AR
object**. The page shows the newest version; tap **View in AR** (ADR-026):

| Platform | What the button does |
|---|---|
| iPhone / iPad (Safari) | AR Quick Look with the USDZ (`<a rel="ar">`); Quick Look opens in AR, or Object view on devices without AR |
| Android (Chrome) | Scene Viewer with the GLB, **floor placement** (`mode=ar_preferred`). If it cannot start, the page reopens with "Scene Viewer could not start on this phone" |

Convert on a computer or on the phone, either works. Older versions are under "Earlier versions" (downloads only); to
view one in AR, convert again with the same settings — it is reused instantly and becomes the shown version. Requires
build **ADR-026 or later** on the dev Worker (redeploy after this change).

### 0.2 Record for each device (once per session)

| Field | Where to find it |
|---|---|
| Tester, date and time, room lighting (bright / dim; floor colour) | — |
| Device model, OS version | iOS: Settings → General → About. Android: Settings → About phone |
| Browser version | iOS: Safari = iOS version. Android: `chrome://version` (full version) |
| Viewer versions (Android) | Google app version and *Google Play Services for AR* version (Play Store → app page) |
| Product build | open `/api/health` on the dev site → `build` (the commit that added View in AR, or later) |

### 0.3 Inputs

Upload these as **display images** (Assets → Upload). All are committed; SHA-256 in `tests/fixtures/manifest.json` and
`tests/fixtures/normalize/SHA256SUMS`. Copy them to the phone, or upload from a desktop and open the page on the phone.

| Case | File | Settings to choose | Expected result note on the page |
|---|---|---|---|
| P2-STEPS | `images/alpha_steps.png` | Auto → **Blend**, 50 cm | — |
| P2-HOLE | `images/ring_inner_hole.png` | Auto → **Cutout**, 40 cm | — |
| P2-FRINGE | `images/aa_disc_dark_fringe.png` | Auto → **Blend**, 30 cm | — |
| P2-BORDER | `images/logo_transparent_border.png` | Auto → **Cutout**, 40 cm | — |
| P2-OPAQUE | `images/opaque_photo.jpg` | Auto → **Opaque**, 40 cm | — |
| P2-ORIENT | `images/orientation_probe.png` | Opaque, 60 cm, Standing up, Bottom edge, **Front only** | — |
| P2-SIDES | `images/orientation_probe.png` | same, but **Both sides** | — |
| P2-FLAT | `images/orientation_probe.png` | same, but **Lying flat**, Centre | — |
| P2-NPOT | `images/tall_npot.png`, `images/wide_npot.png` | Auto → Cutout, 70 cm / 90 cm | — |
| P2-WEBP | `normalize/disc_soft_alpha.webp` | Auto → **Blend**, 30 cm | "converted to PNG" |
| P2-ROTATED | `normalize/orientation_probe_exif6.jpg` | Opaque, 60 cm, Standing up, Bottom edge | "turned upright" |
| P2-BUDGET | `normalize/ring_4096.png` (4096 × 4096) | Auto → **Cutout**, 40 cm | "scaled down from 4096 × 4096 to 2048 × 2048 px" |

Use the default Bottom edge / Standing up / Front only unless the table says otherwise. Keep each object's page URL
(it holds the conversion id) for the Evidence column.

### 0.4 How to look

- Place on a **plain, light floor** for the fringe and steps cases, and a **patterned floor** (rug, tiles) for the hole
  case, so see-through areas are obvious.
- Do **not** pinch to resize before the size check. If you resize by accident, close and reopen the object.
- AR lighting tints colours; judge **transparency and shape**, not exact colour. Screenshot every case (power + volume up);
  screenshots show the real room, so only keep them if that is acceptable.

## 1. Transparency (gate: IOS-ALPHA-01 / AND-ALPHA-01)

Run on each platform. Fail = any visible rectangle, halo or wrong opacity.

- [ ] **P2-STEPS:** five green bands. Band 1 (0 %) completely invisible; bands 2–4 (20 / 50 / 80 %) show the floor through
      them, progressively less; band 5 (100 %) solid. **No grey, white or black rectangle** around the bands.
- [ ] **P2-HOLE:** the floor is visible **inside the ring's hole** and outside the ring; edges are crisp; nothing is drawn
      in the transparent areas (no rectangle, no outline of the quad).
- [ ] **P2-FRINGE:** a white disc with a smooth edge. **No dark ring or halo** at the edge, including when seen against a
      light floor and from 1–2 m away.
- [ ] **P2-BORDER:** the logo with nothing around it; no rectangle where the transparent border is.
- [ ] **P2-OPAQUE:** the whole photo is shown as a solid rectangle; no part is see-through.
- [ ] **P2-WEBP:** same as P2-FRINGE (this file went WebP → PNG in the converter container).
- [ ] Transparency looks the same from the front, at a steep angle and while walking around (BLEND sorting: note any
      flicker where see-through parts overlap the floor or each other).

## 2. Orientation, sides and shape

- [ ] **P2-ORIENT:** stands upright on the floor on its bottom edge (not floating, not sunk). Seen from the front:
      **red top-left, green top-right, blue bottom-left, yellow bottom-right, arrow points up**. Not mirrored.
- [ ] **P2-ORIENT back:** walk behind it — with Front only the back is **invisible**.
- [ ] **P2-SIDES:** from behind, the picture is visible and **mirrored** (red at top-right as seen from the back).
- [ ] **P2-FLAT:** lies flat on the floor, centred where you placed it. Record which way the arrow points relative to you
      when it first appears (iOS and Android may differ; not a fail by itself — needed for P4).
- [ ] **P2-NPOT:** tall strip and wide banner keep their proportions (not stretched or squashed); no rectangle in the
      transparent margins.

## 3. Real-world size

- [ ] **P2-SIZE:** using P2-ORIENT (60 cm wide, 40 cm tall), hold a tape measure next to it on the floor. Width **60 cm ± 3
      cm**, height **40 cm ± 2 cm**. iOS: Quick Look shows a scale percentage only after pinching — it must be unpinched.
      Android: Scene Viewer allows resizing by default — do not pinch. Record the measured values.

## 4. Milestone 8 inputs

- [ ] **P2-ROTATED:** the page said "turned upright"; on the phone it looks exactly like P2-ORIENT (red top-left, arrow up)
      — **not** lying on its side.
- [ ] **P2-BUDGET (2048 px):** opens without crash or reload of the browser; record the time from tap to the object
      appearing. The hole stays clear and the edge is not jagged when viewed from 1 m. Repeat once with two other apps
      open. A crash or "couldn't open" here means the 2048 px budget is wrong for this device — record the model.
- [ ] **P2-BUDGET sharpness:** compared with P2-HOLE (512 px original) at the same 40 cm size, it looks at least as sharp.

## 5. Fallbacks and honesty

- [ ] iOS on a device without AR (or Quick Look opened outside AR): the object view opens; no broken page.
- [ ] Android without the Google app / ARCore (if a device is available): the page reopens with "Scene Viewer could not
      start on this phone", no blank screen.
- [ ] On a computer the page shows "To see it in AR, open this page on an iPhone, iPad or Android phone" instead of the button.
- [ ] The page's note "not verified on a device yet" is still shown — it must stay until this checklist passes.

## 6. Recording

For each case fill the matrix row: `ID | device/OS | viewer + version | case | expected | PASS/FAIL/NOT TESTED | evidence`.
Evidence = object page URL, the settings line shown under Result (e.g. "40 cm × 40 cm · Cutout (auto) · standing · front only"),
screenshot name and measured values. Checksums of the GLB/USDZ can be looked up afterwards from the asset and its settings.
A failure needs: the case, what was seen, a screenshot, and whether it reproduces after closing and reopening.

**Gate passes** when sections 1–3 pass on at least one iPhone (Quick Look) and one ARCore Android phone (Scene Viewer),
and section 4 passes on both or has a recorded budget decision. Everything else is informative.

## Phase 5 — compiled scenes (test builds, ADR-034)

1. In the editor, **Test on device → Make a test build**; wait for "Ready to test on your phones."
2. Scan the QR code with the phone camera (or open the link). No sign-in is needed; the link works for 24 hours.
3. iPhone (Safari): **View in AR** → Quick Look. Check anchoring (floor: horizontal; wall: vertical; image: on the printed tracking image at the printed width shown on the page), every object at its editor position and size, text/panels readable, and the main button as Quick Look's banner — tapping it opens the link.
4. Android floor/wall (Chrome): **View in AR** → Scene Viewer. Same checks; the main button is Scene Viewer's link button. Image placement on Android waits for M17.
5. Record per case: device, OS, viewer, build id (in the URL), what was seen, screenshots.

### Android image placement (WebXR, M17)

1. Chrome on an ARCore phone; for tracking, enable chrome://flags → "WebXR Incubations" and relaunch (record the flag state).
2. Open the test link of an **image** build, check the three AR checks are ticked, print the tracking image at the width shown, tap **Start AR**.
3. Expect: status "Point your camera at the printed image" → "Image found"; the scene sits on the print as in the editor (ADR-005 H3 orientation: image top away from you), at its real size; on-screen buttons for every link (main first); tapping an object with a tap action runs it (show/hide, animation, link); hotspots show a blue marker and respond to taps; moving the print out of view shows "Image lost" and the scene hides; Exit AR returns to the page.
4. With the flag **off**: Start AR then "AR works, but this browser did not turn on image tracking" with the flag help (AND-IMG-02).
