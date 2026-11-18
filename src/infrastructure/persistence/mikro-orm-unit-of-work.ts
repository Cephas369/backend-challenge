import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../application/ports/persistence';
import { DomainInvariantError } from '../../domain/shared/domain-error';
import { translateDatabaseError } from './database-errors';
import { createRepositories } from './repositories';

export interface UnitOfWorkOptions {
  /** Espera máxima por um lock de linha (ex.: a wallet travada por outra transação). */
  readonly lockTimeoutMs: number;
  /** Duração máxima de cada comando. */
  readonly statementTimeoutMs: number;
}

/**
 * Transação por unidade de trabalho, com um fork novo do EntityManager a cada execução.
 *
 * READ COMMITTED + lock explícito: depois que `lockById` obtém a wallet, cada comando seguinte enxerga
 * tudo o que foi confirmado antes. Em REPEATABLE READ, esperar por uma linha alterada por outra
 * transação terminaria em erro de serialização.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly settings: string[];

  constructor(
    private readonly orm: MikroORM,
    options: UnitOfWorkOptions,
  ) {
    for (const [name, value] of Object.entries(options)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new DomainInvariantError(`${name} deve ser um inteiro positivo`);
      }
    }
    // valores numéricos validados acima: interpolar é seguro (SET não aceita parâmetros)
    this.settings = [
      `set local lock_timeout = ${options.lockTimeoutMs}`,
      `set local statement_timeout = ${options.statementTimeoutMs}`,
    ];
  }

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.run(work, { isolationLevel: IsolationLevel.READ_COMMITTED });
  }

  readOnly<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.run(work, { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true });
  }

  private async run<T>(
    work: (repositories: Repositories) => Promise<T>,
    options: { isolationLevel: IsolationLevel; readOnly?: boolean },
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        for (const setting of this.settings) {
          await em.execute(setting);
        }
        return work(createRepositories(em));
      }, options);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
