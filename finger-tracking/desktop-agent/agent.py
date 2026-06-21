#!/usr/bin/env python3
"""
Finger-Tracking desktop agent.

Receives normalised pointer + gesture events over WebSocket from the
Finger-Tracking web page and drives the REAL operating-system cursor
(Windows / macOS / Linux X11).

  Browser (camera + MediaPipe)  --ws-->  this agent  -->  OS mouse

Why this exists:
A web page is sandboxed and *cannot* move the system cursor by itself.
This small local program is the bridge that makes "control my PC/Mac with
my fingers" actually work. Run it on the machine you want to control, then
press "Koble til" in the web UI (default ws://localhost:8765).

Setup:
    python3 -m venv .venv
    source .venv/bin/activate        # Windows: .venv\\Scripts\\activate
    pip install -r requirements.txt
    python agent.py

macOS: grant the terminal/Python "Accessibility" permission under
System Settings -> Privacy & Security -> Accessibility, or mouse control
will be silently ignored.

Security: binds to localhost only by default. Do not expose to the network.
"""

import asyncio
import json
import sys

try:
    import websockets
except ImportError:
    sys.exit("Missing dependency. Run:  pip install -r requirements.txt")

try:
    import pyautogui
except ImportError:
    sys.exit("Missing dependency. Run:  pip install -r requirements.txt")

HOST = "127.0.0.1"
PORT = 8765

# pyautogui safety: moving the mouse to a corner normally aborts the program.
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0  # we want immediate, low-latency moves

SCREEN_W, SCREEN_H = pyautogui.size()


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def to_pixels(x, y):
    px = clamp(int(x * SCREEN_W), 0, SCREEN_W - 1)
    py = clamp(int(y * SCREEN_H), 0, SCREEN_H - 1)
    return px, py


async def handle(websocket):
    peer = getattr(websocket, "remote_address", "?")
    print(f"[+] Client connected: {peer}")
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue

            t = msg.get("t")
            try:
                if t == "move":
                    px, py = to_pixels(float(msg["x"]), float(msg["y"]))
                    pyautogui.moveTo(px, py, _pause=False)
                elif t == "down":
                    pyautogui.mouseDown(button=msg.get("button", "left"), _pause=False)
                elif t == "up":
                    pyautogui.mouseUp(button=msg.get("button", "left"), _pause=False)
                elif t == "click":
                    pyautogui.click(button=msg.get("button", "left"), _pause=False)
                elif t == "scroll":
                    pyautogui.scroll(int(float(msg.get("dy", 0))))
            except Exception as exc:  # never let one bad event kill the loop
                print(f"[!] action error ({t}): {exc}")
    except websockets.ConnectionClosed:
        pass
    finally:
        print(f"[-] Client disconnected: {peer}")


async def main():
    print("Finger-Tracking desktop agent")
    print(f"  screen: {SCREEN_W}x{SCREEN_H}")
    print(f"  listening on ws://{HOST}:{PORT}")
    print("  open the web page and press 'Koble til'. Ctrl+C to quit.")
    async with websockets.serve(handle, HOST, PORT, max_queue=8):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBye.")
