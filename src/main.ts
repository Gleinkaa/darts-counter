// Darts Counter — app shell: setup, camera, calibration, play, corrections.
// Everything runs on the device: frames are read from the <video> into a canvas and never leave it.

import { CALIBRATION_POINTS, CALIBRATION_SECTORS, makeScore, scoreAt, scoreLabel, type Pt, type Score } from './board.ts';
import { checkoutHint, CRICKET_TARGETS, Game, type GameConfig, type GameEvent, type GameKind, type GameState } from './game.ts';
import { apply, fitHomography, invert, mul, type Mat3 } from './homography.ts';
import { poseFromHomography } from './camera.ts';
import { refineCalibration } from './refine.ts';
import { ThrowTracker, type TrackerEvent } from './tracker.ts';
import { boardSvg } from './ui/boardSvg.ts';
import { drawBoardOverlay, drawDartMarker } from './ui/overlay.ts';
import type { Img } from './img.ts';

const PROC_LONG = 960; // long side of the processing image (never upscaled); see docs/eval.md
const LS = {
  settings: 'darts.settings.v1',
  calib: 'darts.calibration.v1',
  corrections: 'darts.corrections.v1',
};

// ---------- tiny helpers ----------
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: settings just are not remembered */
  }
}
function toast(msg: string, ms = 2200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

interface Settings {
  kind: GameKind;
  start: number;
  doubleOut: boolean;
  players: string[];
  speak: boolean;
}
const DEFAULTS: Settings = { kind: 'x01', start: 501, doubleOut: true, players: ['Player 1'], speak: false };
function validSettings(v: Partial<Settings>): Settings {
  const players = Array.isArray(v.players) ? v.players.filter((p) => typeof p === 'string').slice(0, 4).map((p) => p.slice(0, 16)) : [];
  return {
    kind: v.kind === 'cricket' ? 'cricket' : 'x01',
    start: v.start === 301 ? 301 : 501,
    doubleOut: v.doubleOut !== false,
    players: players.length ? players : [...DEFAULTS.players],
    speak: v.speak === true,
  };
}
const settings: Settings = validSettings(load<Partial<Settings>>(LS.settings, DEFAULTS));

function say(text: string) {
  if (!settings.speak || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// ---------- camera ----------
interface Cam {
  video: HTMLVideoElement;
  stream: MediaStream;
  proc: HTMLCanvasElement;
  pctx: CanvasRenderingContext2D;
  pw: number;
  ph: number;
}
let cam: Cam | null = null;
let wakeLock: { released?: boolean; release(): Promise<void> } | null = null; // held while a game is on screen

let wakeRequest: Promise<void> | null = null;
function keepAwake(): Promise<void> {
  // One request at a time, so a sentinel is never overwritten without being released.
  wakeRequest ??= (async () => {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ released?: boolean; release(): Promise<void> }> } }).wakeLock;
      // The browser releases the lock whenever the page is hidden; a released sentinel must not block a new one.
      if (!wl || document.visibilityState !== 'visible' || (wakeLock && !wakeLock.released)) return;
      wakeLock = await wl.request('screen');
    } catch {
      /* not fatal: the screen may dim */
    } finally {
      wakeRequest = null;
    }
  })();
  return wakeRequest;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game) void keepAwake();
});

async function openCamera(): Promise<Cam> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true })!;
  const c: Cam = { video, stream, proc, pctx, pw: 0, ph: 0 };
  sizeProc(c);
  return c;
}

/** Processing size follows the stream's aspect ratio (it flips when the phone rotates). */
function sizeProc(c: Cam): boolean {
  const vw = c.video.videoWidth, vh = c.video.videoHeight;
  const k = Math.min(1, PROC_LONG / Math.max(vw, vh));
  const pw = Math.round(vw * k), ph = Math.round(vh * k);
  if (pw === c.pw && ph === c.ph) return false;
  c.pw = c.proc.width = pw;
  c.ph = c.proc.height = ph;
  return true;
}

function grab(c: Cam): Img {
  c.pctx.drawImage(c.video, 0, 0, c.pw, c.ph);
  return c.pctx.getImageData(0, 0, c.pw, c.ph);
}

