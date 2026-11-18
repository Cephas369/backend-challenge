import type { MigrationObject } from '@mikro-orm/core';

/**
 * Lista explícita, sem glob: a ordem de aplicação é a ordem do array e nenhum arquivo
 * entra por acidente. Cada migration traz SQL escrito à mão em `up()` e `down()`.
 */
export const migrationsList: MigrationObject[] = [];
