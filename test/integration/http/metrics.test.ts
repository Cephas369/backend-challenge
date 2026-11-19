import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestApi, type TestApi, wagerBody } from '../../support/api';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi('metrics_api');
});

afterAll(async () => {
  await api?.close();
});

async function scrape(): Promise<string> {
  const response = await fetch(`${api.baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  return response.text();
}

const metricValue = (text: string, prefix: string): number =>
  Number(
    text
      .split('\n')
      .find((line) => line.startsWith(prefix))
      ?.split(' ')
      .at(-1) ?? Number.NaN,
  );

describe('GET /metrics', () => {
  test('conta desfechos, duplicatas, latência e outbox lag das operações reais', async () => {
    const wallet = await api.createWallet('10.00');
    const bet = wagerBody(wallet, { money: { amount: '5.00', currency: 'BRL' } });
    await api.submit(bet);
    await api.submit(bet);
    await api.submit(wagerBody(wallet, { money: { amount: '50.00', currency: 'BRL' } }));

    const text = await scrape();

    expect(
      metricValue(
        text,
        'wagering_transactions_total{kind="BET",status="PROCESSED",source="http",replay="false"}',
      ),
    ).toBe(1);
    expect(
      metricValue(
        text,
        'wagering_transactions_total{kind="BET",status="PROCESSED",source="http",replay="true"}',
      ),
    ).toBe(1);
    expect(
      metricValue(
        text,
        'wagering_transactions_total{kind="BET",status="REJECTED",source="http",replay="false"}',
      ),
    ).toBe(1);
    expect(metricValue(text, 'wagering_duplicates_detected_total{layer="pre-check"}')).toBe(1);
    expect(metricValue(text, 'wagering_processing_duration_seconds_count{source="http"}')).toBe(3);
    // sem o papel de outbox, os eventos ficam pendentes: o lag aparece e cresce
    expect(metricValue(text, 'wagering_outbox_pending_messages')).toBeGreaterThan(0);
    expect(metricValue(text, 'wagering_outbox_lag_seconds')).toBeGreaterThan(0);
    // métricas padrão de processo também vão junto
    expect(text).toContain('process_cpu_seconds_total');
  });
});
