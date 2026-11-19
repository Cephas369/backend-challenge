import { formatCents } from './stats';

/** Desfecho de uma tentativa HTTP, do ponto de vista do cliente. */
export interface HttpOutcome {
  readonly status: number | 'connection-error';
  readonly latencyMs: number;
  readonly body: Record<string, unknown>;
  readonly retryAfterMs: number;
}

export interface WalletRef {
  readonly id: string;
  readonly playerId: string;
  readonly initialCents: bigint;
}

export type OperationKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND';

export interface Operation {
  readonly vu: number;
  readonly key: string;
  readonly kind: OperationKind;
  readonly wallet: WalletRef;
  readonly cents: bigint;
  readonly body: Readonly<Record<string, unknown>>;
  /** Reenvio de uma operação já respondida: tem de voltar como replay do original. */
  readonly duplicateOf?: SettledOperation;
}

interface SettledOperation {
  readonly operation: Operation;
  readonly transactionId: string;
  readonly httpStatus: number;
}

interface VirtualUserState {
  sequence: number;
  /** Últimas operações respondidas, candidatas a reenvio. */
  readonly history: SettledOperation[];
  /** BETs processadas que ainda não receberam REFUND. */
  readonly refundable: Operation[];
}

export interface WorkloadOptions {
  /** Prefixo dos ids, único por cenário. */
  readonly name: string;
  readonly providerId: string;
  readonly wallets: readonly WalletRef[];
  /** Peso de cada tipo; REFUND só sai quando o usuário virtual tem uma BET processada a devolver. */
  readonly mix: Readonly<Partial<Record<OperationKind, number>>>;
  /** Fração das operações que reenvia, com a mesma key e o mesmo corpo, uma operação anterior. */
  readonly duplicateRate: number;
  /** Faixa de valores, em centavos, para BET e WIN. */
  readonly betCents: readonly [number, number];
  readonly winCents: readonly [number, number];
}

const HISTORY_SIZE = 64;

/**
 * Gera as operações dos usuários virtuais e guarda, a partir só das respostas, o efeito que cada
 * wallet deve ter sofrido. No fim, o saldo no banco tem de bater com essa conta do cliente.
 */
export class Workload {
  private readonly users = new Map<number, VirtualUserState>();
  private readonly deltas = new Map<string, bigint>();
  /** Respostas que contradizem o contrato (reenvio sem replay, 4xx inesperado, etc.). */
  readonly anomalies: string[] = [];
  /** Operações que terminaram sem desfecho conhecido (o cliente desistiu de reenviar). */
  unresolved = 0;

  constructor(private readonly options: WorkloadOptions) {}

  next(vu: number): Operation {
    const user = this.userState(vu);
    const original = user.history[Math.floor(Math.random() * user.history.length)];
    if (original !== undefined && Math.random() < this.options.duplicateRate) {
      return { ...original.operation, duplicateOf: original };
    }

    let kind = this.pickKind();
    if (kind === 'REFUND' && user.refundable.length === 0) {
      kind = 'BET';
    }
    user.sequence += 1;
    const externalTransactionId = `${this.options.name}-${vu}-${user.sequence}`;
    const base = {
      providerId: this.options.providerId,
      externalTransactionId,
      gameId: 'fortune-chimp',
    };

    if (kind === 'REFUND') {
      const [bet] = user.refundable.splice(Math.floor(Math.random() * user.refundable.length), 1);
      if (bet !== undefined) {
        return this.operation(vu, kind, bet.wallet, bet.cents, {
          ...base,
          playerId: bet.wallet.playerId,
          walletId: bet.wallet.id,
          roundId: bet.body.roundId,
          referenceExternalTransactionId: bet.body.externalTransactionId,
        });
      }
    }

    const wallet = this.options.wallets[Math.floor(Math.random() * this.options.wallets.length)];
    if (wallet === undefined) {
      throw new Error('workload sem wallets');
    }
    const cents =
      kind === 'LOSS'
        ? 0n
        : BigInt(randomInt(...(kind === 'WIN' ? this.options.winCents : this.options.betCents)));
    return this.operation(vu, kind === 'REFUND' ? 'BET' : kind, wallet, cents, {
      ...base,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `${externalTransactionId}-round`,
    });
  }

  /** Registra o desfecho final da operação (depois das retentativas). */
  settle(operation: Operation, outcome: HttpOutcome): void {
    if (outcome.status === 'connection-error' || outcome.status >= 500) {
      this.unresolved += 1;
      return;
    }
    const transactionId = outcome.body.transactionId;
    const replay = outcome.body.idempotentReplay === true;

    if (operation.duplicateOf !== undefined) {
      const original = operation.duplicateOf;
      if (!replay || transactionId !== original.transactionId || outcome.status !== original.httpStatus) {
        this.anomalies.push(`reenvio de ${operation.key} não devolveu o replay do original`);
      }
      return;
    }
    if (typeof transactionId !== 'string' || (outcome.status !== 201 && outcome.status !== 422)) {
      this.anomalies.push(`${operation.key}: resposta inesperada ${outcome.status}`);
      return;
    }

    // Sem reenvio do gerador, um replay aqui só acontece se uma tentativa anterior da mesma operação
    // (sem resposta) chegou a ser aplicada: o efeito existe e conta uma vez.
    if (outcome.status === 201 && outcome.body.status === 'PROCESSED') {
      const sign = operation.kind === 'BET' ? -1n : 1n;
      this.deltas.set(
        operation.wallet.id,
        (this.deltas.get(operation.wallet.id) ?? 0n) + sign * operation.cents,
      );
      if (operation.kind === 'BET') {
        this.userState(operation.vu).refundable.push(operation);
      }
    }
    const history = this.userState(operation.vu).history;
    history.push({ operation, transactionId, httpStatus: outcome.status });
    if (history.length > HISTORY_SIZE) {
      history.shift();
    }
  }

  /** Saldo final esperado pelo cliente, em centavos. */
  expectedCents(wallet: WalletRef): bigint {
    return wallet.initialCents + (this.deltas.get(wallet.id) ?? 0n);
  }

  private operation(
    vu: number,
    kind: OperationKind,
    wallet: WalletRef,
    cents: bigint,
    fields: Record<string, unknown>,
  ): Operation {
    return {
      vu,
      key: `${this.options.providerId}:${fields.externalTransactionId}`,
      kind,
      wallet,
      cents,
      body: { ...fields, kind, money: { amount: formatCents(cents), currency: 'BRL' } },
    };
  }

  private pickKind(): OperationKind {
    const entries = Object.entries(this.options.mix) as [OperationKind, number][];
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let draw = Math.random() * total;
    for (const [kind, weight] of entries) {
      draw -= weight;
      if (draw < 0) {
        return kind;
      }
    }
    return 'BET';
  }

  private userState(vu: number): VirtualUserState {
    let state = this.users.get(vu);
    if (state === undefined) {
      state = { sequence: 0, history: [], refundable: [] };
      this.users.set(vu, state);
    }
    return state;
  }
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
