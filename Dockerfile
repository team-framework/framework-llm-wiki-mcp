FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN apk add --no-cache git && npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /cache /metrics /chat-data && chown node:node /cache /metrics /chat-data
USER node
EXPOSE 3100
CMD ["node", "dist/index.js"]
