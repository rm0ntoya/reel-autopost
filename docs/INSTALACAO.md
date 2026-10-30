# Instalação completa do Reel Autopost

Este guia instala as três peças do sistema, primeiro na máquina local e depois na Discloud:

1. **9router**: gateway de IA que gera as legendas
2. **Site Reel Autopost**: contas, fila e edição de vídeo
3. **Extensão do Chrome**: posta no Instagram

Ele foi escrito pra ser **executado por uma IA com acesso a terminal** (Claude Code, Codex, Cursor etc.), mas uma pessoa também consegue seguir.

---

## 0. Regras para a IA que vai executar

- Execute as fases **em ordem**. Cada passo tem um comando e uma **verificação**. Só avance se a verificação passar.
- Passos marcados com **👤 HUMANO** exigem ação da pessoa (login OAuth, copiar token, clicar no Chrome). Pare, explique exatamente o que ela precisa fazer, espere a confirmação e então verifique.
- **Nunca** escreva credenciais em arquivos versionados, em commits ou em logs. Elas vão só em `site/.env`, `site/.env.production`, `9router/data/` e na variável `DISCLOUD_TOKEN`, todos fora do git.
- **Nunca** imprima o valor de chaves e tokens no terminal. Para conferir se existem, teste o tamanho (`[ -n "$VAR" ]`) ou use `sed 's/=.*/=<oculto>/'`.
- Comandos assumem que o diretório atual é a **raiz do repositório**, a não ser que o passo diga outra coisa.
- `discloud app commit` **reinicia o app** e mata vídeos em processamento. Em app que já está em uso, confira antes com `discloud app info <id>` se a CPU está perto de 0%.

### Valores que serão usados

Peça à pessoa (ou defina) antes de começar e guarde para os passos seguintes:

| Nome | Exemplo | Onde é usado |
|---|---|---|
| `ROUTER_ID` | `meu9router` | Subdomínio e ID do app do 9router na Discloud |
| `SITE_ID` | `meureelautopost` | Subdomínio e ID do app do site na Discloud |
| `ROUTER_PASSWORD` | (senha forte) | Senha do painel do 9router |
| `DISCLOUD_TOKEN` | (token da Discloud) | Login do CLI, fase 6 |
| `TELEGRAM_BOT_TOKEN` | opcional | Bot do Telegram |

IDs da Discloud: só letras minúsculas e números, únicos na plataforma. O endereço final fica `https://<ID>.discloud.dev`.

Se o seu terminal não mantém variáveis entre um comando e outro (caso comum em agentes de IA), salve os valores num arquivo fora do git e carregue no começo de cada bloco:

```bash
cat > .local/install.env <<'VARS'
ROUTER_ID=meu9router
SITE_ID=meureelautopost
VARS
. ./.local/install.env
```

(`.local/` está no `.gitignore`. Não coloque o `DISCLOUD_TOKEN` nesse arquivo se a máquina for compartilhada.)

---

## 1. Pré-requisitos

Ferramentas: **git**, **Node.js 22.13 ou maior**, **ffmpeg**, **Python 3**, **sqlite3**.

### macOS (Homebrew)

```bash
command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git node ffmpeg python sqlite
```