function releaseWakeLock() {
  const wl = wakeLock;
  wakeLock = null;
  void wl?.release();
  // A request still in flight would land after this; release it when it does.
  void wakeRequest?.then(() => {
    if (!game) {
      void wakeLock?.release();
      wakeLock = null;
    }
  });
}

function cameraError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera access was denied. Allow the camera for this site (tap the lock or ⓘ icon in the address bar → Permissions → Camera), then tap “Try again”.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No usable camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is busy in another app. Close it and tap “Try again”.';
  if (name === 'InsecureContext')
    return 'The browser only allows the camera on a secure (https://) page. Open the app through its https:// address (see README: tailscale serve).';
  return `The camera could not be started (${esc(String((e as Error)?.message ?? e))}).`;
}

// ---------- geometry between processing pixels and the screen ----------
/** Similarity mapping processing px -> overlay canvas px for an object-fit: contain video. */
function viewMatrix(c: Cam, canvas: HTMLCanvasElement): { M: Mat3; k: number; ox: number; oy: number } {
  const W = canvas.width, Hh = canvas.height;
  const k = Math.min(W / c.pw, Hh / c.ph);
  const ox = (W - c.pw * k) / 2, oy = (Hh - c.ph * k) / 2;
  return { M: [k, 0, ox, 0, k, oy, 0, 0, 1], k, ox, oy };
}
function screenToProc(c: Cam, canvas: HTMLCanvasElement, ev: PointerEvent): Pt {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / r.width;
  const { k, ox, oy } = viewMatrix(c, canvas);
  return { x: ((ev.clientX - r.left) * dpr - ox) / k, y: ((ev.clientY - r.top) * dpr - oy) / k };
}

// ---------- calibration storage (one per stream size, i.e. per orientation) ----------
type CalibStore = Record<string, Pt[]>;
const calibKey = (c: Cam) => `${c.pw}x${c.ph}`;
function savedCalibration(c: Cam): Pt[] | null {
  const pts = load<CalibStore>(LS.calib, {})[calibKey(c)];
  return pts?.length === 4 ? pts : null;
}
function storeCalibration(c: Cam, pts: Pt[]) {
  const all = load<CalibStore>(LS.calib, {});
  all[calibKey(c)] = pts;
  save(LS.calib, all);
}

// ---------- app state ----------
let game: Game | null = null;
let tracker: ThrowTracker | null = null;
let H: Mat3 | null = null;
let calPts: Pt[] = [];
let loopTimer = 0;
let rafId = 0;
let placeDartFor: GameEvent | null = null; // dart awaiting a tap on the camera picture
let observers: ResizeObserver[] = [];
let manual = false; // scoring by tapping only, camera unused
let autoAdvancedAt = -1; // game.events.length right after the board reported "darts pulled"
let boardEmpty = true; // false from the first dart until the board is seen (or confirmed) empty again
let lastStatus = '';

const app = $('#app');

