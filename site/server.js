import { createServer } from 'node:http'
import { mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
// Primeiro import: os outros módulos leem process.env assim que carregam
import './lib/env.js'
import { db, DATA_DIR, now, sha256, newToken, hashPassword, checkPassword, newDeviceCode } from './lib/db.js'
import { detectPlatform, processVideo, getOverlay, ensureYtDlp, run } from './lib/media.js'
import { normalizeAvatar } from './lib/overlay.js'
import { generateCaption } from './lib/caption.js'
import { buildExtensionZip } from './lib/extension-zip.js'
import { telegramEnabled, botUsername, startPolling, sendMessage } from './lib/telegram.js'

const PORT = Number(process.env.PORT) || 9283
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`
const SECURE_COOKIE = PUBLIC_URL.startsWith('https://')
// Link do site nas mensagens do Telegram (já usado no boot, antes das rotas)
const siteLink = `${PUBLIC_URL}/`
const SESSION_TTL = 30 * 24 * 3600 * 1000
const CODE_TTL = 10 * 60 * 1000
// Tempo máximo que a extensão pode ficar "postando" um job antes de ser considerado travado
const POSTING_TIMEOUT = 15 * 60 * 1000
// Vídeos ficam no disco só o suficiente pra extensão postar / usuário baixar
const VIDEO_TTL = 3 * 24 * 3600 * 1000
const MAX_PENDING_PER_USER = 3
const WORKERS = Number(process.env.WORKERS) || 2
const USERS_DIR = join(DATA_DIR, 'users')
const VIDEOS_DIR = join(DATA_DIR, 'videos')
// Miniaturas ficam mesmo depois do vídeo expirar: o histórico continua com imagem
const THUMBS_DIR = join(DATA_DIR, 'thumbs')
await mkdir(USERS_DIR, { recursive: true })
await mkdir(VIDEOS_DIR, { recursive: true })
await mkdir(THUMBS_DIR, { recursive: true })
const thumbPath = id => join(THUMBS_DIR, `${id}.jpg`)

const userDir = id => join(USERS_DIR, String(id))

// ---------- helpers HTTP ----------

function json(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'Requisição grande demais.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit = 32_000) {
  const raw = (await readBody(req, limit)).toString('utf8')
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw new HttpError(400, 'JSON inválido.')
  }
}

function cookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function sessionCookie(token, maxAgeMs) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${SECURE_COOKIE ? '; Secure' : ''}`
}

async function sendFile(res, path, type, extra = {}) {
  if (!path || !existsSync(path)) throw new HttpError(404, 'Arquivo não encontrado.')
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': (await stat(path)).size, 'Cache-Control': 'no-store', ...extra })
  createReadStream(path).pipe(res)
}

// IP real do cliente atrás de proxy:
// - Cloudflare Tunnel: conexão vem de 127.0.0.1 e o IP chega em CF-Connecting-IP
// - Discloud (TRUST_PROXY=1): último IP do X-Forwarded-For é o que o proxy viu
// Cabeçalho só é aceito nesses casos, senão qualquer um forjaria.
function clientIp(req) {
  const addr = req.socket.remoteAddress || ''
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean)
    if (forwarded.length) return forwarded.at(-1)
  }
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  return (local && req.headers['cf-connecting-ip']) || addr
}

// Tentativas de login por IP (memória): 10 erros em 15 min bloqueia
const loginFails = new Map()
function checkLoginRate(ip) {
  const entry = loginFails.get(ip)
  if (entry && entry.until > now() && entry.count >= 10) throw new HttpError(429, 'Muitas tentativas. Espere alguns minutos.')
}
function addLoginFail(ip) {
  const entry = loginFails.get(ip)
  if (!entry || entry.until < now()) loginFails.set(ip, { count: 1, until: now() + 15 * 60 * 1000 })
  else entry.count++
}

// Legendas usam o 9router do dono: limita gerações por usuário por hora
const CAPTIONS_PER_HOUR = Number(process.env.CAPTIONS_PER_HOUR) || 40
const captionUse = new Map() // userId -> [timestamps]
function useCaptionQuota(userId) {
  const recent = (captionUse.get(userId) || []).filter(t => t > now() - 3600 * 1000)
  if (recent.length >= CAPTIONS_PER_HOUR) throw new HttpError(429, 'Limite de legendas por hora atingido. Tente mais tarde.')
  recent.push(now())
  captionUse.set(userId, recent)
}

// ---------- auth ----------

function currentUser(req) {
  const sid = cookies(req).sid
  if (!sid) return null
  return db
    .prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .get(sha256(sid), now()) || null
}

