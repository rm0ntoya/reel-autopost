// Sobe o servidor do 9router na porta da Discloud (8080), com os dados em ./data.
// Não usa o CLI do 9router: ele abre menu interativo e tenta abrir navegador.
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const appDir = path.join(__dirname, 'node_modules', '9router', 'app')
const server = fs.existsSync(path.join(appDir, 'custom-server.js')) ? 'custom-server.js' : 'server.js'
const DATA_DIR = path.join(__dirname, 'data')

function start() {
  const child = spawn(process.execPath, ['--dns-result-order=ipv4first', '--max-old-space-size=384', server], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, DATA_DIR, PORT: '8080', HOSTNAME: '0.0.0.0', NODE_ENV: 'production' },
  })
  // Reinicia sozinho se cair
  child.on('exit', code => {
    console.error(`9router saiu (código ${code}), reiniciando em 3s`)
    setTimeout(start, 3000)
  })
}

console.log(`9router: dados em ${DATA_DIR}`)
start()