// =================================================================================
// Setup screen
// =================================================================================
function renderSetup() {
  stopLoops();
  releaseWakeLock();
  placeDartFor = null;
  game = null;
  tracker = null;
  stopCamera();
  const s = settings;
  app.innerHTML = `
  <main class="setup">
    <div>
      <h1>🎯 Darts Counter</h1>
      <p class="lead">Your phone watches the board and scores every dart. Nothing leaves the phone.</p>
    </div>
    <div class="field"><label>Game</label>
      <div class="seg" role="group" aria-label="Game">
        ${[['501', 'x01', 501], ['301', 'x01', 301], ['Cricket', 'cricket', 0]]
          .map(([l, k, st]) => `<button data-kind="${k}" data-start="${st}" aria-pressed="${s.kind === k && (k === 'cricket' || s.start === st)}">${l}</button>`)
          .join('')}
      </div>
    </div>
    <label class="toggle" ${s.kind === 'cricket' ? 'hidden' : ''}>Double out <input type="checkbox" id="dout" ${s.doubleOut ? 'checked' : ''}></label>
    <div class="field"><label>Players</label>
      <div class="seg" role="group" aria-label="Number of players">
        ${[1, 2, 3, 4].map((n) => `<button data-n="${n}" aria-pressed="${s.players.length === n}">${n}</button>`).join('')}
      </div>
      <div class="players">${s.players.map((p, i) => `<input aria-label="Player ${i + 1} name" data-i="${i}" value="${esc(p)}" maxlength="16">`).join('')}</div>
    </div>
    <label class="toggle">Speak scores <input type="checkbox" id="speak" ${s.speak ? 'checked' : ''}></label>
    <div class="tips">
      <b>Setup:</b> prop the phone 50–100 cm from the board, ideally <b>30–50° off to the side or below</b>
      (not straight in front — the darts must be seen from the side). The whole double ring must be in view.
      Keep the phone still while playing.
    </div>
    <div class="actions">
      <div class="row"><button class="btn primary" id="go" data-testid="start">Start camera</button><button class="btn ghost" id="manual">Play without camera</button></div>
    </div>
  </main>`;
  app.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => {
      s.kind = b.dataset.kind as GameKind;
      if (s.kind === 'x01') s.start = Number(b.dataset.start);
      save(LS.settings, s);
      renderSetup();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-n]').forEach((b) =>
    b.addEventListener('click', () => {
      const n = Number(b.dataset.n);
      s.players = Array.from({ length: n }, (_, i) => s.players[i] ?? `Player ${i + 1}`);
      save(LS.settings, s);
      renderSetup();
    }),
  );
  app.querySelectorAll<HTMLInputElement>('.players input').forEach((inp) =>
    inp.addEventListener('input', () => {
      s.players[Number(inp.dataset.i)] = inp.value.trim() || `Player ${Number(inp.dataset.i) + 1}`;
      save(LS.settings, s);
    }),
  );
  $<HTMLInputElement>('#dout')?.addEventListener('change', (e) => {
    s.doubleOut = (e.target as HTMLInputElement).checked;
    save(LS.settings, s);
  });
  $<HTMLInputElement>('#speak').addEventListener('change', (e) => {
    s.speak = (e.target as HTMLInputElement).checked;
    save(LS.settings, s);
    if (s.speak) say('Scores will be spoken');
  });
  $('#go').addEventListener('click', () => void startCamera());
  $('#manual').addEventListener('click', () => {
    manual = true;
    newGame();
    renderPlay();
  });
}

/** Turn the camera off (and its indicator light) while it is not used. */
function stopCamera() {
  cam?.stream.getTracks().forEach((t) => t.stop());
  cam = null;
}

function newGame() {
  void keepAwake();
  autoAdvancedAt = -1;
  winnerShown = false;
  const cfg: GameConfig = { kind: settings.kind, start: settings.start, doubleOut: settings.doubleOut, players: [...settings.players] };
  game = new Game(cfg);
}

async function startCamera() {
  try {
    cam ??= await openCamera();
  } catch (e) {
    renderCameraError(e);
    return;
  }
  manual = false;
  void keepAwake();
  if (!game) newGame(); // coming from tap-only scoring keeps the running game
  const saved = savedCalibration(cam);
  calPts = saved ? [...saved] : [];
  renderCalibrate();
}

function renderCameraError(e: unknown) {
  app.innerHTML = `
  <div class="error" role="alert">
    <h2>Camera unavailable</h2>
    <p>${cameraError(e)}</p>
    <div class="row"><button class="btn primary" id="retry">Try again</button></div>
    <div class="row"><button class="btn" id="manual">Score by tapping instead</button></div>
    <div class="row"><button class="btn ghost" id="back">Back</button></div>
  </div>`;
  $('#retry').addEventListener('click', () => void startCamera());
  $('#manual').addEventListener('click', () => {
    manual = true;
    if (!game) newGame();
    renderPlay();
  });
  $('#back').addEventListener('click', () => {
    if (game?.events.length) {
      manual = true;
      renderPlay();
    } else renderSetup();
  });
}

