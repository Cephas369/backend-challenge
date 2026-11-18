import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não negatividade ficam no banco
 * (restrição 9 do enunciado), não só no código. Violações detectadas por trigger usam SQLSTATEs
 * próprios para serem reconhecíveis:
 *
 *   WP001  tabela append-only (UPDATE/DELETE/TRUNCATE bloqueados)
 *   WP002  transação em estado terminal, campo de negócio alterado ou transição inválida
 *   WP003  lançamento que quebra a cadeia do ledger da wallet
 *   WP004  saldo/versão da wallet divergente do último lançamento (checado no commit)
 *   WP005  lançamento sem transação processada correspondente, ou o inverso (checado no commit)
 */
export class Migration20261119000000InitialSchema extends Migration {
  override up(): void {
    for (const statement of UP) {
      this.addSql(statement);
    }
  }

  override down(): void {
    for (const statement of DOWN) {
      this.addSql(statement);
    }
  }
}

const REJECTION_CODES = [
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'CURRENCY_MISMATCH',
  'PLAYER_WALLET_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_MISMATCH',
  'REFERENCE_KIND_NOT_ALLOWED',
  'REFERENCE_ALREADY_REVERSED',
  'REVERSAL_AMOUNT_MISMATCH',
];
const INFRASTRUCTURE_FAILURE_CODES = ['INVARIANT_VIOLATION', 'PROCESSING_FAILED'];
const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