function requireUser(req) {
  const user = currentUser(req)
  if (!user) throw new HttpError(401, 'Faça login.')
  return user
}

// Extensão manda "Authorization: Bearer <token do dispositivo>"
function requireDevice(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const device = token && db.prepare('SELECT id, user_id, name FROM devices WHERE token_hash = ?').get(sha256(token))
  if (!device) throw new HttpError(401, 'Dispositivo desconectado. Gere um novo código no site.')
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), device.id)
  return device
}

function createSession(res, userId) {
  const token = newToken()
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + SESSION_TTL)
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL))
}

// ---------- perfil ----------

function getProfile(userId) {
  let p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId)
  if (!p) {
    db.prepare('INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)').run(userId, now())
    p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId)
  }
  return p
}

function publicProfile(p) {
  return {
    name: p.name,
    handle: p.handle,
    phrase: p.phrase,
    verified: !!p.verified,
    hasAvatar: !!p.has_avatar,
    mode: p.mode,
    autoPost: !!p.auto_post,
    captionReuse: p.caption_reuse,
    // Vídeos que ainda vão usar a legenda atual antes de gerar outra
    reuseLeft: p.caption_reuse > 1 && p.reuse_caption ? p.reuse_left : 0,
    customCaption: p.custom_caption,
    customCaptionUses: p.custom_caption_total,
    customCaptionLeft: p.custom_caption_left,
    // O que fazer quando a legenda fixa acabar: 'generate' (IA) ou 'none' (sem legenda)
    afterCustom: p.after_custom === 'none' ? 'none' : 'generate',
  }
}

// overlay.py lê o perfil deste arquivo
async function writeBrand(userId) {
  const p = getProfile(userId)
  const dir = userDir(userId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'brand.json'),
    JSON.stringify({
      name: p.name || 'Minha Página',
      handle: p.handle || '@minhapagina',
      phrase: p.phrase || 'Os melhores vídeos estão aqui 😂',
      avatar: p.has_avatar ? 'avatar.jpg' : '',
      verified: !!p.verified,
    })
  )
}

const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)

// ---------- jobs ----------

function publicJob(j) {
  return {
    id: j.id,
    url: j.url,
    platform: j.platform,
    mode: j.mode,
    status: j.status,
    error: j.error,
    caption: j.caption,
    originalCaption: j.original_caption,
    model: j.model,
    hasVideo: !!j.video_path && existsSync(j.video_path),
    hasThumb: existsSync(thumbPath(j.id)),
    source: j.tg_chat_id ? 'telegram' : 'site',
    captionReport: j.caption_report ? JSON.parse(j.caption_report) : null,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  }
}

function getJob(userId, id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(Number(id), userId)
  if (!job) throw new HttpError(404, 'Vídeo não encontrado.')
  return job
}

