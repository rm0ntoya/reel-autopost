const $ = id => document.getElementById(id)

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const r = await fetch(path, {
    method,
    headers: body && !raw ? { 'Content-Type': 'application/json' } : {},
    body: raw ? body : body && JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({}))
  if (r.status === 401 && !['/api/login', '/api/register', '/api/me'].includes(path)) showAuth()
  if (!r.ok) throw new Error(data.error || `Erro ${r.status}`)
  return data
}

let toastTimer
function toast(text, err = false) {
  const el = $('toast')
  el.textContent = text
  el.className = `toast show${err ? ' err' : ''}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200)
}

// Botão com spinner enquanto a ação roda
async function busy(btn, fn) {
  btn.disabled = true
  btn.classList.add('busy')
  try {
    return await fn()
  } finally {
    btn.disabled = false
    btn.classList.remove('busy')
  }
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'agora'
  if (s < 3600) return `há ${Math.round(s / 60)} min`
  if (s < 86400) return `há ${Math.round(s / 3600)} h`
  const d = new Date(ts)
  const yesterday = new Date(Date.now() - 86400000).toDateString() === d.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return yesterday ? `ontem ${time}` : `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${time}`
}

let me = null

// ---------- login / cadastro ----------

let authMode = 'login'
const AUTH_TEXT = {
  login: { title: 'Bem-vindo de volta', sub: 'Entre para gerenciar seus vídeos.', go: 'Entrar', q: 'Não tem conta?', link: 'Criar conta' },
  register: { title: 'Crie sua conta', sub: 'Leva menos de um minuto. Depois é só colar links.', go: 'Criar conta', q: 'Já tem conta?', link: 'Entrar' },
}

function setAuthMode(mode) {
  authMode = mode
  const t = AUTH_TEXT[mode]
  $('auth-title').textContent = t.title
  $('auth-sub').textContent = t.sub
  $('auth-go').textContent = t.go
  $('switch-text').textContent = t.q
  $('auth-switch').textContent = t.link
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password'
  $('pw-hint').hidden = mode === 'login'
  $('auth-msg').textContent = ''
  document.querySelectorAll('#auth-form input').forEach(i => i.classList.remove('invalid'))
}

$('auth-switch').addEventListener('click', e => {
  e.preventDefault()
  setAuthMode(authMode === 'login' ? 'register' : 'login')
  $('email').focus()
})

$('pw-toggle').addEventListener('click', () => {
  const show = $('password').type === 'password'
  $('password').type = show ? 'text' : 'password'
  $('pw-toggle').textContent = show ? 'Ocultar' : 'Mostrar'
})

$('auth-form').addEventListener('submit', async e => {
  e.preventDefault()
  const email = $('email')
  const password = $('password')
  email.classList.toggle('invalid', !email.checkValidity())
  password.classList.toggle('invalid', authMode === 'register' ? password.value.length < 8 : !password.value)
  if (!email.checkValidity()) return ($('auth-msg').textContent = 'Digite um e-mail válido.')
  if (password.classList.contains('invalid'))
    return ($('auth-msg').textContent = authMode === 'register' ? 'A senha precisa de pelo menos 8 caracteres.' : 'Digite sua senha.')
  $('auth-msg').textContent = ''
  await busy($('auth-go'), async () => {
    try {
      await api(authMode === 'login' ? '/api/login' : '/api/register', {
        method: 'POST',
        body: { email: email.value, password: password.value },
      })
      await boot()
      // Conta nova: vai direto personalizar
      if (authMode === 'register') showView('profile')
    } catch (err) {
      $('auth-msg').textContent = err.message
    }
  })
})

$('logout').addEventListener('click', async e => {
  e.preventDefault()
  await api('/api/logout', { method: 'POST' }).catch(() => {})
  showAuth()
})

function showAuth() {
  me = null
  stopPolling()
  closeDrawer(true)
  $('auth').hidden = false
  $('app').hidden = true
  setAuthMode(authMode)
}

// ---------- navegação ----------

function showView(name) {
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name))
  document.querySelectorAll('[data-panel]').forEach(p => (p.hidden = p.dataset.panel !== name))
  if (name === 'profile') loadProfile()
  if (name === 'connections') loadDevices()
  window.scrollTo(0, 0)
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)))

// ---------- vídeos ----------

const STATUS = {
  processing: 'Editando',
  review: 'Revisar',
  ready: 'Na fila',
  posting: 'Postando',
  posted: 'Postado',
  failed: 'Falhou',
  error: 'Erro no download',
}
// Filtros e números agrupam status parecidos
const GROUPS = {
  all: null,
  processing: ['processing'],
  queue: ['ready', 'posting'],
  posted: ['posted'],
  review: ['review'],
  failed: ['failed', 'error'],
}
let filter = 'all'

$('dl').addEventListener('submit', async e => {
  e.preventDefault()
  const msg = $('dl-msg')
  msg.className = 'form-msg'
  msg.textContent = ''
  await busy($('dl-go'), async () => {
    try {
      const mode = document.querySelector('input[name=mode]:checked')?.value
      await api('/api/jobs', { method: 'POST', body: { url: $('url').value.trim(), mode } })
      $('url').value = ''
      msg.textContent = 'Baixando, editando e gerando a legenda. Leva cerca de 1 minuto.'
      setFilter('all')
      await loadJobs()
    } catch (err) {
      msg.className = 'form-msg err'
      msg.textContent = err.message
    }
  })
})

function setFilter(name) {
  filter = name
  document.querySelectorAll('#filters .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === name))
  document.querySelectorAll('#stats .stat').forEach(s => s.classList.toggle('active', s.dataset.filter === name))
  renderJobs()
}
document.querySelectorAll('[data-filter]').forEach(b =>
  b.addEventListener('click', () => setFilter(b.classList.contains('stat') && filter === b.dataset.filter ? 'all' : b.dataset.filter))
)

let lastJobs = []
let loadedOnce = false
const captionTitle = j => (j.caption || '').split('\n').find(l => l.trim()) || ''

function renderStats(counts) {
  const sum = list => list.reduce((n, s) => n + (counts[s] || 0), 0)
  for (const [name, list] of Object.entries(GROUPS)) {
    const el = document.querySelector(`[data-count="${name}"]`)
    if (el && list) el.textContent = sum(list)
  }
  const queue = sum(GROUPS.queue)
  $('nav-count').textContent = queue || ''
}

function renderJobs() {
  const box = $('jobs')
  if (!loadedOnce) {
    box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
    return
  }
  const allowed = GROUPS[filter]
  const jobs = allowed ? lastJobs.filter(j => allowed.includes(j.status)) : lastJobs
  if (!jobs.length) {
    box.innerHTML = lastJobs.length
      ? '<div class="empty"><b>Nada por aqui</b>Nenhum vídeo com esse status.</div>'
      : '<div class="empty"><b>Nenhum vídeo ainda</b>Cole um link do Instagram ou TikTok acima, ou mande pro bot do Telegram.</div>'
    return
  }
  // Reaproveita a linha que não mudou: miniatura não pisca a cada atualização
  const existing = new Map([...box.querySelectorAll('.job')].map(el => [el.dataset.id, el]))
  const frag = document.createDocumentFragment()
  for (const j of jobs) {
    const key = `${j.status}|${captionTitle(j)}|${j.error}|${j.hasThumb}|${Math.floor((Date.now() - j.createdAt) / 60000)}`
    let el = existing.get(String(j.id))
    if (!el || el.dataset.key !== key) {
      el = jobRow(j)
      el.dataset.key = key
    }
    frag.appendChild(el)
  }
  box.replaceChildren(frag)
}

function thumbHtml(j, cls = 'thumb') {
  if (j.hasThumb) return `<img class="${cls}" src="/api/jobs/${j.id}/thumb" alt="" loading="lazy">`
  if (j.status === 'processing') return `<span class="${cls} loading"></span>`
  return `<span class="${cls} ${j.platform}">${j.platform === 'tiktok' ? 'TT' : 'IG'}</span>`
}

function jobRow(j) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'job'
  el.dataset.id = j.id
  const title = captionTitle(j)
  const note =
    j.status === 'posted' && j.error ? `<p class="job-note warn">⚠ ${esc(j.error)}</p>`
      : j.error && j.status !== 'posted' ? `<p class="job-note err">${esc(j.error)}</p>`
        : ''
  el.innerHTML = `
    ${thumbHtml(j)}
    <div class="job-main">
      <p class="job-title${title ? '' : ' dim'}">${title ? esc(title) : j.status === 'processing' ? 'Preparando o vídeo…' : 'Sem legenda'}</p>
      <p class="job-meta">
        <span>${j.platform === 'tiktok' ? 'TikTok' : 'Instagram'}</span>
        <span>${j.source === 'telegram' ? 'via Telegram' : 'pelo site'}</span>
        <span>${ago(j.createdAt)}</span>
      </p>
      ${note}
    </div>
    <span class="pill ${j.status}">${STATUS[j.status] || j.status}</span>
    <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5"/></svg>`
  el.addEventListener('click', () => openDrawer(j.id))
  return el
}

