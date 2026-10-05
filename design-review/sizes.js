(() => {
  const frame = document.getElementById('review-frame');
  const box = document.getElementById('frame-box');
  const target = document.getElementById('target');
  const fit = document.getElementById('fit');
  const readout = document.getElementById('readout');
  const buttons = [...document.querySelectorAll('button[data-width]')];
  let width = 1280, height = 720;
  function layout() {
    const scale = fit.checked ? Math.min(1, Math.max(280, window.innerWidth - 40) / width) : 1;
    frame.style.width = `${width}px`; frame.style.height = `${height}px`;
    frame.width = String(width); frame.height = String(height);
    frame.style.transform = `scale(${scale})`;
    box.style.width = `${width * scale}px`; box.style.height = `${height * scale}px`;
    const name = target.value === '/' ? 'Proposed design' : 'Current interface replay';
    frame.title = `${name} at ${width} by ${height} CSS pixels`;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.width) === width && Number(button.dataset.height) === height)));
    // Reading our same-origin frame verifies its real layout viewport; no storage,
    // network, or application internals are inspected.
    window.requestAnimationFrame(() => {
      const actual = frame.contentWindow;
      readout.textContent = `${name} · requested ${width} × ${height} · actual frame ${actual?.innerWidth ?? '?'} × ${actual?.innerHeight ?? '?'} CSS px · display ${Math.round(scale * 100)}%`;
    });
  }
  buttons.forEach(button => button.addEventListener('click', () => { width = Number(button.dataset.width); height = Number(button.dataset.height); layout(); }));
  target.addEventListener('change', () => { frame.src = target.value; layout(); });
  fit.addEventListener('change', layout);
  document.getElementById('reload').addEventListener('click', () => { frame.src = target.value; });
  frame.addEventListener('load', layout);
  window.addEventListener('resize', layout);
  layout();
})();
