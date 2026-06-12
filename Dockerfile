FROM node:24-alpine3.24 AS build
RUN apk -U upgrade --no-cache
WORKDIR /app
COPY package.json tsconfig.json server.ts ./
RUN npm install && npx tsc

FROM node:24-alpine3.24
RUN apk -U upgrade --no-cache
WORKDIR /app
COPY --from=build /app/dist/server.js ./
USER 1000
EXPOSE 8080
CMD ["node", "server.js"]