// =================================================================================
// Shared camera view (video + overlay canvas)
// =================================================================================
function mountCamera(host: HTMLElement): HTMLCanvasElement {
  host.prepend(cam!.video);
  const canvas = document.createElement('canvas');
  canvas.className = 'overlay';
  host.append(canvas);
  const fit = () => {
    const r = host.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(host);
  observers.push(ro);
  return canvas;
}

function stopLoops() {
  observers.forEach((o) => o.disconnect());
  observers = [];
  clearInterval(loopTimer);
  cancelAnimationFrame(rafId);
  loopTimer = 0;
  rafId = 0;
}

/**
 * Re-check the stream size. Rotating a phone on a stand moves the camera, so a rotation always goes back
 * to calibration (pre-filled with this orientation's saved taps) and needs the user's OK again.
 */
function checkRotation(): boolean {
  if (!cam || !sizeProc(cam)) return false;
  const saved = savedCalibration(cam);
  calPts = saved ? [...saved] : [];
  H = null;
  toast(saved ? 'Camera rotated — check the calibration' : 'Camera rotated — please calibrate this orientation');
  renderCalibrate();
  return true;
}

// =================================================================================
// Calibration
// =================================================================================
/** Angle between the line of sight to the board centre and the board normal, degrees. */
function viewingAngleDeg(Hm: Mat3, w: number, h: number): number {
  const P = poseFromHomography(Hm, w, h);
  const n = Math.hypot(...P.t);
  const cos = Math.abs(P.r3[0] * P.t[0] + P.r3[1] * P.t[1] + P.r3[2] * P.t[2]) / n;
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

function renderCalibrate() {
  stopLoops();
  const c = cam!;
  app.innerHTML = `
  <div class="stage">
    <div class="cam" id="cam" data-testid="camera">
      <div class="banner" id="banner"></div>
      <canvas class="loupe" id="loupe" width="140" height="140"></canvas>
    </div>
    <div class="panel">
      <div class="status"><span id="calinfo"></span></div>
      <div class="row">
        <button class="btn" id="undo">Undo point</button>
        <button class="btn" id="reset">Reset</button>
      </div>
      <div class="row"><button class="btn primary" id="ok" data-testid="calib-ok" disabled>Board empty — start</button></div>
      <div class="row"><button class="btn ghost" id="back">Back</button></div>
    </div>
  </div>`;
  const host = $('#cam');
  const canvas = mountCamera(host);
  const ctx = canvas.getContext('2d')!;
  const loupe = $<HTMLCanvasElement>('#loupe');
  const lctx = loupe.getContext('2d')!;
  let drag: { i: number } | null = null;
  let live: Pt | null = null;

  let snap = '';
  let snapped = false;
  const update = (refine = true) => {
    H = null;
    snap = '';
    snapped = false;
    if (calPts.length === 4) {
      try {
        H = fitHomography(CALIBRATION_POINTS, calPts);
      } catch {
        snap = '⚠ points too close together or in a line — undo and tap again';
      }
    }
    if (H && refine) {
      // Snap to the wires: finger taps are only good to a few pixels.
      const r = refineCalibration(grab(c), H, CALIBRATION_POINTS);
      H = r.H;
      snapped = r.ok;
      snap = r.ok ? `✓ snapped to the wires (${r.used} edge points)` : '⚠ could not snap to the wires — check the lines by eye';
      const view = viewingAngleDeg(H, c.pw, c.ph);
      if (view < 15) snap += ` · ⚠ camera is almost straight in front of the board (${Math.round(view)}°): move it 30–50° to the side for reliable scoring`;
    }
    const i = calPts.length;
    const banner = $('#banner');
    if (i < 4) {
      const where = ['top', 'right', 'bottom', 'left'][i];
      banner.innerHTML = `${boardSvg({ calibrationIndex: i })}<div>Tap the <b>outer edge of the double ring</b> in the middle of <b>${CALIBRATION_SECTORS[i]}</b> (${where}). <span style="color:var(--muted)">Hold to zoom.</span></div>`;
    } else {
      banner.innerHTML = `<div>Check the overlay lines sit on the wires. Drag a point to adjust.</div>`;
    }
    $('#calinfo').textContent = i < 4 ? `${i} / 4 points` : snap;
    const ok = $<HTMLButtonElement>('#ok');
    ok.disabled = !H;
    // The confirmed frame becomes the empty-board reference, so darts still in the board (after a
    // rotation or a mid-game recalibration) must come out first; say so on the button itself.
    const dartsIn = !!game && (!boardEmpty || game.state.visit.darts.length > 0);
    if (dartsIn && i >= 4) $('#calinfo').textContent = `⚠ Pull all darts out first: the board must be empty. ${snap}`;
    // Without a successful snap the user must explicitly accept the rough calibration.
    ok.textContent = dartsIn
      ? 'Darts are out — start'
      : !H || snapped
        ? 'Board empty — start'
        : 'Lines look right — start anyway';
  };

  const showLoupe = (p: Pt, ev: PointerEvent) => {
    const r = host.getBoundingClientRect();
    loupe.style.display = 'block';
    loupe.style.left = `${Math.min(r.width - 150, Math.max(10, ev.clientX - r.left - 70))}px`;
    loupe.style.top = `${Math.max(10, ev.clientY - r.top - 190)}px`;
    const z = 4;
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = '#000';
    lctx.fillRect(0, 0, 140, 140);
    lctx.drawImage(c.proc, p.x - 70 / z, p.y - 70 / z, 140 / z, 140 / z, 0, 0, 140, 140);
    lctx.strokeStyle = '#ff2d55';
    lctx.lineWidth = 1.5;
    lctx.beginPath();
    lctx.moveTo(70, 52); lctx.lineTo(70, 88); lctx.moveTo(52, 70); lctx.lineTo(88, 70);
    lctx.stroke();
  };

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    const p = screenToProc(c, canvas, ev);
    const { k } = viewMatrix(c, canvas);
    const near = calPts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) * k < 36);
    if (near >= 0) drag = { i: near };
    else if (calPts.length < 4) live = p;
    else return;
    grab(c);
    showLoupe(p, ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag && !live) return;
    const p = screenToProc(c, canvas, ev);
    if (drag) calPts[drag.i] = { x: Math.min(c.pw, Math.max(0, p.x)), y: Math.min(c.ph, Math.max(0, p.y)) };
    else live = p;
    showLoupe(p, ev);
    update(false);
  });
  const end = (ev: PointerEvent) => {
    if (live && ev.type === 'pointerup') {
      const p = screenToProc(c, canvas, ev);
      if (p.x >= 0 && p.y >= 0 && p.x < c.pw && p.y < c.ph) calPts.push(p);
      else toast('Tap on the camera picture');
    }
    live = null;
    drag = null;
    loupe.style.display = 'none';
    update();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  $('#undo').addEventListener('click', () => {
    calPts.pop();
    update();
  });
  $('#reset').addEventListener('click', () => {
    calPts = [];
    update();
  });
  $('#back').addEventListener('click', () => {
    // Leaving calibration must not throw away a game in progress: keep scoring by tapping.
    if (game?.events.length) {
      manual = true;
      tracker = null;
      stopCamera(); // "Camera" then reopens it through startCamera(), which leaves tap-only mode
      renderPlay();
      toast('Scoring by tapping — tap Camera to calibrate again');
    } else renderSetup();
  });
  $('#ok').addEventListener('click', () => {
    storeCalibration(c, calPts);
    tracker = null;
    manual = false;
    boardEmpty = true; // the user has just confirmed it
    // "Darts are out" also ends a finished visit, as the board seeing them pulled would have.
    if (game?.state.visitClosed && game.next()) {
      autoAdvancedAt = game.events.length;
      announceVisit();
    }
    renderPlay();
  });

  const draw = () => {
    if (checkRotation()) return; // re-rendered for the new orientation
    const { M } = viewMatrix(c, canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (H) drawBoardOverlay(ctx, mul(M, H), { color: '#00e5ff', alpha: 0.9, lineWidth: 2 });
    const pts = live ? [...calPts, live] : calPts;
    pts.forEach((p, i) => {
      const q = apply(M, p);
      drawDartMarker(ctx, q, String(CALIBRATION_SECTORS[i] ?? ''), { color: '#ff2d55' });
    });
    rafId = requestAnimationFrame(draw);
  };
  update();
  rafId = requestAnimationFrame(draw);
}

// =================================================================================
// Play
// =================================================================================
function renderPlay() {
  stopLoops();
  const withCam = !manual && !!cam && !!H;
  placeDartFor = null;
  app.innerHTML = `
  <div class="stage">
    ${withCam ? `<div class="cam" id="cam" data-testid="camera"><div class="big-dart" id="bigdart" aria-live="polite"></div></div>` : ''}
    <div class="panel" ${withCam ? '' : 'style="flex:1"'}>
      <div class="players-board" id="players" data-testid="players"></div>
      <div class="visit" id="visit" data-testid="visit"></div>
      <div class="status"><span id="status" data-testid="status"></span><span class="hint" id="hint"></span></div>
      <div class="controls">
        <button class="btn" id="undo" data-testid="undo">Undo</button>
        <button class="btn" id="add">＋ Dart</button>
        <button class="btn warn wide" id="next" data-testid="next">Darts pulled ▸</button>
        <button class="btn ghost" id="hist">History</button>
        <button class="btn ghost" id="recal">${withCam ? 'Calibrate' : 'Camera'}</button>
        <button class="btn ghost wide" id="menu">New game</button>
      </div>
    </div>
  </div>`;

  $('#undo').addEventListener('click', () => {
    placeDartFor = null;
    const ev = game!.undo();
    if (!ev) toast('Nothing to undo');
    refresh();
  });
  $('#add').addEventListener('click', () => openPicker(null));
  $('#next').addEventListener('click', () => {
    placeDartFor = null;
    const st = game!.state;
    // The board already reported "pulled" and moved on: a second tap must not skip the next player.
    if (!st.visit.darts.length && !st.visitClosed && game!.events.length === autoAdvancedAt) {
      toast(`Already ${st.players[st.current].name}'s turn`);
      return;
    }
    game!.next(true);
    if (tracker && cam) tracker.resync(grab(cam)); // never replaces the empty-board reference
    announceVisit();
    refresh();
  });
  $('#hist').addEventListener('click', openHistory);
  $('#recal').addEventListener('click', () => (cam ? renderCalibrate() : void startCamera()));
  $('#menu').addEventListener('click', () => {
    if (game!.events.length && !confirm('Abandon this game?')) return;
    renderSetup();
  });

  if (withCam) startTracking();
  refresh();
}

function startTracking() {
  const c = cam!;
  const host = $('#cam');
  const canvas = mountCamera(host);
  const ctx = canvas.getContext('2d')!;
  tracker = new ThrowTracker(H!, c.pw, c.ph);
  tracker.resetWhenStill();
  setStatus('Ready — throw!');

  canvas.addEventListener('click', (ev) => {
    // Tap on the camera picture: place a dart there (correction mode) or ask what to do.
    if (!H) return;
    const p = invert(H) && apply(invert(H), screenToProc(c, canvas, ev as PointerEvent));
    const s = scoreAt(p.x, p.y);
    if (placeDartFor !== null) {
      const idx = game!.events.indexOf(placeDartFor); // the dart may have been undone meanwhile
      placeDartFor = null;
      if (idx < 0) return toast('That dart no longer exists');
      game!.correct(idx, s, p);
      logCorrection();
      toast(`Corrected to ${scoreLabel(s)}`);
      refresh();
    }
  });

  const t0 = performance.now();
  loopTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible' || c.video.readyState < 2) return;
    if (checkRotation()) return;
    const events = tracker!.feed(grab(c), performance.now() - t0);
    events.forEach(onTrackerEvent);
  }, 100);

  const draw = () => {
    const { M } = viewMatrix(c, canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (H) {
      const HM = mul(M, H);
      drawBoardOverlay(ctx, HM, { color: '#00e5ff', alpha: 0.25, lineWidth: 1 });
      game!.state.visit.darts.forEach((d) => {
        const ev = game!.events[d.event];
        if (ev.type === 'dart' && ev.point) drawDartMarker(ctx, apply(HM, ev.point), d.label, { color: d.auto ? '#27c46b' : '#ffb02e' });
      });
    }
    rafId = requestAnimationFrame(draw);
  };
  rafId = requestAnimationFrame(draw);
}

