# 🎯 Darts Counter

A browser app that turns a phone into an automatic darts scorer. Prop the phone up next to a standard
steel-tip board, tap four points to calibrate, and throw: the app spots each new dart in the camera
picture, finds its tip and scores it (single / double / treble / 25 / bull / miss), and keeps the
game: **501 · 301 (double-out, bust) · Cricket**, 1–4 players, undo, visit history and averages.

- **No install, no account.** It is a static web page. Android Chrome first, iOS Safari second.
- **Private.** All image processing happens on the phone. No frame ever leaves it, there is no
  server-side code, no analytics and no third-party CDN; a Content-Security-Policy only allows the page's
  own origin.
- **One tap to fix.** Tap any dart to correct it on a board picture (or tap its spot on the camera
  image). Corrections are logged on the device.

## Open it on the phone

**https://gleinkaa.github.io/darts-counter/** — open it in the phone's browser. That's all.

The camera only works on a secure (`https://`) page; GitHub Pages provides that. The page is static: it is
downloaded once and everything else happens on the phone.

### Self-hosting

`npm run build` writes a self-contained `dist/` with relative paths, so any HTTPS static host works.
`.github/workflows/pages.yml` deploys it to GitHub Pages on every push to `main`.

To serve it from your own machine, keep the servers on loopback (they never bind `0.0.0.0`) and put HTTPS in
front, for example with [Tailscale](https://tailscale.com/kb/1312/serve), which keeps it inside your tailnet:

```bash
npm ci && npm run build
npm run preview                                   # http://127.0.0.1:4173, loopback only
tailscale serve --bg --https=443 http://127.0.0.1:4173
tailscale serve status                            # shows https://<machine>.<tailnet>.ts.net/
```

Stop sharing with `tailscale serve --https=443 off`. For hot reload use `npm run dev` (port 5173) instead.
Both servers accept `*.ts.net` host names (`vite.config.ts`).

## Using it

1. **Set up the phone** 50–100 cm from the board, **30–50° off to the side or below** the board
   rather than straight in front. Darts are found from their side profile, so a head-on view is the
   weakest setup (see *Accuracy*). The whole double ring must be in the picture. Keep the phone still.
2. **Start camera** and allow camera access.
3. **Calibrate:** tap the outer edge of the double ring in the middle of **20, 6, 3 and 11**. A small
   board picture on screen shows which point comes next. Hold your finger down to get a magnifier and
   let go on the wire. The app then **snaps the calibration to the wires** (it measures about 200
   ring-edge and wire points) and draws the board's segments over the camera picture. If the lines sit
   on the wires, tap **Board empty — start**; otherwise drag a point to adjust it. If the snap fails,
   the button reads *Lines look right — start anyway*, so a rough calibration is never accepted
   silently. A camera almost straight in front of the board gets a warning. Calibrations are remembered
   separately for portrait and landscape, but every rotation comes back to this screen to confirm.
4. **Throw.** Each dart is scored about ⅓ s after it lands and marked on the picture. Three darts make
   a visit; a bust or a checkout ends it early. Darts thrown into a finished visit are not counted.
5. **Pull the darts.** When every dart is out and the board has stayed empty for about 0.7 s, the visit
   ends and the next player is up (*Darts pulled — Player 2 to throw*). Pulling after one or two darts
   ends the visit early. A dart that is pulled out or falls out mid-visit is recognised as a removal and
   is not counted. **Darts pulled ▸** ends a visit by hand, for darts the camera never saw.
   The pull only ends the visit its darts were scored in: if that visit was already ended with
   **Darts pulled ▸** while the darts were still in, pulling them later does not end the next
   player's visit. **Undo** right after a hand-over gives the board back to the previous player.
6. **Fix a dart:** tap it in the visit bar or in **History**, then tap the right segment on the board
   picture (or *Miss / 25 / Bull*, or *Tap position on camera*). **＋ Dart** enters a dart by hand,
   for example one that bounced out. **Undo** steps back one action at a time, including a visit change.

**Board check.** The camera compares every throw with the empty board it learned when you tapped
*Board empty — start*. A hand resting on the board is waited out: the status shows *View blocked*
and nothing is scored until it is gone. But if most of the board still looks different after about
5 s (a light switched on or off, the camera knocked), that empty board is no longer valid, and scoring
against it would invent darts. The camera then stops scoring and asks you to pull all darts out and tap
**Board is empty**; a finished visit is then handed over, an open one goes on. A plain exposure change
(the whole picture brighter or darker) is compensated and needs no check. Recalibrating or rotating the
phone with darts in the board asks for the same thing on the calibration screen (*Darts are out — start*).
A game is not restored after the page is reloaded, so a reload always starts at that confirmation too.

If camera access is denied, the app explains how to allow it and offers **Score by tapping instead**:
the same game with the board picker only.

## How it works

| step | module |
|---|---|
| WDF/PDC board geometry, point → score | `src/board.ts` |
| 4-point homography (Hartley-normalised DLT), inverse | `src/homography.ts` |
| camera pose from the homography (focal length + board normal) | `src/camera.ts` |
| dart detection by frame differencing | `src/detect.ts` |
| frame stream → "dart" / "darts pulled" / "blocked" events | `src/tracker.ts` |
| whose darts are in the board; what a pull hands over | `src/handover.ts` |
| game rules as a replayable event log (undo, corrections) | `src/game.ts` |
| UI | `src/main.ts`, `src/ui/*` |

Detection is small hand-written CV (no OpenCV):

1. Take the colour difference between the settled frame before the throw and the one after, with
   auto-exposure drift compensated and cast shadows suppressed (shadows darken every channel by about
   the same factor).
2. Threshold the difference and keep the largest connected component, the new dart. Fragments are merged
   back when the dart is cut in pieces by an earlier dart, or when its shaft blends into the background.
3. The flight holds most of the changed area. The tip is the far end of a thin, straight, continuous run
   (the shaft) leading out of it. A pose prior from the calibration says which way a dart standing at a
   given point must stick out of the board, which rules out flight corners and the stubs of older darts.
4. Fit a line to the barrel and point, then walk along it on the raw difference with a lower threshold,
   because the thin steel point is faint. Map the tip to the board with the inverse homography and score it.

## Accuracy

Measured on synthetic throws at the frame sizes the app actually processes (960×540 landscape, 540×960
portrait, plus a 4:3 stream). Every throw includes simulated calibration taps (σ 2 px) with the snap,
4:2:0 chroma subsampling, noise, lighting, shadows and overlapping darts. Seeds are held out from
development. These numbers are for the detector given clean before/after frames; fed through the
app's frame-stream tracker, a 120-throw probe scored 89.2 % (see "Detector only" in `docs/eval.md`).
The full table and failure list are in [`docs/eval.md`](docs/eval.md):

| set | throws | detected | score accuracy | 95 % CI | mean err mm | median | p90 | p95 | tip err < 3 mm |
|---|---|---|---|---|---|---|---|---|---|
| **landscape 960×540, oblique 25–55° (recommended)** | 480 | 99.2 % | **92.9 %** | 90.3–94.9 % | 1.52 | 0.60 | 2.61 | 4.25 | 91.5 % |
| … overlapping an earlier dart | 85 | 97.6 % | **85.9 %** | 76.9–91.7 % | 3.97 | 0.92 | 7.76 | 22.89 | 82.4 % |
| **portrait 540×960, oblique 25–55°** | 318 | 99.1 % | **91.5 %** | 87.9–94.1 % | 3.43 | 0.64 | 3.07 | 5.05 | 89.0 % |
| … overlapping an earlier dart | 47 | 97.9 % | **83.0 %** | 69.9–91.1 % | 11.85 | 0.67 | 35.22 | 117.05 | 78.7 % |
| **oblique, both orientations** | 798 | 99.1 % | **92.4 %** | 90.3–94.0 % | 2.28 | 0.61 | 2.71 | 4.41 | 90.5 % |
| 4:3 640×480, oblique | 162 | 98.8 % | **91.4 %** | 86.0–94.8 % | 3.31 | 0.55 | 3.59 | 5.69 | 86.4 % |
| landscape 960×540, near-front 0–20° (not recommended) | 162 | 99.4 % | **78.4 %** | 71.4–84.0 % | 9.13 | 1.06 | 33.25 | 42.40 | 65.4 % |
| *ablation: landscape oblique, first 120 throws, taps only (no snap)* | 120 | 98.3 % | **88.3 %** | 81.4–92.9 % | 2.75 | 2.11 | 4.13 | 5.02 | 77.5 % |
| *… the same throws with snap* | 120 | 98.3 % | **92.5 %** | 86.4–96.0 % | 1.67 | 0.65 | 3.03 | 4.25 | 88.3 % |

**Against the targets (tip error < 3 mm, score accuracy ≥ 95 %), honestly:** the median tip error (about 0.6 mm) is well under 3 mm, and
about 90 % of throws in the recommended setup land within 3 mm. Score accuracy is **92.9 % in landscape and
91.5 % in portrait, so the ≥ 95 % target is not met.** The upper ends of the 95 % CIs are 94.9 % and 94.1 %. Earlier,
easier versions of this eval reported 96.7 %. Those used full-chroma 640×480 frames, one turn per scene,
and seeds the detector had been tuned on.

Most failures are darts landing within 3 mm of a wire, where a sub-millimetre error flips the segment,
and darts partly hidden behind an earlier dart's flight. Faint steel points over lit cream segments, and
darts not found at all, account for the rest. [`docs/eval.md`](docs/eval.md) has the exact breakdown,
computed by the eval itself.

Snapping the calibration to the wires improves the same throws from 88 % to 92.5 %. A head-on camera is much
worse (78 %), and the app warns about it.

These are **synthetic** numbers (`synth/render.ts`), not field results. The renderer shares the app's
pinhole-camera assumptions and has no lens distortion, glare or worn board, so real boards will do
worse. A labelled real-photo test set is the next step (see *Limitations*).

### Accuracy ideas from the earlier plain-JS build, measured here

The earlier plain-JS build had three extra accuracy ideas. Each was measured against this app's own
eval and kept only where it helped:

1. **Tip averaged over the resting frames** — kept (already in `src/tracker.ts`, `REST_FRAMES = 4`). At
   the held-out eval's noise (σ 2–4.5) it is a wash: a paired 40-scene run flips 4 of 612 throws, the
   median tip-error shift is 0.03 mm, and the bucket accuracies move within noise. Through the
   frame-stream tracker it moves 105/120 → 107/120 (87.5 → 89.2 %). It is kept as a cheap
   outlier-rejection step — neutral, not harmful, at the app's operating point — rather than as a
   claimed accuracy win.
2. **Board crop at native resolution** — dropped. Measured with `node synth/crop-exp.ts` (whole frame vs a
   native-resolution board crop vs crop + re-snap). The app already processes at 960 px on the long side
   (twice the plain-JS app's 480 px), so a board-only crop gains only ~1.14 → 1.39 px/mm (22 %) instead
   of the plain-JS app's ~2×. Score accuracy is unchanged (79.8 → 79.8/80.0 %, 4 vs 4 throws flip), with
   only a smaller p90 tail (4.93 → 3.52 mm). Not worth the added pipeline complexity.
3. **Five-tap homography** — dropped. This app snaps the calibration to ~60–200 measured wire points,
   which re-fits the homography far more accurately than a fifth (bull) tap. A 5-tap calibration is
   identical to 4-tap + snap (1 of 612 throws flips, median tip-error shift 0.011 mm).

## Development

```bash
npm ci
npm test            # unit tests: geometry, homography, game rules, tracker, detection on synthetic frames
npm run eval        # held-out detection eval, ~1 000 synthetic throws → docs/eval.md   (~8 min)
npm run e2e         # build + fake-camera video + Playwright (system Chromium) + screenshots
npm run typecheck
```

`npm run e2e` drives the real app in Chromium with a fake camera that plays `e2e/fixtures/darts.y4m`
(made by `synth/make-video.ts`). The test calibrates, waits for three darts (T20, 5, Bull = 115) and
checks the score after the darts are pulled. Layout screenshots at 390×844 and 844×390 go to
`docs/screens/`. It uses `/usr/bin/chromium`; set `CHROME_PATH` to use another browser.

### Dependencies

The app has **no runtime dependencies**. Everything is development tooling:

| package | why |
|---|---|
| `vite` | dev server and production bundler (TypeScript → one small JS file) |
| `typescript`, `@types/node` | type checking; Node 26 runs the `.ts` scripts directly |
| `vitest` | unit tests |
| `@playwright/test` | browser end-to-end test with a fake camera |

## Limitations

- Validated on synthetic images only. Real boards add specular highlights, worn sisal, numbers on the
  ring, motion blur, lens distortion and compression artefacts. The renderer also draws wires centred on
  the nominal radii, while real radii are measured to the outside of the wire, so expect a systematic
  error of around 0.5 mm. A labelled real-photo set is the next step and needs real boards.
- A dart whose tip is hidden behind an earlier dart, as seen by the camera, is scored at the end of
  its visible part. One tap fixes it.
- Head-on camera placement is noticeably less accurate than an oblique one.
- A dart that bounces out never reaches the camera and has to be entered with **＋ Dart**.
- Moving the phone breaks the calibration. Recalibrate with **Calibrate**. Rotating it always asks again.
