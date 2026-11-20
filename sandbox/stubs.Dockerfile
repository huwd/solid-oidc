# syntax=docker/dockerfile:1

# The sandbox's stubs. Not published: build it with sandbox/compose.yaml.
# The base is the broker's build image, pinned by digest; Dependabot proposes
# updates. openssl creates the sandbox's certificate on first start.

FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global "$(node --print 'require("./package.json").packageManager')" \
  && pnpm install --frozen-lockfile --prod

COPY sandbox ./sandbox
RUN mkdir /certs && chown node:node /certs

USER node
ENV NODE_ENV=production
ENTRYPOINT ["sandbox/entrypoint.sh"]