let devicesOnline = 0
async function loadJobs() {
  const data = await api('/api/jobs')
  devicesOnline = data.devicesOnline
  const before = new Map(lastJobs.map(j => [j.id, j.status]))
  // Vídeo acabou de ficar pronto: avisa a extensão deste navegador na hora (sem esperar os 30s)
  if (data.jobs.some(j => j.status === 'ready' && before.get(j.id) !== 'ready')) pingExtension()
  lastJobs = data.jobs
  loadedOnce = true
  renderStats(data.counts || {})
  renderJobs()
  renderConn()
  refreshDrawer()
  const busyJobs = data.jobs.some(j => ['processing', 'ready', 'posting'].includes(j.status))
  if (!busyJobs && !$('dl-msg').classList.contains('err')) $('dl-msg').textContent = ''
}

const hasExtension = () => document.documentElement.dataset.reelAutopost === 'on'
function pingExtension() {
  if (hasExtension()) window.postMessage({ type: 'reel-autopost:check' }, '*')
}

function renderConn() {
  const conn = $('conn-status')
  conn.classList.toggle('on', devicesOnline > 0)
  conn.querySelector('span').textContent = devicesOnline ? 'Extensão online' : 'Extensão offline'
  const hint = $('ext-hint')
  if (!me?.profile.autoPost) {
    hint.innerHTML = 'Postagem automática desligada. <a href="#" data-goto="profile">Mudar</a>'
  } else if (devicesOnline) {
    hint.textContent = 'Extensão online: os vídeos da fila são postados sozinhos.'
  } else {
    hint.innerHTML = 'Nenhuma extensão online. <a href="#" data-goto="connections">Conectar</a>'
  }
}
$('ext-hint').addEventListener('click', e => {
  if (!e.target.dataset.goto) return
  e.preventDefault()
  showView(e.target.dataset.goto)
})

