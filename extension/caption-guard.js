// Funções que rodam no mundo MAIN da aba do Instagram (chrome.scripting.executeScript serializa
// cada uma): precisam ser autocontidas, sem usar nada de fora delas.
//
// Por que existe: a tela e o editor (Lexical) podem mostrar a legenda e mesmo assim o Instagram
// publicar sem ela, porque o que vale é o campo `caption` da requisição de publicação
// (/api/v1/media/configure_to_clips/). A guarda intercepta essa requisição, coloca a legenda
// se ela estiver faltando e guarda a resposta pra conferir o que foi realmente publicado.

export function armCaptionGuard(caption) {
  const key = s => String(s || '').replace(/\s+/g, '')
  const isPublish = url => /\/api\/v1\/media\/configure(_to_clips)?\/?(\?|$)/.test(url)

  const existing = window.__reelCaptionGuard
  const state = existing || { headers: {} }
  Object.assign(state, { caption, requests: [], posts: [], media: null })
  window.__reelCaptionGuard = state
  if (existing) return { ok: true }

  const hasCaption = value => key(value).includes(key(state.caption).slice(0, 40))

  // Objeto da publicação: o campo caption e, se houver, o JSON de signed_body
  // ("SIGNATURE.{...}"), que é o que o servidor do Instagram lê quando ele existe
  function fixData(data) {
    const before = data.caption ?? null
    let injected = false
    if (!hasCaption(data.caption)) {
      data.caption = state.caption
      injected = true
    }
    let signed = null
    if (typeof data.signed_body === 'string' && data.signed_body.startsWith('SIGNATURE.')) {
      const inner = JSON.parse(data.signed_body.slice('SIGNATURE.'.length))
      signed = inner.caption ?? null
      if (!hasCaption(inner.caption)) {
        inner.caption = state.caption
        data.signed_body = `SIGNATURE.${JSON.stringify(inner)}`
        injected = true
      }
    }
    return { before, signed, injected }
  }

  // Corpo da publicação: urlencoded (string ou URLSearchParams), FormData ou JSON
  function fixBody(body) {
    const fixParams = params => {
      const data = { caption: params.get('caption') ?? undefined, signed_body: params.get('signed_body') ?? undefined }
      const result = fixData(data)
      if (result.injected) {
        params.set('caption', data.caption)
        if (data.signed_body !== undefined) params.set('signed_body', data.signed_body)
      }
      return result
    }
    if (typeof body === 'string') {
      if (body.trim().startsWith('{')) {
        const data = JSON.parse(body)
        const result = fixData(data)
        return { body: result.injected ? JSON.stringify(data) : body, ...result }
      }
      const params = new URLSearchParams(body)
      const result = fixParams(params)
      return { body: result.injected ? params.toString() : body, ...result }
    }
    if (body instanceof URLSearchParams || body instanceof FormData) return { body, ...fixParams(body) }
    return { body, before: null, injected: false, unknown: true }
  }

  function onRequest(url, body) {
    try {
      const fixed = fixBody(body)
      state.requests.push({
        url: url.replace(/\?.*/, ''),
        before: fixed.before == null ? null : String(fixed.before).slice(0, 80),
        signed: fixed.signed == null ? null : String(fixed.signed).slice(0, 80),
        injected: fixed.injected,
        unknownBody: !!fixed.unknown,
      })
      return fixed.body
    } catch (e) {
      state.requests.push({ url, error: e.message })
      return body
    }
  }

  // A resposta pode vir com o prefixo anti-JSON-hijacking "for (;;);" e o post em
  // media, medias[].media_dict ou posts[]: procura o primeiro objeto com cara de post
  function onResponse(text) {
    try {
      const data = JSON.parse(String(text).replace(/^\s*for\s*\(;;\);/, ''))
      const queue = [data]
      for (let seen = 0; queue.length && seen < 500; seen++) {
        const node = queue.shift()
        if (!node || typeof node !== 'object') continue
        if (typeof node.code === 'string' && (node.pk || node.id) && ('caption' in node || 'media_type' in node)) {
          state.media = { id: node.id, pk: node.pk, code: node.code, caption: node.caption?.text ?? null }
          return
        }
        queue.push(...Object.values(node))
      }
    } catch {}
  }

  const XHR = XMLHttpRequest.prototype
  const { open, send, setRequestHeader } = XHR
  XHR.open = function (method, url) {
    this.__reel = { method: String(method).toUpperCase(), url: String(url), headers: {} }
    return open.apply(this, arguments)
  }
  XHR.setRequestHeader = function (name, value) {
    if (this.__reel) this.__reel.headers[name.toLowerCase()] = value
    return setRequestHeader.apply(this, arguments)
  }
  XHR.send = function (body) {
    const info = this.__reel
    if (info?.method === 'POST') {
      state.posts.push(info.url.replace(/\?.*/, ''))
      if (isPublish(info.url)) {
        Object.assign(state.headers, info.headers)
        body = onRequest(info.url, body)
        this.addEventListener('load', () => {
          try {
            onResponse(this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText)
          } catch {}
        })
      }
    }
    return send.call(this, body)
  }

  const nativeFetch = window.fetch
  window.fetch = async function (input, init) {
    const url = String(input instanceof Request ? input.url : input)
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'POST') state.posts.push(url.replace(/\?.*/, ''))
    if (method !== 'POST' || !isPublish(url) || input instanceof Request) return nativeFetch.apply(this, arguments)
    new Headers(init?.headers).forEach((value, name) => (state.headers[name] = value))
    const response = await nativeFetch.call(this, input, { ...init, body: onRequest(url, init?.body) })
    response.clone().text().then(onResponse, () => {})
    return response
  }
  return { ok: true }
}

// Lê o que a guarda viu. Se o Instagram respondeu com o post publicado sem legenda,
// edita o post na hora com a legenda certa (mesmos cabeçalhos da publicação).
export async function captionReport() {
  const state = window.__reelCaptionGuard
  if (!state) return { armed: false }
  const key = s => String(s || '').replace(/\s+/g, '')
  const hasCaption = value => key(value).includes(key(state.caption).slice(0, 40))
  const report = {
    armed: true,
    requests: state.requests,
    posts: [...new Set(state.posts)].slice(-15),
    media: state.media,
    verified: !!state.media && hasCaption(state.media.caption),
  }
  if (!state.media || report.verified) return report

  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  for (const name of ['x-csrftoken', 'x-ig-app-id', 'x-instagram-ajax', 'x-asbd-id', 'x-ig-www-claim', 'x-requested-with'])
    if (state.headers[name]) headers[name] = state.headers[name]
  if (!headers['x-csrftoken']) headers['x-csrftoken'] = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1] || ''
  try {
    const r = await fetch(`/api/v1/media/${state.media.id || state.media.pk}/edit_media/`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: new URLSearchParams({ caption_text: state.caption }).toString(),
    })
    const data = await r.json().catch(() => ({}))
    const text = data.media?.caption?.text
    report.edited = { status: r.status, ok: r.ok && hasCaption(text) }
    report.verified = report.edited.ok
  } catch (e) {
    report.edited = { error: e.message }
  }
  return report
}
