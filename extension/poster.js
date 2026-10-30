// Roda dentro da página do Instagram (chrome.scripting.executeScript serializa a função):
// precisa ser autocontida, sem usar nada de fora dela.
// Textos em PT-PT, PT-BR e inglês pra funcionar em qualquer idioma da conta.
export async function postReel({ video, cover, caption, dryRun }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const visible = el => el && el.getClientRects().length > 0

  async function waitFor(find, label, timeout = 30000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const el = find()
      if (el) return el
      await sleep(300)
    }
    throw new Error(`Não achei: ${label}`)
  }

  const clickable = el => el?.closest('a, button, [role="button"], [role="link"], [role="menuitem"]') || el

  function svgButton(labels) {
    for (const label of labels) {
      const svg = [...document.querySelectorAll(`svg[aria-label="${label}"]`)].find(visible)
      if (svg) return clickable(svg)
    }
  }

  // loose: o texto só precisa conter o rótulo (botões com ícone têm o <title> do SVG no textContent)
  function textButton(labels, root = document, loose = false) {
    const els = [...root.querySelectorAll('button, [role="button"], [role="menuitem"], a')].filter(visible)
    if (!loose) return els.find(el => labels.includes(el.textContent.trim()))
    // O mais interno que contém o texto
    return els.filter(el => labels.some(l => el.textContent.includes(l))).pop()
  }

  const dialog = () => [...document.querySelectorAll('div[role="dialog"]')].filter(visible).pop() || document

  async function toFile(b64, name, type) {
    const blob = await (await fetch(`data:${type};base64,${b64}`)).blob()
    return new File([blob], name, { type })
  }

  function setFile(input, file) {
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const NEXT = ['Seguinte', 'Avançar', 'Next']
  const SHARE = ['Partilhar', 'Compartilhar', 'Share']

  try {
    // 1-2. Criar (+) e depois "Publicar" no submenu, até aparecer o input de vídeo
    const videoInput = () => document.querySelector('input[type="file"][accept*="video"]')
    const newPost = await waitFor(() => svgButton(['Nova publicação', 'New post', 'Criar', 'Create']), 'botão Criar (+)')
    newPost.click()
    let submenuClicked = false
    await waitFor(() => {
      if (videoInput()) return true
      const sub = !submenuClicked && svgButton(['Publicar', 'Publicação', 'Post'])
      if (sub) {
        sub.click()
        submenuClicked = true
      }
    }, 'janela de upload')

    // 3. Envia o vídeo
    setFile(videoInput(), await toFile(video, 'reel.mp4', 'video/mp4'))

    // Aviso "os vídeos agora são partilhados como reels" (aparece às vezes)
    for (let i = 0; i < 10; i++) {
      const ok = textButton(['OK'])
      if (ok) {
        ok.click()
        break
      }
      if (svgButton(['Selecionar recorte', 'Selecionar corte', 'Select crop'])) break
      await sleep(400)
    }

    // 4-5. Recortar: tamanho original
    const cropBtn = await waitFor(() => svgButton(['Selecionar recorte', 'Selecionar corte', 'Select crop']), 'botão de recorte', 60000)
    cropBtn.click()
    const original = await waitFor(() => textButton(['Original'], dialog(), true), 'opção Original')
    original.click()
    await sleep(500)

    // 6. Seguinte → tela Editar
    ;(await waitFor(() => textButton(NEXT, dialog()), 'Seguinte (recorte)')).click()

    // 7. Capa fixa: primeiro input de imagem da tela Editar
    const coverInput = await waitFor(
      () => dialog().querySelector('input[type="file"][accept*="image/jpeg"]'),
      'campo da foto de capa',
      20000
    ).catch(() => null)
    if (coverInput && cover) {
      setFile(coverInput, await toFile(cover, 'capa.jpg', 'image/jpeg'))
      await sleep(2500)
    }

    // 8. Seguinte → tela da legenda
    ;(await waitFor(() => textButton(NEXT, dialog()), 'Seguinte (editar)')).click()

    // 9. Legenda. Busca só dentro do diálogo: a página por trás pode ter outra caixa
    // editável (comentário, DM) e a legenda iria parar nela
    const box = await waitFor(
      () => [...dialog().querySelectorAll('div[contenteditable="true"][role="textbox"]')].find(visible),
      'campo de legenda'
    )
    if (caption) {
      box.focus()
      const range = document.createRange()
      range.selectNodeContents(box)
      range.collapse(false)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
      await sleep(400)

      // execCommand dispara os eventos nativos de edição que o React do Instagram
      // usa para atualizar o estado da publicação, não apenas o DOM visível.
      document.execCommand('insertText', false, caption)
      await sleep(800)

      const key = s => s.replace(/\s+/g, '')
      if (!key(box.innerText).includes(key(caption).slice(0, 40))) {
        // Fallback para versões do editor que bloqueiam execCommand.
        const typing = await chrome.runtime.sendMessage({ type: 'typeText', text: caption })
        if (!typing?.ok) throw new Error(`Não consegui digitar a legenda: ${typing?.error || 'sem resposta'}`)
        await sleep(800)
      }

      // Melhor falhar do que publicar sem legenda.
      if (!key(box.innerText).includes(key(caption).slice(0, 40)))
        throw new Error('A legenda não entrou no campo do Instagram')
      // A tela não garante: o post usa o estado interno do editor
      const editor = await chrome.runtime.sendMessage({ type: 'readEditor' })
      if (editor?.ok && editor.text !== null && !key(editor.text).includes(key(caption).slice(0, 40)))
        throw new Error('A legenda aparece na tela, mas o editor do Instagram não registrou')
    }

    if (dryRun) return { ok: true, dryRun: true, coverSet: !!(coverInput && cover) }

    // Guarda na requisição de publicação: garante o campo caption mesmo se o formulário
    // do Instagram não tiver registrado o que foi digitado (ver caption-guard.js)
    if (caption) {
      const guard = await chrome.runtime.sendMessage({ type: 'armGuard', caption })
      if (!guard?.ok) throw new Error(`Não consegui proteger a legenda antes de publicar: ${guard?.error || 'sem resposta'}`)
    }
    // Clique de verdade tira o foco do editor antes do Partilhar; .click() não, e o
    // formulário pode só copiar o texto do editor quando ele perde o foco
    box.blur()
    await sleep(500)

    // 10. Partilhar e esperar a confirmação
    ;(await waitFor(() => textButton(SHARE, dialog()), 'botão Partilhar')).click()
    await waitFor(
      () => /partilhad|compartilhad|shared/i.test(dialog().textContent || ''),
      'confirmação de publicação',
      5 * 60 * 1000
    )
    if (!caption) return { ok: true, coverSet: !!(coverInput && cover) }

    // 11. Confere na resposta do Instagram se o post saiu com a legenda (e corrige se não)
    let report
    for (let i = 0; i < 20; i++) {
      report = (await chrome.runtime.sendMessage({ type: 'guardReport' }))?.result
      if (report?.media) break
      await sleep(500)
    }
    console.log('[Reel Autopost] legenda:', report)
    let warning = null
    if (!report?.media)
      warning = 'Publicado, mas não deu pra confirmar a legenda pela resposta do Instagram. Confira o post.'
    else if (!report.verified)
      warning = 'O Instagram publicou sem a legenda e a correção automática falhou. Edite a legenda do post.'
    return { ok: true, coverSet: !!(coverInput && cover), warning, captionReport: report }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