function setJob(id, fields) {
  const keys = Object.keys(fields)
  db.prepare(`UPDATE jobs SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map(k => fields[k]),
    now(),
    id
  )
  if ('status' in fields) notifyTelegram(id)
}

// Link novo (site ou Telegram) entra na fila. tgChatId: chat que recebe os avisos de status
function createJob(userId, url, requestedMode, tgChatId = null) {
  const platform = detectPlatform(url)
  if (!platform) throw new HttpError(400, 'Cole um link de vídeo do Instagram ou do TikTok.')
  const pending = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status = 'processing'").get(userId).n
  if (pending >= MAX_PENDING_PER_USER) throw new HttpError(429, 'Espere os vídeos em processamento terminarem.')
  const mode = requestedMode === 'raw' || requestedMode === 'edited' ? requestedMode : getProfile(userId).mode
  const t = now()
  const { lastInsertRowid } = db
    .prepare("INSERT INTO jobs (user_id, url, platform, mode, status, tg_chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)")
    .run(userId, url, platform, mode, tgChatId, t, t)
  const id = Number(lastInsertRowid)
  enqueue(id)
  return id
}

// Fila simples em memória; jobs "processing" interrompidos por reinício viram erro no boot
const queue = []
let active = 0

function enqueue(jobId) {
  queue.push(jobId)
  pump()
}

function pump() {
  while (active < WORKERS && queue.length) {
    const id = queue.shift()
    active++
    processJob(id)
      .catch(e => console.error(`job ${id}:`, e))
      .finally(() => {
        active--
        pump()
      })
  }
}

async function processJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  if (!job || job.status !== 'processing') return
  const output = join(VIDEOS_DIR, `${id}.mp4`)
  try {
    await writeBrand(job.user_id)
    const { caption: original } = await processVideo({
      url: job.url,
      platform: job.platform,
      edited: job.mode === 'edited',
      userDir: userDir(job.user_id),
      output,
    })
    setJob(id, { video_path: output, original_caption: original })
    await makeThumb(id, output)
    const { caption, model } = await captionForJob(job.user_id)
    const autoPost = !!getProfile(job.user_id).auto_post
    setJob(id, { caption, model, status: autoPost ? 'ready' : 'review' })
  } catch (e) {
    console.error(`job ${id} falhou:`, e.message)
    // Vídeo pronto mas legenda falhou: deixa revisar e escrever à mão
    if (existsSync(output)) setJob(id, { status: 'review', error: e.message })
    else setJob(id, { status: 'error', error: friendlyError(e.message) })
  }
}

// Com caption_reuse = N, a mesma legenda vai em N vídeos seguidos e só então gera outra.
// Dois vídeos da mesma conta ao mesmo tempo esperam a mesma geração em vez de gerar duas
const captionInFlight = new Map() // userId -> promise
async function captionForJob(userId) {
  const p = getProfile(userId)
  // Legenda fixa colada pelo usuário tem prioridade enquanto houver usos
  if (p.custom_caption && p.custom_caption_left > 0) {
    db.prepare('UPDATE profiles SET custom_caption_left = custom_caption_left - 1 WHERE user_id = ?').run(userId)
    return { caption: p.custom_caption, model: 'fixa' }
  }
  // Acabou (ou nunca teve) a legenda fixa e o usuário escolheu postar sem legenda
  if (p.after_custom === 'none') return { caption: '', model: 'sem-legenda' }
  const reuse = p.caption_reuse > 1
  if (reuse && p.reuse_left > 0 && p.reuse_caption) {
    db.prepare('UPDATE profiles SET reuse_left = reuse_left - 1 WHERE user_id = ?').run(userId)
    return { caption: p.reuse_caption, model: 'reutilizada' }
  }
  if (reuse && captionInFlight.has(userId)) {
    await captionInFlight.get(userId).catch(() => {})
    return captionForJob(userId)
  }
  useCaptionQuota(userId)
  const promise = generateCaption()
  if (reuse) captionInFlight.set(userId, promise)
  try {
    const result = await promise
    if (reuse) db.prepare('UPDATE profiles SET reuse_caption = ?, reuse_left = ? WHERE user_id = ?').run(result.caption, p.caption_reuse - 1, userId)
    return result
  } finally {
    if (captionInFlight.get(userId) === promise) captionInFlight.delete(userId)
  }
}

// Quadro do começo do vídeo, pequeno, pra lista do site. Sem miniatura não é erro
async function makeThumb(id, video) {
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.5', '-i', video, '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '5', '-threads', '1', thumbPath(id)])
  } catch (e) {
    console.warn(`job ${id}: sem miniatura:`, e.message)
  }
}

// Mensagem do yt-dlp/ffmpeg é técnica demais pro cliente; o original fica no log
function friendlyError(msg) {
  if (/empty media response|login required|cookies|rate-limit|429/i.test(msg))
    return 'O Instagram bloqueou o download desse post agora (privado ou limite de acesso). Tente outro link ou mais tarde.'
  if (/not available|unavailable|removed|private|404/i.test(msg)) return 'Vídeo indisponível: foi apagado ou é privado.'
  if (/no video|Nenhum vídeo/i.test(msg)) return 'Esse link não tem vídeo.'
  if (/larger than max-filesize|File is larger/i.test(msg)) return 'Vídeo grande demais (máx. 300 MB).'
  return 'Não consegui baixar esse vídeo. Confira o link e tente de novo.'
}

async function removeJobVideo(job) {
  if (job.video_path) await rm(job.video_path, { force: true })
}

// Manutenção: libera jobs travados em "posting" e apaga vídeos antigos
async function housekeeping() {
  // Um por um pelo setJob: quem mandou pelo Telegram fica sabendo
  for (const { id } of db.prepare("SELECT id FROM jobs WHERE status = 'posting' AND claimed_at < ?").all(now() - POSTING_TIMEOUT))
    setJob(id, { status: 'failed', error: 'A extensão não confirmou a postagem a tempo.' })
  const old = db.prepare('SELECT * FROM jobs WHERE video_path IS NOT NULL AND updated_at < ?').all(now() - VIDEO_TTL)
  for (const job of old) {
    await removeJobVideo(job)
    db.prepare('UPDATE jobs SET video_path = NULL WHERE id = ?').run(job.id)
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now())
  db.prepare('DELETE FROM device_codes WHERE expires_at < ?').run(now())
  // Arquivos órfãos (job apagado do banco)
  for (const f of await readdir(THUMBS_DIR)) {
    const id = Number(f.replace(/\.jpg$/, ''))
    if (!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id)) await rm(join(THUMBS_DIR, f), { force: true })
  }
  for (const f of await readdir(VIDEOS_DIR)) {
    const id = Number(f.replace(/\.mp4$/, ''))
    if (!db.prepare('SELECT 1 FROM jobs WHERE id = ? AND video_path IS NOT NULL').get(id)) await rm(join(VIDEOS_DIR, f), { force: true })
  }
}

await ensureYtDlp()
setInterval(() => ensureYtDlp(), 24 * 3600 * 1000).unref()

for (const { id } of db.prepare("SELECT id FROM jobs WHERE status = 'processing'").all())
  setJob(id, { status: 'error', error: 'Servidor reiniciou durante o processamento. Tente de novo.' })
// Jobs "posting" órfãos de um deploy/reinício: volta pra revisão (não trava a fila nem repõe sozinho,
// evitando postar o mesmo vídeo duas vezes). O usuário confere e reposta num clique se precisar.
for (const { id } of db.prepare("SELECT id FROM jobs WHERE status = 'posting'").all())
  setJob(id, { status: 'review', error: 'O servidor reiniciou durante a postagem. Confira se o vídeo saiu no Instagram e reposte se precisar.' })
setInterval(() => housekeeping().catch(e => console.error('housekeeping:', e)), 5 * 60 * 1000).unref()
housekeeping().catch(() => {})

// ---------- rotas ----------

const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.zip': 'application/zip' }

// Muda quando style.css ou app.js mudam (mesmo conteúdo = mesma versão, cache continua valendo)
const ASSET_VERSION = sha256(
  (await Promise.all(['style.css', 'app.js'].map(f => readFile(join(PUBLIC_DIR, f), 'utf8')))).join('')
).slice(0, 10)

const routes = []
const route = (method, pattern, handler) => routes.push({ method, pattern, handler })

// --- conta ---
route('POST', '/api/register', async (req, res) => {
  const { email, password } = await readJson(req)
  const mail = String(email || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 200) throw new HttpError(400, 'E-mail inválido.')
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Senha precisa de pelo menos 8 caracteres.')
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) throw new HttpError(409, 'Esse e-mail já tem conta. Faça login.')
  const { lastInsertRowid: id } = db.prepare('INSERT INTO users (email, pass, created_at) VALUES (?, ?, ?)').run(mail, hashPassword(password), now())
  getProfile(Number(id))
  createSession(res, Number(id))
  json(res, 200, { ok: true })
})

route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req)
  checkLoginRate(ip)
  const { email, password } = await readJson(req)
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase())
  if (!user || typeof password !== 'string' || !checkPassword(password, user.pass)) {
    addLoginFail(ip)
    throw new HttpError(401, 'E-mail ou senha incorretos.')
  }
  createSession(res, user.id)
  json(res, 200, { ok: true })
})

route('POST', '/api/logout', async (req, res) => {
  const sid = cookies(req).sid
  if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid))
  json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) })
})

route('GET', '/api/me', async (req, res) => {
  const user = requireUser(req)
  json(res, 200, { email: user.email, profile: publicProfile(getProfile(user.id)) })
})

// --- personalização ---
route('PUT', '/api/profile', async (req, res) => {
  const user = requireUser(req)
  const body = await readJson(req)
  let handle = clean(body.handle, 40).replace(/\s+/g, '')
  if (handle && !handle.startsWith('@')) handle = '@' + handle
  const reuse = Math.min(100, Math.max(1, Math.round(Number(body.captionReuse)) || 1))
  // Legenda fixa: texto + quantos vídeos vão usá-la, e o que fazer depois
  const customCaption = typeof body.customCaption === 'string' ? body.customCaption.slice(0, 2200).trim() : ''
  const customUses = customCaption ? Math.min(1000, Math.max(1, Math.round(Number(body.customCaptionUses)) || 1)) : 0
  const afterCustom = body.afterCustom === 'none' ? 'none' : 'generate'
  const prev = getProfile(user.id)
  // Só reinicia o contador quando o texto ou o total mudam; senão mantém (e limita) o que falta
  const customLeft = customCaption === prev.custom_caption && customUses === prev.custom_caption_total
    ? Math.min(prev.custom_caption_left, customUses)
    : customUses
  db.prepare(
    // Diminuiu o N: a legenda atual não pode passar do novo limite. N = 1 desliga
    'UPDATE profiles SET name = ?, handle = ?, phrase = ?, verified = ?, mode = ?, auto_post = ?, caption_reuse = ?, reuse_left = MIN(reuse_left, ?), custom_caption = ?, custom_caption_total = ?, custom_caption_left = ?, after_custom = ?, updated_at = ? WHERE user_id = ?'
  ).run(
    clean(body.name, 40),
    handle,
    clean(body.phrase, 160),
    body.verified ? 1 : 0,
    body.mode === 'raw' ? 'raw' : 'edited',
    body.autoPost === false ? 0 : 1,
    reuse,
    reuse - 1,
    customCaption,
    customUses,
    customLeft,
    afterCustom,
    now(),
    user.id
  )
  await writeBrand(user.id)
  json(res, 200, { profile: publicProfile(getProfile(user.id)) })
})

route('POST', '/api/profile/avatar', async (req, res) => {
  const user = requireUser(req)
  const buffer = await readBody(req, 8 * 1024 * 1024)
  if (!buffer.length) throw new HttpError(400, 'Envie uma imagem.')
  await mkdir(userDir(user.id), { recursive: true })
  await normalizeAvatar(buffer, join(userDir(user.id), 'avatar.jpg'))
  db.prepare('UPDATE profiles SET has_avatar = 1, updated_at = ? WHERE user_id = ?').run(now(), user.id)
  await writeBrand(user.id)
  json(res, 200, { profile: publicProfile(getProfile(user.id)) })
})

route('GET', '/api/profile/avatar', async (req, res) => {
  const user = requireUser(req)
  await sendFile(res, join(userDir(user.id), 'avatar.jpg'), 'image/jpeg')
})

// Bloco perfil + frase exatamente como vai aparecer no vídeo
route('GET', '/api/profile/preview', async (req, res) => {
  const user = requireUser(req)
  await writeBrand(user.id)
  const { text } = await getOverlay(userDir(user.id))
  await sendFile(res, text, 'image/png')
})

// --- dispositivos ---
route('POST', '/api/device-code', async (req, res) => {
  const user = requireUser(req)
  db.prepare('DELETE FROM device_codes WHERE user_id = ?').run(user.id)
  const code = newDeviceCode()
  db.prepare('INSERT INTO device_codes (code, user_id, expires_at) VALUES (?, ?, ?)').run(code, user.id, now() + CODE_TTL)
  json(res, 200, { code, expiresAt: now() + CODE_TTL, telegram: botUsername || null })
})

route('GET', '/api/devices', async (req, res) => {
  const user = requireUser(req)
  const devices = db.prepare('SELECT id, name, created_at, last_seen, tg_chat_id FROM devices WHERE user_id = ? ORDER BY id DESC').all(user.id)
  json(res, 200, {
    devices: devices.map(d => ({
      id: d.id,
      name: d.name,
      kind: d.tg_chat_id ? 'telegram' : 'extension',
      createdAt: d.created_at,
      lastSeen: d.last_seen,
    })),
  })
})

route('DELETE', /^\/api\/devices\/(\d+)$/, async (req, res, [, id]) => {
  const user = requireUser(req)
  db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(Number(id), user.id)
  json(res, 200, { ok: true })
})

// Código do site (extensão ou Telegram): uso único. rateKey limita chutes (IP ou chat)
function redeemCode(code, rateKey) {
  checkLoginRate(rateKey)
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4)}`
  const row = db.prepare('SELECT * FROM device_codes WHERE code = ? AND expires_at > ?').get(formatted, now())
  if (!row) {
    addLoginFail(rateKey)
    throw new HttpError(401, 'Código inválido ou expirado. Gere outro no site.')
  }
  db.prepare('DELETE FROM device_codes WHERE code = ?').run(formatted)
  return row.user_id
}

// --- vídeos (site) ---
route('POST', '/api/jobs', async (req, res) => {
  const user = requireUser(req)
  const body = await readJson(req, 4096)
  const id = createJob(user.id, String(body.url || '').trim(), body.mode)
  json(res, 200, { job: publicJob(getJob(user.id, id)) })
})

route('GET', '/api/jobs', async (req, res) => {
  const user = requireUser(req)
  const jobs = db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id)
  // Contagem de todos os vídeos da conta, não só dos 100 da lista
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM jobs WHERE user_id = ? GROUP BY status').all(user.id).map(r => [r.status, r.n])
  )
  const online = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND tg_chat_id IS NULL AND last_seen > ?').get(user.id, now() - 2 * 60 * 1000).n
  json(res, 200, { jobs: jobs.map(publicJob), counts, devicesOnline: online })
})

