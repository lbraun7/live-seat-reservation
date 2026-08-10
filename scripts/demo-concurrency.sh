#!/bin/sh
set -eu

echo 'Checking deployment readiness...'
docker compose ps
curl --fail --silent --show-error http://localhost:3000/health/ready
printf '\nRunning a short same-seat contention scenario...\n'
RATE="${RATE:-20}" DURATION="${DURATION:-15s}" PRE_ALLOCATED_VUS="${PRE_ALLOCATED_VUS:-30}" \
  MAX_VUS="${MAX_VUS:-100}" npm run load:test -- same-seat
printf '\nDemo complete: inspect load-tests/results and the audit output above.\n'
