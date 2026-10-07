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
COPY . .
# Older upstream releases have no packs/; keeping an empty directory lets them build too.
# Asset errors must fail the build rather than replace a working image with incomplete art.
RUN mkdir -p packs public/assets \
    && node tools/vendor.mjs \
    && case "$FETCH_ASSETS" in \
         1) node tools/fetch-assets.mjs ;; \
         0) echo "Building without downloaded game assets" ;; \
         *) echo "FETCH_ASSETS must be 0 or 1" >&2; exit 1 ;; \
       esac
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=dependencies /app/package.json /app/package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/data ./data
COPY --from=build /app/public ./public
COPY --from=build /app/packs ./packs
# The simulator reads these research tables when the primary data needs a fallback.
COPY --from=build /app/docs/research ./docs/research
COPY --from=build /app/LICENSE /app/NOTICE.md /app/THIRD-PARTY-NOTICES.md ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server/index.js"]