route('GET', /^\/api\/jobs\/(\d+)\/video$/, async (req, res, [, id]) => {
  const user = requireUser(req)
  const job = getJob(user.id, id)
  await sendFile(res, job.video_path, 'video/mp4', { 'Content-Disposition': `attachment; filename="reel-${job.id}.mp4"` })
})

route('GET', /^\/api\/jobs\/(\d+)\/thumb$/, async (req, res, [, id]) => {
  const user = requireUser(req)
  const job = getJob(user.id, id)
  await sendFile(res, thumbPath(job.id), 'image/jpeg', { 'Cache-Control': 'private, max-age=86400' })
})

route('PUT', /^\/api\/jobs\/(\d+)\/caption$/, async (req, res, [, id]) => {
  const user = requireUser(req)
  const job = getJob(user.id, id)
  if (job.status === 'posting' || job.status === 'posted') throw new HttpError(409, 'Esse vídeo já foi pra postagem.')
  const { caption } = await readJson(req)
  setJob(job.id, { caption: String(caption ?? '').slice(0, 2200) })
  json(res, 200, { job: publicJob(getJob(user.id, id)) })
})

route('POST', /^\/api\/jobs\/(\d+)\/regenerate$/, async (req, res, [, id]) => {
  const user = requireUser(req)
  const job = getJob(user.id, id)
  if (!['review', 'ready', 'failed'].includes(job.status)) throw new HttpError(409, 'Não dá pra gerar outra legenda agora.')
  useCaptionQuota(user.id)
  const { caption, model } = await generateCaption()
  setJob(job.id, { caption, model, error: null })
  json(res, 200, { job: publicJob(getJob(user.id, id)) })
})

