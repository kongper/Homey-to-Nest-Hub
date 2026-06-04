# syntax=docker/dockerfile:1
FROM node:24-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# App source
COPY server.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

# config.json is provided at runtime via a bind mount (see docker-compose.yml)
CMD ["node", "server.js"]
