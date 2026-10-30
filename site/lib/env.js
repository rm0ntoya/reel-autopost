import { readFileSync } from 'node:fs'

// .env opcional (KEY=valor por linha) sem depender de pacote.
// production.env existe porque o CLI da Discloud não envia arquivos .env
for (const file of ['../.env', '../production.env']) {
  try {
    for (const line of readFileSync(new URL(file, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
}
