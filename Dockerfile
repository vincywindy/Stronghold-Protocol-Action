# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# Upstream postinstall needs tools/vendor.mjs, which is copied in the next stage.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM dependencies AS build
ARG FETCH_ASSETS=1
ARG INCLUDE_LOCAL_ASSETS=0
ARG PREPARED_PLUGINS=0
COPY . .
# Older upstream releases have no packs/; keeping an empty directory lets them build too.
# INCLUDE_LOCAL_ASSETS retains its existing name, but now imports ALL verified Release art.
# Vanilla releases keep their verified manifests; plugin builds arrive with their prepared art snapshot.
RUN if [ "$PREPARED_PLUGINS" = 1 ]; then cp -R .plugin-art/. .; fi \
    && mkdir -p packs public/assets \
    && node tools/vendor.mjs \
    && if [ "$PREPARED_PLUGINS" = 1 ]; then \
         test -s plugin-build.json; \
       else \
       test "$PREPARED_PLUGINS" = 0 && case "$FETCH_ASSETS:$INCLUDE_LOCAL_ASSETS" in \
         1:1) test -f .container-assets/data/assets.json \
              && test -f .container-assets/data/local-assets.json \
              && cp -R .container-assets/public/. public/ \
              && cp -R .container-assets/data/. data/ ;; \
         1:0) node tools/fetch-assets.mjs ;; \
         0:0) echo "Building without downloaded game assets" ;; \
         *) echo "Expected FETCH_ASSETS:INCLUDE_LOCAL_ASSETS = 1:1, 1:0 or 0:0" >&2; exit 1 ;; \
       esac; \
       fi \
    && rm -rf .container-assets .plugin-art .cache
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Dockerfile.dockerignore defines the shipped source; a second directory list here
# previously omitted tools/ even though Studio imports it at runtime. Dependencies are production-only.
COPY --from=build /app ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server/index.js"]
