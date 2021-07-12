FROM alpine:3.14

ARG TARGETARCH=amd64

RUN apk add --no-cache \
      python3 py3-pip py3-setuptools py3-wheel \
      py3-pillow \
      py3-aiohttp \
      py3-magic \
      py3-ruamel.yaml \
      py3-commonmark \
      # encryption
      py3-olm \
      py3-cffi \
      py3-pycryptodome \
      py3-unpaddedbase64 \
      py3-future \
      # Other dependencies
      ca-certificates \
      bash \
      curl \
      jq \
      yq

WORKDIR /opt/matrix-puppeteer-line

COPY requirements.txt optional-requirements.txt ./
RUN apk add --virtual .build-deps python3-dev libffi-dev build-base \
 && pip3 install -r requirements.txt -r optional-requirements.txt \
 && apk del .build-deps

COPY LICENSE setup.py ./
COPY matrix_puppeteer_line matrix_puppeteer_line
RUN apk add --no-cache git && pip3 install .[e2be] && apk del git \
  # This doesn't make the image smaller, but it's needed so that the `version` command works properly
  && cp matrix_puppeteer_line/example-config.yaml . && rm -rf matrix_puppeteer_line

VOLUME /data

# Needed to prevent "KeyError: 'getpwuid(): uid not found: 1337'" when connecting to postgres
RUN adduser -DHu 1337 --gecos "" line

COPY docker-run.sh ./
RUN chown -R 1337:1337 .
USER 1337
CMD ["./docker-run.sh"]