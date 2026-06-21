import { HandLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { PointFilter } from "./euro.js";
import { analyzeHand, classifyGesture } from "./gestures.js";
import { DesktopBridge } from "./bridge.js";

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
};

// ---- State ----
let landmarker = null;
let stream = null;
let running = false;
let rafId = null;
let lastVideoTime = -1;
let fpsEMA = 0;
let lastFrameT = performance.now();

const pointFilter = new PointFilter({ minCutoff: 1.5, beta: 0.02, dCutoff: 1.0 });
const bridge = new DesktopBridge();

// Gesture state machine
const state = {
  gesture: "idle",
  pinchDown: false,
  rightDown: false,
  lastClickT: 0,
  scrollAnchorY: null,
  cursor: { x: 0.5, y: 0.5 },   // normalised, post-gain
};

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
  landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

// ---- Camera ----
async function startCamera() {
  try {
    ui.start.disabled = true;
    if (!landmarker) await loadModel();

    setStatus("Åpner kamera…");
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;

    running = true;
    ui.stop.disabled = false;
    cursorEl.hidden = false;
    hint.classList.add("hidden");
    setStatus("Sporer", "live");
    lastFrameT = performance.now();
    loop();
  } catch (err) {
    console.error(err);
    ui.start.disabled = false;
    setStatus(cameraErrorMessage(err), "err");
  }
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

// ---- Main loop ----
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  if (video.currentTime === lastVideoTime) return; // no new frame yet
  lastVideoTime = video.currentTime;

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
    ui.gesture.textContent = "–";
    cursorEl.style.opacity = "0.35";
    // release any held button when the hand disappears
    if (state.pinchDown) { bridge.up("left"); state.pinchDown = false; cursorEl.classList.remove("pinch"); }
    state.scrollAnchorY = null;
    return;
  }
  cursorEl.style.opacity = "1";

  // Choose the primary (first) hand for control.
  const lm = hands[0];
  const handed = results.handednesses?.[0]?.[0]?.categoryName || "Right";

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
  // Smoothing params live-controlled by the "Glatting" slider.
  const minCutoff = parseFloat(ui.smooth.value);
  pointFilter.setParams({ minCutoff, beta: 0.02 });

  // Raw normalised index-tip position. Mirror x when the preview is mirrored.
  let nx = a.pointer.x;
  let ny = a.pointer.y;
  if (ui.mirror.checked) nx = 1 - nx;

  const sm = pointFilter.filter(nx, ny, now);

  // Apply gain ("zoom"): expand a central region to the full screen so the
  // fingertip doesn't need to reach the camera edges.
  const gain = parseFloat(ui.gain.value);
  const gx = clamp01((sm.x - 0.5) * gain + 0.5);
  const gy = clamp01((sm.y - 0.5) * gain + 0.5);
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

  // Left pinch = press / drag / click
  if (isPinch && !state.pinchDown) {
    state.pinchDown = true;
    bridge.down("left");
    dispatchClickFeedback();
  } else if (!isPinch && state.pinchDown) {
    state.pinchDown = false;
    bridge.up("left");
    const now = performance.now();
    // Treat a quick press+release as a click for the bridge already handled by down/up.
    state.lastClickT = now;
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

function dispatchClickFeedback() {
  // Visual + DOM click on whatever the virtual cursor hovers (in-browser control).
  const x = state.cursor.x * window.innerWidth;
  const y = state.cursor.y * window.innerHeight;
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
window.addEventListener("beforeunload", () => { if (stream) stream.getTracks().forEach((t) => t.stop()); });

// Friendly check for camera API availability.
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setStatus("Nettleseren støtter ikke kamera", "err");
  ui.start.disabled = true;
}
