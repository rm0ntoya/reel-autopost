// Cliente mínimo da Bot API do Telegram via long polling: o servidor busca as mensagens,
// sem precisar de webhook nem de endereço público. Sem TELEGRAM_BOT_TOKEN, fica desligado.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const API = `https://api.telegram.org/bot${TOKEN}`

export const telegramEnabled = !!TOKEN
export let botUsername = ''

export async function tg(method, params = {}, timeoutMs = 15_000) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await r.json().catch(() => ({}))
  if (!data.ok) {
    const error = new Error(`Telegram ${method}: ${data.description || r.status}`)
    error.code = data.error_code || r.status
    error.retryAfter = data.parameters?.retry_after
    throw error
  }
  return data.result
}

// Falha ao avisar não pode derrubar o fluxo do vídeo
export function sendMessage(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }).catch(e =>
    console.warn(`Telegram: não consegui avisar o chat ${chatId}:`, e.message)
  )
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// offset: { get() -> número, set(n) } guardado no banco. Assim um reinício não reprocessa
// mensagens já tratadas (repetir um link postaria o mesmo vídeo duas vezes)
export async function startPolling({ onMessage, offset }) {
  if (!telegramEnabled) return
  for (;;) {
    try {
      botUsername = (await tg('getMe')).username
      break
    } catch (e) {
      console.error('Telegram: token inválido ou sem conexão:', e.message)
      await sleep(30_000)
    }
  }
  console.log(`Telegram: bot @${botUsername} ligado`)
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: offset.get(), timeout: 50, allowed_updates: ['message'] }, 65_000)
      for (const update of updates) {
        // Avança antes de tratar: mensagem que derruba o handler não pode travar a fila pra sempre
        offset.set(update.update_id + 1)
        if (update.message) await onMessage(update.message).catch(e => console.error('Telegram: erro tratando mensagem:', e))
      }
    } catch (e) {
      // 409 = outro processo usando o mesmo token (ex.: servidor local e Discloud juntos)
      if (e.code === 409) console.error('Telegram: outro servidor está usando este bot. Só um pode rodar por vez.')
      else if (e.name !== 'TimeoutError') console.warn('Telegram:', e.message)
      await sleep(e.retryAfter ? e.retryAfter * 1000 : 5_000)
    }
  }
}
