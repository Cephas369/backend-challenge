import 'reflect-metadata';

// Defaults que apontam para a infraestrutura local (`bun run infra:up`).
// Variáveis já definidas no ambiente (ex.: CI) ou no `.env` têm precedência.
process.env.DATABASE_URL ??= 'postgres://wagering:wagering@127.0.0.1:55432/wagering';
process.env.SQS_ENDPOINT ??= 'http://127.0.0.1:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

// O nível de log não segue o `.env` de desenvolvimento (que usa `info`): os testes rodam em silêncio.
// Para depurar: TEST_LOG_LEVEL=debug bun test ...
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
