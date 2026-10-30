import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

export const DATA_DIR = new URL('../data/', import.meta.url).pathname
mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(DATA_DIR + 'app.db')
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    pass TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  -- Perfil que vai no vídeo editado + preferências de postagem
  CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    handle TEXT NOT NULL DEFAULT '',
    phrase TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0,
    has_avatar INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'edited',
    auto_post INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  -- Código curto gerado no site e digitado na extensão
  CREATE TABLE IF NOT EXISTS device_codes (
    code TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0
  );
  -- processing -> review (sem auto-post) | ready -> posting -> posted | failed; error = falha no download
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    platform TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    original_caption TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    model TEXT,
    video_path TEXT,
    device_id INTEGER,
    claimed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, id DESC);
  -- Valores soltos do servidor (ex.: offset do Telegram)
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

// Colunas novas em bancos já existentes (ADD COLUMN falha se já tiver: ignora)
for (const sql of [
  // Dispositivo com tg_chat_id é um chat do Telegram, não uma extensão
  'ALTER TABLE devices ADD COLUMN tg_chat_id TEXT',
  // Chat que mandou o link: recebe os avisos de status do vídeo
  'ALTER TABLE jobs ADD COLUMN tg_chat_id TEXT',
  // Mesma legenda em N vídeos seguidos: guarda a legenda da vez e quantos usos faltam
  'ALTER TABLE profiles ADD COLUMN caption_reuse INTEGER NOT NULL DEFAULT 1',
  "ALTER TABLE profiles ADD COLUMN reuse_caption TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE profiles ADD COLUMN reuse_left INTEGER NOT NULL DEFAULT 0',
  // Legenda fixa que o usuário cola: usada custom_caption_total vezes (left = quantas faltam).
  // Esgotada, after_custom decide: 'generate' gera com IA, 'none' posta sem legenda.
  "ALTER TABLE profiles ADD COLUMN custom_caption TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE profiles ADD COLUMN custom_caption_total INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE profiles ADD COLUMN custom_caption_left INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE profiles ADD COLUMN after_custom TEXT NOT NULL DEFAULT 'generate'",
  // O que a extensão viu na requisição de publicação (diagnóstico da legenda)
  'ALTER TABLE jobs ADD COLUMN caption_report TEXT',
]) {
  try {
    db.exec(sql)
  } catch {}
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS devices_tg_chat ON devices(tg_chat_id)')

export const now = () => Date.now()
export const sha256 = s => createHash('sha256').update(s).digest('hex')
export const newToken = () => randomBytes(32).toString('hex')

export function hashPassword(password) {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`
}

export function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  const got = scryptSync(password, Buffer.from(salt, 'hex'), 64)
  return timingSafeEqual(got, Buffer.from(hash, 'hex'))
}

// Sem 0/O/1/I/L: código é digitado à mão na extensão
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export function newDeviceCode() {
  const bytes = randomBytes(8)
  const chars = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}
