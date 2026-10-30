import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rename, copyFile, stat } from 'node:fs/promises'
import { renderOverlay } from './overlay.js'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname
// Opcional: caminho de um cookies.txt (formato Netscape) pra posts privados / rate-limit
// (no servidor: basta subir um cookies.txt na raiz do app)
const DEFAULT_COOKIES = join(ROOT, 'cookies.txt')
const COOKIES = process.env.IG_COOKIES || (existsSync(DEFAULT_COOKIES) ? DEFAULT_COOKIES : '')
// Ou ler direto do navegador logado no Instagram: chrome, safari, firefox, brave...
const COOKIES_BROWSER = process.env.IG_BROWSER
// yt-dlp: no Mac usa o do .venv (o do Homebrew quebra por causa do libexpat);
// no servidor Linux baixa o binário oficial (o do APT fica velho e o Instagram muda sempre)
const LOCAL_YTDLP = join(ROOT, '.venv/bin/yt-dlp')
const BIN_DIR = join(ROOT, 'data', 'bin')
const LINUX_YTDLP = join(BIN_DIR, 'yt-dlp')
let YTDLP = process.env.YTDLP || (existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp')

export async function ensureYtDlp() {
  if (process.env.YTDLP || process.platform !== 'linux') return
  const arch = process.arch === 'arm64' ? '_aarch64' : ''
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux${arch}`
  try {
    // Atualiza no máx. 1x por dia
    const fresh = existsSync(LINUX_YTDLP) && Date.now() - (await stat(LINUX_YTDLP)).mtimeMs < 24 * 3600 * 1000
    if (!fresh) {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await mkdir(BIN_DIR, { recursive: true })
      const tmp = LINUX_YTDLP + '.tmp'
      await writeFile(tmp, Buffer.from(await r.arrayBuffer()), { mode: 0o755 })
      await rename(tmp, LINUX_YTDLP)
      console.log('yt-dlp atualizado:', (await run(LINUX_YTDLP, ['--version'])).trim())
    }
    YTDLP = LINUX_YTDLP
  } catch (e) {
    console.warn('Não consegui baixar o yt-dlp, usando o do sistema:', e.message)
    if (existsSync(LINUX_YTDLP)) YTDLP = LINUX_YTDLP
  }
}

export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let out = ''
    let err = ''
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (err += d))
    p.on('error', reject)
    p.on('close', code =>
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${cmd} saiu com código ${code}`))
    )
  })
}

// Descobre a plataforma pelo link: 'instagram', 'tiktok' ou null
export function detectPlatform(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    if (/(^|\.)instagram\.com$/.test(u.hostname) && /^\/(p|reel|reels|tv|stories)\//.test(u.pathname)) return 'instagram'
    // tiktok.com/@user/video/ID, /t/CODE e links curtos vm./vt.tiktok.com
    if (/^(www\.|m\.)?tiktok\.com$/.test(u.hostname) && /^\/(@[^/]+\/video\/\d+|t\/\w+|v\/\d+)/.test(u.pathname)) return 'tiktok'
    if (/^(vm|vt)\.tiktok\.com$/.test(u.hostname) && /^\/\w+/.test(u.pathname)) return 'tiktok'
    return null
  } catch {
    return null
  }
}

// TikTok: nunca pega o formato com marca d'água ("watermarked"); o "?" aceita formato sem essa info
const NO_WATERMARK = '[format_note!*=?watermark]'
function formatArgs(platform, edited) {
  if (platform !== 'tiktok') return ['-f', 'bv*+ba/b']
  return [
    '-f', `b${NO_WATERMARK}/bv*${NO_WATERMARK}+ba`,
    // Só o vídeo: H.264 (o Instagram aceita melhor); editado vai recodificar, então maior resolução
    '-S', edited ? 'res,br' : 'vcodec:h264,res,br',
  ]
}

// Unidades SEI carregam string do encoder (ex: "x264 - core ...") dentro do próprio bitstream
const SEI_FILTER = {
  h264: 'filter_units=remove_types=6',
  hevc: 'filter_units=remove_types=39|40',
}

// Remove metadados globais, de stream e capítulos sem recodificar
async function stripMetadata(input, output) {
  const codec = (
    await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', input])
  ).trim()
  const bsf = SEI_FILTER[codec] ? ['-bsf:v', SEI_FILTER[codec]] : []
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-i', input,
    '-map', '0',
    '-map_metadata', '-1',
    '-map_metadata:s', '-1',
    '-map_chapters', '-1',
    '-metadata:s', 'handler_name=',
    '-metadata:s', 'vendor_id=',
    '-metadata:s', 'language=und',
    '-c', 'copy',
    ...bsf,
    '-fflags', '+bitexact',
    '-movflags', '+faststart',
    output,
  ])
}

// Camadas (fundo + perfil/frase) de cada usuário; refeitas quando o perfil ou o avatar mudam
const overlayCache = new Map() // userDir -> { layout, stamp }