let pollTimer
function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => !document.hidden && loadJobs().catch(() => {}), 3000)
}
function stopPolling() {
  clearInterval(pollTimer)
}

// ---------- detalhe do vídeo ----------

let drawerId = null
let drawerKey = ''
// Legenda em edição não pode ser sobrescrita pela atualização automática
let captionDirty = false

function openDrawer(id) {
  drawerId = id
  drawerKey = ''
  captionDirty = false
  $('drawer').hidden = false
  $('drawer').classList.remove('closing')
  document.body.style.overflow = 'hidden'
  refreshDrawer()
}

function closeDrawer(instant) {
  if ($('drawer').hidden) return
  drawerId = null
  document.body.style.overflow = ''
  if (instant) return ($('drawer').hidden = true)
  $('drawer').classList.add('closing')
  setTimeout(() => {
    if (drawerId === null) $('drawer').hidden = true
  }, 220)
}
$('drawer').addEventListener('click', e => e.target.closest('[data-close]') && closeDrawer())
document.addEventListener('keydown', e => e.key === 'Escape' && closeDrawer())

function refreshDrawer() {
  if (drawerId === null) return
  const j = lastJobs.find(x => x.id === drawerId)
  if (!j) return closeDrawer()
  const key = `${j.status}|${j.caption}|${j.error}|${j.hasVideo}|${j.hasThumb}`
  if (key === drawerKey) return
  // Não troca o conteúdo enquanto a pessoa digita (o vídeo também não reinicia)
  if (captionDirty || document.activeElement?.id === 'd-caption') return
  drawerKey = key
  renderDrawer(j)
}

