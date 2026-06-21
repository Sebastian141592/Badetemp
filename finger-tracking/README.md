# ✋ Finger-Tracking

Spor fingrene dine presist gjennom kameraet og styr enheten med gester.
Kjører **helt lokalt i nettleseren** med [MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) — ingen video forlater enheten.

> Track your fingers precisely through the camera and control your device
> with gestures. Runs entirely in the browser; no video leaves your device.

---

## ✨ Funksjoner

- **21 landemerker per hånd**, opptil 2 hender, i sanntid (GPU-akselerert).
- **Presis markør** styrt av pekefingeren, glattet med et **One Euro-filter**
  (lav forsinkelse + lite skjelving).
- **Gester:**
  | Gest | Handling |
  |------|----------|
  | Peke (pekefinger ut) | Flytt markøren |
  | Klyp tommel + pekefinger | Venstreklikk / dra |
  | Klyp tommel + langfinger | Høyreklikk |
  | To fingre opp + beveg | Rull |
  | Åpen hånd | Slipp / hvile |
- Justerbar **følsomhet (zoom)**, **glatting** og **klikk-terskel**.
- **Speilvendt** selfie-visning (kan slås av).
- Valgfri **desktop-bro** for å styre den *ekte* musepekeren på PC/Mac/Linux.

---

## 🚀 Kom i gang (nettside)

Kamera i nettleseren krever **HTTPS** (eller `localhost`).

**Alternativ A – lokalt:**
```bash
cd finger-tracking
python3 -m http.server 8000
# åpne http://localhost:8000
```

**Alternativ B – GitHub Pages:** Slå på Pages for repoet, så åpne
`https://<bruker>.github.io/<repo>/finger-tracking/`. (HTTPS er allerede på plass.)

Trykk **Start kamera**, gi tilgang, og hold hånden foran kameraet.

---

## 🖥️ Styre en ekte PC / Mac (desktop-bro)

En nettside kan **ikke** flytte systemets musepeker av seg selv (nettleseren
er sandkassesikret). Den lille agenten under er broen som gjør det mulig.

```bash
cd finger-tracking/desktop-agent
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python agent.py
```

I nettsiden: skriv inn `ws://localhost:8765` og trykk **Koble til**.
Nå styrer fingrene den ekte markøren.

- **macOS:** gi terminalen/Python tilgang under *Systeminnstillinger →
  Personvern og sikkerhet → Tilgjengelighet*, ellers ignoreres museflyttingen.
- Agenten lytter kun på `localhost` av sikkerhetsgrunner.

---

## 📱 Hva fungerer på hvilken enhet?

| Enhet | Sporing i nettleseren | Styre selve OS-et |
|-------|:--:|:--|
| **PC (Windows)** | ✅ | ✅ via desktop-agenten |
| **Mac** | ✅ | ✅ via desktop-agenten (krever Tilgjengelighet) |
| **Linux** | ✅ | ✅ via desktop-agenten (X11) |
| **iPad / iPhone** | ✅ (Safari, HTTPS) | ❌ se under |
| **Android** | ✅ (Chrome, HTTPS) | ⚠️ kun i nettleseren |

**Ærlig om begrensningene:** iOS/iPadOS lar ikke en nettside (eller en vanlig
app) overstyre systemmarkøren eller styre andre apper — Apple tilbyr ingen
slikt API. På iPad/iPhone fungerer derfor sporing og styring **inne i selve
nettsiden** (flytt markør, klikk på elementer, rull), men ikke styring av hele
operativsystemet. Full OS-styring der ville krevd en native app som bruker
Apples *Switch Control*/*AssistiveTouch*-rammeverk, noe som ligger utenfor en
nettside.

På PC/Mac/Linux gir desktop-agenten ekte OS-styring.

---

## 🧠 Slik virker det

```
Kamera ─▶ MediaPipe HandLandmarker (WASM/GPU) ─▶ 21 punkter/hånd
        ─▶ gestures.js (klyp/peke/rull, skala-invariant)
        ─▶ One Euro-filter (presis, lav latens)
        ─▶ virtuell markør i siden  +  (valgfritt) WebSocket ─▶ desktop-agent ─▶ OS-mus
```

- **Skala-invariant gestgjenkjenning:** klyp-avstand normaliseres mot
  håndstørrelsen, så avstand til kameraet ikke påvirker treffsikkerheten.
- **One Euro-filteret** gir glatt markør i ro og rask respons ved bevegelse.

---

## 📂 Struktur

`index.html` er **selvstendig** — all CSS, JS og ikoner er bygget inn, så filen
kan brukes/deles alene. Den genereres fra kildefilene under med `build.py`.

```
finger-tracking/
├── index.html            # ✅ ferdig, selvstendig app (generert – ikke rediger direkte)
├── index.template.html   # kilde: HTML-strukturen
├── build.py              # bygger index.html (python3 build.py)
├── css/style.css         # kilde: stil
├── js/
│   ├── app.js            # kamera, løkke, tegning, gest-tilstandsmaskin
│   ├── gestures.js       # landemerke → gest
│   ├── euro.js           # One Euro-filter (lav forsinkelse)
│   ├── bridge.js         # WebSocket-klient til desktop-agenten (auto-reconnect)
│   └── game.js           # boble-test-spillet
├── icons/                # app-ikoner (bygges inn som data-URI)
├── sw.js                 # service worker (offline / installerbar)
└── desktop-agent/
    ├── agent.py          # flytter den ekte OS-musen på PC/Mac/Linux (pyautogui)
    └── requirements.txt
```

> **Vil du endre noe?** Rediger `index.template.html` / `css/` / `js/` og kjør
> `python3 build.py` for å regenerere `index.html`.

## ⚡ Mindre forsinkelse

Pekerbevegelsen glattes med et One Euro-filter med høy `beta`, som holder
markøren rolig når hånden står stille, men følger raske bevegelser med svært
lite lag. Dra **«Respons»**-skyveren høyere for enda snappere føling (litt mer
skjelving), eller lavere for jevnere (litt mer lag).

## 🔐 Personvern

All bildebehandling skjer i nettleseren din. Ingen videostrøm eller
landemerker sendes til en server. Desktop-broen sender kun
musekoordinater/-klikk til en agent du selv kjører lokalt.

## Nettleserstøtte

Nyere Chrome, Edge, Safari og Firefox med WebGL2/WASM. Krever HTTPS eller
`localhost` for kameratilgang.