// Manda (ou reenvia) pra fila da extensão
route('POST', /^\/api\/jobs\/(\d+)\/post$/, async (req, res, [, id]) => {
  const user = requireUser(req)
  const job = getJob(user.id, id)
  if (!['review', 'failed', 'ready'].includes(job.status)) throw new HttpError(409, 'Esse vídeo não pode ser postado agora.')
  if (!job.video_path || !existsSync(job.video_path)) throw new HttpError(410, 'O vídeo expirou. Baixe de novo.')
  setJob(job.id, { status: 'ready', error: null })
  json(res, 200, { job: publicJob(getJob(user.id, id)) })
})

route('DELETE', /^\/api\/jobs\/(\d+)$/, async (req, res, [, id]) => {
  const user = requireUser(req)
  const job = getJob(user.id, id)
  if (job.status === 'processing' || job.status === 'posting') throw new HttpError(409, 'Espere terminar antes de apagar.')
  await removeJobVideo(job)
  await rm(thumbPath(job.id), { force: true })
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id)
  json(res, 200, { ok: true })
})

// --- extensão ---
route('POST', '/api/ext/login', async (req, res) => {
  const { code, name } = await readJson(req)
  const userId = redeemCode(code, clientIp(req))
  const token = newToken()
  db.prepare('INSERT INTO devices (user_id, token_hash, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(
    userId,
    sha256(token),
    clean(name, 60) || 'Chrome',
    now(),
    now()
  )
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId)
  json(res, 200, { token, email: user.email })
})

