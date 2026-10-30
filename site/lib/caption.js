import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

// 9router (gateway OpenAI-compatível) do dono do sistema: configurado só no servidor (.env),
// todos os usuários usam o mesmo. Tenta os modelos em ordem até um responder.
const ROUTER_URL = process.env.ROUTER_URL || 'http://localhost:20128/v1/chat/completions'
const ROUTER_KEY = process.env.ROUTER_KEY || readRouterKey()
const ROUTER_MODELS = (process.env.ROUTER_MODELS || 'cc/claude-opus-5-5,ag/claude-sonnet-5-5,cc/claude-sonnet-5-5')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean)
const PROMPT_TEMPLATE = await readFile(new URL('../prompt.md', import.meta.url), 'utf8')

// Sem ROUTER_KEY no env, usa a chave ativa do próprio 9router instalado nesta máquina
function readRouterKey() {
  const dbPath = join(homedir(), '.9router', 'db', 'data.sqlite')
  if (!existsSync(dbPath)) return ''
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1').get()
    db.close()
    return row?.key || ''
  } catch (e) {
    console.warn('Não consegui ler a chave do 9router:', e.message)
    return ''
  }
}

// Modelo às vezes solta "ok." ou cerca de código antes da legenda: corta tudo antes do 【
function cleanCaption(raw) {
  let text = raw.replace(/```[a-z]*\n?/g, '').replace(/\r\n?/g, '\n').trim()
  const start = text.search(/【/)
  if (start > 0) text = text.slice(start)
  return text
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Uma linha vazia só, depois do título
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Gênero do anime no 『』, sorteado a cada legenda nova (o modelo do CSV usa ADVENTURE)
const TITLES = [
  'ADVENTURE', 'MYSTERY', 'DESTINY', 'REVENGE', 'LEGEND', 'FANTASY', 'BATTLE', 'ODYSSEY', 'FRONTIER',
  'GUARDIAN', 'REBELLION', 'ETERNITY', 'HORIZON', 'PHANTOM', 'KINGDOM', 'SURVIVAL', 'MIRACLE', 'VOYAGE',
  'AWAKENING', 'INFINITY', 'SHADOW', 'GENESIS', 'CHRONICLE', 'QUEST',
]

// Mesmo formato do CSV de referência: 6 linhas, título no 『』, linha 2 vazia, 公式 no fim
export function captionLooksRight(caption, title) {
  const lines = caption.split('\n')
  return (
    lines.length === 6 &&
    lines[0].startsWith(`【#TVアニメ】『${title}』 `) &&
    lines[0].length > `【#TVアニメ】『${title}』 `.length &&
    lines[1] === '' &&
    lines.slice(2).every(Boolean) &&
    lines[2].endsWith('!!') &&
    lines[4].includes('とは――!?') &&
    / 公式$/.test(lines[5])
  )
}

// Gera de novo (até 3 vezes) se o modelo fugir do formato
export async function generateCaption() {
  const title = TITLES[randomBytes(2).readUInt16BE() % TITLES.length]
  let result
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await requestCaption(title)
    if (captionLooksRight(result.caption, title)) return result
    console.warn('Legenda fora do formato, gerando de novo:', JSON.stringify(result.caption.slice(0, 120)))
  }
  return result
}

async function requestCaption(title) {
  const prompt = PROMPT_TEMPLATE.replaceAll('{{TITULO}}', title)
  const errors = []
  for (const model of ROUTER_MODELS) {
    try {
      const r = await fetch(ROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ROUTER_KEY && { Authorization: `Bearer ${ROUTER_KEY}` }),
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 1,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(90_000),
      })
      const data = await r.json()
      const text = cleanCaption(data.choices?.[0]?.message?.content || '')
      if (text) return { caption: text, model }
      errors.push(`${model}: ${data.error?.message || r.status}`)
    } catch (e) {
      // "fetch failed" sozinho não diz nada; a causa (DNS, TLS, conexão) fica em e.cause
      errors.push(`${model}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`)
    }
  }
  // Detalhe (modelos, URL) só no log do servidor: usuário final não precisa ver
  console.error('9router falhou:', errors.join(' | '))
  throw new Error('Gerador de legendas indisponível agora. Tente de novo em instantes.')
}
