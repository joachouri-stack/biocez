# Image du site pour Coolify (ou tout hébergeur Docker).
# La base SQLite vit dans /app/data : y monter un volume persistant.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/biocez.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["npm", "start"]
