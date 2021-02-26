FROM node:14-alpine3.12

RUN echo $'\
@edge http://dl-cdn.alpinelinux.org/alpine/edge/main\n\
@edge http://dl-cdn.alpinelinux.org/alpine/edge/testing\n\
@edge http://dl-cdn.alpinelinux.org/alpine/edge/community' >> /etc/apk/repositories

RUN apk add --no-cache chromium@edge

WORKDIR /opt/mautrix-amp/puppet
RUN chown node:node /opt/mautrix-amp/puppet
USER node
COPY package.json yarn.lock ./
RUN yarn --production && rm -rf node_modules/puppeteer/.local-chromium

COPY . /opt/mautrix-amp/puppet
CMD ["yarn", "start", "--config", "/data/config.json", "--browser", "/usr/lib/chromium/chrome", "--no-sandbox"]