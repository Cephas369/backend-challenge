import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261119000000InitialSchema } from './Migration20261119000000InitialSchema';
import { Migration20261119140000OutboxClaimIndex } from './Migration20261119140000OutboxClaimIndex';

/**
 * Lista explícita, sem glob: a ordem de aplicação é a ordem do array e nenhum arquivo
 * entra por acidente. Cada migration traz SQL escrito à mão em `up()` e `down()`.
 */
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261119000000_initial_schema', class: Migration20261119000000InitialSchema },
  { name: 'Migration20261119140000_outbox_claim_index', class: Migration20261119140000OutboxClaimIndex },
];
