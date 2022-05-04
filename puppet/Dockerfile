FROM node:16-alpine3.14

ARG TARGETARCH=amd64

RUN apk add --no-cache chromium xvfb-run xdotool gtk+3.0

WORKDIR /opt/matrix-puppeteer-line/puppet

# Want to use same UID as Python process so the Unix socket can be shared.
# But yarn hits snags if there is no user for the UID it's run under.
RUN adduser -Du 1337 --gecos "" line

VOLUME /data

RUN chown 1337:1337 .
USER 1337
COPY package.json yarn.lock ./
RUN yarn --production && rm -rf node_modules/puppeteer/.local-chromium

COPY src src
COPY docker-run.sh example-config-docker.json ./
CMD ["./docker-run.sh"]