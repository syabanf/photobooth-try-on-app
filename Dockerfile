# The booth server for a Linux booth computer. Run it with deploy/docker-compose.yml, which puts it
# on the host network: the booth-only routes (photo uploads, the DSLR proxy, QRIS management) answer
# only 127.0.0.1, and with a published port every request would arrive from Docker's gateway instead.

# ---------- build: install, fetch the camera models, bundle ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# The face, pose, hand and background models ship inside the image, so a booth without internet
# still tracks. Building needs internet once for this step.
RUN pnpm models && pnpm build

# ---------- run: Node and the built app, nothing from npm ----------
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4173 \
    HOST=0.0.0.0 \
    PHOTO_DATA_DIR=/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/serve.mjs /app/scripts/camera-proxy.mjs /app/scripts/qris-mutations.mjs /app/scripts/booth-only.mjs ./scripts/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/delivery-config').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "scripts/serve.mjs"]
