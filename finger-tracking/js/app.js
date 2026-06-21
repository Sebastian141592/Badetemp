import { HandLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { PointFilter } from "./euro.js";
import { analyzeHand, classifyGesture } from "./gestures.js";
import { DesktopBridge } from "./bridge.js";
import { BubbleGame } from "./game.js";

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");
const cursorEl = $("cursor");
const hint = $("hint");

const ui = {
  start: $("startBtn"), stop: $("stopBtn"),
  statusDot: $("statusDot"), statusText: $("statusText"),
  fps: $("fps"), hands: $("hands"), gesture: $("gesture"),
  gain: $("gain"), smooth: $("smooth"), pinch: $("pinch"),
  mirror: $("mirror"), showLandmarks: $("showLandmarks"),
  bridgeUrl: $("bridgeUrl"), bridgeBtn: $("bridgeBtn"), bridgeStatus: $("bridgeStatus"),
  gameBtn: $("gameBtn"),
};

// ---- Test game ----
const game = new BubbleGame({
  layer: $("gameLayer"),
  scoreEl: $("gameScore"),
  timeEl: $("gameTime"),
  bestEl: $("gameBest"),
  resultEl: $("gameResult"),
  finalEl: $("gameFinal"),
});

// ---- State ----
let landmarker = null;
let stream = null;
let running = false;
let rafId = null;
let lastVideoTime = -1;
let fpsEMA = 0;
let lastFrameT = performance.now();
let lastNewFrameT = 0;     // when the video last produced a fresh frame
let wakeLock = null;       // Screen Wake Lock sentinel (keeps display awake)
let watchdogTimer = null;  // periodic stall detector
let recovering = false;

const pointFilter = new PointFilter({ minCutoff: 1.5, beta: 0.02, dCutoff: 1.0 });
const bridge = new DesktopBridge();

// Gesture state machine
const state = {
  gesture: "idle",
  pinchDown: false,
  rightDown: false,
  lastClickT: 0,
  scrollAnchorY: null,
  cursor: { x: 0.5, y: 0.5 },       // normalised, post-gain (current frame)
  preFrameCursor: { x: 0.5, y: 0.5 }, // cursor from before this frame (pre pinch-jump)
  pinchAnchor: null,                // frozen cursor captured when a pinch begins
  dragging: false,                  // true once the hand moves enough while pinched
};

// How far the hand must move (normalised screen units) while pinched before we
// treat it as a drag instead of a stationary click. Keeps clicks rock-steady.
const DRAG_DEADZONE = 0.045;

// Keep the cursor/gesture alive through brief detection gaps (ms).
const HAND_GRACE_MS = 350;
let lastHandT = 0;

// ---- Connections (lines) between landmarks for drawing the skeleton ----
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17],
];

function setStatus(text, kind) {
  ui.statusText.textContent = text;
  ui.statusDot.className = "dot" + (kind ? " " + kind : "");
}

// ---- Model load ----
async function loadModel() {
  setStatus("Laster modell…");
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  const options = {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    // Track a single hand: half the work (much steadier + lighter on phones)
    // and the app only ever controls with one hand anyway.
    numHands: 1,
    // Detect at a normal bar, but hold onto an already-tracked hand through
    // brief blur/occlusion so tracking doesn't keep dropping out.
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
  };
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, options);
  } catch (e) {
    // Some mobile GPUs/WebGL contexts are flaky — fall back to CPU so it still runs.
    console.warn("GPU delegate failed, falling back to CPU", e);
    options.baseOptions.delegate = "CPU";
    landmarker = await HandLandmarker.createFromOptions(fileset, options);
  }
}

// ---- Camera ----
// Lower resolution + capped framerate keeps memory/thermal/GPU load down on
// phones, which is what stops iOS from muting (dropping) the camera stream.
const CAM_CONSTRAINTS = {
  video: {
    facingMode: "user",
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30, max: 30 },
  },
  audio: false,
};