route('GET', '/api/ext/me', async (req, res) => {
  const device = requireDevice(req)
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(device.user_id)
  const p = getProfile(device.user_id)
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status = 'ready'").get(device.user_id).n
  json(res, 200, { email: user.email, device: device.name, handle: p.handle, waiting })
})

route('POST', '/api/ext/logout', async (req, res) => {
  const device = requireDevice(req)
  db.prepare('DELETE FROM devices WHERE id = ?').run(device.id)
  json(res, 200, { ok: true })
})

// Pega o próximo vídeo pronto e marca como "postando" por este dispositivo (só um por vez)
route('POST', '/api/ext/claim', async (req, res) => {
  const device = requireDevice(req)
  // Só bloqueia por um "posting" recente: um travado (extensão fechou no meio) não trava a fila pra sempre
  const busy = db.prepare("SELECT 1 FROM jobs WHERE user_id = ? AND status = 'posting' AND claimed_at > ?").get(device.user_id, now() - POSTING_TIMEOUT)
  if (busy) return json(res, 200, { job: null })
  const job = db.prepare("SELECT * FROM jobs WHERE user_id = ? AND status = 'ready' ORDER BY id LIMIT 1").get(device.user_id)
  if (!job) return json(res, 200, { job: null })
  if (!job.video_path || !existsSync(job.video_path)) {
    setJob(job.id, { status: 'failed', error: 'O vídeo expirou antes de postar.' })
    return json(res, 200, { job: null })
  }
  // UPDATE condicional: se dois dispositivos pedirem juntos, só um ganha
  const { changes } = db
    .prepare("UPDATE jobs SET status = 'posting', device_id = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'ready'")
    .run(device.id, now(), now(), job.id)
  if (!changes) return json(res, 200, { job: null })
  notifyTelegram(job.id)
  json(res, 200, { job: { id: job.id, caption: job.caption, hasCover: !!getProfile(device.user_id).has_avatar } })
})

