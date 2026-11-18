import type { Clock, IdGenerator } from '../application/ports/runtime';

export const systemClock: Clock = { now: () => new Date() };

/** UUIDv7: ordenável no tempo, bom para chaves primárias e para os índices do ledger. */
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
