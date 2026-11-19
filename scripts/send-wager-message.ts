import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/infrastructure/config/config';
import { QueueUrls } from '../src/infrastructure/sqs/queue-urls';
import { createSqsClient } from '../src/infrastructure/sqs/sqs.client';

/**
 * Envia uma mensagem `WagerTransactionRequested` para a fila de entrada (útil sem a AWS CLI).
 *   bun run sqs:send -- <walletId> <playerId> [BET|WIN|LOSS|REFUND|ROLLBACK] [valor] [referência]
 */
const [walletId, playerId, kind = 'BET', amount = '25.00', reference] = process.argv.slice(2);
if (walletId === undefined || playerId === undefined) {
  console.error(
    'uso: bun run sqs:send -- <walletId> <playerId> [kind] [valor] [referenceExternalTransactionId]',
  );
  process.exit(2);
}

const config = loadConfig(process.env);
const client = createSqsClient(config.sqs);
const externalTransactionId = `tx-${Bun.randomUUIDv7()}`;
const message = {
  messageId: `msg-${Bun.randomUUIDv7()}`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  },
};

try {
  await client.send(
    new SendMessageCommand({
      QueueUrl: await new QueueUrls(client).get(config.sqs.wagerQueue),
      MessageBody: JSON.stringify(message),
      MessageGroupId: walletId,
      MessageDeduplicationId: message.messageId,
    }),
  );
  console.log(JSON.stringify(message, null, 2));
} finally {
  client.destroy();
}
