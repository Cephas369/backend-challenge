import { describe, expect, test } from 'bun:test';
import {
  canonicalJson,
  type WagerPayload,
  wagerPayloadHash,
} from '../../../src/domain/wagering/wager-payload';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';

/** Exemplo do enunciado (seção 9). */
const PAYLOAD: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

const CANONICAL =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
  '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
  '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

describe('JSON canônico', () => {
  test('ordena as chaves em todos os níveis, sem espaços e sem campos ausentes', () => {
    expect(canonicalJson({ b: '2', a: { d: '4', c: '3' }, z: undefined, y: null })).toBe(
      '{"a":{"c":"3","d":"4"},"b":"2","y":null}',
    );
  });

  test('a ordem de inserção das chaves não muda o resultado', () => {
    expect(canonicalJson({ a: '1', b: '2' })).toBe(canonicalJson({ b: '2', a: '1' }));
  });

  test('escapa strings como JSON', () => {
    expect(canonicalJson({ texto: 'aspas " e \\ barra' })).toBe('{"texto":"aspas \\" e \\\\ barra"}');
  });
});

describe('payloadHash', () => {
  test('é o SHA-256 do JSON canônico (vetor calculado fora do código com sha256sum)', () => {
    expect(wagerPayloadHash(PAYLOAD)).toBe(
      '629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344',
    );
    expect(new Bun.CryptoHasher('sha256').update(CANONICAL).digest('hex')).toBe(wagerPayloadHash(PAYLOAD));
  });

  test('referência ausente e referência undefined geram o mesmo hash', () => {
    expect(wagerPayloadHash({ ...PAYLOAD, referenceExternalTransactionId: undefined })).toBe(
      wagerPayloadHash(PAYLOAD),
    );
  });

  test('propriedades extras (transporte) não entram no hash', () => {
    const withTransport = {
      ...PAYLOAD,
      idempotencyKey: 'outra-key',
      messageId: 'msg-1',
      occurredAt: 'agora',
    };
    expect(wagerPayloadHash(withTransport)).toBe(wagerPayloadHash(PAYLOAD));
  });

  test.each<[string, Partial<WagerPayload>]>([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'outro-player' }],
    ['walletId', { walletId: 'outra-wallet' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'outro-jogo' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'transaction-100' }],
  ])('muda quando %s muda', (_field, change) => {
    expect(wagerPayloadHash({ ...PAYLOAD, ...change })).not.toBe(wagerPayloadHash(PAYLOAD));
  });
});
