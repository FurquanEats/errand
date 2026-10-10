# Errand with its own computer: a real Chromium on a virtual display, viewable and
# controllable from any device through noVNC. Run it on a VPS, home server or Raspberry Pi
# and your agent keeps working while your laptop is closed.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb fluxbox x11vnc novnc websockify fonts-noto fonts-noto-color-emoji tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The app runs as "node": its data volume and the X display socket must be writable by it.
RUN npm run build && chown -R node:node /app \
    && mkdir -p /data /tmp/.X11-unix && chown node:node /data && chmod 1777 /tmp/.X11-unix

USER node
ENV ERRAND_HOST=0.0.0.0 \
    ERRAND_PORT=4747 \
    ERRAND_DATA_DIR=/data \
    ERRAND_BROWSER_PATH=/usr/bin/chromium \
    ERRAND_HEADLESS=0 \
    ERRAND_BROWSER_ARGS="--no-sandbox --disable-dev-shm-usage" \
    DISPLAY=:99

VOLUME /data
EXPOSE 4747 6080
ENTRYPOINT ["/usr/bin/tini", "--", "sh", "/app/docker/entrypoint.sh"]
