// Camadas do vídeo editado: fundo 1080x1920 e bloco transparente com perfil + frase.
// Porta do antigo overlay.py pra Node: roda em qualquer servidor sem Python/Pillow.
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const W = 1080
const H = 1920
const SIDE = 90 // margem lateral da área do vídeo
const BOTTOM = 150
const INK = '#111111'
const MUTED = '#3c3c3c'
const BLUE = '#1d9bf0'

const FONTS = new URL('../assets/fonts/', import.meta.url).pathname
GlobalFonts.registerFromPath(join(FONTS, 'Nunito.ttf'), 'Nunito')
GlobalFonts.registerFromPath(join(FONTS, 'NotoColorEmoji.ttf'), 'Noto Color Emoji')
const font = (size, weight = 900) => `${weight} ${size}px Nunito, "Noto Color Emoji"`

function wrap(ctx, text, maxW) {
  const lines = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = cur ? `${cur} ${word}` : word
    if (ctx.measureText(test).width <= maxW || !cur) cur = test
    else {
      lines.push(cur)
      cur = word
    }
  }
  if (cur) lines.push(cur)
  return lines
}

// Gradiente claro vertical, mais claro a 35% da altura
function background() {
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, 'rgb(233,233,233)')
  g.addColorStop(0.35, 'rgb(250,250,250)')
  g.addColorStop(1, 'rgb(233,233,233)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  return canvas
}

async function drawAvatar(ctx, path, name, x, y, d) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2)
  ctx.clip()
  if (path && existsSync(path)) {
    const im = await loadImage(await readFile(path))
    const side = Math.min(im.width, im.height)
    // Retrato: pega o quadrado da parte de cima (rosto), não o centro
    const top = im.height <= im.width ? 0 : Math.round((im.height - side) * 0.15)
    ctx.drawImage(im, (im.width - side) / 2, top, side, side, x, y, d, d)
  } else {
    // Sem foto: círculo cinza com a inicial do nome
    ctx.fillStyle = 'rgb(200,200,205)'
    ctx.fillRect(x, y, d, d)
    ctx.fillStyle = '#fff'
    ctx.font = font(Math.round(d * 0.5))
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText((name.trim()[0] || '?').toUpperCase(), x + d / 2, y + d / 2)
  }
  ctx.restore()
}

function drawBadge(ctx, x, y, size) {
  ctx.fillStyle = BLUE
  ctx.beginPath()
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = size * 0.12
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(x + size * 0.28, y + size * 0.52)
  ctx.lineTo(x + size * 0.44, y + size * 0.68)
  ctx.lineTo(x + size * 0.73, y + size * 0.35)
  ctx.stroke()
}

// brand: { name, handle, phrase, avatar (caminho ou ''), verified }
// Salva fundo e texto em PNG e devolve as medidas do layout
export async function renderOverlay(brand, bgPath, textPath) {
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.textBaseline = 'top'

  // Cabeçalho: avatar + nome/@ centralizados
  const avD = 150
  const nameF = font(70, 900)
  const handleF = font(46, 700)
  const badge = brand.verified ? 52 : 0
  ctx.font = nameF
  const nameTextW = ctx.measureText(brand.name).width
  const nameW = nameTextW + (badge ? badge + 14 : 0)
  ctx.font = handleF
  const handleW = ctx.measureText(brand.handle).width
  const gap = 26
  const x0 = Math.round((W - (avD + gap + Math.max(nameW, handleW))) / 2)
  const cy = 250
  const ring = 6
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(x0 + avD / 2, cy, avD / 2 + ring, 0, Math.PI * 2)
  ctx.fill()
  await drawAvatar(ctx, brand.avatar, brand.name, x0, cy - avD / 2, avD)

  const tx = x0 + avD + gap
  const nameY = cy - 78
  ctx.textAlign = 'left'
  ctx.fillStyle = INK
  ctx.font = nameF
  ctx.fillText(brand.name, tx, nameY)
  if (badge) drawBadge(ctx, Math.round(tx + nameTextW + 14), nameY + 18, badge)
  ctx.fillStyle = MUTED
  ctx.font = handleF
  ctx.fillText(brand.handle, tx, cy + 6)

  // Frase centralizada, quebrando linha se precisar
  const phraseSize = 72
  ctx.font = font(phraseSize, 900)
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  const lineH = Math.round(phraseSize * 1.18)
  let y = 390
  for (const line of wrap(ctx, brand.phrase, W - 2 * 70)) {
    ctx.fillText(line, W / 2, y)
    y += lineH
  }

  // Recorta do topo do avatar até o fim da frase
  const top = cy - avD / 2 - ring
  let textH = y - top
  textH -= textH % 2
  const crop = createCanvas(W, textH)
  crop.getContext('2d').drawImage(canvas, 0, top, W, textH, 0, 0, W, textH)
  await writeFile(textPath, await crop.encode('png'))
  await writeFile(bgPath, await background().encode('png'))
  return { width: W, height: H, textH, gap: 60, videoW: W - 2 * SIDE, margin: BOTTOM }
}

// Normaliza a foto enviada (JPG/PNG/WEBP) para JPEG de no máx. 1080px
export async function normalizeAvatar(buffer, dest) {
  let im
  try {
    im = await loadImage(buffer)
  } catch {
    throw new Error('Imagem inválida. Envie JPG, PNG ou WEBP.')
  }
  const scale = Math.min(1, 1080 / Math.max(im.width, im.height))
  const canvas = createCanvas(Math.round(im.width * scale), Math.round(im.height * scale))
  canvas.getContext('2d').drawImage(im, 0, 0, canvas.width, canvas.height)
  await writeFile(dest, await canvas.encode('jpeg', 92))
}
