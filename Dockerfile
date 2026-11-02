# DEV image. Not hardened; Testnet/synthetic only.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV APP_ENV=development PORT=3001 DATABASE_FILE=/data/core.db
EXPOSE 3001
VOLUME /data
CMD ["npx", "tsx", "src/main.ts"]
