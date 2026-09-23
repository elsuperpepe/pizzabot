FROM node:22-slim

# Chromium del sistema (lo usa whatsapp-web.js) + fuentes para que renderice bien
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium \
    DATA_DIR=/data

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# /data debe ser el volumen de Railway: ahí quedan la sesión de WhatsApp y los Excel
CMD ["node", "index.js"]
