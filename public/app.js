// Progressive enhancement only — every workflow also works without JavaScript.
(() => {
  // Confirmation for money-moving / destructive actions.
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  // Prevent double submissions (the server also rejects duplicates, this just avoids the round trip).
  document.querySelectorAll('form[data-once]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (e.defaultPrevented) return;
      const btn = form.querySelector('button:not([type=button])');
      if (btn) {
        setTimeout(() => { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Working…'; }, 0);
      }
    });
  });

  // Client-side file size check so users don't wait for a 2 MB+ upload to fail.
  document.querySelectorAll('input[type=file][data-maxbytes]').forEach((input) => {
    input.addEventListener('change', () => {
      const f = input.files[0];
      if (f && f.size > Number(input.dataset.maxbytes)) {
        alert('That file is larger than 2 MB. Please compress it or upload a smaller file.');
        input.value = '';
      }
    });
  });

  // Milestone builder on the apply form.
  const rows = document.getElementById('ms-rows');
  if (!rows) return;
  const max = Number(rows.dataset.max);
  const available = Number(rows.dataset.available);
  const totalEl = document.getElementById('ms-total');
  const overEl = document.getElementById('ms-over');
  const fmt = (n) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

  const recalc = () => {
    let total = 0;
    rows.querySelectorAll('.amt').forEach((i) => {
      const v = Number(String(i.value).replace(/[,\s₹]/g, ''));
      if (Number.isFinite(v) && v > 0) total += v;
    });
    totalEl.textContent = fmt(total);
    overEl.hidden = total <= available;
  };
  rows.addEventListener('input', recalc);
  recalc();

  document.getElementById('add-ms').addEventListener('click', () => {
    const count = rows.children.length;
    if (count >= max) return alert(`At most ${max} milestones.`);
    const row = rows.lastElementChild.cloneNode(true);
    row.querySelector('.ms-n').textContent = count + 1;
    row.querySelectorAll('input').forEach((i) => {
      i.name = i.name.replace(/\[\d+\]/, `[${count}]`);
      i.value = '';
    });
    rows.appendChild(row);
    row.querySelector('input').focus();
  });
})();