function renderDrawer(j) {
  const editable = ['review', 'ready', 'failed'].includes(j.status)
  const canPost = ['review', 'failed'].includes(j.status) && j.hasVideo
  const hasCaption = j.status !== 'processing' && j.status !== 'error'
  const alert =
    j.status === 'posted' && j.error ? `<p class="d-alert warn">⚠ ${esc(j.error)}</p>`
      : j.error ? `<p class="d-alert err">${esc(j.error)}</p>`
        : j.status === 'ready' ? `<p class="d-alert info">Na fila da extensão. Deixe o Chrome aberto e logado no Instagram.</p>`
          : j.status === 'review' ? `<p class="d-alert warn">Revise a legenda e clique em Postar.</p>`
            : ''
  const media = j.hasVideo
    ? `<div class="d-media"><video src="/api/jobs/${j.id}/video" controls playsinline preload="metadata" ${j.hasThumb ? `poster="/api/jobs/${j.id}/thumb"` : ''}></video></div>`
    : j.hasThumb
      ? `<div class="d-media"><img src="/api/jobs/${j.id}/thumb" alt=""></div>`
      : `<div class="d-media none">${j.status === 'processing' ? 'Preparando o vídeo…' : 'Vídeo não está mais disponível'}</div>`

  $('drawer-body').innerHTML = `
    <div class="d-head">
      <div style="display:flex;align-items:center;gap:10px">
        <h2 id="drawer-title">Vídeo #${j.id}</h2>
        <span class="pill ${j.status}">${STATUS[j.status] || j.status}</span>
      </div>
      <button type="button" class="icon-btn" data-close aria-label="Fechar"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button>
    </div>
    <div class="d-body">
      ${alert}
      ${media}
      ${hasCaption ? `
        <div class="d-section">
          <div class="d-section-head"><p class="label">Legenda</p><span class="save-state" id="save-state"></span></div>
          <textarea id="d-caption" ${editable ? '' : 'readonly'} placeholder="Escreva a legenda…">${esc(j.caption)}</textarea>
        </div>` : ''}
      <div class="d-actions">
        ${canPost ? `<button type="button" class="btn primary small" data-act="post">${j.status === 'failed' ? 'Tentar postar de novo' : 'Postar'}</button>` : ''}
        ${editable ? '<button type="button" class="btn ghost small" data-act="regen">Gerar outra legenda</button>' : ''}
        ${hasCaption ? '<button type="button" class="btn ghost small" data-act="copy">Copiar legenda</button>' : ''}
        ${j.hasVideo ? `<a class="btn ghost small" href="/api/jobs/${j.id}/video" download>Baixar vídeo</a>` : ''}
        ${!['processing', 'posting'].includes(j.status) ? '<button type="button" class="btn danger small" data-act="delete">Apagar</button>' : ''}
      </div>
      <dl class="d-meta">
        <dt>Link</dt><dd><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.url)}</a></dd>
        <dt>Plataforma</dt><dd>${j.platform === 'tiktok' ? 'TikTok' : 'Instagram'} · ${j.mode === 'edited' ? 'editado' : 'só o vídeo'}</dd>
        <dt>Origem</dt><dd>${j.source === 'telegram' ? 'Telegram' : 'Site'}</dd>
        ${j.model ? `<dt>Legenda</dt><dd>${{ reutilizada: 'Reaproveitada da anterior', fixa: 'Legenda fixa', 'sem-legenda': 'Sem legenda (sua escolha)' }[j.model] || 'Gerada pra este vídeo'}</dd>` : ''}
        <dt>Criado</dt><dd>${new Date(j.createdAt).toLocaleString()}</dd>
        <dt>Atualizado</dt><dd>${new Date(j.updatedAt).toLocaleString()}</dd>
      </dl>
    </div>`

  const ta = $('d-caption')
  let saveTimer
  const save = async () => {
    clearTimeout(saveTimer)
    if (!captionDirty) return
    $('save-state').textContent = 'Salvando…'
    try {
      await api(`/api/jobs/${j.id}/caption`, { method: 'PUT', body: { caption: ta.value } })
      $('save-state').textContent = 'Salvo ✓'
      captionDirty = false
    } catch (err) {
      $('save-state').textContent = err.message
    }
  }
  ta?.addEventListener('input', () => {
    captionDirty = true
    $('save-state').textContent = ''
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 700)
  })

  $('drawer-body').querySelector('.d-actions').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'copy') {
      await navigator.clipboard.writeText(ta?.value || '').catch(() => {})
      return toast('Legenda copiada')
    }
    // Apagar pede um segundo clique
    if (act === 'delete' && !btn.classList.contains('armed')) {
      btn.classList.add('armed')
      btn.textContent = 'Confirmar exclusão'
      setTimeout(() => {
        btn.classList.remove('armed')
        btn.textContent = 'Apagar'
      }, 3500)
      return
    }
    await busy(btn, async () => {
      try {
        if (act === 'delete') {
          await api(`/api/jobs/${j.id}`, { method: 'DELETE' })
          closeDrawer()
          toast('Vídeo apagado')
        } else {
          // Salva a legenda digitada antes de postar
          if (act === 'post' && ta) await api(`/api/jobs/${j.id}/caption`, { method: 'PUT', body: { caption: ta.value } })
          await api(`/api/jobs/${j.id}/${act === 'post' ? 'post' : 'regenerate'}`, { method: 'POST' })
          captionDirty = false
          drawerKey = ''
          if (act === 'post') {
            pingExtension()
            toast('Na fila da extensão')
          } else toast('Legenda nova gerada')
        }
        await loadJobs()
      } catch (err) {
        toast(err.message, true)
      }
    })
  })
}

