#!/usr/bin/env bash
# JobPilot daily run — fetch latest jobs + AI-curated top picks + digest email.
# Usage: BACKEND=http://localhost:8080 TOKEN=... ./scripts/daily.sh
set -euo pipefail
BASE="${JOBPILOT_BACKEND_URL:-http://localhost:8080}"
TOKEN="${JOBPILOT_API_TOKEN:?Set JOBPILOT_API_TOKEN env var}"
echo "JobPilot daily run against $BASE ..."
curl -fsS --max-time 180 -X POST "$BASE/api/daily/run/sync" -H "X-Api-Token: $TOKEN"
echo
