import { postReel } from './poster.js'
import { SERVER } from './config.js'
import { armCaptionGuard, captionReport } from './caption-guard.js'

// Procura vídeo pronto a cada 30s (mínimo do chrome.alarms); o site também avisa na hora via bridge.js
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('poll', { periodInMinutes: 0.5 }))
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('poll', { periodInMinutes: 0.5 }))
chrome.alarms.onAlarm.addListener(a => a.name === 'poll' && tick())

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    login,
    logout,
    status,
    typeText,
    readEditor,
    armGuard: (msg, sender) => runInPage(sender, armCaptionGuard, [msg.caption]),
    guardReport: (msg, sender) => runInPage(sender, captionReport),
    check: () => tick().then(status),
  }
  const handler = handlers[msg?.type]
  if (!handler) return
  handler(msg, sender).then(sendResponse, e => sendResponse({ ok: false, error: e.message }))
  return true // resposta assíncrona
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Digita no campo focado da aba do Instagram como um teclado de verdade (eventos confiáveis
// via protocolo do DevTools), uma letra por vez. O Chrome mostra a faixa "começou a depurar"
// enquanto digita.
async function typeText({ text }, sender) {
  const tab = sender.tab
  if (!tab?.id || !tab.url?.startsWith('https://www.instagram.com/')) throw new Error('Só digito na aba do Instagram')
  const target = { tabId: tab.id }
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params)
  const enter = async () => {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }

  await chrome.debugger.attach(target, '1.3')
  try {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    for (const [i, line] of lines.entries()) {
      // Por "letra" visível: emoji compostos (👍🏽, 👨‍👩‍👧) vão inteiros
      for (const { segment } of new Intl.Segmenter().segment(line)) {
        await send('Input.insertText', { text: segment })
        await sleep(20 + Math.random() * 40)
      }
      // Linha terminando em #hashtag ou @menção deixa a lista de sugestões aberta, e o
      // Enter escolheria a sugestão no lugar da quebra de linha. O espaço fecha a lista.
      if (/[#@][^\s#@]+$/.test(line)) await send('Input.insertText', { text: ' ' })
      if (i < lines.length - 1) await enter()
      await sleep(80)
    }
  } finally {
    await chrome.debugger.detach(target).catch(() => {})
  }
  return { ok: true }
}

// Texto que o editor da legenda (Lexical) guarda internamente, que é o que o Instagram
// publica. A tela pode mostrar texto que o editor não registrou. Precisa do mundo MAIN:
// o objeto do editor fica na página, invisível pros scripts da extensão.
// text null = campo não é Lexical (aí só dá pra conferir pela tela)
async function readEditor(msg, sender) {
  const tab = sender.tab
  if (!tab?.id || !tab.url?.startsWith('https://www.instagram.com/')) throw new Error('Só leio a aba do Instagram')
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      const box =
        document.activeElement?.closest('[contenteditable="true"]') ||
        [...document.querySelectorAll('div[role="dialog"] div[contenteditable="true"][role="textbox"]')].pop()
      const editor = box?.__lexicalEditor
      if (!editor) return null
      const out = []
      const walk = node => {
        if (node.text) out.push(node.text)
        ;(node.children || []).forEach(walk)
      }
      walk(editor.getEditorState().toJSON().root)
      return out.join('')
    },
  })
  return { ok: true, text: result }
}

// Roda uma função de caption-guard.js no mundo MAIN da aba do Instagram que pediu:
// só lá dá pra interceptar o fetch/XHR da própria página
async function runInPage(sender, func, args = []) {
  const tab = sender.tab
  if (!tab?.id || !tab.url?.startsWith('https://www.instagram.com/')) throw new Error('Só rodo na aba do Instagram')
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func, args })
  return { ok: true, result }
}

const getAuth = async () => (await chrome.storage.local.get('auth')).auth || null

