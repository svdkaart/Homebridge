const $ = (id) => document.getElementById(id);
const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MODE_LABEL = { comfort: 'Comfort', voorverwarmen: 'Voorverwarmen', nacht: 'Buiten schema', afwezig: 'Afwezig' };
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599'];

let state = null;
let hours = 24;
let scheduleDirty = false;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const fmtT = (t) => (t == null ? '-' : `${Number(t).toFixed(1)}°`);
// Tijden altijd tonen in de tijdzone van de Pi, ook als je telefoon ergens anders is.
const tz = () => state?.timezone || undefined;
const fmtTime = (iso, withDay = false) => {
  const d = new Date(iso);
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz() };
  return withDay
    ? d.toLocaleString('nl-NL', { weekday: 'short', ...opts })
    : d.toLocaleTimeString('nl-NL', opts);
};
const localParts = (t) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date(t));
  return { hour: parts.find((p) => p.type === 'hour').value, day: new Date(t).toLocaleDateString('nl-NL', { weekday: 'short', timeZone: tz() }) };
};

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) e.append(c?.nodeType ? c : document.createTextNode(c ?? ''));
  return e;
}

function renderStatus() {
  const s = state;
  const d = s.decision || {};
  $('error').hidden = !s.error;
  if (s.error) $('error').textContent = `Probleem met Homebridge: ${s.error.message}`;

  $('mode').textContent = MODE_LABEL[d.mode] || '-';
  $('target').textContent = d.target != null ? `${d.target}°C` : '-';
  $('next').textContent = d.next ? `${fmtTime(d.next.start, true)} (${d.next.target}°)` : '-';
  $('strategyLabel').textContent = s.strategies?.[s.settings.strategy] || s.settings.strategy;
  const temps = (s.rooms || []).map((r) => r.temp).filter((t) => t != null);
  const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  $('summary').textContent = `Gemiddeld ${fmtT(avg)} in huis, bijgewerkt ${s.t ? fmtTime(s.t) : '-'}`;
  $('awayBtn').classList.toggle('active', s.away);
  $('awayBtn').textContent = s.away ? 'Afwezig (aan)' : 'Afwezig';

  const now = s.serverTime;
  $('rooms').replaceChildren(...(s.rooms || []).map((r) => {
    const paused = r.overrideUntil && r.overrideUntil > now;
    const a = r.airco || {};
    let badge;
    if (paused) badge = el('span', { class: 'badge pause' }, `Pauze tot ${fmtTime(r.overrideUntil)}`);
    else if (a.mode === 'heat') badge = el('span', { class: 'badge heat' }, `Airco verwarmt ${a.setpoint ?? ''}°`);
    else if (a.mode === 'cool') badge = el('span', { class: 'badge cool' }, `Airco koelt ${a.setpoint ?? ''}°`);
    else if (a.mode === 'auto') badge = el('span', { class: 'badge' }, 'Airco auto (handmatig)');
    else badge = el('span', { class: 'badge ok' }, a.available === false ? 'Airco niet gevonden' : 'Airco uit');

    const target = d.target ?? 20;
    const pct = r.temp == null ? 0 : Math.max(0, Math.min(100, ((r.temp - (target - 4)) / 4) * 100));
    return el('div', { class: 'card room' },
      el('div', { class: 'line' }, el('span', {}, r.name), el('span', {}, r.source ? `meting: ${r.source}` : '')),
      el('div', { class: 'temp' }, fmtT(r.temp), el('small', {}, ` / ${target}°`)),
      el('div', { class: 'bar' }, el('div', { style: `width:${pct}%` })),
      badge,
      el('div', { class: 'line meta' },
        el('span', {}, r.managed ? 'Door app aangezet' : ''),
        el('span', {}, r.rate ? `opwarmen ${r.rate}°/u` : '')),
      el('div', { class: 'actions' },
        paused
          ? el('button', { class: 'small', onclick: () => override(r.id, 0) }, 'Automaat aan')
          : el('button', { class: 'small secondary', onclick: () => override(r.id, 120) }, 'Pauze 2 uur'),
      ),
    );
  }));

  const n = s.thermostat || {};
  $('nest').replaceChildren(
    n.available
      ? el('div', { class: 'row-between' },
          el('div', {}, el('div', { class: 'muted' }, n.name || 'Nest'),
            el('div', { class: 'room' }, el('span', { class: 'temp' }, fmtT(n.temp)), el('small', { class: 'muted' }, `  doel ${fmtT(n.target)}`))),
          el('span', { class: `badge ${n.heating ? 'heat' : 'ok'}` }, n.mode === 0 ? 'Uit' : n.heating ? 'Cv stookt' : 'Cv in rust'))
      : el('span', { class: 'muted' }, 'Nest niet gevonden in Homebridge. Controleer de naam in config.json.'),
  );

  $('events').replaceChildren(...(s.events || []).map((e) => el('li', {}, `${fmtTime(e.t, true)}  ${e.text}`)));
  if (!s.events?.length) $('events').append(el('li', { class: 'muted' }, 'Nog geen acties.'));
  $('reasons').replaceChildren(...(d.reasons || []).map((t) => el('li', {}, t)));
}

