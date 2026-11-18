# Arquitetura

Este documento registra as decisões técnicas do Distributed Wagering Processor à medida que são tomadas: o contexto, a escolha e o que ela implica.

**Estado atual:** há o esqueleto da aplicação, a infraestrutura local, os health checks e os testes que validam as premissas da stack. O domínio ainda não foi implementado.

## Estrutura

```
src/
  domain/          TypeScript puro
  application/     use cases e portas
  infrastructure/  config, observabilidade, persistência (MikroORM), SQS
  interfaces/      HTTP (health, correlation id)
test/
  unit/            sem dependências externas
  integration/     PostgreSQL e MiniStack reais
  support/         bancos e filas descartáveis, processo real da aplicação, waitFor
```

A regra de dependência (`domain ← application ← infrastructure/interfaces`) é verificada por [um teste de arquitetura](test/unit/architecture/boundaries.test.ts). O domínio e a aplicação não podem importar Nest, MikroORM, AWS SDK, pino, zod nem as camadas externas, inclusive em imports só de tipo.

## Decisões

### D1. Runtime, framework e compilação

- O Bun 1.4.4 executa TypeScript direto, sem etapa de build. O framework é o NestJS 12 (ESM).
- O TypeScript 7 (compilador nativo) só faz o type-check (`bun run typecheck`), porque o Bun transpila sem checar tipos.
- O Nest usa decorators legados com `emitDecoratorMetadata`. Verificamos que o Bun emite o `design:paramtypes` que a injeção por classe exige.
- `verbatimModuleSyntax` impede que o import de uma classe usada na injeção seja apagado. Por isso a regra `useImportType` do Biome está desligada: ela converteria esses imports em `import type` e quebraria a injeção.

### D2. Emulador SQS: MiniStack, não LocalStack

- **Contexto:** a LocalStack atual (2026.10.8) encerra com código 55 sem `LOCALSTACK_AUTH_TOKEN`. Usá-la obrigaria quem avalia o projeto a criar uma conta.
- **Decisão:** MiniStack 1.5.41, livre e compatível com a API do SQS na mesma porta 4566. O endpoint vem de `SQS_ENDPOINT`, então trocar de emulador ou usar a AWS real não muda código.
- **Verificado** em [test/integration/infra/sqs.test.ts](test/integration/infra/sqs.test.ts), porque o resto do desenho depende disso:
  - dedup FIFO por `MessageDeduplicationId`;
  - ordem por `MessageGroupId` e bloqueio do grupo enquanto há mensagem em voo;
  - `ChangeMessageVisibility` com `ApproximateReceiveCount` crescente;
  - redrive para a DLQ depois de `maxReceiveCount`.

### D3. PostgreSQL 18 e MikroORM 7

O MikroORM é o ORM preferencial do enunciado. Três comportamentos da versão 7, verificados em [test/integration/infra/postgres.test.ts](test/integration/infra/postgres.test.ts), afetam o desenho:

1. **`numeric` chega como string.** O driver só reescreve os parsers de data, timestamp e interval. Valores como `99999999999999999.99` voltam exatos, e dinheiro nunca passa por `number`.
2. **Lock timeout não tem exceção própria.** O SQLSTATE `55P03` chega como `DriverException` genérica com `code = '55P03'`, e não como `LockWaitTimeoutException`. Já `40001` e `40P01` viram `DeadlockException`. O classificador de erros transitórios decide pelo SQLSTATE, não pela classe.
3. **A conexão é preguiçosa.** `MikroORM.init` não conecta; a primeira query é que abre o pool. A aplicação sobe com o banco fora do ar e o readiness acusa a falha. Antes da primeira query, `checkConnection()` responde "Connection not established", por isso o readiness faz um `select 1` real.

Configuração adotada:
- `allowGlobalContext: false`: todo acesso ao `EntityManager` passa por um fork explícito.
- `ensureDatabase: false`: a aplicação nunca cria banco.
- `forceUtcTimezone: true`.

### D4. Migrations

- O SQL é escrito à mão em `up()` e `down()`, porque índices parciais, triggers e constraints compostas não saem do diff do ORM.
- As migrations ficam numa lista explícita (`migrationsList`), sem glob nem snapshot.
- O executor é programático (`bun run db:migrate`, `db:rollback`, `db:pending`). No compose ele roda como serviço one-shot antes da aplicação, o que evita corrida entre réplicas aplicando migrations ao mesmo tempo.
- Há um teste que faz up → down → up num banco descartável.

### D5. Observabilidade (base)

- **Logs:** pino em JSON no stdout. O contexto de correlação (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`) vive num `AsyncLocalStorage` e entra em todo log pelo `mixin`.
- **Redação:** `payload`, `body`, `money`, `amount`, `balance` e `authorization` saem como `[REDACTED]`.
- **`X-Correlation-Id`:** é aceito se tiver até 128 caracteres de um conjunto seguro; caso contrário, é gerado um UUIDv7. O id sempre volta na resposta.
- **Health:** `/health/live` não consulta dependências. `/health/ready` faz `select 1` no PostgreSQL e `GetQueueUrl` no SQS, cada um com timeout próprio (`HEALTH_CHECK_TIMEOUT_MS`), e responde 503 se algum falhar.
- **Shutdown:** no SIGTERM, o Nest roda os hooks, fecha o cliente SQS e o pool do banco e termina. Com `docker stop`, isso leva cerca de 0,3 s.

### D6. Testes e ferramentas

- Os testes de integração usam PostgreSQL e MiniStack reais, sem mocks. Cada suíte cria um banco próprio e filas com nome único e remove tudo no fim. As filas não são reaproveitadas porque `PurgeQueue` só pode rodar a cada 60 s.
- O teste de shutdown sobe a aplicação como processo real (`Bun.spawn`) e lê os logs JSON do stdout.
- O Biome cuida do lint e da formatação, só em `src/`, `test/` e nos JSONs da raiz.
- O CI (GitHub Actions) roda typecheck, lint e testes de unidade, e depois os testes de integração contra o compose.

## Trade-offs registrados

- **Readiness inclui o SQS** porque o enunciado pede (seção 9). A API conseguiria aceitar transações com o SQS fora, já que os eventos ficam na outbox. Em produção, o readiness seria separado por papel (API, consumer, publisher).
