# site/

Servidor do Reel Autopost: Node puro (`node:http` + `node:sqlite`), sem framework.

| Arquivo | Função |
|---|---|
| `server.js` | Rotas HTTP, sessão, fila de jobs, API da extensão, bot do Telegram |
| `lib/env.js` | Carrega `.env` (local) ou `production.env` (Discloud). Precisa ser o primeiro import |
| `lib/db.js` | SQLite em `data/app.db`, códigos de dispositivo |
| `lib/media.js` | yt-dlp (download), ffmpeg (edição), limpeza de metadados |
| `lib/overlay.js` | Arte do perfil (foto, nome, @, frase) desenhada com `@napi-rs/canvas` |
| `lib/caption.js` | Legenda via 9router, com validação de formato e fallback de modelos |
| `lib/extension-zip.js` | Monta o `.zip` da extensão já apontando pro `PUBLIC_URL` |
| `lib/telegram.js` | Bot do Telegram (long polling) |
| `public/` | Front-end |
| `prompt.md` | Prompt da legenda |

Rodar: `npm start` na raiz do repositório. Variáveis: [`.env.example`](.env.example).
Dados de runtime (banco, fotos, vídeos, binário do yt-dlp) ficam em `data/`, fora do git. Vídeos são apagados após 3 dias.
