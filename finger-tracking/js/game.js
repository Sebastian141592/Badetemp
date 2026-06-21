// Bubble-pop test game. Point with the index finger to move the cursor, pinch
// to pop a bubble. Works with the virtual cursor (pinch dispatches a real DOM
// click on the bubble) and with a normal mouse for desktop testing.

const DURATION = 30;            // seconds per round
const SPAWN_MS = 780;           // base spawn interval
const MAX_BUBBLES = 5;
const BOMB_CHANCE = 0.16;       // popping a bomb costs points

export class BubbleGame {
  constructor(refs) {
    this.refs = refs;           // { layer, scoreEl, timeEl, bestEl, resultEl, finalEl }
    this.active = new Set();
    this.spawnTimer = null;
    this.tickTimer = null;
    this.running = false;
    this.score = 0;
    this.timeLeft = DURATION;
    this.best = Number(localStorage.getItem("ft_best") || 0);
    if (this.refs.bestEl) this.refs.bestEl.textContent = this.best;
  }

  start() {
    this.stop();
    this.running = true;
    this.score = 0;
    this.timeLeft = DURATION;
    this.#renderHud();
    this.refs.layer.hidden = false;
    this.refs.resultEl.hidden = true;

    this.spawnTimer = setInterval(() => this.#spawn(), SPAWN_MS);
    this.tickTimer = setInterval(() => {
      this.timeLeft -= 1;
      this.#renderHud();
      if (this.timeLeft <= 0) this.#finish();
    }, 1000);
    this.#spawn();
  }

  stop() {
    this.running = false;
    clearInterval(this.spawnTimer);
    clearInterval(this.tickTimer);
    this.spawnTimer = this.tickTimer = null;
    for (const b of this.active) b.remove();
    this.active.clear();
  }

  close() {
    this.stop();
    this.refs.layer.hidden = true;
  }

  #renderHud() {
    this.refs.scoreEl.textContent = this.score;
    this.refs.timeEl.textContent = Math.max(0, this.timeLeft);
  }

  #spawn() {
    if (!this.running || this.active.size >= MAX_BUBBLES) return;

    const size = 60 + Math.random() * 38;
    const margin = size / 2 + 12;
    const x = margin + Math.random() * (window.innerWidth - margin * 2);
    const y = 80 + margin + Math.random() * (window.innerHeight - margin * 2 - 90);
    const isBomb = Math.random() < BOMB_CHANCE;

    const el = document.createElement("div");
    el.className = "bubble" + (isBomb ? " bomb" : "");
    el.style.width = el.style.height = size + "px";
    el.style.left = x - size / 2 + "px";
    el.style.top = y - size / 2 + "px";
    el.textContent = isBomb ? "💣" : "";

    const onHit = (ev) => {
      ev.stopPropagation();
      this.#pop(el, isBomb);
    };
    el.addEventListener("click", onHit);

    this.refs.layer.appendChild(el);
    this.active.add(el);

    // Auto-expire if not popped in time.
    const life = isBomb ? 1400 : 1700 + Math.random() * 800;
    el._expire = setTimeout(() => this.#remove(el), life);
  }

  #pop(el, isBomb) {
    if (!this.active.has(el)) return;
    this.score += isBomb ? -2 : 1;
    if (this.score < 0) this.score = 0;
    this.#renderHud();
    clearTimeout(el._expire);
    el.classList.add("pop");
    this.active.delete(el);
    setTimeout(() => el.remove(), 250);
  }

  #remove(el) {
    if (!this.active.has(el)) return;
    this.active.delete(el);
    el.remove();
  }

  #finish() {
    this.stop();
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem("ft_best", String(this.best));
      if (this.refs.bestEl) this.refs.bestEl.textContent = this.best;
    }
    this.refs.finalEl.textContent = this.score;
    this.refs.resultEl.hidden = false;
  }
}
