# ADR 003 — Monólito modular em processos especializados

**Status:** aceito.

Um código-base e um schema reduzem custo transacional e operacional. API, gateway, worker,
relay e controlador têm imagens/alvos e escalas independentes. A troca é acoplamento de
deploy; contratos de módulo e migrations controladas preparam uma extração futura sem
introduzir microsserviços prematuramente.
