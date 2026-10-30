#!/bin/sh
# Copia o 9router configurado nesta máquina (~/.9router) para 9router/data,
# que é enviado junto com o app do 9router pra Discloud.
# Na cópia liga requireLogin + requireApiKey: o 9router fica público na internet.
set -e
cd "$(dirname "$0")/.."

SRC="${NINEROUTER_HOME:-$HOME/.9router}"
DST=9router/data
DB="$DST/db/data.sqlite"

if [ ! -f "$SRC/db/data.sqlite" ]; then
  echo "erro: $SRC/db/data.sqlite não existe. Rode o 9router local e configure antes (docs/INSTALACAO.md)." >&2
  exit 1
fi

rm -rf "$DST"
mkdir -p "$DST/db"
# Só o necessário: contas conectadas, chaves, catálogo de modelos e segredos de sessão
cp -R "$SRC/auth" "$DST/" 2>/dev/null || true
cp "$SRC/jwt-secret" "$SRC/machine-id" "$SRC/model-catalog.json" "$DST/" 2>/dev/null || true
# Cópia consistente do SQLite (inclui o que ainda está no WAL)
sqlite3 "$SRC/db/data.sqlite" ".backup '$DB'"

sqlite3 "$DB" "UPDATE settings SET data = json_set(data, '\$.requireLogin', json('true'), '\$.requireApiKey', json('true'))"

HAS_PASSWORD=$(sqlite3 "$DB" "SELECT coalesce(json_extract(data, '\$.password'), '') != '' FROM settings")
KEYS=$(sqlite3 "$DB" "SELECT count(*) FROM apiKeys WHERE isActive = 1")
PROVIDERS=$(sqlite3 "$DB" "SELECT count(*) FROM providerConnections WHERE isActive = 1")

[ "$HAS_PASSWORD" = 1 ] || echo "aviso: 9router sem senha definida. Defina em Settings no painel local e rode de novo." >&2
[ "$KEYS" -gt 0 ] || echo "aviso: nenhuma API key ativa. Crie uma em API Keys no painel local e rode de novo." >&2
[ "$PROVIDERS" -gt 0 ] || echo "aviso: nenhum provedor conectado. Conecte em Providers no painel local." >&2

echo "pronto: $DST (provedores: $PROVIDERS, chaves ativas: $KEYS, senha: $([ "$HAS_PASSWORD" = 1 ] && echo sim || echo NÃO))"
