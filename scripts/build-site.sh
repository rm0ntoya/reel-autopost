#!/bin/sh
# Monta dist/site, a pasta que vai pra Discloud: só os arquivos do sistema
# (sem .venv, data/ local, .env de desenvolvimento nem a extensão legível).
set -e
cd "$(dirname "$0")/.."

if [ ! -f site/.env.production ]; then
  echo "erro: falta site/.env.production (copie site/.env.example e preencha)" >&2
  exit 1
fi

# Extensão ofuscada (site/extension-dist/) gerada a partir de extension/
node scripts/obfuscate-extension.mjs

OUT=dist/site
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R site/server.js site/prompt.md site/package.json site/discloud.config site/lib site/public site/assets site/extension-dist "$OUT/"
# O CLI da Discloud não envia arquivos .env: vai como production.env (lido por lib/env.js)
cp site/.env.production "$OUT/production.env"
# Opcional: cookies de uma conta do Instagram pro yt-dlp
[ -f site/cookies.txt ] && cp site/cookies.txt "$OUT/"
printf 'node_modules\npackage-lock.json\ndata\n' > "$OUT/.discloudignore"
echo "pronto: $OUT ($(du -sh "$OUT" | cut -f1))"