async function api(path, { method = 'GET', body, raw } = {}) {
  const auth = await getAuth()
  const r = await fetch(SERVER + path, {
    method,
    headers: {
      ...(auth && { Authorization: `Bearer ${auth.token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  })
  if (r.status === 401 && auth) {
    // Dispositivo removido no site: desloga aqui também
    await chrome.storage.local.remove('auth')
    updateBadge()
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Servidor respondeu ${r.status}`)
  return raw ? r : r.json()
}

async function login({ code }) {
  const info = await chrome.runtime.getPlatformInfo()
  const data = await api('/api/ext/login', { method: 'POST', body: { code, name: `Chrome (${info.os})` } })
  await chrome.storage.local.set({ auth: { token: data.token, email: data.email }, last: null })
  updateBadge()
  tick()
  return { ok: true }
}

async function logout() {
  await api('/api/ext/logout', { method: 'POST' }).catch(() => {})
  await chrome.storage.local.remove(['auth', 'last'])
  updateBadge()
  return { ok: true }
}

async function status() {
  const auth = await getAuth()
  const { last } = await chrome.storage.local.get('last')
  if (!auth) return { ok: true, loggedIn: false }
  try {
    const me = await api('/api/ext/me')
    return { ok: true, loggedIn: true, ...me, running, last }
  } catch (e) {
    return { ok: true, loggedIn: !!(await getAuth()), email: auth.email, offline: e.message, running, last }
  }
}

let running = false

async function tick() {
  if (running || !(await getAuth())) return
  running = true
  // Service worker do MV3 morre ocioso em 30s: chamadas de API periódicas mantêm vivo durante a postagem
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000)
  let job
  try {
    ;({ job } = await api('/api/ext/claim', { method: 'POST' }))
    if (!job) return
    setBadge('…', '#888')
    const [video, cover] = await Promise.all([
      fetchBase64(`/api/ext/jobs/${job.id}/video`),
      job.hasCover ? fetchBase64(`/api/ext/jobs/${job.id}/cover`) : null,
    ])
    const tab = await instagramTab()
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: postReel,
      args: [{ video, cover, caption: job.caption, dryRun: false }],
    })
    if (!result?.ok) throw new Error(result?.error || 'Falhou sem mensagem')
    console.log('Legenda na publicação:', result.captionReport)
    const { warning, captionReport: report } = result
    await api(`/api/ext/jobs/${job.id}/result`, { method: 'POST', body: { ok: true, warning, captionReport: report } })
    await chrome.storage.local.set({ last: { ok: true, at: Date.now(), jobId: job.id, warning } })
    setBadge(warning ? '!' : 'OK', warning ? '#c2410c' : '#15803d')
  } catch (e) {
    console.error(e)
    if (job) {
      const error = /Criar|Nova publicação/.test(e.message)
        ? `${e.message}. Você está logado no Instagram neste Chrome?`
        : e.message
      await api(`/api/ext/jobs/${job.id}/result`, { method: 'POST', body: { ok: false, error } }).catch(() => {})
      await chrome.storage.local.set({ last: { ok: false, at: Date.now(), jobId: job.id, error } })
      setBadge('ERR', '#b91c1c')
    }
  } finally {
    clearInterval(keepAlive)
    running = false
    if (job) setTimeout(updateBadge, 15000)
  }
}

async function fetchBase64(path) {
  const r = await api(path, { raw: true })
  const bytes = new Uint8Array(await r.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

// Aproveita uma aba do Instagram já aberta (recarregada pra começar limpa); senão abre uma nova
async function instagramTab() {
  const [existing] = await chrome.tabs.query({ url: 'https://www.instagram.com/*' })
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true })
    await chrome.windows.update(existing.windowId, { focused: true })
    await chrome.tabs.reload(existing.id)
    await waitForLoad(existing.id)
    return existing
  }
  const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: true })
  await waitForLoad(tab.id)
  return tab
}

function waitForLoad(tabId) {
  return new Promise(resolve => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color })
}

// Sem login: badge "!" pra lembrar de conectar
async function updateBadge() {
  if (await getAuth()) chrome.action.setBadgeText({ text: '' })
  else setBadge('!', '#c2410c')
}
updateBadge()
