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
    this._wantConnected = false;      // user intent (drives auto-reconnect)
    this._reconnectTimer = null;
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect(url) {
    this._wantConnected = true;
    this.url = url || this.url;
    this.#open();
  }

  #open() {
    this.#teardownSocket();
    this.onState("connecting", this.url);
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.onState("error", String(e));
      this.#scheduleReconnect();
      return;
    }
    this.ws.onopen = () => this.onState("open", this.url);
    this.ws.onclose = () => {
      this.onState("closed", this.url);
      this.#scheduleReconnect();
    };
    this.ws.onerror = () => this.onState("error", this.url);
  }

  #scheduleReconnect() {
    if (!this._wantConnected || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._wantConnected && !this.connected) this.#open();
    }, 1500);
  }

  #teardownSocket() {
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onerror = null;
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }

  disconnect() {
    this._wantConnected = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.#teardownSocket();
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
