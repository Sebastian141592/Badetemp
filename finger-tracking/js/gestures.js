// Gesture analysis from MediaPipe Hand landmarks (21 points per hand).
//
// Landmark index map:
//   0 wrist
//   1-4   thumb  (4 = tip)
//   5-8   index  (8 = tip, 6 = PIP)
//   9-12  middle (12 = tip, 10 = PIP)
//   13-16 ring   (16 = tip, 14 = PIP)
//   17-20 pinky  (20 = tip, 18 = PIP)

const TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIPS = { index: 6, middle: 10, ring: 14, pinky: 18 };

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.hypot(dx, dy, dz);
}

// Reference length: wrist -> middle-finger MCP. Scale-invariant (distance to
// camera no longer matters), which is what makes pinch detection reliable.
function handScale(lm) {
  return Math.max(dist(lm[0], lm[9]), 1e-4);
}

// A finger is "up" when its tip is clearly above (smaller y) its PIP joint.
function fingerUp(lm, name) {
  return lm[TIPS[name]].y < lm[PIPS[name]].y - 0.02;
}

// Thumb extension depends on which hand it is (mirror on x).
function thumbOut(lm, isRight) {
  const tip = lm[TIPS.thumb], ip = lm[3], mcp = lm[2];
  const spread = Math.abs(tip.x - mcp.x);
  const folded = dist(tip, lm[9]) < dist(ip, lm[9]); // tip closer to palm than IP
  return spread > 0.10 && !folded;
}

export function analyzeHand(lm, handedness) {
  const isRight = handedness === "Right";
  const scale = handScale(lm);

  const fingers = {
    thumb: thumbOut(lm, isRight),
    index: fingerUp(lm, "index"),
    middle: fingerUp(lm, "middle"),
    ring: fingerUp(lm, "ring"),
    pinky: fingerUp(lm, "pinky"),
  };
  const upCount = Object.values(fingers).filter(Boolean).length;

  // Normalised pinch distances (0 = touching). thumb+index = left, thumb+middle = right.
  const pinchIndex = dist(lm[TIPS.thumb], lm[TIPS.index]) / scale;
  const pinchMiddle = dist(lm[TIPS.thumb], lm[TIPS.middle]) / scale;

  // Pointer position = blend of index tip and index PIP for stability,
  // weighted toward the tip for precision.
  const tip = lm[TIPS.index];
  const pointer = { x: tip.x, y: tip.y, z: tip.z || 0 };

  return {
    isRight,
    fingers,
    upCount,
    pinchIndex,
    pinchMiddle,
    pointer,
    scale,
    landmarks: lm,
  };
}

// Turn a per-frame analysis + thresholds into a high-level intent.
// pinchThreshold is normalised (compared against pinchIndex/pinchMiddle).
export function classifyGesture(a, pinchThreshold) {
  if (a.pinchIndex < pinchThreshold) return "pinch";          // left click / drag
  if (a.pinchMiddle < pinchThreshold) return "pinch-right";   // right click
  if (a.fingers.index && a.fingers.middle && !a.fingers.ring && !a.fingers.pinky) {
    return "scroll";                                          // two fingers up
  }
  if (a.upCount >= 4) return "open";                          // open palm = idle/release
  if (a.fingers.index && !a.fingers.middle) return "point";  // pointing = move only
  return "idle";
}
