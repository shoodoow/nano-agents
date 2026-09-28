FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    adduser \
    procps \
    xvfb \
    x11vnc \
    novnc \
    python3-websockify \
    xdotool \
    x11-xserver-utils \
    imagemagick \
    socat \
    netcat-openbsd \
  && rm -rf /var/lib/apt/lists/*

CMD ["sleep", "infinity"]