const UP: readonly string[] = [
  // wallets
  `create table wallets (
    id uuid primary key,
    player_id uuid not null,
    currency char(3) not null,
    balance_amount numeric(20, 2) not null,
    version integer not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint wallets_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
    constraint wallets_balance_non_negative_ck check (balance_amount >= 0),
    constraint wallets_version_positive_ck check (version >= 1),
    constraint wallets_player_currency_uq unique (player_id, currency),
    constraint wallets_id_currency_uq unique (id, currency)
  )`,

  // wager_transactions
  `create table wager_transactions (
    id uuid primary key,
    provider_id text not null,
    external_transaction_id text not null,
    idempotency_key text not null,
    payload_hash char(64) not null,
    wallet_id uuid not null references wallets (id),
    player_id uuid not null,
    round_id text not null,
    game_id text not null,
    kind text not null,
    amount numeric(20, 2) not null,
    currency char(3) not null,
    reference_external_transaction_id text,
    reference_transaction_id uuid references wager_transactions (id),
    status text not null,
    failure_code text,
    observed_balance_amount numeric(20, 2),
    observed_balance_currency char(3),
    processed_at timestamptz,
    reference_attempts integer not null default 0,
    next_reference_check_at timestamptz,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint wager_tx_idempotency_uq unique (provider_id, idempotency_key),
    constraint wager_tx_external_uq unique (provider_id, external_transaction_id),
    constraint wager_tx_id_wallet_uq unique (id, wallet_id),
    constraint wager_tx_kind_ck check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
    constraint wager_tx_status_ck check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
    constraint wager_tx_required_text_ck check (
      btrim(provider_id) <> '' and btrim(external_transaction_id) <> '' and btrim(idempotency_key) <> ''
      and btrim(round_id) <> '' and btrim(game_id) <> ''
    ),
    constraint wager_tx_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
    constraint wager_tx_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
    constraint wager_tx_amount_ck check (amount > 0 or (kind = 'LOSS' and amount = 0)),
    constraint wager_tx_opening_is_internal_ck check ((kind = 'OPENING') = (provider_id = 'system')),
    constraint wager_tx_reference_required_ck check (
      kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null
    ),
    constraint wager_tx_reference_forbidden_ck check (
      kind not in ('BET', 'OPENING') or reference_external_transaction_id is null
    ),
    constraint wager_tx_resolved_reference_ck check (
      reference_transaction_id is null
      or (status = 'PROCESSED' and reference_external_transaction_id is not null)
    ),
    constraint wager_tx_processed_reference_ck check (
      status <> 'PROCESSED'
      or ((reference_external_transaction_id is null) = (reference_transaction_id is null))
    ),
    constraint wager_tx_processed_at_ck check ((status = 'PROCESSED') = (processed_at is not null)),
    -- "is not null" explícito: um CHECK que avalia NULL passa, e "null in (...)" é NULL
    constraint wager_tx_failure_code_ck check (
      (status = 'REJECTED' and failure_code is not null and failure_code in (${sqlList(REJECTION_CODES)}))
      or (status = 'FAILED' and failure_code is not null
          and failure_code in (${sqlList(INFRASTRUCTURE_FAILURE_CODES)}))
      or (status not in ('REJECTED', 'FAILED') and failure_code is null)
    ),
    constraint wager_tx_observed_balance_ck check (
      (observed_balance_amount is null) = (observed_balance_currency is null)
      and (observed_balance_amount is null or observed_balance_amount >= 0)
      and (observed_balance_currency is null or observed_balance_currency ~ '^[A-Z]{3}$')
      and (status in ('PENDING', 'FAILED') or observed_balance_amount is not null)
    ),
    constraint wager_tx_pending_reference_ck check (
      (status = 'PENDING_REFERENCE') = (next_reference_check_at is not null)
    ),
    constraint wager_tx_reference_attempts_ck check (reference_attempts >= 0)
  )`,
  // uma transação aceita no máximo uma reversão PROCESSED, de qualquer tipo
  `create unique index wager_tx_single_reversal_uq on wager_transactions (reference_transaction_id)
    where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`,
  `create index wager_tx_reference_check_due_ix on wager_transactions (next_reference_check_at)
    where status = 'PENDING_REFERENCE'`,
  `create index wager_tx_waiting_reference_ix on wager_transactions (provider_id, reference_external_transaction_id)
    where status = 'PENDING_REFERENCE'`,
  'create index wager_tx_wallet_ix on wager_transactions (wallet_id)',

  // wallet_ledger_entries
  `create table wallet_ledger_entries (
    id uuid primary key,
    wallet_id uuid not null,
    transaction_id uuid not null,
    direction text not null,
    amount numeric(20, 2) not null,
    currency char(3) not null,
    balance_before numeric(20, 2) not null,
    balance_after numeric(20, 2) not null,
    wallet_version integer not null,
    created_at timestamptz not null,
    constraint ledger_wallet_currency_fk foreign key (wallet_id, currency) references wallets (id, currency),
    constraint ledger_transaction_wallet_fk foreign key (transaction_id, wallet_id)
      references wager_transactions (id, wallet_id),
    constraint ledger_one_entry_per_transaction_uq unique (transaction_id, wallet_id),
    constraint ledger_wallet_version_uq unique (wallet_id, wallet_version),
    constraint ledger_direction_ck check (direction in ('DEBIT', 'CREDIT')),
    constraint ledger_amount_positive_ck check (amount > 0),
    constraint ledger_balances_non_negative_ck check (balance_before >= 0 and balance_after >= 0),
    constraint ledger_arithmetic_ck check (
      (direction = 'CREDIT' and balance_after = balance_before + amount)
      or (direction = 'DEBIT' and balance_after = balance_before - amount)
    ),
    constraint ledger_wallet_version_positive_ck check (wallet_version >= 1)
  )`,

  // inbox / outbox
  `create table inbox_messages (
    consumer_name text not null,
    message_id text not null,
    payload_hash char(64) not null,
    received_at timestamptz not null,
    processed_at timestamptz,
    primary key (consumer_name, message_id),
    constraint inbox_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$')
  )`,
  `create table outbox_messages (
    id uuid primary key,
    aggregate_id uuid not null,
    event_type text not null,
    payload jsonb not null,
    occurred_at timestamptz not null,
    attempts integer not null default 0,
    next_attempt_at timestamptz,
    published_at timestamptz,
    last_error text,
    constraint outbox_attempts_ck check (attempts >= 0),
    constraint outbox_event_type_ck check (btrim(event_type) <> ''),
    constraint outbox_pending_is_scheduled_ck check (published_at is not null or next_attempt_at is not null)
  )`,
  'create index outbox_due_ix on outbox_messages (next_attempt_at) where published_at is null',

  // imutabilidade (WP001, WP002)
  `create function forbid_mutation() returns trigger language plpgsql as $$
  begin
    raise exception '% em % não é permitido: a tabela é append-only', tg_op, tg_table_name
      using errcode = 'WP001';
  end
  $$`,
  `create trigger wallet_ledger_entries_append_only before update or delete on wallet_ledger_entries
    for each row execute function forbid_mutation()`,
  `create trigger wallet_ledger_entries_no_truncate before truncate on wallet_ledger_entries
    for each statement execute function forbid_mutation()`,
  `create trigger wager_transactions_no_delete before delete on wager_transactions
    for each row execute function forbid_mutation()`,
  `create trigger wager_transactions_no_truncate before truncate on wager_transactions
    for each statement execute function forbid_mutation()`,
  `create function guard_wager_transaction_update() returns trigger language plpgsql as $$
  begin
    if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
      raise exception 'transação % está em estado terminal (%) e não muda mais', old.id, old.status
        using errcode = 'WP002';
    end if;
    if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
        new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
        new.reference_external_transaction_id, new.created_at)
       is distinct from
       (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
        old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
        old.reference_external_transaction_id, old.created_at) then
      raise exception 'os campos de negócio da transação % são imutáveis', old.id using errcode = 'WP002';
    end if;
    if not (
      (old.status = 'PENDING' and new.status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
      or (old.status = 'PENDING_REFERENCE' and new.status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
    ) then
      raise exception 'transição inválida da transação %: % → %', old.id, old.status, new.status
        using errcode = 'WP002';
    end if;
    return new;
  end
  $$`,
  `create trigger wager_transactions_guard before update on wager_transactions
    for each row execute function guard_wager_transaction_update()`,

  // cadeia do ledger (WP003)
  `create function check_ledger_chain() returns trigger language plpgsql as $$
  declare
    previous_balance numeric(20, 2);
  begin
    select balance_after into previous_balance from wallet_ledger_entries
     where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;
    if found then
      if previous_balance <> new.balance_before then
        raise exception 'lançamento % não continua o saldo anterior da wallet %', new.id, new.wallet_id
          using errcode = 'WP003';
      end if;
    elsif not (
      new.balance_before = 0
      and (new.wallet_version = 1
           or (new.wallet_version = 2
               and not exists (select 1 from wallet_ledger_entries where wallet_id = new.wallet_id)))
    ) then
      raise exception 'lançamento % quebra a cadeia do ledger da wallet %', new.id, new.wallet_id
        using errcode = 'WP003';
    end if;
    return new;
  end
  $$`,
  `create trigger wallet_ledger_entries_chain before insert on wallet_ledger_entries
    for each row execute function check_ledger_chain()`,

  // saldo e ledger conferidos no commit (WP004)
  `create function check_wallet_matches_ledger() returns trigger language plpgsql as $$
  declare
    target_wallet uuid;
    current_version integer;
    current_balance numeric(20, 2);
    latest_version integer;
    latest_balance numeric(20, 2);
  begin
    -- IF em vez de CASE: cada ramo só é planejado quando executa (wallets não tem wallet_id)
    if tg_table_name = 'wallets' then
      target_wallet := new.id;
    else
      target_wallet := new.wallet_id;
    end if;
    select version, balance_amount into current_version, current_balance from wallets where id = target_wallet;
    select wallet_version, balance_after into latest_version, latest_balance
      from wallet_ledger_entries where wallet_id = target_wallet
     order by wallet_version desc limit 1;
    if not found then
      if not (current_version = 1 and current_balance = 0) then
        raise exception 'wallet % tem saldo % na versão % sem lançamento correspondente',
          target_wallet, current_balance, current_version using errcode = 'WP004';
      end if;
    elsif latest_version <> current_version or latest_balance <> current_balance then
      raise exception 'wallet % (versão %, saldo %) diverge do último lançamento (versão %, saldo %)',
        target_wallet, current_version, current_balance, latest_version, latest_balance using errcode = 'WP004';
    end if;
    return null;
  end
  $$`,
  `create constraint trigger wallets_match_ledger after insert or update on wallets
    deferrable initially deferred for each row execute function check_wallet_matches_ledger()`,
  `create constraint trigger ledger_matches_wallet after insert on wallet_ledger_entries
    deferrable initially deferred for each row execute function check_wallet_matches_ledger()`,

  // ledger e transação conferidos no commit (WP005)
  `create function check_ledger_entry_matches_transaction() returns trigger language plpgsql as $$
  declare
    tx record;
    expected_direction text;
  begin
    select kind, status, amount, currency, reference_transaction_id into tx
      from wager_transactions where id = new.transaction_id;
    if tx.status <> 'PROCESSED' or tx.kind = 'LOSS' or tx.amount <> new.amount or tx.currency <> new.currency then
      raise exception 'lançamento % não corresponde a uma transação processada de mesmo valor', new.id
        using errcode = 'WP005';
    end if;
    expected_direction := case tx.kind
      when 'BET' then 'DEBIT'
      when 'ROLLBACK' then (
        select case reversed.direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end
          from wallet_ledger_entries reversed where reversed.transaction_id = tx.reference_transaction_id
      )
      else 'CREDIT'
    end;
    if expected_direction is distinct from new.direction then
      raise exception 'lançamento % tem direção % incompatível com a transação %', new.id, new.direction, tx.kind
        using errcode = 'WP005';
    end if;
    return null;
  end
  $$`,
  `create constraint trigger ledger_entry_matches_transaction after insert on wallet_ledger_entries
    deferrable initially deferred for each row execute function check_ledger_entry_matches_transaction()`,
  `create function check_processed_transaction_has_entry() returns trigger language plpgsql as $$
  begin
    if new.status = 'PROCESSED' and new.kind <> 'LOSS'
       and not exists (select 1 from wallet_ledger_entries where transaction_id = new.id) then
      raise exception 'transação % processada sem lançamento no ledger', new.id using errcode = 'WP005';
    end if;
    return null;
  end
  $$`,
  `create constraint trigger processed_transaction_has_entry after insert or update on wager_transactions
    deferrable initially deferred for each row execute function check_processed_transaction_has_entry()`,

  // privilégio mínimo para a aplicação
  `do $$
  begin
    create role wagering_runtime nologin;
  exception when duplicate_object then
    null;
  end
  $$`,
  'grant select, insert, update on wallets, wager_transactions to wagering_runtime',
  'grant select, insert on wallet_ledger_entries to wagering_runtime',
  'grant select, insert, update, delete on inbox_messages, outbox_messages to wagering_runtime',
];

const DOWN: readonly string[] = [
  'revoke all on wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages from wagering_runtime',
  'drop table outbox_messages',
  'drop table inbox_messages',
  'drop table wallet_ledger_entries',
  'drop table wager_transactions',
  'drop table wallets',
  'drop function check_processed_transaction_has_entry()',
  'drop function check_ledger_entry_matches_transaction()',
  'drop function check_wallet_matches_ledger()',
  'drop function check_ledger_chain()',
  'drop function guard_wager_transaction_update()',
  'drop function forbid_mutation()',
  // o role é do cluster (pode ter permissões em outros bancos): fica
];
