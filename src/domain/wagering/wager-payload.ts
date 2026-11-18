import { createHash } from 'node:crypto';
import type { MoneyProps } from '../money/money';
import type { WagerTransactionKind } from './wager-transaction-kind';

/**
 * Subconjunto de negócio que identifica um pedido. Ficam de fora o `Idempotency-Key` e os metadados
 * de transporte (`messageId`, `occurredAt`, headers).
 */
export interface WagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}

export type CanonicalValue = string | null | { readonly [key: string]: CanonicalValue | undefined };

/**
 * JSON canônico: chaves em ordem lexicográfica em todos os níveis, sem espaços, e campos `undefined`
 * omitidos (ausente e `undefined` são a mesma coisa). Como todos os valores são strings, o resultado
 * coincide com o JCS da RFC 8785.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'string') {
    return JSON.stringify(value);
  }
  const members = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as CanonicalValue)}`);
  return `{${members.join(',')}}`;
}

/**
 * `payloadHash` = SHA-256 (hex) do JSON canônico do payload de negócio. Os campos são copiados um a um,
 * então nada além deles entra no hash, mesmo que o objeto recebido traga propriedades extras.
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