function onTrackerEvent(e: TrackerEvent) {
  const g = game!;
  if (e.type === 'busy') setStatus('Hand in view…');
  else if (e.type === 'removed') setStatus('Dart pulled out — not counted');
  else if (e.type === 'nodart') {
    boardEmpty = false; // maybe a dart the detector missed: warn before it becomes the empty board
    setStatus('Change seen but no dart found — use ＋ Dart if one landed');
  }
  else if (e.type === 'empty') {
    boardEmpty = true;
    if (g.next()) {
      autoAdvancedAt = g.events.length;
      announceVisit();
      setStatus('Darts pulled — next player');
    } else setStatus('Ready — throw!');
  } else if (e.type === 'dart') {
    const s = scoreAt(e.board.x, e.board.y);
    boardEmpty = false;
    if (!g.addDart(s, true, e.board)) {
      setStatus('Visit complete — pull the darts');
      return;
    }
    flashDart(scoreLabel(s));
    say(s.ring === 'miss' ? 'miss' : spoken(s));
    const st = g.state;
    setStatus(st.visitClosed ? 'Visit complete — pull the darts' : `Dart ${st.visit.darts.length} — ${scoreLabel(s)}`);
  }
  refresh();
}

function spoken(s: Score): string {
  if (s.ring === 'bull') return 'bull';
  if (s.ring === 'outer-bull') return '25';
  return `${s.multiplier === 3 ? 'treble ' : s.multiplier === 2 ? 'double ' : ''}${s.sector}`;
}

