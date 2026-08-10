# Load-test results and evidence

The suite and its criteria are documented in `docs/load-testing.md`. Raw results are generated in `load-tests/results/` for each environment because latency without identified hardware is not comparable. This repository does not invent a numerical baseline.

Versioned automated evidence includes:

- same-seat contention requires one winner and only expected conflicts;
- the SQL audit requires `oversold_seats=0` and `active_hold_collisions=0`;
- API restarts, unavailable Redis/workers, an interrupted relay, and a saturated pool have reproducible scenarios in `load-tests/chaos.sh`;
- duplicate HTTP requests/events/jobs and slow clients have dedicated scenarios or tests.

To publish an environment result, run the matrix, retain the generated JSON files, and complete `docs/load-test-report-template.md` with the commit, CPU, memory, p50/p95/p99, throughput, and audit output. That report becomes the baseline for that hardware.
