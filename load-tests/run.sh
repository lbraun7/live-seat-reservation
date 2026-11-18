#!/bin/sh
set -eu

scenario="${1:-all}"
results_dir="${RESULTS_DIR:-./load-tests/results}"
mkdir -p "$results_dir"

run_k6() {
  script="$1"
  shift
  docker compose run --rm \
    -e RESULTS_DIR=/results \
    -e RATE="${RATE:-}" \
    -e DURATION="${DURATION:-}" \
    -e PRE_ALLOCATED_VUS="${PRE_ALLOCATED_VUS:-}" \
    -e MAX_VUS="${MAX_VUS:-}" \
    -e VUS="${VUS:-}" \
    -e ITERATIONS="${ITERATIONS:-}" \
    -e MAX_DURATION="${MAX_DURATION:-}" \
    -e SPIKE_RATE="${SPIKE_RATE:-}" \
    -e RAMP_DURATION="${RAMP_DURATION:-}" \
    -e CONNECTION_MS="${CONNECTION_MS:-}" \
    -e ADMISSION_TIMEOUT_SECONDS="${ADMISSION_TIMEOUT_SECONDS:-}" \
    -e RESULT_NAME="${RESULT_NAME:-}" \
    "$@" \
    k6 run "/scripts/$script"
}

audit() {
  docker compose exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U reservation -d reservation \
    < load-tests/audit.sql | tee "$results_dir/audit.txt"
}

case "$scenario" in
  distinct-seats | same-seat | waiting-room-spike | websocket-storm | websocket-slow-clients | duplicate-delivery | resilience)
    scripts="$scenario.js"
    ;;
  all) scripts="distinct-seats.js same-seat.js waiting-room-spike.js websocket-storm.js websocket-slow-clients.js duplicate-delivery.js" ;;
  *)
    echo "unknown scenario: $scenario" >&2
    echo "valid scenarios: all, distinct-seats, same-seat, waiting-room-spike, websocket-storm, websocket-slow-clients, duplicate-delivery, resilience" >&2
    exit 2
    ;;
esac

status=0
for script in $scripts; do
  run_k6 "$script" || status=$?
done
audit
exit "$status"