// Keep the screen from sleeping while tracking (gestures aren't touches, so iOS
// would otherwise dim/lock the display and pause the camera after a short while).
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (_) { /* not supported / not allowed — watchdog still recovers */ }
}
async function releaseWakeLock() {
  try { if (wakeLock) await wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

// If the camera track ends or the video gets paused, recover instead of dying.
function attachStreamHandlers() {
  const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
  if (track) {
    track.onended = () => { if (running) recoverCamera(true); };
    // iOS mutes the track on interruption; it often un-mutes by itself, so just
    // resume on unmute and only force a rebuild if it stays muted (watchdog).
    track.onmute = () => { if (running) setStatus("Kamera pauset…", "live"); };
    track.onunmute = () => {
      if (!running) return;
      try { video.play(); } catch (_) {}
      lastNewFrameT = performance.now();
      setStatus("Sporer", "live");
    };
  }
}

async function acquireStream() {
  stream = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS);
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  await video.play();
  overlay.width = video.videoWidth || 1280;
  overlay.height = video.videoHeight || 720;
  attachStreamHandlers();
  lastNewFrameT = performance.now();
}

async function startCamera() {
  if (running) return;
  try {
    ui.start.disabled = true;
    if (!landmarker) await loadModel();

    setStatus("Åpner kamera…");
    await acquireStream();

    running = true;
    ui.stop.disabled = false;
    cursorEl.hidden = false;
    hint.classList.add("hidden");
    setStatus("Sporer", "live");
    lastFrameT = performance.now();

    await requestWakeLock();
    startWatchdog();
    loop();
  } catch (err) {
    console.error(err);
    ui.start.disabled = false;
    setStatus(cameraErrorMessage(err), "err");
  }
}

// Recover a stalled/stopped camera without the user having to press anything.
// `force` skips the cheap resume and rebuilds the stream outright.
async function recoverCamera(force = false) {
  if (!running || recovering) return;
  recovering = true;
  try {
    // 1) Cheapest fix: resume a merely-paused video element, then give it a
    //    moment to start producing frames again.
    if (!force && video.paused) {
      try { await video.play(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }

    // 2) Still not producing fresh frames? Fully rebuild the camera stream.
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    const dead = !track || track.readyState === "ended";
    const stalled = performance.now() - lastNewFrameT > 1200;
    if (force || dead || stalled) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      await acquireStream();
    }
    await requestWakeLock();
    if (running) setStatus("Sporer", "live");
    lastNewFrameT = performance.now();
  } catch (err) {
    setStatus(cameraErrorMessage(err), "err");
  } finally {
    recovering = false;
  }
}

function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!running) return;
    if (performance.now() - lastNewFrameT > 1500) recoverCamera();
  }, 1000);
}
function stopWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}

function cameraErrorMessage(err) {
  if (err && (err.name === "NotAllowedError" || err.name === "SecurityError"))
    return "Kameratilgang avslått";
  if (err && err.name === "NotFoundError") return "Fant ikke noe kamera";
  if (location.protocol !== "https:" && location.hostname !== "localhost")
    return "Krever HTTPS for kamera";
  return "Kamerafeil";
}

function stopCamera() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  stopWatchdog();
  releaseWakeLock();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ui.start.disabled = false;
  ui.stop.disabled = true;
  cursorEl.hidden = true;
  hint.classList.remove("hidden");
  setStatus("Stoppet");
  if (state.pinchDown) { bridge.up("left"); state.pinchDown = false; }
}

// Resume promptly when returning to the tab / app, and if the video is paused.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) {
    requestWakeLock();
    recoverCamera();
  }
});
video.addEventListener("pause", () => {
  if (running) { try { video.play(); } catch (_) {} }
});

