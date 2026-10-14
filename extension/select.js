// Injected on demand: draw a selection rectangle, then send its viewport rect to the service worker.
(() => {
  if (window.__fontsnapActive) return; window.__fontsnapActive = true;
  const ov = document.createElement('div'), box = document.createElement('div'), hint = document.createElement('div');
  Object.assign(ov.style, { position: 'fixed', inset: '0', zIndex: 2147483647, cursor: 'crosshair', background: 'rgba(0,0,0,0.15)' });
  Object.assign(box.style, { position: 'fixed', border: '2px solid #4f7cff', background: 'rgba(79,124,255,0.08)', display: 'none', pointerEvents: 'none' });
  Object.assign(hint.style, { position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', background: '#111', color: '#fff', font: '13px system-ui,sans-serif', padding: '6px 12px', borderRadius: '6px', pointerEvents: 'none' });
  hint.textContent = 'FontSnap: drag over the text (Esc to cancel)';
  ov.append(box, hint); document.documentElement.appendChild(ov);
  let sx, sy, drag = false;
  const done = () => { if (!ov.isConnected) return; ov.remove(); window.removeEventListener('keydown', key, true); window.__fontsnapActive = false; };
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
  window.addEventListener('keydown', key, true);
  ov.addEventListener('mousedown', e => { e.preventDefault(); drag = true; sx = e.clientX; sy = e.clientY; Object.assign(box.style, { display: 'block', left: sx + 'px', top: sy + 'px', width: '0', height: '0' }); });
  ov.addEventListener('mousemove', e => { if (!drag) return; const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: Math.abs(e.clientX - sx) + 'px', height: Math.abs(e.clientY - sy) + 'px' }); });
  ov.addEventListener('mouseup', e => { if (!drag) return; drag = false;
    const rect = { x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY), w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy) };
    done(); if (rect.w < 8 || rect.h < 8) return;
    let text = ''; try { const s = window.getSelection()?.toString(); text = (s || '').trim().slice(0, 80); } catch {}
    // wait two frames so the overlay is gone from the screenshot
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => chrome.runtime.sendMessage({ type: 'fontsnap-rect', rect, dpr: window.devicePixelRatio || 1, text }), 30)));
  });
})();
