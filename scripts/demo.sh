# Helpers para demonstrar a API pelo terminal. Uso, com o compose no ar:
#   source scripts/demo.sh
# Precisa de curl, jq e bun. Os ids levam o prefixo $RUN, então a demo pode ser repetida.

BASE=${BASE:-http://127.0.0.1:3000}
RUN=demo-$(date +%s)

# nova_wallet <saldo>: wallet nova para um player novo; define P (player) e W (wallet)
nova_wallet() {
  P=$(bun -e 'console.log(crypto.randomUUID())')
  W=$(curl -s -X POST "$BASE/wallets" -H 'content-type: application/json' \
    -d "{\"playerId\":\"$P\",\"initialBalance\":{\"amount\":\"$1\",\"currency\":\"BRL\"}}" | jq -r .id)
  echo "wallet $W com $1 BRL"
}

# aposta <id> <BET|WIN|LOSS|REFUND|ROLLBACK> <valor> [id da referência]
# O externalTransactionId é "$RUN-<id>" e a Idempotency-Key, "provider-a:$RUN-<id>".
# Com CORRELATION=<valor> no ambiente, manda também o header x-correlation-id.
aposta() {
  local ref='' extra=()
  [ -n "${4:-}" ] && ref=",\"referenceExternalTransactionId\":\"$RUN-$4\""
  [ -n "${CORRELATION:-}" ] && extra=(-H "x-correlation-id: $CORRELATION")
  curl -s -w ' → HTTP %{http_code}\n' -X POST "$BASE/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$RUN-$1" "${extra[@]}" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$RUN-$1\",\"playerId\":\"$P\",\"walletId\":\"$W\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"$2\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}$ref}"
}

# carga <n> <valor>: n apostas diferentes em paralelo na wallet atual; imprime o status HTTP
# e se foi replay (use com `| sort | uniq -c`)
carga() {
  # subshell: o shell interativo não imprime um aviso por job em segundo plano
  (
    for i in $(seq "$1"); do
      aposta "carga-$i" BET "$2" | grep -o -E 'HTTP [0-9]+|"idempotentReplay":(true|false)' &
    done
    wait
  )
}

# transacao <id>: status atual de uma transação do provider-a
transacao() {
  curl -s "$BASE/providers/provider-a/wagering/transactions/$1" | jq -c '{status, failureCode, kind, money: .money.amount}'
}

saldo() { curl -s "$BASE/wallets/$W" | jq -c '{balance: .balance.amount, version}'; }

reconciliar() {
  curl -s -X POST "$BASE/wallets/$W/reconciliation" | jq -c '{consistent, stored: .storedBalance.amount, calculated: .calculatedBalance.amount, issues}'
}
