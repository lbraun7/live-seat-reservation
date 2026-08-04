export function summary(name, data) {
  const directory = __ENV.RESULTS_DIR || '/results';
  return {
    stdout: `${name}: ${JSON.stringify(compact(data.metrics))}\n`,
    [`${directory}/${name}.json`]: JSON.stringify(data, null, 2),
  };
}

function compact(metrics) {
  const names = [
    'http_reqs',
    'http_req_failed',
    'http_req_duration',
    'checks',
    'iterations',
    'vus_max',
    'ws_sessions',
    'ws_connecting',
    'expected_hold_conflicts',
    'unexpected_hold_results',
  ];
  return Object.fromEntries(
    names.filter((name) => metrics[name]).map((name) => [name, metrics[name].values]),
  );
}