function announceVisit() {
  const st = game!.state;
  const v = st.history.at(-1);
  if (!v) return;
  if (st.winner !== null) say(`Game shot! ${st.players[st.winner].name} wins`);
  else if (v.bust) say('Bust');
  else if (st.config.kind === 'x01') say(String(v.total));
}

function flashDart(label: string) {
  const el = document.getElementById('bigdart');
  if (!el) return;
  el.textContent = label;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1400);
}

function setStatus(s: string) {
  lastStatus = s;
  const el = document.getElementById('status');
  if (el) el.textContent = s;
}

function refresh() {
  const st = game!.state;
  renderPlayers(st);
  renderVisit(st);
  setStatus(lastStatus);
  const hint = document.getElementById('hint');
  if (hint) {
    const p = st.players[st.current];
    const h = st.config.kind === 'x01' && st.config.doubleOut && !st.visitClosed ? checkoutHint(p.score, 3 - st.visit.darts.length) : null;
    hint.textContent = h ?? '';
  }
  if (st.winner !== null) showWinner(st);
  else winnerShown = false; // e.g. the sheet was dismissed, then Undo
  if (game!.events.length < autoAdvancedAt) autoAdvancedAt = -1; // undone past the auto-advance
}

function renderPlayers(st: GameState) {
  const el = document.getElementById('players');
  if (!el) return;
  el.innerHTML = st.players
    .map((p, i) => {
      const marks =
        st.config.kind === 'cricket'
          ? `<div class="marks">${CRICKET_TARGETS.map((t) => `${t === 25 ? 'B' : t}${['·', '/', '✕', 'Ⓧ'][p.marks[t]]}`).join(' ')}</div>`
          : '';
      return `<div class="pcard ${i === st.current ? 'active' : ''}" data-testid="player-${i}">
        <div class="name">${esc(p.name)}</div>
        <div class="score" data-testid="score-${i}">${p.score}</div>
        <div class="avg">${st.config.kind === 'x01' ? `avg ${p.average.toFixed(1)}` : `MPR ${p.average.toFixed(2)}`}</div>${marks}
      </div>`;
    })
    .join('');
}

