// Roda no site: avisa a página que a extensão está instalada e repassa o "vídeo novo, confere a fila"
document.documentElement.dataset.reelAutopost = 'on'

window.addEventListener('message', e => {
  if (e.source !== window || e.data?.type !== 'reel-autopost:check') return
  chrome.runtime.sendMessage({ type: 'check' }, result => {
    window.postMessage({ type: 'reel-autopost:status', ...(result || {}) }, '*')
  })
})
