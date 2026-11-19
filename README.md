# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e pela fila SQS. Saldo, ledger e eventos continuam corretos com mensagens duplicadas, fora de ordem ou simultâneas, e com várias instâncias rodando ao mesmo tempo.

- Enunciado do desafio: [docs/CHALLENGE.md](docs/CHALLENGE.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)

**Stack:** Bun 1.4.4, TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 18, SQS via [MiniStack](https://github.com/ministackorg/ministack) e Docker Compose.

## O que está implementado

| Área da avaliação | Onde ver |
|---|---|
| Correção financeira | `Money` em `bigint` de centavos, sem arredondamento; ledger imutável e encadeado; reconciliação que só sinaliza ([D7, D8, D13, D19](ARCHITECTURE.md)) |
| Concorrência | lock por wallet com `READ COMMITTED`, guarda de versão e `CHECK` no banco; testado com 50 apostas idênticas, o cenário 100/80/80 e 3 processos reais ([D15, D24](ARCHITECTURE.md)) |
| Idempotência | key e `externalTransactionId` únicos no banco, `payloadHash` canônico e replay com o saldo da época ([D9, D17](ARCHITECTURE.md)) |
| Mensageria e falhas | inbox e outbox na transação do efeito, `SKIP LOCKED`, DLQ com motivo, referências fora de ordem com TTL, shutdown gracioso, queda entre commit e ack ([D20–D24](ARCHITECTURE.md)) |
| Modelagem e arquitetura | domínio puro em `src/domain`, portas em `src/application` e um teste que barra dependência indevida entre camadas |
| Testes | mais de 320 testes; PostgreSQL e SQS reais, sem mocks de infraestrutura |
| Observabilidade | logs JSON com correlação e sem valores financeiros, `/metrics` e health de liveness e readiness ([D5, D25](ARCHITECTURE.md)) |

## Subir tudo

Requisito: Docker com Compose v2.

```bash
docker compose up -d --build --wait
```

Esse comando:
- sobe o PostgreSQL e a MiniStack;
- cria as filas FIFO (`wager-transactions.fifo` e a DLQ com redrive, `wagering-events.fifo`);
- aplica as migrations;
- cria o usuário de banco da aplicação, com privilégio mínimo;
- sobe 3 réplicas da aplicação atrás de um nginx em `http://127.0.0.1:3000`.

Cada réplica roda API, consumer SQS, publisher da outbox e worker de referências pendentes.

| Porta no host (127.0.0.1) | Serviço | Variável para trocar |
|---|---|---|
| 3000 | API (nginx → réplicas) | `APP_HOST_PORT` |
| 55432 | PostgreSQL | `POSTGRES_HOST_PORT` |
| 4566 | MiniStack (SQS) | `SQS_HOST_PORT` |

Para parar: `docker compose down`. Para apagar também os dados: `docker compose down -v`.

## Exemplos

```bash
# criar a wallet; o saldo inicial gera a transação OPENING e o crédito no ledger
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# apostar (use o id devolvido acima); repetir o mesmo comando devolve o mesmo resultado com "idempotentReplay": true
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# consultas
curl -s localhost:3000/wallets/<walletId>
curl -s "localhost:3000/wallets/<walletId>/ledger?limit=50"
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation

# operação (sem autenticação)
curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics
```

As respostas seguem a [D18](ARCHITECTURE.md#d18-contrato-http):
- 201 processada, 202 aguardando referência, 422 rejeitada por regra de negócio (com `failureCode`);
- 400 payload inválido, 404 inexistente, 409 conflito;
- 503 falha transitória, que deve ser reenviada com a mesma key.

### Pela fila

```bash
cp .env.example .env    # o script lê a configuração local
bun run sqs:send -- <walletId> <playerId> BET 25.00
```

O script publica uma mensagem `WagerTransactionRequested` em `wager-transactions.fifo`, no formato da seção 10, e a imprime. Uma das réplicas consome a mensagem, e o resultado aparece em `GET /providers/provider-a/wagering/transactions/<externalTransactionId>`.

Com a AWS CLI, o equivalente é este comando, com `mensagem.json` no formato que o script imprime:

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws --endpoint-url http://127.0.0.1:4566 --region us-east-1 \
  sqs send-message --queue-url http://127.0.0.1:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 --message-body file://mensagem.json
```

## Desenvolvimento

Requisitos: Bun 1.4.4 e Docker.

```bash
bun install
cp .env.example .env
bun run infra:up                          # só PostgreSQL e MiniStack
bun run sqs:setup && bun run db:migrate
bun run dev                               # todos os papéis num processo, com reload
```

`APP_ROLES` escolhe o que a instância roda (`api`, `consumer`, `outbox`, `pending-ref`). As demais variáveis estão comentadas no [.env.example](.env.example).

## Testes

```bash
bun run infra:up           # os testes de integração usam PostgreSQL e MiniStack reais
bun run test               # tudo (cerca de 1 minuto)
bun run test:unit          # domínio e bordas, sem infraestrutura
bun run test:integration   # schema, repositórios, API, consumer, outbox, worker, shutdown
bun run test:concurrency   # paralelismo real e processos reais
bun run typecheck && bun run lint
```

Cada suíte de integração cria um banco e filas próprios e remove tudo no fim. Ao final dos testes de API e de concorrência, a invariante `wallet.balance == saldo reconstruído pelo ledger` é conferida pela própria reconciliação. Os testes rodam com os logs desligados; para ligá-los, use `TEST_LOG_LEVEL=debug`.

Onde estão os testes obrigatórios da seção 13:

| Exigência | Arquivo |
|---|---|
| Money, Wallet, regras por tipo, conflito de moeda, key com payload divergente | [test/unit/domain](test/unit/domain) |
| Migrations e constraints | [test/integration/persistence/schema.test.ts](test/integration/persistence/schema.test.ts) |
| Atomicidade entre wallet, ledger, inbox e outbox | [test/integration/persistence/repositories.test.ts](test/integration/persistence/repositories.test.ts) |
| Inbox, redelivery, retry e DLQ | [test/integration/messaging/consumer.test.ts](test/integration/messaging/consumer.test.ts) |
| Concorrência 6 (dois publishers sobre a mesma outbox) e morte entre o envio e o commit | [test/integration/messaging/outbox.test.ts](test/integration/messaging/outbox.test.ts) |
| Concorrência 7 (REFUND antes da BET), TTL e dois workers ao mesmo tempo | [test/integration/messaging/pending-references.test.ts](test/integration/messaging/pending-references.test.ts) |
| Shutdown gracioso | [test/integration/process/shutdown.test.ts](test/integration/process/shutdown.test.ts) |
| Concorrência 1 a 3 (50× em paralelo, 100/80/80, wallets em paralelo) | [test/concurrency/http-concurrency.test.ts](test/concurrency/http-concurrency.test.ts) |
| Concorrência 4, 5 e 8 (3 processos, morte entre commit e ack, `SIGKILL` em todas e restart) | [test/concurrency/multi-instance.test.ts](test/concurrency/multi-instance.test.ts) |

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | aplicação com reload / sem reload |
| `bun run infra:up` / `bun run infra:down` | sobe / derruba PostgreSQL e MiniStack |
| `bun run sqs:setup` | cria ou converge as filas |
| `bun run db:migrate` / `db:rollback` / `db:pending` | aplica / reverte a última / lista as migrations |
| `bun run sqs:send -- <walletId> <playerId> [kind] [valor] [referência]` | envia uma mensagem de exemplo à fila |
| `bun run sqs:dlq` | mostra até 10 mensagens da DLQ com o motivo, sem removê-las |
| `source scripts/demo.sh` | helpers de shell para demonstrar a API pelo terminal |
| `bun run test` / `test:unit` / `test:integration` / `test:concurrency` | testes |
| `bun run typecheck` / `bun run lint` / `bun run lint:fix` | TypeScript 7 sem emitir; Biome |

## Estrutura

```
src/
  domain/          TypeScript puro: Money, Wallet, ledger, WagerTransaction, regras, eventos, inbox/outbox
  application/     use cases e portas (persistência, relógio, ids, métricas, identidade do provedor)
  infrastructure/  config, logs e métricas, MikroORM (schema, migrations, repositórios), SQS
  interfaces/      HTTP, consumer SQS e workers
test/              unit, integration, concurrency e support (bancos, filas e processos descartáveis)
scripts/           envio de mensagem de exemplo, leitura da DLQ e helpers da demonstração
infra/             nginx e o usuário de banco da aplicação
docs/              enunciado do desafio
```

## Notas

- **MiniStack em vez de LocalStack:** a LocalStack atual não sobe sem conta (`LOCALSTACK_AUTH_TOKEN`). A MiniStack é livre, e os recursos usados (FIFO, dedup, redrive, visibilidade) estão validados por teste ([D2](ARCHITECTURE.md#d2-emulador-sqs-ministack-não-localstack)).
- **Autenticação:** não implementada, por decisão. O desenho e o ponto de extensão estão na [D26](ARCHITECTURE.md#d26-autenticação).
- **Teste de carga:** é opcional e não foi feito; está entre os próximos passos do [ARCHITECTURE.md](ARCHITECTURE.md#limitações-conhecidas-e-próximos-passos).
