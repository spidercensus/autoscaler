ARG NODE_VERSION=18
FROM node:${NODE_VERSION}-alpine AS build-env

WORKDIR /usr/src/app
COPY . .

RUN npm config set update-notifier false
RUN npm install

FROM gcr.io/distroless/nodejs${NODE_VERSION}:latest
COPY --from=build-env /usr/src/app /usr/src/app
WORKDIR /usr/src/app/scaler-core

CMD ["../index.js"]