### Linux (Debian/Ubuntu)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y git nodejs ffmpeg python3 python3-venv sqlite3
```

### Windows

Use o WSL2 (Ubuntu) e siga os passos de Linux.

**Verificação:**

```bash
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) {console.error("Node muito antigo: "+process.version); process.exit(1)} else console.log("node ok", process.version)'
ffmpeg -version | head -1 && python3 --version && sqlite3 --version && git --version
```

---

## 2. Baixar o projeto

```bash
git clone https://github.com/<usuario>/<repositorio>.git reel-autopost
cd reel-autopost
npm run setup
```

`npm run setup` instala as dependências da raiz (ofuscador da extensão) e do site (`@napi-rs/canvas`).

**Verificação:** `ls node_modules/javascript-obfuscator site/node_modules/@napi-rs/canvas` não dá erro.

---

## 3. 9router local

O [9router](https://www.npmjs.com/package/9router) é um gateway compatível com a API da OpenAI que usa as suas contas de IA (assinatura do Claude Code, Antigravity, Codex etc.). O site manda o prompt da legenda pra ele.

### 3.1 Instalar e iniciar

```bash
npm install -g 9router
9router --version
```

Inicie em segundo plano, sem abrir navegador, e espere responder:

```bash
nohup 9router -n --skip-update > /tmp/9router.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:20128/ && break; sleep 1; done
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:20128/
```

**Verificação:** o último comando imprime `307` (redireciona pro `/dashboard`). Os dados ficam em `~/.9router/`.

### 3.2 Configurar pelo painel 👤 HUMANO

Peça à pessoa para abrir **http://localhost:20128/dashboard** e fazer:

1. **Providers** → conectar pelo menos uma conta de IA. Cada provedor vira um prefixo de modelo:
   - Claude (assinatura do Claude Code, login OAuth) → modelos `cc/...`
   - Antigravity (login Google) → modelos `ag/...`
   - Codex / OpenAI e outros também funcionam
   Dá pra conectar várias contas do mesmo provedor; o 9router reveza entre elas.
2. **API Keys** → criar uma chave e deixá-la ativa. É ela que vira `ROUTER_KEY`.
3. **Settings** → definir uma **senha** (`ROUTER_PASSWORD`) para o painel.
   Não precisa ligar "require login" no 9router local: o script da fase 7 liga isso só na cópia que vai pra internet.

**Verificação** (sem imprimir a chave):

```bash
DB=~/.9router/db/data.sqlite
sqlite3 "$DB" "SELECT 'provedores ativos: ' || count(*) FROM providerConnections WHERE isActive = 1"
sqlite3 "$DB" "SELECT 'chaves ativas: ' || count(*) FROM apiKeys WHERE isActive = 1"
sqlite3 "$DB" "SELECT 'senha definida: ' || (coalesce(json_extract(data,'\$.password'),'') != '') FROM settings"
```

Precisa dar provedores ≥ 1, chaves ≥ 1 e senha = 1.

### 3.3 Testar geração

```bash
ROUTER_KEY=$(sqlite3 ~/.9router/db/data.sqlite "SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1")
# Modelos disponíveis
curl -s http://localhost:20128/v1/models -H "Authorization: Bearer $ROUTER_KEY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.map(m=>m.id).filter(id=>/^(cc|ag|cx)\//.test(id)).join("\n")))'
# Uma resposta de verdade
curl -s http://localhost:20128/v1/chat/completions -H "Authorization: Bearer $ROUTER_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"cc/claude-sonnet-5-5","messages":[{"role":"user","content":"responda só: ok"}]}' | head -c 300; echo
```

**Verificação:** a lista de modelos não está vazia e o chat devolve um JSON com `choices`.
Escolha 2 ou 3 modelos da lista pra `ROUTER_MODELS` (em ordem de preferência). Se o modelo do exemplo não existir na sua lista, troque por um que exista.

---

## 4. Site local

### 4.1 Configuração

```bash
cp site/.env.example site/.env
```

Os valores padrão já servem pro uso local (porta 9283, 9router em `localhost:20128`, chave lida sozinha do `~/.9router`). Ajuste `ROUTER_MODELS` com os modelos escolhidos no passo 3.3.

### 4.2 yt-dlp

No Linux o site baixa o yt-dlp oficial sozinho na primeira execução. No **macOS** crie um ambiente Python dentro de `site/`:

```bash
python3 -m venv site/.venv && site/.venv/bin/pip install -q -U yt-dlp
site/.venv/bin/yt-dlp --version
```

### 4.3 Subir

```bash
npm start
```

`npm start` gera a extensão ofuscada em `site/extension-dist/` e sobe o site. Pra rodar em segundo plano:

```bash
nohup npm start > /tmp/reel-autopost.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:9283/ && break; sleep 1; done
curl -s -o /dev/null -w 'site %{http_code}\n' http://localhost:9283/
curl -s -o /dev/null -w 'extensao %{http_code}\n' http://localhost:9283/reel-autopost.zip
```

**Verificação:** `site 200` e `extensao 200`. O log mostra `Rodando em http://localhost:9283`.

### 4.4 Cookies do Instagram (recomendado)

O Instagram bloqueia muito download anônimo (`empty media response`, `isn't available to everyone`). Para resolver:

- **Local:** em `site/.env`, coloque `IG_BROWSER=chrome` (o Chrome precisa estar logado no Instagram).
- **Produção:** exporte os cookies de uma conta qualquer do Instagram em formato Netscape (extensão "Get cookies.txt LOCALLY") 👤 **HUMANO** e salve como `site/cookies.txt`. O build envia esse arquivo junto. Ele está no `.gitignore`.

---

## 5. Extensão do Chrome 👤 HUMANO

A extensão é sempre baixada **pelo site**, porque o site grava nela o próprio endereço. Não carregue a pasta `extension/` direto: ela aponta pra `localhost:9283`.