// ---- Main loop ----
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  if (video.currentTime === lastVideoTime) return; // no new frame yet
  lastVideoTime = video.currentTime;
  lastNewFrameT = now;                              // mark progress for the watchdog

  let results;
  try {
    results = landmarker.detectForVideo(video, now);
  } catch (e) {
    return;
  }

  // FPS (exponential moving average)
  const dt = now - lastFrameT;
  lastFrameT = now;
  if (dt > 0) fpsEMA = fpsEMA ? fpsEMA * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
  ui.fps.textContent = Math.round(fpsEMA);

  const hands = results.landmarks || [];
  ui.hands.textContent = hands.length;

  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (hands.length === 0) {
    // Brief dropout (blur/fast move): hold the cursor + gesture state for a
    // short grace period so tracking doesn't flicker or release the pinch.
    if (now - lastHandT < HAND_GRACE_MS) {
      cursorEl.style.opacity = "0.7";
      return;
    }
    ui.gesture.textContent = "–";
    cursorEl.style.opacity = "0.35";
    // release any held button when the hand is truly gone
    if (state.pinchDown) { bridge.up("left"); cursorEl.classList.remove("pinch"); }
    state.pinchDown = false;
    state.pinchAnchor = null;
    state.dragging = false;
    state.scrollAnchorY = null;
    return;
  }
  lastHandT = now;
  cursorEl.style.opacity = "1";

  // Choose the primary (first) hand for control.
  const lm = hands[0];
  const handed =
    results.handednesses?.[0]?.[0]?.categoryName ||
    results.handedness?.[0]?.[0]?.categoryName ||
    "Right";

  if (ui.showLandmarks.checked) drawHand(lm);

  const analysis = analyzeHand(lm, handed);
  const pinchThreshold = parseFloat(ui.pinch.value);
  const gesture = classifyGesture(analysis, pinchThreshold);
  ui.gesture.textContent = gestureLabel(gesture);

  updatePointer(analysis, now);
  handleGesture(gesture, analysis);
}

function gestureLabel(g) {
  return ({
    pinch: "Klyp (klikk)", "pinch-right": "Høyreklikk",
    scroll: "Rull", open: "Åpen", point: "Peker", idle: "Hvile",
  })[g] || g;
}

// ---- Pointer mapping + smoothing ----
function updatePointer(a, now) {
  // Smoothing params live-controlled by the "Respons" slider. A high beta keeps
  // the cursor steady when still but follows fast moves with very little lag,
  // which is what removes the perceived delay.
  const minCutoff = parseFloat(ui.smooth.value);
  pointFilter.setParams({ minCutoff, beta: 0.6 });

  // Raw normalised index-tip position. Mirror x when the preview is mirrored.
  let nx = a.pointer.x;
  let ny = a.pointer.y;
  if (ui.mirror.checked) nx = 1 - nx;

  const sm = pointFilter.filter(nx, ny, now);

  // Apply gain ("zoom"): expand a central region to the full screen so small
  // hand movements cover the whole screen — no need to reach the camera edges.
  const gain = parseFloat(ui.gain.value);
  let gx = clamp01((sm.x - 0.5) * gain + 0.5);
  let gy = clamp01((sm.y - 0.5) * gain + 0.5);

  // Remember where the cursor was *before* this frame, so a pinch can anchor to
  // the aim point instead of the spot the fingertip jumps to when it meets the thumb.
  state.preFrameCursor.x = state.cursor.x;
  state.preFrameCursor.y = state.cursor.y;

  // While pinched, hold the cursor still for a precise click; only follow the
  // hand once it clearly moves (then it's a drag).
  if (state.pinchDown && state.pinchAnchor) {
    const moved = Math.hypot(gx - state.pinchAnchor.x, gy - state.pinchAnchor.y);
    if (!state.dragging && moved < DRAG_DEADZONE) {
      gx = state.pinchAnchor.x;
      gy = state.pinchAnchor.y;
    } else {
      state.dragging = true;
    }
  }

  state.cursor.x = gx;
  state.cursor.y = gy;

  // Position the on-screen cursor in viewport pixels.
  cursorEl.style.left = gx * window.innerWidth + "px";
  cursorEl.style.top = gy * window.innerHeight + "px";

  // Forward to the desktop agent if connected.
  if (bridge.connected) bridge.move(gx, gy);
}

