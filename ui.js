/* Всплывающие окна в стиле «жидкого стекла» вместо системных alert / confirm / prompt
   (просьба пользователя 2026-10-14: «все всплывающие окна — жидким стеклом»).
   Все три возвращают Promise: uiAlert → undefined, uiConfirm → true/false, uiPrompt → строка или null (отмена). */
function uiDialog({ text, input = false, value = '', ok = 'ОК', cancel = 'Отмена', danger = false, choices = null }) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'ui-dlg-back';
    const box = document.createElement('div');
    box.className = 'ui-dlg';
    box.setAttribute('role', 'dialog');
    const p = document.createElement('div');
    p.className = 'ui-dlg-text';
    p.textContent = String(text == null ? '' : text);
    box.appendChild(p);
    // выбор из вариантов — переключатель-слайдер (сегменты с переезжающей плашкой, как в iOS)
    let pick = choices ? (choices.find(c => c[0] === value) || choices[0])[0] : null;
    if (choices) {
      const seg = document.createElement('div');
      seg.className = 'ui-seg';
      seg.style.setProperty('--n', choices.length);
      seg.innerHTML = '<i class="ui-seg-thumb"></i>' + choices.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('');
      const place = () => {
        const i = choices.findIndex(c => c[0] === pick);
        seg.style.setProperty('--i', i);
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === pick));
      };
      seg.querySelectorAll('button').forEach(b => b.onclick = () => { pick = b.dataset.v; place(); });
      // плашку можно и перетащить пальцем — по отпусканию встаёт на ближайший вариант
      let drag = null;
      seg.addEventListener('pointerdown', e => { drag = { x: e.clientX }; });
      seg.addEventListener('pointermove', e => {
        if (!drag) return;
        const r = seg.getBoundingClientRect(), w = r.width / choices.length;
        const i = Math.max(0, Math.min(choices.length - 1, Math.floor((e.clientX - r.left) / w)));
        if (Math.abs(e.clientX - drag.x) > 6 && choices[i][0] !== pick) { pick = choices[i][0]; place(); }
      });
      const up = () => { drag = null; };
      seg.addEventListener('pointerup', up); seg.addEventListener('pointercancel', up);
      place();
      box.appendChild(seg);
    }
    let inp = null;
    if (input) {
      inp = document.createElement('input');
      inp.className = 'ui-dlg-input';
      inp.type = 'text';
      inp.value = value == null ? '' : String(value);
      inp.setAttribute('autocomplete', 'off');
      box.appendChild(inp);
    }
    const row = document.createElement('div');
    row.className = 'ui-dlg-btns';
    const mk = (label, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ui-dlg-btn ' + cls; b.textContent = label; row.appendChild(b); return b; };
    const bCancel = cancel ? mk(cancel, 'cancel') : null;
    const bOk = mk(ok, danger ? 'ok danger' : 'ok');
    box.appendChild(row);
    back.appendChild(box);
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add('on'));
    let done = false;
    const close = res => {
      if (done) return; done = true;
      if (inp) inp.blur();
      back.classList.remove('on');
      setTimeout(() => back.remove(), 180);
      resolve(res);
    };
    const yes = () => close(input ? inp.value : choices ? pick : true);
    const no = () => close(input || choices ? null : false);
    bOk.onclick = yes;
    if (bCancel) bCancel.onclick = no;
    back.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); yes(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel ? no() : yes(); }
    });
    // текст не выделяем — курсор в конец (просьба пользователя 2026-10-17: выделение при редактировании мешает)
    setTimeout(() => { if (inp) { inp.focus(); const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch {} } else bOk.focus(); }, 30);
    // iOS рисует курсор там, где поле было до сдвига окна (масштаб при появлении, подъём над клавиатурой) — курсор «висел»
    // правее конца слова (видео пользователя 2026-10-17). Окно с полем появляется без масштаба (класс .has-input), а после
    // каждого сдвига экрана выделение переустанавливается — WebKit перерисовывает курсор на правильном месте
    if (inp) {
      box.classList.add('has-input');
      const vv = window.visualViewport;
      let t = 0;
      const later = () => { clearTimeout(t); t = setTimeout(recaret, 120); };
      const off = () => { if (vv) { vv.removeEventListener('resize', later); vv.removeEventListener('scroll', later); } };
      function recaret() {
        if (done) return off();
        if (document.activeElement !== inp) return;
        const s = inp.selectionStart, e = inp.selectionEnd;
        try { inp.setSelectionRange(0, 0); inp.setSelectionRange(s, e); } catch {}
      }
      if (vv) { vv.addEventListener('resize', later); vv.addEventListener('scroll', later); }
      [350, 700].forEach(ms => setTimeout(recaret, ms));
    }
  });
}
const uiAlert = text => uiDialog({ text, cancel: null });
const uiConfirm = text => uiDialog({ text });
const uiPrompt = (text, value = '') => uiDialog({ text, input: true, value });
// выбор одного из вариантов слайдером: choices = [[значение, подпись], …]; → значение или null (отмена)
const uiChoose = (text, choices, value) => uiDialog({ text, choices, value });
