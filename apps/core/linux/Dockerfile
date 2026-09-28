FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    adduser \
    sudo \
    procps \
    xvfb \
    x11vnc \
    novnc \
    python3-websockify \
    xdotool \
    x11-xserver-utils \
    xfonts-base \
    jwm \
    xterm \
    chromium \
    pcmanfm \
    fonts-dejavu-core \
    imagemagick \
    socat \
    netcat-openbsd \
  && rm -rf /var/lib/apt/lists/*

CMD ["sleep", "infinity"]