function renderVisit(st: GameState) {
  const el = document.getElementById('visit');
  if (!el) return;
  const v = st.visit;
  const slots = [0, 1, 2]
    .map((i) => {
      const d = v.darts[i];
      return d
        ? `<button class="slot filled ${d.auto ? '' : 'manual'}" data-ev="${d.event}" data-testid="dart-${i}" aria-label="Dart ${i + 1}: ${d.label}. Tap to correct">${d.label}<small>${d.auto ? 'tap to fix' : 'manual'}</small></button>`
        : `<div class="slot" data-testid="dart-${i}" aria-label="Dart ${i + 1}: not thrown"></div>`;
    })
    .join('');
  el.innerHTML = `${slots}<div class="slot total ${v.bust ? 'bust' : ''}" data-testid="visit-total">${v.bust ? 'BUST' : v.total}</div>`;
  el.querySelectorAll<HTMLElement>('[data-ev]').forEach((b) => b.addEventListener('click', () => openPicker(Number(b.dataset.ev))));
}

// =================================================================================
// Sheets: segment picker (add / correct), history, winner
// =================================================================================
function sheet(html: string): { root: HTMLElement; close: () => void } {
  const back = document.createElement('div');
  back.className = 'sheet-back';
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(back);
  const close = () => back.remove();
  back.addEventListener('click', (e) => e.target === back && close());
  return { root: back, close };
}

