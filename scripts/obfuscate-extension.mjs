// Gera site/extension-dist/ (ofuscada, servida pro download) a partir de extension/ (fonte editável).
//
// Perfil SEGURO e obrigatório: várias funções (postReel, armCaptionGuard, captionReport e o arrow de
// readEditor) são serializadas com Function.prototype.toString() e injetadas no mundo MAIN da página do
// Instagram via chrome.scripting.executeScript. Qualquer transform que coloque um helper no escopo do
// MÓDULO (stringArray, selfDefending) faz o corpo serializado referenciar algo que não existe na página
// e quebra tudo. transformObjectKeys também é proibido: mudaria chaves como {periodInMinutes} passadas
// pras APIs do Chrome. controlFlowFlattening/renomear identificadores ficam DENTRO de cada função, então
// sobrevivem à serialização.
import { readdir, readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const JavaScriptObfuscator = require('javascript-obfuscator')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'extension')
const OUT = join(ROOT, 'site', 'extension-dist')

const OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  numbersToExpressions: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  // Tudo que escaparia do escopo da função fica DESLIGADO (ver nota no topo)
  stringArray: false,
  selfDefending: false,
  transformObjectKeys: false,
  renameGlobals: false,
  deadCodeInjection: false,
  unicodeEscapeSequence: false,
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

for (const name of (await readdir(SRC)).sort()) {
  const src = join(SRC, name)
  const dst = join(OUT, name)
  if (!name.endsWith('.js') || name === 'config.js') {
    // config.js é regerado no download (SERVER do site); manifest.json/popup.html ficam legíveis
    await cp(src, dst)
    continue
  }
  const code = await readFile(src, 'utf8')
  const result = JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode()
  await writeFile(dst, result)
  console.log(`ofuscado: ${name} (${code.length} -> ${result.length})`)
}
console.log('site/extension-dist pronto')