Peça à pessoa:

1. Abrir o site, criar conta e personalizar o perfil (foto, nome, @, frase).
2. Baixar a extensão pelo site (link `/reel-autopost.zip`) e descompactar.
3. Abrir `chrome://extensions`, ligar o **Modo do desenvolvedor**, clicar em **Carregar sem compactação** e escolher a pasta `reel-autopost`.
4. No site, ir em **Conexões** e gerar um código `XXXX-XXXX`.
5. Clicar no ícone da extensão, colar o código e conectar.
6. Deixar o Chrome logado no Instagram que vai receber os posts.

**Verificação:** no site, a conexão aparece como **Extensão online**. Cole um link de Reel ou TikTok: o vídeo passa por baixando → editando → legenda → **Na fila da extensão** → postado.

Ao trocar o endereço do site (por exemplo, ao ir pra produção), **baixe a extensão de novo** pelo novo endereço e recarregue.

---

## 6. Discloud: conta e CLI

A [Discloud](https://discloud.com) hospeda os dois apps. Hospedar **site** (app web com subdomínio) exige um plano que permita sites; o sistema roda bem com 2 GB de RAM no total (site 1536 MB + 9router 512 MB).

### 6.1 Instalar o CLI

```bash
npm install -g discloud-cli
discloud --version
```

### 6.2 Login 👤 HUMANO

Peça à pessoa para abrir **https://discloud.com/dashboard**, ir no perfil/configurações e copiar o **API Token**.

O CLI aceita o token por variável de ambiente, sem prompt interativo:

```bash
export DISCLOUD_TOKEN='<token colado pela pessoa>'
discloud user info
```

Para gravar o login de forma permanente, a pessoa pode rodar `discloud login` e colar o token (é interativo).

**Verificação:** `discloud user info` mostra o usuário e o plano.

### 6.3 Subdomínios

Cada app do tipo site precisa de um subdomínio registrado com o mesmo nome do `ID`:

```bash
discloud subdomain create --id "$ROUTER_ID"
discloud subdomain create --id "$SITE_ID"
discloud subdomain info
```

Se o CLI recusar, crie pelo painel da Discloud (área de subdomínios) 👤 **HUMANO**.

---

## 7. Deploy do 9router

### 7.1 Copiar a configuração local

```bash
npm run sync:9router
```

O script copia `~/.9router` para `9router/data/` (contas conectadas, chaves, catálogo de modelos) e **liga `requireLogin` e `requireApiKey` na cópia**, porque esse 9router vai ficar público na internet.

**Verificação:** a saída termina com `provedores: N, chaves ativas: N, senha: sim`, com N ≥ 1. Se aparecer `aviso:`, volte ao passo 3.2.

### 7.2 Ajustar o config

Edite `9router/discloud.config` e troque `ID` e `NAME`:

```bash
sed -i.bak "s/^ID=.*/ID=$ROUTER_ID/; s/^NAME=.*/NAME=$ROUTER_ID/" 9router/discloud.config && rm 9router/discloud.config.bak
cat 9router/discloud.config
```

`start.js` já sobe o 9router na porta 8080 (exigida pela Discloud) usando `./data`.

### 7.3 Subir

Primeira vez:

```bash
cd 9router && discloud app upload && cd ..
```

Atualizações seguintes:

```bash
cd 9router && discloud app commit "$ROUTER_ID" && cd ..
```

O upload às vezes devolve **524** (timeout do Cloudflare) mesmo dando certo. Confira com `discloud app info "$ROUTER_ID"`.

### 7.4 Verificar

```bash
ROUTER_KEY=$(sqlite3 9router/data/db/data.sqlite "SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1")
curl -s -o /dev/null -w 'sem chave: %{http_code}\n' "https://$ROUTER_ID.discloud.dev/v1/models"
curl -s "https://$ROUTER_ID.discloud.dev/v1/models" -H "Authorization: Bearer $ROUTER_KEY" | head -c 200; echo
```

**Verificação:** sem chave → erro de autenticação (4xx); com chave → JSON com a lista de modelos. Logs: `discloud app logs "$ROUTER_ID"`.

---

## 8. Deploy do site

### 8.1 Configuração de produção

```bash
cp site/.env.example site/.env.production
```

Edite `site/.env.production` com estes valores (a chave sai do banco do 9router, sem passar pelo terminal):

```bash
ROUTER_KEY=$(sqlite3 9router/data/db/data.sqlite "SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1")
F=site/.env.production
set_env() { grep -vE "^#? ?$1=" "$F" > "$F.tmp"; mv "$F.tmp" "$F"; printf '%s=%s\n' "$1" "$2" >> "$F"; }
set_env PORT 8080
set_env HOST 0.0.0.0
set_env PUBLIC_URL "https://$SITE_ID.discloud.dev"
set_env TRUST_PROXY 1
set_env ROUTER_URL "https://$ROUTER_ID.discloud.dev/v1/chat/completions"
set_env ROUTER_KEY "$ROUTER_KEY"
set_env WORKERS 1
# opcional:
# set_env TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
sed 's/=.*/=<oculto>/' "$F" | grep -v '^#'
```

Regras importantes:

- `PORT=8080` e `HOST=0.0.0.0` são obrigatórios na Discloud.
- `WORKERS=1`: cada vídeo usa 600-750 MB de RAM. Dois em paralelo derrubam o app.
- Se usar o bot do Telegram em produção, **não** coloque o mesmo token no `site/.env` local: só um servidor pode usar o token por vez.

### 8.2 Ajustar o config

```bash
sed -i.bak "s/^ID=.*/ID=$SITE_ID/; s/^NAME=.*/NAME=$SITE_ID/" site/discloud.config && rm site/discloud.config.bak
cat site/discloud.config
```

O config já pede `APT=ffmpeg, tools` e `RAM=1536`. Não diminua a RAM.

### 8.3 Build

```bash
npm run build:site
```

Gera `dist/site/` com só o necessário: código, extensão ofuscada, fontes, `production.env` (o CLI da Discloud não envia arquivos `.env`, por isso o nome) e `cookies.txt` se existir.

**Verificação:** `ls dist/site` mostra `production.env`, `extension-dist`, `server.js`, `discloud.config`.

### 8.4 Subir

Primeira vez:

```bash
cd dist/site && discloud app upload && cd ../..
```

Atualizações seguintes:

```bash
cd dist/site && discloud app commit "$SITE_ID" && cd ../..
```

### 8.5 Verificar

```bash
discloud app logs "$SITE_ID" | tail -5
curl -s -o /dev/null -w 'site %{http_code}\n' "https://$SITE_ID.discloud.dev/"
curl -s -o /dev/null -w 'extensao %{http_code}\n' "https://$SITE_ID.discloud.dev/reel-autopost.zip"
```

**Verificação:** o log mostra `Rodando em https://<SITE_ID>.discloud.dev` e, na primeira vez, `yt-dlp atualizado`. Os dois curls dão `200`.

Depois disso, repita a **fase 5** usando o endereço de produção (baixar a extensão de novo).

---

## 9. Atualizar depois

| Mudou | Comando |
|---|---|
| Código do site ou da extensão | `npm run build:site && cd dist/site && discloud app commit "$SITE_ID"` |
| Contas/chaves do 9router | Configure no painel local, depois `npm run sync:9router && cd 9router && discloud app commit "$ROUTER_ID"` |
| Versão do 9router | Troque a versão em `9router/package.json` e faça commit do app |
| Versão da extensão | Suba `version` em `extension/manifest.json`, faça o deploy do site e reinstale a extensão |

Sempre confira se não há vídeo processando (`discloud app info`) antes do commit.

---

## 10. Problemas comuns

| Sintoma | Causa | O que fazer |
|---|---|---|
| `ERR_CONNECTION_RESET` no navegador, mas a Discloud diz online | Firewall da rede bloqueando `*.discloud.dev` (comum em empresa/faculdade) | `curl http://<ID>.discloud.dev` mostra a página de bloqueio. Teste em outra rede, use VPN ou domínio próprio |
| App reinicia sem log | Falta de RAM (ffmpeg) | `WORKERS=1`, RAM do site 1536 MB |
| Legenda não sai / `9router falhou` | Chave errada, URL errada ou modelo inexistente | Refaça 7.4 e confira `ROUTER_MODELS` contra `/v1/models` |
| `401` no 9router com a chave certa | Chave criada depois do último sync | `npm run sync:9router` e commit do 9router |
| `Instagram sent an empty media response` | Download anônimo bloqueado | `site/cookies.txt` (4.4) e novo deploy |
| Telegram `409 Conflict` ou mensagens sumindo | Dois servidores com o mesmo token | Tire o token do `site/.env` local |
| Extensão não conecta | Extensão baixada de outro endereço | Baixe de novo pelo site certo e recarregue em `chrome://extensions` |
| Upload devolve 524 | Timeout do Cloudflare durante upload grande | Normalmente subiu: confira com `discloud app info` |
