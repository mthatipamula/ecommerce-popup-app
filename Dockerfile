# One image for both Cloud Run services (ROLE=api and ROLE=worker).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web && npm run build -w api

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace api && npm cache clean --force
COPY --from=build /app/api/dist api/dist
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8080
CMD ["node", "api/dist/main.js"]