// ---------- personalizar ----------

const BLANK = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'
function refreshImages() {
  const t = Date.now()
  const avatar = me.profile.hasAvatar ? `/api/profile/avatar?t=${t}` : BLANK
  $('avatar').src = avatar
  $('me-avatar').src = avatar
  $('preview').src = `/api/profile/preview?t=${t}`
}

function loadProfile() {
  const p = me.profile
  $('p-name').value = p.name
  $('p-handle').value = p.handle
  $('p-phrase').value = p.phrase
  $('p-verified').checked = p.verified
  $('p-auto').checked = p.autoPost
  $('p-reuse').value = p.captionReuse || 1
  renderReuseHelp()
  $('p-cap').value = p.customCaption || ''
  $('p-cap-uses').value = p.customCaptionUses || 1
  $('p-after').value = p.afterCustom === 'none' ? 'none' : 'generate'
  renderCapFixed()
  $('p-msg').textContent = ''
  refreshImages()
}

const capUsesValue = () => Math.min(1000, Math.max(1, Math.round(Number($('p-cap-uses').value)) || 1))
function renderCapFixed() {
  const has = $('p-cap').value.trim().length > 0
  $('cap-uses-row').hidden = !has
  if (!has) return
  const n = capUsesValue()
  const p = me.profile
  const left = p.customCaption === $('p-cap').value.trim() && p.customCaptionUses === n ? p.customCaptionLeft : n
  $('cap-uses-help').textContent =
    `Usa essa legenda em ${n} ${n === 1 ? 'vídeo' : 'vídeos'}.${left ? ` Ainda faltam ${left}.` : ''} Depois: ${$('p-after').value === 'none' ? 'posta sem legenda' : 'gera com IA'}.`
}
$('p-cap').addEventListener('input', renderCapFixed)
$('p-after').addEventListener('change', renderCapFixed)
$('p-cap-uses').addEventListener('input', renderCapFixed)
$('p-cap-uses').addEventListener('blur', () => {
  $('p-cap-uses').value = capUsesValue()
  renderCapFixed()
})
document.querySelectorAll('[data-cap-step]').forEach(b =>
  b.addEventListener('click', () => {
    $('p-cap-uses').value = Math.min(1000, Math.max(1, capUsesValue() + Number(b.dataset.capStep)))
    renderCapFixed()
  })
)

