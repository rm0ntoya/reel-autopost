# 9router/

App da Discloud que publica o [9router](https://www.npmjs.com/package/9router) (gateway de IA compatível com a API da OpenAI) pro site gerar legendas.

- `start.js` sobe o servidor do 9router direto (sem o CLI interativo) na porta **8080**, com os dados em `./data`, e reinicia se cair.
- `data/` **não vai pro git**: é gerado por `npm run sync:9router` a partir do `~/.9router` configurado localmente, com `requireLogin` e `requireApiKey` ligados.
- Deploy: `discloud app upload` (primeira vez) ou `discloud app commit <id>` dentro desta pasta.

Passo a passo: [`docs/INSTALACAO.md`](../docs/INSTALACAO.md#3-9router-local).
