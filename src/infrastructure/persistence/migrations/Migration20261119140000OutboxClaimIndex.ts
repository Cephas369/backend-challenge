import { Migration } from '@mikro-orm/migrations';

/**
 * Índice da claim da outbox alinhado ao `ORDER BY occurred_at, id` (achado do teste de carga, D27).
 * O índice anterior, por `next_attempt_at`, não servia à ordenação: com 40 mil eventos pendentes a
 * claim fazia seq scan e ordenação em disco (~16 ms por lote, a cada lote). Com este, ela percorre o
 * índice na ordem e para no 10º evento devido.
 */
export class Migration20261119140000OutboxClaimIndex extends Migration {
  override up(): void {
    this.addSql('drop index outbox_due_ix');
    this.addSql(
      'create index outbox_pending_ix on outbox_messages (occurred_at, id) where published_at is null',
    );
  }

  override down(): void {
    this.addSql('drop index outbox_pending_ix');
    this.addSql('create index outbox_due_ix on outbox_messages (next_attempt_at) where published_at is null');
  }
}