const reuseValue = () => Math.min(100, Math.max(1, Math.round(Number($('p-reuse').value)) || 1))
function renderReuseHelp() {
  const n = reuseValue()
  const left = me.profile.captionReuse === n ? me.profile.reuseLeft : 0
  $('reuse-help').textContent =
    n === 1 ? 'Desligado: cada vídeo ganha uma legenda nova.'
      : `A mesma legenda vai em ${n} vídeos seguidos, depois gera outra.${left ? ` A atual ainda vale pra mais ${left}.` : ''}`
}
$('p-reuse').addEventListener('input', renderReuseHelp)
$('p-reuse').addEventListener('blur', () => {
  $('p-reuse').value = reuseValue()
  renderReuseHelp()
})
document.querySelectorAll('[data-step]').forEach(b =>
  b.addEventListener('click', () => {
    $('p-reuse').value = Math.min(100, Math.max(1, reuseValue() + Number(b.dataset.step)))
    renderReuseHelp()
  })
)

$('profile').addEventListener('submit', async e => {
  e.preventDefault()
  $('p-msg').className = 'form-msg'
  await busy($('p-save'), async () => {
    try {
      const { profile } = await api('/api/profile', {
        method: 'PUT',
        body: {
          name: $('p-name').value,
          handle: $('p-handle').value,
          phrase: $('p-phrase').value,
          verified: $('p-verified').checked,
          autoPost: $('p-auto').checked,
          captionReuse: reuseValue(),
          customCaption: $('p-cap').value,
          customCaptionUses: capUsesValue(),
          afterCustom: $('p-after').value,
          mode: me.profile.mode,
        },
      })
      me.profile = profile
      loadProfile()
      toast('Perfil salvo')
    } catch (err) {
      $('p-msg').className = 'form-msg err'
      $('p-msg').textContent = err.message
    }
  })
})

$('avatar-file').addEventListener('change', async e => {
  const file = e.target.files[0]
  if (!file) return
  $('p-msg').className = 'form-msg'
  $('p-msg').textContent = 'Enviando foto…'
  try {
    const { profile } = await api('/api/profile/avatar', { method: 'POST', body: file, raw: true })
    me.profile = profile
    refreshImages()
    $('p-msg').textContent = ''
    toast('Foto atualizada')
  } catch (err) {
    $('p-msg').className = 'form-msg err'
    $('p-msg').textContent = err.message
  }
  e.target.value = ''
})

// Modo escolhido ao colar o link vira o padrão da conta
document.querySelectorAll('input[name=mode]').forEach(r =>
  r.addEventListener('change', async () => {
    me.profile.mode = r.value
    await api('/api/profile', { method: 'PUT', body: { ...me.profile } }).catch(() => {})
  })
)

// ---------- conexões ----------

