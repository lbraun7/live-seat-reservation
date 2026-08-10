# Resultados e evidências de carga

A suíte e os critérios estão publicados em `docs/load-testing.md`. Resultados brutos são
gerados em `load-tests/results/` para cada ambiente, porque latências sem identificação de
hardware não são comparáveis. O repositório não inventa uma baseline numérica.

Evidências automatizadas versionadas:

- contenção da mesma cadeira exige um vencedor e somente conflitos esperados;
- a auditoria SQL exige `oversold_seats=0` e `active_hold_collisions=0`;
- reinício de API, Redis/worker indisponíveis, relay interrompido e pool saturado têm
  cenários reproduzíveis em `load-tests/chaos.sh`;
- duplicação HTTP/evento/job e slow clients possuem cenários/testes dedicados.

Para publicar um resultado de ambiente, execute a matriz, mantenha os JSON gerados e
preencha `docs/load-test-report-template.md` com commit, CPU, memória, p50/p95/p99,
throughput e auditoria. Esse relatório passa a ser a baseline daquele hardware.
