#!/bin/sh
set -e

if [ -z "$ERRAND_PASSWORD" ]; then
  echo "ERRAND_PASSWORD must be set: this container is reachable over the network." >&2
  exit 1
fi
if [ -z "$VNC_PASSWORD" ]; then
  echo "VNC_PASSWORD must be set: it protects the live view of the agent's computer." >&2
  exit 1
fi
if [ "$ERRAND_PASSWORD" = "change-me" ] || [ "$VNC_PASSWORD" = "change-me-too" ]; then
  echo "Replace the placeholder passwords (change-me) in docker-compose.yml before starting Errand." >&2
  exit 1
fi

# The agent's screen.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
sleep 1
fluxbox >/dev/null 2>&1 &

# Live view / takeover at http://<host>:6080/vnc.html (password protected).
mkdir -p "$HOME/.vnc"
x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null
x11vnc -display :99 -rfbauth "$HOME/.vnc/passwd" -forever -shared -localhost -quiet -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

exec node --disable-warning=ExperimentalWarning --import tsx server/index.ts
