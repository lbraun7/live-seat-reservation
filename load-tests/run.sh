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
