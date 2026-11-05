FROM node:22-bookworm-slim
# python3 + yt-dlp solo para importar vídeos desde enlaces (ffmpeg viene incluido vía npm: ffmpeg-static)
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "server/index.js"]
