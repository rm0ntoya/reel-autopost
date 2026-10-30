import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

// Serve a versão OFUSCADA (site/extension-dist/, gerada por scripts/obfuscate-extension.mjs).
// A fonte editável/legível fica em extension/ na raiz do repositório.
const EXT_DIR = new URL('../extension-dist/', import.meta.url).pathname

// Zip "store" (sem compressão) da pasta extension/, com config.js e manifest apontando pro site.
// Assim cada pessoa baixa a extensão já configurada, sem editar nada.
export async function buildExtensionZip(publicUrl) {
  const origin = new URL(publicUrl).origin
  const files = []
  for (const name of (await readdir(EXT_DIR)).sort()) {
    let data = await readFile(join(EXT_DIR, name))
    if (name === 'config.js') data = Buffer.from(`export const SERVER = ${JSON.stringify(origin)}\n`)
    if (name === 'manifest.json') {
      const m = JSON.parse(data)
      m.content_scripts[0].matches = [`${origin}/*`]
      m.host_permissions = ['https://www.instagram.com/*', `${origin}/*`]
      data = Buffer.from(JSON.stringify(m, null, 2))
    }
    files.push({ name: `reel-autopost/${name}`, data })
  }

  const parts = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // nomes em UTF-8
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuf, end])
}