export async function getOverlay(userDir) {
  const brandFile = join(userDir, 'brand.json')
  const avatar = join(userDir, 'avatar.jpg')
  const bg = join(userDir, 'bg.png')
  const text = join(userDir, 'text.png')
  const avatarStamp = existsSync(avatar) ? (await stat(avatar)).mtimeMs : 0
  const stamp = `${(await stat(brandFile)).mtimeMs}:${avatarStamp}`
  const cached = overlayCache.get(userDir)
  if (cached?.stamp === stamp && existsSync(bg) && existsSync(text)) return cached
  const brand = JSON.parse(await readFile(brandFile, 'utf8'))
  const layout = await renderOverlay({ ...brand, avatar: brand.avatar ? join(userDir, brand.avatar) : '' }, bg, text)
  const entry = { layout, stamp, bg, text }
  overlayCache.set(userDir, entry)
  return entry
}

// Tamanho como o vídeo aparece na tela (vídeo de celular pode vir com rotação de 90°)
async function displaySize(input) {
  const info = JSON.parse(
    await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:stream_side_data=rotation', '-of', 'json', input])
  ).streams[0]
  const rotation = Math.abs(info.side_data_list?.find(d => 'rotation' in d)?.rotation ?? 0)
  const swap = rotation === 90 || rotation === 270
  return { w: swap ? info.height : info.width, h: swap ? info.width : info.height, fps: info.r_frame_rate || '30' }
}

// Threads fixas: na Discloud o container enxerga 48 núcleos e o x264 em modo
// automático abre uma thread por núcleo, estourando o limite de RAM. A cota real de CPU
// é ~1,4 núcleo, então mais threads não aceleram; o preset superfast é que acelera
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || '2'

const even = n => Math.max(2, Math.floor(n / 2) * 2)

// Perfil + frase em cima, vídeo inteiro logo abaixo (sem cortar); bloco centralizado na tela
async function composeEdited(userDir, input, output) {
  const { layout: L, bg, text } = await getOverlay(userDir)
  const src = await displaySize(input)
  const maxH = L.height - 2 * L.margin - L.textH - L.gap
  const scale = Math.min(L.videoW / src.w, maxH / src.h)
  const vw = even(src.w * scale)
  const vh = even(src.h * scale)
  const textY = Math.round((L.height - (L.textH + L.gap + vh)) / 2)
  const videoX = Math.round((L.width - vw) / 2)
  const videoY = textY + L.textH + L.gap
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-filter_complex_threads', FFMPEG_THREADS,
    '-loop', '1', '-framerate', src.fps, '-i', bg,
    '-loop', '1', '-framerate', src.fps, '-i', text,
    '-threads', FFMPEG_THREADS, '-i', input,
    '-filter_complex',
    `[2:v]scale=${vw}:${vh},setsar=1[v];` +
      `[0:v][1:v]overlay=x=0:y=${textY}[bg];` +
      `[bg][v]overlay=x=${videoX}:y=${videoY}:shortest=1,format=yuv420p[out]`,
    '-map', '[out]', '-map', '2:a?',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '21', '-threads', FFMPEG_THREADS,
    '-c:a', 'copy',
    '-map_metadata', '-1',
    output,
  ])
}

// Baixa o primeiro vídeo do link, edita (opcional), limpa metadados e salva em `output`.
// Retorna a legenda original do post (só Instagram; TikTok ignora a legenda).
export async function processVideo({ url, platform, edited, userDir, output }) {
  const dir = await mkdtemp(join(tmpdir(), 'igdl-'))
  try {
    const args = [
      '--no-progress', '--no-mtime', '--no-part', '--no-playlist',
      '--no-write-info-json', '--no-write-thumbnail', '--no-embed-metadata',
      // Carrossel: só o primeiro vídeo vira post
      '--playlist-items', '1',
      '--max-filesize', '300M',
      ...formatArgs(platform, edited),
      '--merge-output-format', 'mp4',
      '-o', join(dir, 'raw.%(ext)s'),
    ]
    if (platform === 'instagram') args.push('--no-simulate', '--print', '%(description)j')
    if (COOKIES) args.push('--cookies', COOKIES)
    else if (COOKIES_BROWSER) args.push('--cookies-from-browser', COOKIES_BROWSER)
    args.push('--', url)

    let caption = ''
    const out = await run(YTDLP, args)
    for (const line of out.split('\n')) {
      try {
        const text = JSON.parse(line)
        if (typeof text === 'string' && text.trim()) {
          caption = text
          break
        }
      } catch {}
    }

    const raw = (await readdir(dir)).find(f => f.startsWith('raw.'))
    if (!raw) throw new Error('Nenhum vídeo encontrado nesse link.')
    let source = join(dir, raw)
    if (edited) {
      const composed = join(dir, 'composed.mp4')
      await composeEdited(userDir, source, composed)
      source = composed
    }
    // Strip roda por último também no editado: tira tags e SEI que o x264 grava ao recodificar
    const clean = join(dir, 'clean.mp4')
    await stripMetadata(source, clean)
    await mkdir(join(output, '..'), { recursive: true })
    // rename falha se o tmp estiver em outro disco: aí copia
    await rename(clean, output).catch(() => copyFile(clean, output))
    return { caption }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