function deviceJob(device, id) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ? AND status = 'posting' AND device_id = ?").get(Number(id), device.user_id, device.id)
  if (!job) throw new HttpError(404, 'Esse vídeo não está reservado pra este dispositivo.')
  return job
}

route('GET', /^\/api\/ext\/jobs\/(\d+)\/video$/, async (req, res, [, id]) => {
  const job = deviceJob(requireDevice(req), id)
  await sendFile(res, job.video_path, 'video/mp4')
})

route('GET', /^\/api\/ext\/jobs\/(\d+)\/cover$/, async (req, res, [, id]) => {
  const device = requireDevice(req)
  deviceJob(device, id)
  await sendFile(res, join(userDir(device.user_id), 'avatar.jpg'), 'image/jpeg')
})

route('POST', /^\/api\/ext\/jobs\/(\d+)\/result$/, async (req, res, [, id]) => {
  const job = deviceJob(requireDevice(req), id)
  const { ok, error, warning, captionReport } = await readJson(req)
  let report = captionReport ? JSON.stringify(captionReport) : null
  if (report?.length > 8000) report = JSON.stringify({ truncated: true, verified: !!captionReport.verified })
  // Postado com aviso (ex.: legenda não confirmada) continua "posted": repostar duplicaria o vídeo
  if (ok) setJob(job.id, { status: 'posted', error: clean(warning, 300) || null, caption_report: report })
  else setJob(job.id, { status: 'failed', error: clean(error, 300) || 'Falhou sem mensagem.' })
  json(res, 200, { ok: true })
})

route('GET', '/reel-autopost.zip', async (req, res) => {
  const zip = await buildExtensionZip(PUBLIC_URL)
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': 'attachment; filename="reel-autopost.zip"',
    // Sem isso o Cloudflare da Discloud guarda o .zip por 4h e serve extensão velha
    'Cache-Control': 'no-store',
  })
  res.end(zip)
})

// ---------- Telegram ----------

function telegramStatusText(job) {
  const n = `#${job.id}`
  switch (job.status) {
    case 'ready': {
      const online = db.prepare('SELECT 1 FROM devices WHERE user_id = ? AND tg_chat_id IS NULL AND last_seen > ?').get(job.user_id, now() - 2 * 60 * 1000)
      return `Vídeo ${n} pronto ✓ Na fila da extensão.` + (online ? '' : '\nNenhuma extensão online agora: ele é postado assim que o Chrome abrir logado no Instagram.')
    }
    case 'review':
      return job.error
        ? `Vídeo ${n} pronto, mas a legenda não saiu. Escreva a legenda no site e clique em Postar: ${siteLink}`
        : `Vídeo ${n} pronto e esperando sua revisão (o postar automático está desligado). Revise e poste pelo site: ${siteLink}`
    case 'posting':
      return `Postando o vídeo ${n} no Instagram…`
    case 'posted':
      return `Vídeo ${n} postado no Instagram ✓` + (job.error ? `\n⚠️ ${job.error}` : '')
    case 'failed':
      return `Não consegui postar o vídeo ${n}: ${job.error || 'falhou sem mensagem.'}\nDá pra tentar de novo pelo site: ${siteLink}`
    case 'error':
      return `Não consegui preparar o vídeo ${n}: ${job.error || 'falhou sem mensagem.'}`
  }
}

// Só avisa se o chat que mandou o link continua ligado à conta (desconectou = silêncio)
function notifyTelegram(jobId) {
  if (!telegramEnabled) return
  const job = db
    .prepare('SELECT j.* FROM jobs j JOIN devices d ON d.tg_chat_id = j.tg_chat_id AND d.user_id = j.user_id WHERE j.id = ?')
    .get(jobId)
  const text = job && telegramStatusText(job)
  if (text) sendMessage(job.tg_chat_id, text)
}