function renderSettings() {
  const s = state.settings;
  const sel = $('strategy');
  sel.replaceChildren(...Object.entries(state.strategies).map(([k, v]) => el('option', { value: k, selected: k === s.strategy ? '' : false }, v)));
  $('setback').value = s.setbackTemperature;
  $('coolEnabled').checked = Boolean(s.cooling?.enabled);
  renderSchedule(s.schedule);
}

function renderSchedule(schedule) {
  $('schedule').replaceChildren(...schedule.map((p, i) => el('tr', { 'data-i': i },
    el('td', {}, el('div', { class: 'days' }, DAY_ORDER.map((d) =>
      el('label', {}, el('input', { type: 'checkbox', value: d, checked: p.days.includes(d) ? '' : false, onchange: markDirty }), DAYS[d])))),
    el('td', {}, el('input', { type: 'time', value: p.start, class: 'start', onchange: markDirty })),
    el('td', {}, el('input', { type: 'time', value: p.end, class: 'end', onchange: markDirty })),
    el('td', {}, el('input', { type: 'number', step: '0.5', min: '10', max: '30', value: p.target, class: 'tgt', onchange: markDirty })),
    el('td', {}, el('button', { class: 'small secondary', onclick: () => { const sc = readSchedule(); sc.splice(i, 1); renderSchedule(sc); markDirty(); } }, 'Weg')),
  )));
}

function readSchedule() {
  return [...$('schedule').querySelectorAll('tr')].map((tr) => ({
    days: [...tr.querySelectorAll('.days input:checked')].map((x) => Number(x.value)),
    start: tr.querySelector('.start').value,
    end: tr.querySelector('.end').value,
    target: Number(tr.querySelector('.tgt').value),
  }));
}

function markDirty() {
  scheduleDirty = true;
  $('saveMsg').textContent = 'Niet opgeslagen';
}

async function saveSettings() {
  try {
    state = await api('/api/settings', {
      method: 'PUT',
      body: {
        schedule: readSchedule(),
        strategy: $('strategy').value,
        setbackTemperature: Number($('setback').value),
        cooling: { enabled: $('coolEnabled').checked },
      },
    });
    scheduleDirty = false;
    $('saveMsg').textContent = 'Opgeslagen';
    renderSettings();
    renderStatus();
  } catch (err) {
    $('saveMsg').textContent = err.message;
  }
}

async function override(roomId, minutes) {
  state = await api('/api/override', { method: 'POST', body: { roomId, minutes } });
  renderStatus();
}

// ---- Grafiek ----
async function loadChart() {
  const rows = await api(`/api/history?hours=${hours}`);
  drawChart(rows);
}