let codeTimer
$('gen-code').addEventListener('click', async () => {
  const btn = $('gen-code')
  let data
  await busy(btn, async () => {
    try {
      data = await api('/api/device-code', { method: 'POST' })
    } catch (err) {
      toast(err.message, true)
    }
  })
  if (!data) return
  const { code, expiresAt, telegram } = data
  $('code').textContent = code
  $('code').className = 'code live'
  btn.textContent = 'Gerar outro'
  if (telegram) {
    $('tg-link').hidden = false
    $('tg-link').href = `https://t.me/${telegram}?start=${code}`
    $('tg-text').innerHTML = `Toque em <b>Abrir no Telegram</b> ou mande o código pro <b>@${esc(telegram)}</b>.`
  } else {
    $('tg-text').textContent = 'O bot do Telegram não está ativo neste servidor.'
  }
  clearInterval(codeTimer)
  const known = new Set((await api('/api/devices')).devices.map(d => d.id))
  // Espera o código ser usado e mostra que conectou
  const tick = async () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
    if (!left) {
      clearInterval(codeTimer)
      $('code').textContent = 'expirou'
      $('code').className = 'code'
      $('code-state').textContent = ''
      $('tg-link').hidden = true
      return
    }
    $('code-state').textContent = `Expira em ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
    if (left % 2) return
    const { devices } = await api('/api/devices').catch(() => ({ devices: [] }))
    const fresh = devices.find(d => !known.has(d.id))
    if (fresh) {
      clearInterval(codeTimer)
      $('code').textContent = `${fresh.kind === 'telegram' ? 'Telegram' : 'Extensão'} conectado ✓`
      $('code').className = 'code done'
      $('code-state').textContent = ''
      $('tg-link').hidden = true
      renderDevices(devices)
    }
  }
  tick()
  codeTimer = setInterval(tick, 1000)
})

const DEVICE_ICONS = {
  extension: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.6"/><path d="M10 7.4h6.3M7.8 11.3L4.6 5.8M12.2 11.3L9 16.9"/></svg>',
  telegram: '<svg viewBox="0 0 20 20"><path d="M16.5 4L3.5 9.2l4.3 1.5 1.6 4.8 2.4-2.9 3.3 2.4z"/><path d="M7.8 10.7l6-4.3"/></svg>',
}

function renderDevices(devices) {
  $('devices').innerHTML = devices.length
    ? devices.map(d => {
        const online = d.kind === 'extension' && Date.now() - d.lastSeen < 2 * 60 * 1000
        const status = d.kind === 'telegram' ? 'manda links pelo bot'
          : online ? '<span class="dot-on"></span>online agora'
            : d.lastSeen ? `visto ${ago(d.lastSeen)}` : 'nunca usado'
        return `
          <div class="device">
            <span class="dev-ico">${DEVICE_ICONS[d.kind] || DEVICE_ICONS.extension}</span>
            <div><b>${esc(d.name)}</b><p class="muted small">Conectado ${ago(d.createdAt)} · ${status}</p></div>
            <button type="button" class="btn danger small" data-remove="${d.id}">Desconectar</button>
          </div>`
      }).join('')
    : '<div class="empty"><b>Nada conectado</b>Gere um código acima pra conectar a extensão ou o Telegram.</div>'
}

async function loadDevices() {
  renderDevices((await api('/api/devices')).devices)
}

$('devices').addEventListener('click', async e => {
  const btn = e.target.closest('[data-remove]')
  if (!btn) return
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed')
    btn.textContent = 'Confirmar'
    setTimeout(() => {
      btn.classList.remove('armed')
      btn.textContent = 'Desconectar'
    }, 3500)
    return
  }
  await busy(btn, async () => {
    await api(`/api/devices/${btn.dataset.remove}`, { method: 'DELETE' }).catch(err => toast(err.message, true))
    await loadDevices()
  })
})

// ---------- início ----------

async function boot() {
  try {
    me = await api('/api/me')
  } catch {
    return showAuth()
  }
  $('auth').hidden = true
  $('app').hidden = false
  $('me').textContent = me.email
  refreshImages()
  const mode = document.querySelector(`input[name=mode][value=${me.profile.mode}]`)
  if (mode) mode.checked = true
  showView('videos')
  renderJobs()
  await loadJobs()
  startPolling()
}

boot()
