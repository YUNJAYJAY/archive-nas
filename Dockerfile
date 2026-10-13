FROM node:24-alpine

RUN apk add --no-cache imagemagick poppler-utils

WORKDIR /app
ENV NODE_ENV=production PORT=4173

COPY server.js ./
COPY public ./public
COPY data/.gitkeep ./data/.gitkeep
COPY storage/.gitkeep ./storage/.gitkeep

RUN mkdir -p /app/data/cache /app/storage && chown -R node:node /app
USER node

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4173/healthz >/dev/null || exit 1

CMD ["node", "server.js"]
