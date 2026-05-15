#!/usr/bin/env bash
#
# Smoke test for the FINAL_MPFE deployment after the Syllabus -> Unity -> Activity
# refactor. Exercises the new REST endpoints end-to-end:
#
#   1. GET /health                                  -> api liveness
#   2. POST /api/syllabuses                         -> empty named syllabus
#   3. POST /api/unities                            -> empty named unity under the syllabus
#   4. POST /api/activities                         -> empty named activity under the unity
#   5. GET /api/syllabuses/:id/snapshot             -> read it back
#
# (The /generate SSE endpoints are NOT smoke-tested here because they
#  require a working OpenRouter key + would burn LLM tokens on every
#  invocation. They are documented in INTEGRATION.md instead.)
#
# Usage:
#
#   API_BASE=https://api-production-6862.up.railway.app ./scripts/smoke-test.sh
#
# Or against a local dev server:
#
#   API_BASE=http://localhost:3001 ./scripts/smoke-test.sh
#
# Exits 0 on full success, non-zero on any HTTP failure.

set -euo pipefail

API_BASE="${API_BASE:-https://api-production-6862.up.railway.app}"
JQ_BIN="${JQ_BIN:-jq}"

# Pretty banner.
echo "== FINAL_MPFE smoke test =="
echo "API_BASE=$API_BASE"
echo

# Quick liveness probe so failures fail fast and obviously.
echo "[1/5] GET /health"
HEALTH_JSON=$(curl -sf "$API_BASE/health")
echo "  $HEALTH_JSON"
echo

# Create the syllabus.
SYLLABUS_TITLE="Smoke test syllabus $(date -u +%Y%m%dT%H%M%SZ)"
echo "[2/5] POST /api/syllabuses (name=\"$SYLLABUS_TITLE\")"
SYLLABUS_JSON=$(
  curl -sf -X POST "$API_BASE/api/syllabuses" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"$SYLLABUS_TITLE\",\"description\":\"Created by scripts/smoke-test.sh.\"}"
)
SYLLABUS_ID=$(echo "$SYLLABUS_JSON" | "$JQ_BIN" -r .id)
echo "  syllabus_id=$SYLLABUS_ID"
echo

# Create the unity.
echo "[3/5] POST /api/unities (syllabus_id=$SYLLABUS_ID)"
UNITY_JSON=$(
  curl -sf -X POST "$API_BASE/api/unities" \
    -H "Content-Type: application/json" \
    -d "{\"syllabus_id\":\"$SYLLABUS_ID\",\"title\":\"Smoke test unity 1\",\"order_index\":0}"
)
UNITY_ID=$(echo "$UNITY_JSON" | "$JQ_BIN" -r .id)
echo "  unity_id=$UNITY_ID"
echo

# Create the activity.
echo "[4/5] POST /api/activities (unity_id=$UNITY_ID)"
ACTIVITY_JSON=$(
  curl -sf -X POST "$API_BASE/api/activities" \
    -H "Content-Type: application/json" \
    -d "{\"unity_id\":\"$UNITY_ID\",\"title\":\"Smoke test activity 1\",\"order_index\":0}"
)
ACTIVITY_ID=$(echo "$ACTIVITY_JSON" | "$JQ_BIN" -r .id)
echo "  activity_id=$ACTIVITY_ID"
echo

# Read it all back to confirm the rows actually persisted.
echo "[5/5] GET /api/syllabuses/$SYLLABUS_ID/snapshot"
SNAPSHOT_JSON=$(curl -sf "$API_BASE/api/syllabuses/$SYLLABUS_ID/snapshot")
SYLLABUS_ROW_TITLE=$(echo "$SNAPSHOT_JSON" | "$JQ_BIN" -r '.syllabus.title // empty')
CHAPTERS_COUNT=$(echo "$SNAPSHOT_JSON" | "$JQ_BIN" -r '.chapters | length')
echo "  syllabus.title=\"$SYLLABUS_ROW_TITLE\""
echo "  chapters (unities legacy view alias) count=$CHAPTERS_COUNT"
echo

if [[ "$SYLLABUS_ROW_TITLE" != "$SYLLABUS_TITLE" ]]; then
  echo "FAIL: snapshot title mismatch (expected \"$SYLLABUS_TITLE\", got \"$SYLLABUS_ROW_TITLE\")"
  exit 1
fi

echo "OK: smoke test passed."
echo
echo "ids:"
echo "  SYLLABUS_ID=$SYLLABUS_ID"
echo "  UNITY_ID=$UNITY_ID"
echo "  ACTIVITY_ID=$ACTIVITY_ID"
