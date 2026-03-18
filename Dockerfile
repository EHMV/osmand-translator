FROM node:24-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json server.ts ./
RUN npm install && npx tsc

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist/server.js ./
USER 1000
EXPOSE 8080
CMD ["node", "server.js"]
