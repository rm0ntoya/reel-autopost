# extension/

Fonte legível da extensão do Chrome (Manifest V3).

| Arquivo | Função |
|---|---|
| `background.js` | Service worker: conecta com o código do site, consulta a fila e coordena a postagem |
| `poster.js` | Automação da tela de postagem do Instagram |
| `caption-guard.js` | Garante que a legenda vai de fato na requisição de publicação do Instagram |
| `bridge.js` | Content script no site: avisa a extensão na hora quando entra vídeo novo |
| `popup.html` / `popup.js` | Tela de conexão |
| `config.js` | Endereço do site (regravado no download) |

**Não carregue esta pasta direto no Chrome.** Os usuários baixam a extensão pelo site (`/reel-autopost.zip`), que entrega a versão ofuscada (`site/extension-dist/`, gerada por `npm run build:extension`) com `config.js` e `manifest.json` apontando pro endereço certo.

Ao mudar a extensão, suba `version` no `manifest.json`.
