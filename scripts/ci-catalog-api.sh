#!/usr/bin/env bash
# CI only (desktop-shots.yml, store-screenshots.yml): runs the API image built from this
# checkout on localhost:<port> with the published catalog.db, the one the deployed test API
# serves. Jobs read the catalog from here, so a deploy of the test environment no longer
# fails them (#211). Returns once /readyz passes, which is after the catalog is open.
#
# Usage: scripts/ci-catalog-api.sh <image> [port]
set -euo pipefail

image=${1:?usage: ci-catalog-api.sh <image> [port]}
port=${2:-3001}
repo=${GITHUB_REPOSITORY:-phenix3443/agent-store}

# CATALOG_REFRESH_SECONDS: catalog-sync re-uploads the asset in place, so a download
# that lands in that gap fails; the next try comes 30 s later instead of 5 minutes.
docker run -d --name catalog-api -p "$port:3001" \
  -e APP_DB_PATH=/tmp/agent-store/app.db \
  -e CATALOG_URL="https://github.com/$repo/releases/download/catalog/catalog.db.gz" \
  -e CATALOG_PATH=/tmp/catalog/catalog.db \
  -e CATALOG_REFRESH_SECONDS=30 \
  --entrypoint sh "$image" -c 'bun src/migrate.ts && exec bun src/index.ts' >/dev/null

for _ in $(seq 150); do
  if curl -fsS --max-time 5 -o /dev/null "http://localhost:$port/readyz"; then
    curl -fsS "http://localhost:$port/api/resources?limit=1" -o /dev/null
    echo "catalog API ready on localhost:$port"
    exit 0
  fi
  sleep 2
done
docker logs catalog-api
echo "catalog API not ready after 5 minutes" >&2
exit 1
