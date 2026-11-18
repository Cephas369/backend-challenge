/** Fonte de tempo: injetável para que testes controlem o relógio. */
export interface Clock {
  now(): Date;
}

/** Gera ids ordenáveis no tempo (UUIDv7 em produção). */
export interface IdGenerator {
  next(): string;
}