function drawChart(rows) {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 260;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted');
  const line = css.getPropertyValue('--line');
  const heat = css.getPropertyValue('--heat');

  const rooms = state.rooms || [];
  if (rows.length < 2) {
    ctx.fillStyle = muted;
    ctx.fillText('Nog te weinig metingen. De grafiek vult zich vanzelf.', 10, 20);
    $('legend').replaceChildren();
    return;
  }

  const pad = { l: 34, r: 8, t: 8, b: 22 + rooms.length * 5 + 6 };
  const t0 = rows[0].t;
  const t1 = rows[rows.length - 1].t;
  const vals = rows.flatMap((r) => [r.target, ...Object.values(r.rooms || {}).map((x) => x.temp)]).filter((v) => v != null);
  const lo = Math.floor(Math.min(...vals) - 0.5);
  const hi = Math.ceil(Math.max(...vals) + 0.5);
  const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / Math.max(1, hi - lo)) * (h - pad.t - pad.b);

  // Raster
  ctx.font = '11px system-ui';
  ctx.strokeStyle = line;
  ctx.fillStyle = muted;
  ctx.lineWidth = 1;
  for (let v = lo; v <= hi; v++) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.fillText(`${v}°`, 4, Y(v) + 4);
  }
  const span = t1 - t0;
  const tickMs = span > 3 * 86400000 ? 86400000 : span > 12 * 3600000 ? 3 * 3600000 : 3600000;
  for (let t = Math.ceil(t0 / tickMs) * tickMs; t <= t1; t += tickMs) {
    const lp = localParts(t);
    const label = tickMs >= 86400000 ? lp.day : `${lp.hour}:00`;
    ctx.fillText(label, X(t) - 14, h - 4);
  }

  // Doeltemperatuur (stippellijn)
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = muted;
  ctx.beginPath();
  rows.forEach((r, i) => { const x = X(r.t), y = Y(r.target); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.setLineDash([]);

  // Kamers
  ctx.lineWidth = 2;
  rooms.forEach((room, ri) => {
    ctx.strokeStyle = COLORS[ri % COLORS.length];
    ctx.beginPath();
    let started = false;
    for (const r of rows) {
      const v = r.rooms?.[room.id]?.temp;
      if (v == null) { started = false; continue; }
      started ? ctx.lineTo(X(r.t), Y(v)) : ctx.moveTo(X(r.t), Y(v));
      started = true;
    }
    ctx.stroke();
  });

  // Strookjes onderaan: wanneer stookte de airco / de cv
  const baseY = h - pad.b + 6;
  rows.forEach((r, i) => {
    if (i === rows.length - 1) return;
    const x = X(r.t), xw = Math.max(1, X(rows[i + 1].t) - x);
    if (r.nest?.heating) { ctx.fillStyle = heat; ctx.globalAlpha = 0.25; ctx.fillRect(x, pad.t, xw, h - pad.t - pad.b); ctx.globalAlpha = 1; }
    rooms.forEach((room, ri) => {
      const a = r.rooms?.[room.id]?.airco;
      if (!a) return;
      ctx.fillStyle = COLORS[ri % COLORS.length];
      ctx.fillRect(x, baseY + ri * 5, xw, 4);
    });
  });

  $('legend').replaceChildren(
    ...rooms.map((r, i) => el('span', {}, el('i', { style: `background:${COLORS[i % COLORS.length]}` }), r.name)),
    el('span', {}, el('i', { style: `background:${muted}` }), 'Doel'),
    el('span', {}, el('i', { style: `background:${heat};opacity:.4;height:10px` }), 'Cv stookt'),
    el('span', {}, 'Strookjes onderaan: airco aan'),
  );
}

// ---- Opstarten ----
async function refresh(full = false) {
  try {
    state = await api('/api/status');
    renderStatus();
    if (full || !scheduleDirty) renderSettings();
    loadChart();
  } catch (err) {
    $('error').hidden = false;
    $('error').textContent = `Geen verbinding met de app: ${err.message}`;
  }
}

$('saveSettings').addEventListener('click', saveSettings);
$('addPeriod').addEventListener('click', () => {
  const sc = readSchedule();
  sc.push({ days: [1, 2, 3, 4, 5], start: '07:00', end: '09:00', target: 20 });
  renderSchedule(sc);
  markDirty();
});
$('strategy').addEventListener('change', markDirty);
$('setback').addEventListener('change', markDirty);
$('coolEnabled').addEventListener('change', markDirty);
$('awayBtn').addEventListener('click', async () => {
  state = await api('/api/away', { method: 'POST', body: { away: !state.away } });
  renderStatus();
});
$('refreshBtn').addEventListener('click', async () => {
  state = await api('/api/refresh', { method: 'POST' });
  renderStatus();
  loadChart();
});
$('range').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  hours = Number(b.dataset.h);
  $('range').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  loadChart();
});
window.addEventListener('resize', () => loadChart());

refresh(true);
setInterval(() => refresh(false), 15000);