// ---- Gesture -> action state machine ----
function handleGesture(gesture, a) {
  const isPinch = gesture === "pinch";
  const isRight = gesture === "pinch-right";

  cursorEl.classList.toggle("pinch", isPinch || isRight);

  // Left pinch = press / drag / click. Anchor to the aim point captured the
  // frame before the pinch so the fingertip's jump toward the thumb can't move it.
  if (isPinch && !state.pinchDown) {
    state.pinchDown = true;
    state.dragging = false;
    state.pinchAnchor = { x: state.preFrameCursor.x, y: state.preFrameCursor.y };
    bridge.down("left");
    clickRipple(state.pinchAnchor.x, state.pinchAnchor.y);
    dispatchClickAt(state.pinchAnchor.x, state.pinchAnchor.y);
  } else if (!isPinch && state.pinchDown) {
    state.pinchDown = false;
    state.dragging = false;
    state.pinchAnchor = null;
    bridge.up("left");
    state.lastClickT = performance.now();
  }

  // Right pinch = right click (edge-triggered)
  if (isRight && !state.rightDown) {
    state.rightDown = true;
    bridge.click("right");
  } else if (!isRight) {
    state.rightDown = false;
  }

  // Scroll = two fingers up; vertical motion of the hand scrolls.
  if (gesture === "scroll") {
    const y = a.pointer.y;
    if (state.scrollAnchorY === null) state.scrollAnchorY = y;
    const dy = (y - state.scrollAnchorY);
    if (Math.abs(dy) > 0.005) {
      bridge.scroll(-dy * 1200);          // up hand = scroll up
      window.scrollBy(0, dy * 1200);      // also scroll this page for in-browser demo
      state.scrollAnchorY = y;
    }
  } else {
    state.scrollAnchorY = null;
  }
}

function clickRipple(nx, ny) {
  const r = document.createElement("div");
  r.className = "click-ripple";
  r.style.left = nx * window.innerWidth + "px";
  r.style.top = ny * window.innerHeight + "px";
  document.body.appendChild(r);
  setTimeout(() => r.remove(), 450);
}

function dispatchClickAt(nx, ny) {
  // DOM click on whatever the virtual cursor hovers (in-browser control).
  const x = nx * window.innerWidth;
  const y = ny * window.innerHeight;
  const el = document.elementFromPoint(x, y);
  if (el && el !== cursorEl && !cursorEl.contains(el)) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  }
}

// ---- Drawing ----
function drawHand(lm) {
  const w = overlay.width, h = overlay.height;
  ctx.lineWidth = Math.max(2, w * 0.004);
  ctx.strokeStyle = "rgba(91,140,255,0.9)";
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
  }
  ctx.stroke();

  for (let i = 0; i < lm.length; i++) {
    const isTip = [4, 8, 12, 16, 20].includes(i);
    ctx.beginPath();
    ctx.arc(lm[i].x * w, lm[i].y * h, isTip ? w * 0.012 : w * 0.007, 0, Math.PI * 2);
    ctx.fillStyle = isTip ? "#38e0c8" : "#e8edff";
    ctx.fill();
  }
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---- Bridge UI ----
bridge.onState = (s, info) => {
  const el = ui.bridgeStatus;
  if (s === "open") { el.textContent = "Tilkoblet ✓"; el.className = "bridge-status ok"; ui.bridgeBtn.textContent = "Koble fra"; }
  else if (s === "connecting") { el.textContent = "Kobler til…"; el.className = "bridge-status"; }
  else if (s === "error") { el.textContent = "Tilkobling feilet"; el.className = "bridge-status err"; ui.bridgeBtn.textContent = "Koble til"; }
  else { el.textContent = "Ikke tilkoblet"; el.className = "bridge-status"; ui.bridgeBtn.textContent = "Koble til"; }
};

ui.bridgeBtn.addEventListener("click", () => {
  if (bridge.connected) bridge.disconnect();
  else bridge.connect(ui.bridgeUrl.value.trim());
});

// ---- Mirror toggle ----
function applyMirror() {
  video.classList.toggle("mirror", ui.mirror.checked);
  overlay.classList.toggle("mirror", ui.mirror.checked);
}
ui.mirror.addEventListener("change", applyMirror);
applyMirror();

// ---- Buttons ----
ui.start.addEventListener("click", startCamera);
ui.stop.addEventListener("click", stopCamera);

// ---- Game wiring ----
ui.gameBtn.addEventListener("click", () => {
  if (!running) startCamera();   // need the camera to play
  game.start();
});
$("gameAgain").addEventListener("click", () => game.start());
$("gameClose").addEventListener("click", () => game.close());
window.addEventListener("beforeunload", () => { if (stream) stream.getTracks().forEach((t) => t.stop()); });

// Friendly check for camera API availability.
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setStatus("Nettleseren støtter ikke kamera", "err");
  ui.start.disabled = true;
}

// Register the service worker so the app is installable + works offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
