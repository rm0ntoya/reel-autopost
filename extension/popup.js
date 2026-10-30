import { SERVER } from './config.js'

const $ = id => document.getElementById(id)
const send = msg => chrome.runtime.sendMessage(msg)
const openSite = () => chrome.tabs.create({ url: SERVER })

$('site').onclick = openSite
$('site2').onclick = openSite
$('version').textContent = `v${chrome.runtime.getManifest().version}`

$('code').addEventListener('input', e => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  e.target.value = v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v
  $('login-msg').textContent = ''
})

$('f').addEventListener('submit', async e => {
  e.preventDefault()
  $('go').disabled = true
  $('go').textContent = 'Conectando…'
  const r = await send({ type: 'login', code: $('code').value })
  $('go').disabled = false
  $('go').textContent = 'Conectar'
  if (!r?.ok) return ($('login-msg').textContent = r?.error || 'Não consegui conectar.')
  render()
})

$('check').onclick = async () => {
  $('check').disabled = true
  $('check').textContent = 'Verificando…'
  await send({ type: 'check' })
  $('check').disabled = false
  $('check').textContent = 'Postar agora'
  render()
}

$('logout').onclick = async () => {
  await send({ type: 'logout' })
  render()
}

const time = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

async function render() {
  const s = await send({ type: 'status' })
  const loggedIn = !!s?.loggedIn
  $('login').hidden = loggedIn
  $('app').hidden = !loggedIn
  $('account').hidden = !loggedIn
  if (!loggedIn) return $('code').focus()

  $('email').textContent = s.email
  $('live').className = `live${s.offline ? ' off' : s.running ? ' busy' : ''}`
  $('state').textContent = s.offline ? 'Sem conexão com o servidor' : s.running ? 'Postando agora…' : 'Conectado'
  $('waiting').textContent = s.offline ? '–' : s.waiting ?? 0
  $('waiting-label').textContent = s.waiting === 1 ? 'vídeo esperando pra postar' : 'vídeos esperando pra postar'
  $('handle').textContent = s.handle ? `Perfil nos vídeos: ${s.handle}` : ''

  const last = s.last
  $('last').className = !last ? 'last' : !last.ok ? 'last err' : last.warning ? 'last warn' : 'last ok'
  $('last').textContent = !last ? ''
    : !last.ok ? `Último post falhou (${time(last.at)}): ${last.error}`
      : `Último post às ${time(last.at)} ✓${last.warning ? ` — ${last.warning}` : ''}`
}

render()
