#!/bin/sh
set -eu

echo 'Checking deployment readiness...'
docker compose ps
curl --fail --silent --show-error http://localhost:3000/health/ready
printf '\nRunning a short same-seat contention scenario...\n'
VUS="${VUS:-100}" ITERATIONS="${ITERATIONS:-1}" MAX_DURATION="${MAX_DURATION:-2m}" \
  npm run load:test -- same-seat
printf '\nDemo complete: inspect load-tests/results and the audit output above.\n'
