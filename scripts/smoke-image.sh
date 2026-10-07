#!/usr/bin/env bash
set -euo pipefail
image="${1:?Usage: smoke-image.sh IMAGE PLATFORM}"
platform="${2:?Usage: smoke-image.sh IMAGE PLATFORM}"
container="stronghold-smoke-${platform//\//-}"
cleanup() {
  docker logs "$container" || true
  docker rm -f "$container" >/dev/null || true
}
trap cleanup EXIT
# A non-default port checks both the server's environment contract and its HEALTHCHECK.
docker run --detach --name "$container" --platform "$platform" \
  --env PORT=3100 --health-interval=2s --health-start-period=2s "$image"
docker exec -i "$container" node --input-type=module < scripts/smoke-test.mjs
for attempt in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  if [[ "$status" == healthy ]]; then
    exit 0
  fi
  sleep 2
done
echo 'Container HEALTHCHECK did not become healthy' >&2
exit 1
