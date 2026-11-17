# syntax=docker/dockerfile:1

# Install production dependencies with pnpm in a full Node image, then copy
# them into a distroless image that has no shell or package manager.
# Base images are pinned by digest; Dependabot proposes updates.

FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS dependencies

WORKDIR /app

# Node 25 and later no longer bundle Corepack, so install the pnpm version
# named in package.json directly.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global "$(node --print 'require("./package.json").packageManager')" \
  && pnpm install --frozen-lockfile --prod

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER nonroot
EXPOSE 3000

# Exec form, with a long interval: Synology's kernel can leave shell-based
# healthchecks stuck in uninterruptible sleep under I/O pressure.
HEALTHCHECK --interval=2m --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "src/bin/healthcheck.ts"]

# The distroless entrypoint is Node itself.
CMD ["src/bin/main.ts"]
