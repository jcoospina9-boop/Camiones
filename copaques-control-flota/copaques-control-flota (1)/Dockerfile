FROM node:22-bookworm-slim

WORKDIR /app

# Dependencias del sistema necesarias si better-sqlite3 requiere compilación nativa
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY . .

RUN npm run build

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
