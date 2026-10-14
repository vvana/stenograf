/* Всплывающие окна в стиле «жидкого стекла» вместо системных alert / confirm / prompt
   (просьба пользователя 2026-10-14: «все всплывающие окна — жидким стеклом»).
   Все три возвращают Promise: uiAlert → undefined, uiConfirm → true/false, uiPrompt → строка или null (отмена). */
function uiDialog({ text, input = false, value = '', ok = 'ОК', cancel = 'Отмена', danger = false }) {
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
    const yes = () => close(input ? inp.value : true);
    const no = () => close(input ? null : false);
    bOk.onclick = yes;
    if (bCancel) bCancel.onclick = no;
    back.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); yes(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel ? no() : yes(); }
    });
    setTimeout(() => { if (inp) { inp.focus(); inp.select(); } else bOk.focus(); }, 30);
  });
}
const uiAlert = text => uiDialog({ text, cancel: null });
const uiConfirm = text => uiDialog({ text });
const uiPrompt = (text, value = '') => uiDialog({ text, input: true, value });
