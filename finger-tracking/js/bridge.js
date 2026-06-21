// Desktop bridge — sends normalised pointer + gesture events over WebSocket
// to a local agent (see desktop-agent/agent.py) that drives the real OS cursor.
//
// All coordinates are normalised 0..1 (top-left origin). The agent maps them
// to the physical screen, so the same stream works on any resolution.

export class DesktopBridge {
  constructor() {
    this.ws = null;
    this.url = null;
    this.onState = () => {};
    this._lastSent = 0;
    this._minIntervalMs = 1000 / 120; // cap at 120 Hz to avoid flooding
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect(url) {
    this.disconnect();
    this.url = url;
    this.onState("connecting", url);
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.onState("error", String(e));
      return;
    }
    this.ws.onopen = () => this.onState("open", url);
    this.ws.onclose = () => this.onState("closed", url);
    this.ws.onerror = () => this.onState("error", url);
  }

  disconnect() {
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onerror = null;
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }

  #send(obj) {
    if (!this.connected) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  move(x, y) {
    const now = performance.now();
    if (now - this._lastSent < this._minIntervalMs) return;
    this._lastSent = now;
    this.#send({ t: "move", x, y });
  }

  down(button = "left") { this.#send({ t: "down", button }); }
  up(button = "left") { this.#send({ t: "up", button }); }
  click(button = "left") { this.#send({ t: "click", button }); }
  scroll(dy) { this.#send({ t: "scroll", dy }); }
}
