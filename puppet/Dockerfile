FROM node:lts-alpine AS builder

WORKDIR /opt/mautrix-amp/puppet
COPY package.json yarn.lock ./
RUN yarn --production

COPY . /opt/mautrix-amp/puppet
CMD ["yarn", "start", "/data/config.json"]
