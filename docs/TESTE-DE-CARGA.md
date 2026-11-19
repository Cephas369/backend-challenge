# Teste de carga

Resultado de `bun run test:load` numa única máquina (descrita em [Ambiente](#ambiente)), com 3 instâncias reais da aplicação, PostgreSQL e MiniStack.

## Resumo

- **Correção:** em todas as rodadas, o dinheiro fechou exatamente.
  - Todas as wallets reconciliam com o ledger, e o saldo de cada uma é o que o cliente calculou pelas respostas.
  - Todo reenvio voltou como replay, cada mensagem da fila foi aplicada uma vez e cada evento publicado chegou ao consumidor.
  - Nenhuma resposta 5xx, nenhum lock timeout e nenhum conflito de versão.
- **Throughput HTTP:** 3 instâncias sustentam 860–910 operações/s.
  - Elas já estão saturadas com 16 usuários virtuais, com p50 de 18 ms e p99 de 36 ms.
  - Com 64 usuários, o throughput não muda e a latência sobe (p50 de 63–72 ms, p99 de 150–162 ms).
  - O limite é a CPU das instâncias. Com 6 instâncias, foram 1.041 op/s, e o limite passou a ser a própria máquina.
- **Hot wallet:** uma wallet sozinha fica em 150–205 op/s, porque o lock da linha serializa as operações (~5,6 ms cada). A espera não é justa: com 8 concorrentes, o p50 é 17 ms e o p99, 473 ms. Não houve lock timeout até 64 concorrentes.
- **Outbox:** a aplicação produz ~1.500 eventos/s, mas a publicação ficou presa ao emulador SQS, entre 67 e 370 eventos/s.
  - O backlog chegou a 44 mil eventos e levou ~5 minutos para esvaziar, sem perda nem duplicata no consumidor.
  - Com carga menor (hot wallet, até ~360 eventos/s), o lag ficou abaixo de 1,3 s.
- **Fila de entrada:** 300 mensagens/s, com a MiniStack a ~100% de CPU.
- **Corrigido pelo teste:** a claim da outbox não usava o índice. Com 40 mil pendentes, custava 16 ms por lote; agora custa 0,03 ms ([D27](../ARCHITECTURE.md#d27-teste-de-carga)).

## Como rodar

```bash
bun run infra:up      # PostgreSQL e MiniStack
bun run test:load     # cerca de 10 minutos; relatório e logs em load-results/<data>/
```

O script sai com código 1 se alguma invariante falhar. As opções mudam o experimento sem mexer no código:

| Opção | Padrão | O que controla |
|---|---|---|
| `--scenarios` | `distributed,hot,sqs` | quais cenários rodar |
| `--instances` | `3` | processos da aplicação |
| `--concurrency`, `--wallets`, `--duration`, `--warmup` | `64`, `500`, `30`, `5` | cenário 1 (segundos) |
| `--hot-levels`, `--hot-duration` | `1,8,32,64`, `10` | cenário 2 |
| `--sqs-messages`, `--sqs-wallets` | `3000`, `100` | cenário 3 |

Exemplo: `bun run test:load -- --scenarios=hot --hot-levels=1,16,128`. Com `SQS_ENDPOINT` apontando para outro SQS, o mesmo teste roda contra ele.

## Ambiente

Tudo na mesma máquina: o gerador de carga, as 3 instâncias, o PostgreSQL e a MiniStack disputam os mesmos 16 threads.

| Item | Valor |
|---|---|
| CPU | AMD Ryzen 7 5800X, 8 núcleos e 16 threads |
| Memória | 23,4 GiB |
| Sistema | Linux 6.18 (WSL2) |
| Bun | 1.4.4 |
| PostgreSQL | 18.4 em Docker, configuração padrão da imagem (`shared_buffers=128MB`, `synchronous_commit=on`, `max_connections=100`) |
| SQS | MiniStack 1.5.41 em Docker |
| Código | versão com o índice da claim da outbox (D27) |

## Metodologia

**O que roda.** O teste sobe processos reais da aplicação (`bun src/main.ts`), com todos os papéis e a configuração padrão do compose:
- `NODE_ENV=production` e logs JSON em nível `info`, gravados em arquivo;
- pool de 10 conexões por instância e `lock_timeout` de 2 s;
- um banco exclusivo, criado pelas migrations reais.

As wallets são criadas antes, pelo próprio use case, com saldo de 1.000.000,00, para que saldo insuficiente não interfira na medição.

**Isolamento.** Cada cenário, e cada nível da hot wallet, roda com:
- filas novas e instâncias novas;
- a outbox vazia no início.

O motivo está na análise: a MiniStack fica mais lenta conforme uma fila FIFO acumula histórico de deduplicação. Sem isolamento, cada cenário herdaria o estado deixado pelo anterior.

**Carga.** O laço é fechado: cada usuário virtual manda uma operação, espera a resposta e manda a próxima. O aquecimento não entra nas estatísticas. As tentativas alternam entre as instâncias (round-robin, sem nginx). Em resposta 503 ou queda de conexão, o cliente faz o que o contrato manda: reenvia com a mesma Idempotency-Key depois do `Retry-After`, até 5 vezes.

**Cenários.**
1. **Wallets distribuídas:** 64 usuários virtuais sobre 500 wallets, por 30 s.
   - A mistura é BET 60%, WIN 25%, LOSS 10% e REFUND 5%. O REFUND devolve uma BET processada do mesmo usuário virtual, com o mesmo valor e a mesma rodada.
   - 5% das operações reenviam uma operação anterior, com a mesma key e o mesmo corpo.
2. **Hot wallet:** todas as operações numa única wallet, com concorrência 1, 8, 32 e 64, por 10 s cada nível. São BETs e WINs de 1.00.
3. **Ingestão pela fila:** 3.000 mensagens `WagerTransactionRequested` para 100 wallets (100 grupos FIFO), enviadas em lotes de 10.
   - 2% são publicadas duas vezes, com o mesmo `messageId` e outro `MessageDeduplicationId`. A fila entrega as duas, e quem barra a repetição é a aplicação.

**Consumidor de eventos.** Seis laços consomem `wagering-events.fifo`, no papel dos consumidores downstream. Eles deduplicam por `eventId` e permitem conferir que cada evento publicado chegou.

**Como cada número é obtido.**

| Medida | Origem |
|---|---|
| Throughput | operações com desfecho final dentro da janela ÷ duração da janela |
| Latência no cliente | todas as tentativas iniciadas na janela; percentis exatos (nearest-rank) sobre as amostras completas |
| Processamento no servidor | crescimento do histograma `wagering_processing_duration_seconds` durante a janela, somado entre instâncias; percentis estimados por interpolação dentro dos buckets (5, 10, 25, 50, 100, 250, 500 ms, 1, 2,5 e 5 s), então a precisão é a dos buckets |
| Taxa de erro | tentativas com 5xx ou sem resposta ÷ tentativas |
| Conflitos de concorrência | crescimento de `wagering_lock_conflicts_total` (lock timeout e conflito de versão) e de `wagering_retries_total` |
| Outbox lag | `published_at − occurred_at` de cada evento gerado na janela, lido no banco depois que a outbox drena; o pico de pendentes vem de uma amostra por segundo |
| CPU | `/proc` das instâncias e `process.cpuUsage` do cliente; para o PostgreSQL e a MiniStack, uma amostra do `docker stats` no meio da janela; sempre em % de um núcleo |

**Invariantes conferidas no fim.** O teste só vale se o dinheiro fechar:
- todas as wallets reconciliam com o ledger;
- o saldo final de cada wallet é exatamente o que o cliente calculou a partir das respostas;
- todo reenvio devolveu o replay do original;
- nenhuma operação ficou sem desfecho;
- todas as mensagens da fila foram decididas uma única vez;
- a DLQ está vazia;
- a outbox drenou;
- cada evento publicado chegou ao consumidor.

**Limites da metodologia.**
- **Uma máquina só:** cliente, aplicação, banco e emulador competem por CPU, e não há latência de rede real entre eles. O PostgreSQL roda em Docker sobre WSL2.
- **MiniStack não é o SQS:** é um emulador em Python, com um custo de deduplicação que o SQS não tem (veja a análise). Os números da outbox e da fila valem para este ambiente, não para a AWS.
- **Laço fechado:** os percentis descrevem a latência naquela concorrência, e não sob uma taxa de chegada fixa. Saturado, o cliente se autorregula (*coordinated omission*). Não houve teste de taxa constante.
- **Rodadas curtas:** a janela é de 30 s, e cada configuração rodou uma vez por rodada completa. Não houve teste de longa duração (vazamento de memória, inchaço de tabela, vacuum). A variação entre rodadas aparece na análise.

## Resultados

Latências em ms, no formato p50 / p95 / p99 / máx. Os relatórios completos ficam em `load-results/<data>/report.md`, com o JSON e os logs das instâncias, e não são versionados.

### Cenário 1: wallets distribuídas

| Rodada | Instâncias | Usuários virtuais | Throughput | Latência no cliente | Erros | Conflitos | CPU por instância |
|---|---|---|---|---|---|---|---|
| completa (a de referência) | 3 | 64 | 889 op/s | 71,8 / 124,7 / 162,1 / 192,1 | 0 | 0 | 115–116% |
| só o cenário 1 | 3 | 64 | 914 op/s | 62,7 / 139,0 / 151,5 / 231,0 | 0 | 0 | 114–115% |
| só o cenário 1 | 3 | 16 | 863 op/s | 17,8 / 28,7 / 35,8 / 64,3 | 0 | 0 | 110–111% |
| só o cenário 1, janela de 15 s | 6 | 64 | 1.041 op/s | 57,4 / 106,5 / 139,7 / 279,4 | 0 | 0 | 99–101% |

Na rodada de referência:
- **Respostas:** 25.327 operações novas e 1.348 replays (os 5% de reenvios). Todos os reenvios foram reconhecidos já na pré-checagem, sem pegar o lock; o contador do servidor marcou 1.351 na janela.
- **Replays × operações novas:** os replays custaram menos da metade (p50 de 30,5 ms contra 74,7 ms).
- **Onde fica o tempo:** a média de processamento no servidor (69,3 ms, exata: soma ÷ contagem do histograma) fica a ~2,6 ms da média no cliente (71,9 ms). O tempo está dentro do use case, e não no HTTP.
- **Percentis do histograma:** o p95 estimado pelo histograma do servidor (208 ms) passa do p95 medido no cliente (125 ms). É o erro da interpolação no bucket largo de 100–250 ms, e por isso os percentis do cliente são a referência.
- **CPU fora da aplicação:** PostgreSQL a 253% de um núcleo, MiniStack a 102% e o cliente a 25%.

### Cenário 2: hot wallet

Rodada de referência; a média entre parênteses é a que a lei de Little prevê (concorrência ÷ throughput):

| Concorrência | Throughput | Latência no cliente | Média | Erros | Lock timeouts | Outbox lag p50 / p95 |
|---|---|---|---|---|---|---|
| 1 | 109 op/s | 8,7 / 12,1 / 15,6 / 23,4 | 9,1 ms (9,2) | 0 | 0 | 252 / 478 ms |
| 8 | 178 op/s | 16,9 / 227,9 / 472,8 / 643,0 | 44,6 ms (44,9) | 0 | 0 | 24 / 263 ms |
| 32 | 165 op/s | 24,8 / 577,8 / 615,8 / 682,6 | 189 ms (194) | 0 | 0 | 189 / 423 ms |
| 64 | 151 op/s | 470,5 / 869,1 / 987,3 / 1.126 | 420 ms (424) | 0 | 0 | 331 / 1.097 ms |

Nas quatro rodadas que incluíram a hot wallet, o throughput ficou entre 107 e 119 op/s com concorrência 1, e entre 151 e 204 op/s a partir de 8.

### Cenário 3: ingestão pela fila

| Medida | Valor |
|---|---|
| Mensagens | 3.000 únicas, mais 67 duplicatas com o mesmo `messageId` |
| Envio | 1,6 s |
| Throughput | 304 mensagens/s (tudo decidido em 9,9 s) |
| Envio → início do processamento | 4.744 / 7.984 / 8.289 / 8.371 ms (as mensagens chegam mais rápido do que são consumidas) |
| Processamento por mensagem (média no servidor) | 32,9 ms |
| Desfechos | 3.000 PROCESSED; as 67 duplicatas reconhecidas, nenhuma aplicada duas vezes |
| CPU | instâncias 77%, PostgreSQL 89%, MiniStack 98% |

### Publicação da outbox ao longo do tempo

Rodada só do cenário 1 com 64 usuários virtuais. A carga ocupa os primeiros 30 s; o resto é a outbox esvaziando. A sonda mede, a cada 2 s, um `SendMessageBatch` de 10 mensagens na mesma fila de eventos em que os publishers escrevem.

| Faixa | Eventos publicados/s | Sonda do broker (p50) |
|---|---|---|
| 0–30 s (com carga) | 285 | 68 ms |
| 30–60 s | 362 | 89 ms |
| 60–90 s | 202 | 160 ms |
| 90–120 s | 176 | 176 ms |
| 150–180 s | 114 | 275 ms |
| 210–240 s | 81 | 392 ms |
| 300–330 s | 67 | 462 ms |

No total, 45.669 eventos tiveram lag de 85,8 / 270,3 / 296,5 / 302,6 s, com pico de 44.307 pendentes, e a outbox esvaziou 301 s depois do fim da carga. Com 16 usuários virtuais, o quadro foi o mesmo, porque a produção de eventos é praticamente igual (863 contra 914 op/s).

### Micro-medições

Com `bun run test:load:micro`, com a máquina sem outra carga:

| Medida | p50 | p99 |
|---|---|---|
| PostgreSQL, ida e volta (`select 1`) | 0,19 ms | 0,37 ms |
| PostgreSQL, ida e volta pela MikroORM, como na aplicação | 0,26 ms | 0,48 ms |
| PostgreSQL, `begin` + `insert` + `commit` (com fsync) | 1,22 ms | 2,01 ms |
| Claim da outbox com 40 mil pendentes, índice atual | 0,033 ms (index scan) | — |
| Claim da outbox com 40 mil pendentes, índice original | 15,9 ms (seq scan + ordenação em disco de 4,4 MB) | — |
| MiniStack, `SendMessageBatch` de 10 numa fila FIFO nova | 2,35 ms | 5,70 ms |
| … depois de 5 mil mensagens | 9,29 ms | 10,58 ms |
| … depois de 15 mil mensagens | 22,92 ms | 34,84 ms |
| … na mesma fila depois de esvaziada | 23,29 ms | 31,54 ms |

A linha do índice original foi medida antes da migration, com o mesmo `EXPLAIN ANALYZE`.

## Análise

### 1. Correção sob carga

As invariantes passaram em todas as rodadas, e a do saldo é a mais forte. O cliente calcula o saldo de cada wallet só a partir das próprias respostas; o resultado bate, centavo por centavo, com o banco. Isso só acontece se cada operação teve exatamente um efeito, inclusive as reenviadas.

Não houve conflito de versão: o `FOR UPDATE` serializa a wallet antes de a guarda de versão ser consultada. A guarda continua como rede de segurança e não disparou.

### 2. Throughput HTTP: o limite é a CPU das instâncias

- **Saturação:** de 16 para 64 usuários virtuais, o throughput cresceu 6% e a latência quadruplicou. O sistema já estava saturado com 16, e o excedente só formou fila. As médias batem com a lei de Little (16 ÷ 863 = 18,5 ms; 64 ÷ 914 = 70 ms).
- **Onde está o limite:**
  - cada instância ficou em ~110–116% de um núcleo. O Bun executa o JavaScript numa thread só, e o excedente é de threads auxiliares (GC, I/O), então a thread JS está cheia;
  - o PostgreSQL, a 240–270% de um núcleo numa máquina de 16 threads, e o cliente, a 25%, não são o limite.
- **Custo por operação:** cerca de 3,8 ms de CPU da aplicação (3 × 1,12 núcleo ÷ ~880 op/s). Isso inclui HTTP e Nest, validação, hash canônico, cerca de 18 comandos SQL pela MikroORM em duas transações (a pré-checagem e a escrita), logs, métricas e a publicação de ~1,7 evento por operação. A divisão desse custo não foi medida; um perfil de CPU é o próximo passo.
- **Por que a espera aparece dentro do use case:** com a thread cheia, cada `await` espera a vez no event loop segurando uma conexão do pool, e as requisições seguintes esperam conexão.
- **Escala horizontal:** com 6 instâncias, o throughput subiu só 14–20% (1.041 op/s). Cada instância continuou saturada, mas passou a gastar 5,8 ms de CPU por operação, contra 3,8 ms. É o sinal de disputa por núcleo físico: a máquina tem 8 núcleos para o cliente, 6 instâncias, o PostgreSQL (330%) e a MiniStack. A aplicação não guarda estado em memória, então escala horizontalmente até o banco, mas medir isso exige máquinas separadas.

### 3. Hot wallet: o lock da linha serializa a wallet

- **Teto:** a partir de 8 concorrentes, o throughput para em 150–205 op/s, ou seja, ~5,6 ms por operação com o lock da linha seguro (1 ÷ 178).
- **De onde vêm os 5,6 ms:** numa BET ou num WIN, há 9 comandos entre o lock e o commit:
  - o próprio lock e a releitura da key e do `externalTransactionId`;
  - os inserts da transação, do lançamento e dos eventos da outbox (os eventos num insert só);
  - os updates do saldo e das referências pendentes;
  - o commit.

  Num REFUND, a resolução da referência acrescenta 2. Isso dá ~2,3 ms de idas e voltas (~0,26 ms cada), ~1 ms de commit com fsync, e o restante é JavaScript entre um `await` e outro (mapeamento, regras, montagem dos eventos).
- **A latência cresce com a concorrência, como a lei de Little prevê,** e a fila do lock não é justa:
  - com 8 concorrentes, o p50 é 17 ms e o p99, 473 ms, quando uma fila justa daria ~45 ms a todos;
  - é compatível com o funcionamento do PostgreSQL: quem é acordado depois de um commit precisa seguir a cadeia de versões até a linha nova, e quem chega nessa hora lê a versão nova direto e pode pegar o lock primeiro. O teste mostra o efeito, não a causa: não há instrumentação de locks.
- **Até onde vai:** não houve lock timeout até 64 concorrentes (o máximo foi 1,1 s, para um `lock_timeout` de 2 s). Acima disso, a resposta seria 503 `LOCK_TIMEOUT`, e o reenvio com a mesma key é seguro, como os testes de concorrência já mostram.
- **No contexto:** uma wallet de jogador raramente passa de algumas operações por segundo, então 150 op/s é folga grande. Uma wallet da casa (um jackpot, por exemplo) precisaria de outra estratégia:
  - encurtar a seção crítica (menos idas ao banco, por exemplo combinando os inserts num só comando);
  - ou agrupar várias operações da mesma wallet numa transação, trocando latência por throughput.
- **Risco não medido:** as requisições que esperam o lock seguram conexões do pool. Uma wallet muito disputada pode esgotar o pool de uma instância e atrasar outras wallets na mesma instância. O cenário misto não foi medido.

### 4. Outbox: neste ambiente, quem dita a publicação é o emulador

A aplicação produziu ~1.500 eventos/s no cenário 1, e a publicação não acompanhou. Quatro evidências apontam para a MiniStack:
1. **Micro-medição:** o mesmo `SendMessageBatch` sai de 2,35 ms numa fila nova para 23 ms depois de 15 mil mensagens, e continua em 23 ms com a fila vazia. O custo cresce com o histórico de deduplicação da fila, não com a profundidade. Uma fila diferente continua rápida.
2. **Na rodada:** a sonda do broker vai de 68 ms a 462 ms enquanto a publicação cai de 362 para 67 eventos/s. Três publishers sequenciais × 10 eventos ÷ 0,462 s dá 65 eventos/s; a medida foi 67. A taxa de publicação é a latência do broker.
3. **CPU:** a MiniStack ficou em 100–114% de um núcleo, perto do teto prático de um processo Python, que executa o interpretador num núcleo por vez.
4. **Com carga menor:** na hot wallet, com até ~360 eventos/s e filas novas, o lag ficou em p50 24–331 ms.

**O que isso garante e o que não garante:**
- **Garante:** nada se perdeu e nada se duplicou. Os 75 mil eventos da rodada de referência chegaram ao consumidor, cada um uma vez. A API também não espera a publicação, porque o evento é só uma linha gravada na mesma transação.
- **Não garante:** o lag de minutos seria inaceitável para quem consome os eventos.

O SQS da AWS não tem esse custo crescente de deduplicação, mas mesmo assim a capacidade do publisher é finita. Por exemplo, se cada envio levasse 20 ms, 3 publishers sequenciais publicariam até ~1.500 eventos/s, no limite do que o cenário 1 produz. Os próximos passos são:
- vários laços de publicação por instância (o `SKIP LOCKED` já permite);
- marcar o lote como publicado num único `UPDATE`, em vez de um por evento;
- não segurar a transação durante o envio pela rede (claim com prazo de reserva);
- alertar no `wagering_outbox_lag_seconds`.

Na faixa de 0–30 s, com carga, a publicação foi menor que na seguinte (285 contra 362 eventos/s): durante a carga, o publisher também disputa a thread JS com a API.

**O índice corrigido** vale com qualquer broker. Sem ele, cada claim ordenava todo o backlog, de modo que, quanto maior o atraso, mais lenta ficava a publicação, justamente quando ela é mais necessária.

### 5. Fila de entrada

- **Ingestão:** 304 mensagens/s, com a MiniStack a 98% de CPU, as instâncias a 77% e o PostgreSQL a 89%. De novo o emulador é o primeiro a encostar no teto.
- **Custo por mensagem:** 33 ms em média, contra ~8 ms de uma operação HTTP isolada, porque cerca de 30 mensagens rodam ao mesmo tempo (3 consumers × 10 por recebimento) disputando o pool e o banco.
- **Ordem por wallet:** mensagens da mesma wallet saem em ordem pela própria fila FIFO, então o paralelismo é limitado a consumers × lote.
- **Próximos passos:**
  - apagar as mensagens em lote (`DeleteMessageBatch`, hoje é uma chamada por mensagem);
  - mais laços de consumo por instância.

### 6. Variação entre rodadas

- **Cenário 1 com 64 usuários:** 782, 802, 889 e 914 op/s. As duas primeiras rodadas foram antes do isolamento entre cenários e do índice da claim, com a outbox e o emulador mais carregados durante a medição.
- **Hot wallet:** variou ~20% entre rodadas.

Com tudo na mesma máquina, os números valem como ordem de grandeza, não como capacidade exata.

### 7. O que não foi medido

- **SQS de verdade ou outro emulador:** separaria de vez o limite da publicação do limite da MiniStack.
- **Cenário misto:** hot wallet e wallets distribuídas ao mesmo tempo, para medir o efeito do pool compartilhado.
- **Carga a taxa constante e testes longos:** mostrariam memória, inchaço de tabela e vacuum.
- **Perfil de CPU da aplicação:** mostraria onde vão os 3,8 ms por operação.
- **Máquinas separadas:** cliente, aplicação, banco e broker em máquinas diferentes, com latência de rede real.

## Comandos destas rodadas

```bash
bun run test:load                                              # rodada completa (a de referência)
bun run test:load -- --scenarios=distributed                   # cenário 1 isolado, 64 usuários virtuais
bun run test:load -- --scenarios=distributed --concurrency=16
bun run test:load -- --scenarios=distributed --instances=6 --duration=15
bun run test:load:micro                                        # micro-medições
```