/** event = index of the dart to correct, or null to add a dart by hand. */
function openPicker(event: number | null) {
  placeDartFor = null; // a pending "tap on camera" correction is cancelled by any picker
  const g = game!;
  const cur = event !== null ? g.events[event] : null;
  const curScore = cur?.type === 'dart' ? cur.score : null;
  const { root, close } = sheet(`
    <h2>${event === null ? 'Add a dart' : `Correct ${curScore ? scoreLabel(curScore) : ''}`}</h2>
    <div class="picker-wrap" data-testid="picker">${boardSvg({ highlight: curScore && curScore.ring !== 'miss' ? curScore : null })}</div>
    <div class="row">
      <button class="btn" data-q="miss">Miss</button>
      <button class="btn" data-q="outer-bull">25</button>
      <button class="btn" data-q="bull">Bull</button>
    </div>
    ${event !== null && cam && H ? '<div class="row"><button class="btn" id="oncam">Tap position on camera</button></div>' : ''}
    <div class="row"><button class="btn ghost" id="cancel">Cancel</button></div>`);
  const commit = (s: Score) => {
    if (event === null) {
      if (g.addDart(s, false)) boardEmpty = false;
      else toast('This visit is complete — tap “Darts pulled”');
    } else if (g.events[event]?.type === 'dart') {
      g.correct(event, s);
      logCorrection();
    }
    close();
    refresh();
  };
  const svg = root.querySelector('svg')!;
  svg.addEventListener('click', (ev) => {
    const m = svg.getScreenCTM();
    if (!m) return;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    commit(scoreAt(pt.x, -pt.y));
  });
  root.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => b.addEventListener('click', () => commit(makeScore(b.dataset.q as Score['ring']))));
  root.querySelector('#cancel')!.addEventListener('click', close);
  root.querySelector('#oncam')?.addEventListener('click', () => {
    placeDartFor = event !== null ? g.events[event] : null;
    close();
    toast('Tap where the dart is on the camera picture');
  });
}

function logCorrection() {
  const c = game!.corrections.at(-1);
  if (!c) return;
  const log = load<unknown[]>(LS.corrections, []);
  log.push(c);
  save(LS.corrections, log.slice(-500));
}

function openHistory() {
  const st = game!.state;
  const rows = st.history
    .map((v, i) => ({ v, i }))
    .reverse()
    .map(
      ({ v, i }) => `<div class="v"><span>${i + 1}. ${esc(st.players[v.player].name)}: ${v.darts
        .map((d) => `<button data-ev="${d.event}">${d.label}</button>`)
        .join(' ')}</span><b>${v.bust ? 'bust' : v.total}</b></div>`,
    )
    .join('');
  const avgs = st.players.map((p) => `${esc(p.name)} ${st.config.kind === 'x01' ? `avg ${p.average.toFixed(1)}` : `MPR ${p.average.toFixed(2)}`} · ${p.dartsThrown} darts`).join('<br>');
  const { root, close } = sheet(`<h2>History</h2><div class="tips">${avgs}</div>
    <div class="history">${rows || '<span style="color:var(--muted)">No visits yet.</span>'}</div>
    <div class="row"><button class="btn ghost" id="close">Close</button></div>`);
  root.querySelector('#close')!.addEventListener('click', close);
  root.querySelectorAll<HTMLButtonElement>('[data-ev]').forEach((b) =>
    b.addEventListener('click', () => {
      close();
      openPicker(Number(b.dataset.ev));
    }),
  );
}

let winnerShown = false;
function showWinner(st: GameState) {
  if (winnerShown) return;
  winnerShown = true;
  const w = st.players[st.winner!];
  const { root, close } = sheet(`<h2>🏆 ${esc(w.name)} wins!</h2>
    <div class="tips">${st.players.map((p) => `${esc(p.name)}: ${st.config.kind === 'x01' ? `avg ${p.average.toFixed(1)}` : `${p.score} pts`}`).join('<br>')}</div>
    <div class="row"><button class="btn" id="undo">Undo last dart</button><button class="btn primary" id="again">New leg</button></div>`);
  root.querySelector('#again')!.addEventListener('click', () => {
    close();
    winnerShown = false;
    placeDartFor = null;
    newGame();
    if (tracker && cam) tracker.resync(grab(cam));
    refresh();
  });
  root.querySelector('#undo')!.addEventListener('click', () => {
    close();
    winnerShown = false;
    game!.undo();
    refresh();
  });
}

renderSetup();
