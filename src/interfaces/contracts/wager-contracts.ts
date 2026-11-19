import { z } from 'zod';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';

/**
 * Contratos de entrada, compartilhados entre HTTP e SQS. O formato fino do dinheiro (escala,
 * sinal, expoente) é validado por `Money.from`; aqui só se garante a forma.
 */

/** Identificador opaco do provedor: não vazio, sem espaços nas pontas (evita que "tx-1" e "tx-1 " virem ids diferentes). */
export const opaqueId = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim() === value, 'não pode ter espaços nas pontas');

export const moneyContract = z.strictObject({
  amount: z.string(),
  currency: z.string(),
});

export const wagerTransactionContract = z.strictObject({
  providerId: opaqueId(64),
  externalTransactionId: opaqueId(255),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: opaqueId(255),
  gameId: opaqueId(255),
  // OPENING passa aqui e é recusado pelo domínio com KIND_NOT_ALLOWED; tipos desconhecidos param aqui
  kind: z.enum(WagerTransactionKind),
  money: moneyContract,
  referenceExternalTransactionId: opaqueId(255).optional(),
});
export type WagerTransactionContract = z.infer<typeof wagerTransactionContract>;

/** Caracteres visíveis do ASCII, até 255. */
export const idempotencyKeyContract = z.string().regex(/^[\x21-\x7E]{1,255}$/, 'Idempotency-Key inválida');

export const createWalletContract = z.strictObject({
  playerId: z.uuid(),
  initialBalance: moneyContract,
});

export const ledgerQueryContract = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Mensagem `WagerTransactionRequested` da fila `wager-transactions.fifo` (seção 10). */
export const wagerTransactionRequestedMessage = z.strictObject({
  messageId: opaqueId(255),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.strictObject({ ...wagerTransactionContract.shape, idempotencyKey: idempotencyKeyContract }),
});
export type WagerTransactionRequestedMessage = z.infer<typeof wagerTransactionRequestedMessage>;
