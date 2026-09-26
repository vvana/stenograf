/* Стенограф — шаблоны техпроцессов (последовательность этапов с подсказками) и юридическая фиксация фото */
'use strict';

/* ---------- шаблоны этапов ---------- */
// Каждый шаблон: список этапов по порядку; hint — что важно зафиксировать на этом этапе
const STAGE_TEMPLATES = [
  {
    id: 'secondary', name: 'Вторичка', ico: '🏚',
    desc: 'Полный ремонт квартиры с демонтажом старой отделки',
    stages: [
      ['Исходное состояние', 'Снимите все стены, потолок и пол до начала работ — это доказательная база «как было».'],
      ['Демонтаж', 'После снятия старой отделки видны реальные стены: трещины, старая проводка, стяжка.'],
      ['Перепланировка и кладка', 'Новые перегородки, короба. Переобмерьте комнаты лидаром, если геометрия изменилась.'],
      ['Электрика: штробы и кабель', 'Главный этап для 🔧 коммуникаций: зафиксируйте каждую трассу с сечением и глубиной до закрытия.'],
      ['Сантехника: разводка', 'Трассы воды и канализации 🔧, выводы 🔌 с высотами — до штукатурки.'],
      ['Штукатурка', 'Коммуникации закрыты. Здесь пригодится AR-призрак — проверить, что ничего не сместилось.'],
      ['Стяжка', 'Пол: толщина, тёплый пол (если есть — как трасса 🔧 «отопление»).'],
      ['Шпаклёвка и грунт', 'Финальная ровность стен — момент для контрольных размеров 📐.'],
      ['Плитка', 'Санузел, кухонный фартук. Фото каждой стены плиткой — для гарантийных споров.'],
      ['Потолки', 'Натяжные / гипсокартон. Точки светильников 🔌 до монтажа полотна.'],
      ['Чистовая отделка', 'Обои, покраска, ламинат. Слайдер «до/после» здесь самый впечатляющий.'],
      ['Установка сантехники и электрики', 'Розетки, выключатели, смесители — отметьте точки «✓ Сделано».'],
      ['Двери и плинтусы', 'Финальные фото проёмов.'],
      ['Готово', 'Финальный скан 🏁 и панорамы 🌐 — для портфолио и заказчика.'],
    ],
  },
  {
    id: 'newbuild', name: 'Новостройка', ico: '🏢',
    desc: 'Без демонтажа: от голых стен застройщика до готовой квартиры',
    stages: [
      ['Приёмка от застройщика', 'Все дефекты — трещины, отклонения от вертикали, щели — с размерами 📐. Это претензия застройщику.'],
      ['Перегородки', 'Если планировка меняется — обмер после кладки.'],
      ['Электрика: штробы и кабель', 'Трассы 🔧 до закрытия.'],
      ['Сантехника: разводка', 'Трассы 🔧 и выводы 🔌.'],
      ['Штукатурка', 'Коммуникации закрыты.'],
      ['Стяжка', 'Толщина, тёплый пол.'],
      ['Шпаклёвка и грунт', 'Контрольные размеры.'],
      ['Плитка', 'Санузел, кухня.'],
      ['Потолки', 'Точки светильников до полотна.'],
      ['Чистовая отделка', 'Обои, краска, пол.'],
      ['Установка сантехники и электрики', 'Отметить точки «✓ Сделано».'],
      ['Готово', 'Финальный скан и панорамы.'],
    ],
  },
  {
    id: 'custom', name: 'Свой список', ico: '✏️',
    desc: 'Стандартные 9 этапов, дальше настроите сами',
    stages: null, // → DEFAULT_STAGES
  },
];

function templateSheet(onPick) {
  // простое модальное окно поверх текущего экрана
  let host = document.getElementById('tpl-sheet');
  if (!host) { host = document.createElement('div'); host.id = 'tpl-sheet'; host.className = 'plan-sheet tpl-sheet'; document.body.appendChild(host); }
  host.innerHTML = `<div class="sh-title">Какой это ремонт?</div>
    <p class="mut small">Шаблон задаёт этапы в правильной последовательности и подсказывает, что фиксировать на каждом. Потом всё можно менять.</p>
    ${STAGE_TEMPLATES.map(t => `<button class="btn wide tpl-btn" data-tpl="${t.id}"><span class="tpl-ico">${t.ico}</span><span class="tpl-txt"><b>${esc(t.name)}</b><small>${esc(t.desc)}${t.stages ? ` · ${t.stages.length} этапов` : ''}</small></span></button>`).join('')}
    <button class="btn ghost wide" id="tpl-cancel">Отмена</button>`;
  host.classList.remove('hidden');
  host.querySelector('#tpl-cancel').onclick = () => host.remove();
  host.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => { const t = STAGE_TEMPLATES.find(x => x.id === b.dataset.tpl); host.remove(); onPick(t); });
}

async function createStagesFromTemplate(pid, tpl) {
  const list = tpl && tpl.stages ? tpl.stages : DEFAULT_STAGES.map(n => [n, '']);
  for (let i = 0; i < list.length; i++) {
    const [name, hint] = list[i];
    await dbPut('stages', { id: uid(), projectId: pid, name, ord: i, status: 0, hint: hint || '' });
  }
}

/* ---------- юридическая фиксация: хеш + геометка при съёмке ---------- */

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let geoCache = { at: 0, pos: null };
// геометка: только с согласия (первый раз спросит браузер), с кешем на 2 минуты; при отказе — null, без блокировки съёмки
function getGeo(timeoutMs = 4000) {
  if (!navigator.geolocation) return Promise.resolve(null);
  if (Date.now() - geoCache.at < 120000) return Promise.resolve(geoCache.pos);
  return new Promise(res => {
    let done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    setTimeout(() => finish(geoCache.pos), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      p => { geoCache = { at: Date.now(), pos: { lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) } }; finish(geoCache.pos); },
      () => finish(null),
      { enableHighAccuracy: false, maximumAge: 120000, timeout: timeoutMs });
  });
}

// «печать» фото: хеш содержимого + время + гео (если разрешено) + устройство. Ставится один раз при добавлении.
async function sealPhoto(photo, opts = {}) {
  photo.seal = {
    sha256: await sha256Hex(photo.blob),
    at: Date.now(),
    shot: photo.created,
    geo: opts.geo === false ? null : await getGeo(),
    by: photo.by || '',
    source: opts.source || 'camera',
    ua: navigator.userAgent.slice(0, 80),
  };
  return photo;
}

// проверка: хеш текущего blob совпадает с печатью? (после «Стереть» — не совпадёт, оригинал хранится в photo.original)
async function verifySeal(photo) {
  if (!photo.seal || !photo.seal.sha256) return { state: 'none' };
  const cur = await sha256Hex(photo.blob);
  if (cur === photo.seal.sha256) return { state: 'ok' };
  if (photo.original && (await sha256Hex(photo.original)) === photo.seal.sha256) return { state: 'edited' };
  return { state: 'broken' };
}

function sealBadge(state) {
  return { ok: '🔒 подлинник', edited: '🔓 изменено (оригинал сохранён)', broken: '⚠️ не совпадает с печатью', none: '' }[state] || '';
}
function fmtGeo(g) { return g ? `${g.lat}, ${g.lon} (±${g.acc} м)` : '—'; }