const TG_HELP = [
  'Mande um link de vídeo do TikTok ou do Instagram que eu baixo, edito com o seu perfil, gero a legenda e mando pra postagem.',
  'Comandos: /sair desconecta este chat da sua conta.',
].join('\n')
const TG_CONNECT = `Pra começar, conecte este chat à sua conta: no site, aba "Conectar extensão", clique em Gerar código e mande o código aqui.\n${siteLink}`
// Link sem https:// (ex.: "vm.tiktok.com/abc") também vale
const TG_LINKS = /(?:https?:\/\/)?(?:[\w-]+\.)*(?:instagram\.com|tiktok\.com)\/[^\s<>"']+/gi

async function onTelegramMessage(msg) {
  // Só conversa privada: em grupo, qualquer um mandaria vídeo pra conta de outra pessoa
  if (msg.chat?.type !== 'private') return
  const chatId = String(msg.chat.id)
  const reply = text => sendMessage(chatId, text)
  const text = String(msg.text || msg.caption || '').trim()
  const [first = '', arg = ''] = text.split(/\s+/)
  const command = first.startsWith('/') ? first.slice(1).split('@')[0].toLowerCase() : ''
  const device = db.prepare('SELECT id, user_id FROM devices WHERE tg_chat_id = ?').get(chatId)

  // Conectar: "/start CODIGO" (link t.me/bot?start=CODIGO do site) ou só o código
  const code = command === 'start' ? arg : !command && /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(text) ? text : ''
  if (code) {
    try {
      const userId = redeemCode(code, `tg:${chatId}`)
      const who = msg.from?.username ? `@${msg.from.username}` : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
      // Chat já ligado a outra conta passa pra conta nova
      db.prepare('DELETE FROM devices WHERE tg_chat_id = ?').run(chatId)
      db.prepare('INSERT INTO devices (user_id, token_hash, name, tg_chat_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?, 0)').run(
        userId,
        // Token aleatório que ninguém recebe: este dispositivo não usa as rotas da extensão
        sha256(newToken()),
        clean(`Telegram${who ? ` (${who})` : ''}`, 60),
        chatId,
        now()
      )
      const { email } = db.prepare('SELECT email FROM users WHERE id = ?').get(userId)
      return reply(`Conectado à conta ${email} ✓\n\n${TG_HELP}`)
    } catch (e) {
      return reply(e instanceof HttpError ? e.message : 'Não consegui conectar agora. Tente de novo em instantes.')
    }
  }

  if (command === 'sair') {
    if (!device) return reply('Este chat não está conectado a nenhuma conta.')
    db.prepare('DELETE FROM devices WHERE id = ?').run(device.id)
    return reply('Desconectado. Pra voltar, gere um código novo no site e mande aqui.')
  }
  if (!device) return reply(TG_CONNECT)
  if (command) return reply(TG_HELP)

  const links = [...new Set((text.match(TG_LINKS) || []).map(l => (/^https?:\/\//i.test(l) ? l : `https://${l}`).replace(/^http:/i, 'https:')))]
  if (!links.length) return reply(`Não achei link de TikTok ou Instagram nessa mensagem.\n\n${TG_HELP}`)
  for (const url of links.slice(0, MAX_PENDING_PER_USER)) {
    try {
      const id = createJob(device.user_id, url, undefined, chatId)
      await reply(`Recebi ✓ Vídeo #${id}: baixando e editando… Te aviso quando ficar pronto.`)
    } catch (e) {
      await reply(e instanceof HttpError ? e.message : 'Não consegui colocar esse vídeo na fila agora. Tente de novo.')
      if (!(e instanceof HttpError)) console.error('Telegram: createJob falhou:', e)
    }
  }
}

// ---------- servidor ----------

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x')
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue
      const match = typeof r.pattern === 'string' ? (r.pattern === pathname ? [pathname] : null) : pathname.match(r.pattern)
      if (match) return await r.handler(req, res, match)
    }
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1)
      const full = join(PUBLIC_DIR, file)
      if (full.startsWith(PUBLIC_DIR) && !file.includes('..') && existsSync(full) && (await stat(full)).isFile()) {
        // O Cloudflare da Discloud força max-age de 4h nos .css/.js: a página (que não é cacheada)
        // aponta pra ?v=<versão>, então cada deploy vira um endereço novo e ninguém fica com o velho
        if (file === 'index.html') {
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
          return res.end((await readFile(full, 'utf8')).replace(/(\/(?:style\.css|app\.js))"/g, `$1?v=${ASSET_VERSION}"`))
        }
        res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
        return createReadStream(full).pipe(res)
      }
    }
    json(res, 404, { error: 'Não encontrado.' })
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e)
    if (res.headersSent) return res.end()
    json(res, e.status || 500, { error: e instanceof HttpError ? e.message : `Erro interno: ${e.message}` })
  }
}).listen(PORT, process.env.HOST || undefined, () => console.log(`Rodando em ${PUBLIC_URL} (Node ${process.version})`))

const TG_OFFSET_KEY = 'telegram_offset'
startPolling({
  onMessage: onTelegramMessage,
  offset: {
    get: () => Number(db.prepare('SELECT value FROM kv WHERE key = ?').get(TG_OFFSET_KEY)?.value || 0),
    set: n =>
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(TG_OFFSET_KEY, String(n)),
  },
})
