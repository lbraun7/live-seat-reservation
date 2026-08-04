#!/bin/sh
set -eu

experiment="${1:-}"
results_dir="${RESULTS_DIR:-./load-tests/results}"
mkdir -p "$results_dir"

case "$experiment" in
  redis-unavailable) target=redis; action=pause; outage=20; default_duration=2m ;;
  worker-unavailable) target=worker; action=stop; outage=180; default_duration=4m ;;
  api-restart) target=api; action=restart; outage=0; default_duration=2m ;;
  outbox-interrupted) target=outbox-relay; action=stop; outage=30; default_duration=2m ;;
  postgres-pool-saturation) target=postgres; action=none; outage=0; default_duration=2m ;;
  *)
    echo "usage: $0 {redis-unavailable|worker-unavailable|api-restart|outbox-interrupted|postgres-pool-saturation}" >&2
    exit 2
    ;;
esac

cleanup() {
  case "$action" in
    pause) docker compose unpause "$target" >/dev/null 2>&1 || true ;;
    stop) docker compose start "$target" >/dev/null 2>&1 || true ;;
  esac
}
trap cleanup EXIT INT TERM

docker compose run --rm \
  -e RESULTS_DIR=/results \
  -e RESULT_NAME="$experiment" \
  -e DURATION="${DURATION:-$default_duration}" \
  -e RATE="${RATE:-100}" \
  k6 run /scripts/resilience.js &
k6_pid=$!

sleep "${WARMUP_SECONDS:-15}"
case "$action" in
  pause) docker compose pause "$target" ;;
  stop) docker compose stop "$target" ;;
  restart) docker compose restart "$target" ;;
  none) : ;;
esac

if [ "$outage" -gt 0 ]; then
  sleep "${OUTAGE_SECONDS:-$outage}"
  cleanup
fi

status=0
wait "$k6_pid" || status=$?
trap - EXIT INT TERM
cleanup
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U reservation -d reservation \
  < load-tests/audit.sql | tee "$results_dir/$experiment-audit.txt"
exit "$status"
