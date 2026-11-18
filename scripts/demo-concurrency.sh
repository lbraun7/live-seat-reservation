#!/bin/sh
set -eu

echo 'Checking deployment readiness...'
docker compose ps
curl --fail --silent --show-error http://localhost:3000/health/ready
printf '\nRunning a short same-seat contention scenario...\n'
VUS="${VUS:-100}" DURATION="${DURATION:-15s}" npm run load:test -- same-seat
printf '\nDemo complete: inspect load-tests/results and the audit output above.\n'
