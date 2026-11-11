// Schema-logica. Een periode heeft dagen (0 = zondag ... 6 = zaterdag),
// een start- en eindtijd ("HH:MM") en een doeltemperatuur.
// Een periode die over middernacht loopt (bijv. 22:00 tot 06:00) wordt ondersteund.

function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) throw new Error(`Ongeldige tijd: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) throw new Error(`Ongeldige tijd: ${hhmm}`);
  return h * 60 + min;
}

export function validateSchedule(schedule) {
  if (!Array.isArray(schedule)) throw new Error('Schema moet een lijst zijn');
  return schedule.map((p, i) => {
    const days = Array.isArray(p.days) ? p.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error(`Periode ${i + 1}: dagen moeten 0 t/m 6 zijn`);
    }
    parseTime(p.start);
    parseTime(p.end);
    const target = Number(p.target);
    if (!Number.isFinite(target) || target < 10 || target > 30) {
      throw new Error(`Periode ${i + 1}: doeltemperatuur moet tussen 10 en 30 liggen`);
    }
    return { days, start: p.start, end: p.end, target };
  });
}

// Bouwt concrete intervallen rond "now" (gisteren, vandaag, morgen).
function intervalsAround(schedule, now) {
  const out = [];
  for (let offset = -1; offset <= 1; offset++) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + offset);
    for (const p of schedule) {
      if (!p.days.includes(day.getDay())) continue;
      const s = parseTime(p.start);
      let e = parseTime(p.end);
      if (e <= s) e += 24 * 60; // over middernacht
      const start = new Date(day.getTime());
      start.setMinutes(s);
      const end = new Date(day.getTime());
      end.setMinutes(e);
      out.push({ start, end, target: p.target });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Geeft de actieve periode terug, of null.
export function activePeriod(schedule, now) {
  const hits = intervalsAround(schedule, now).filter((iv) => iv.start <= now && now < iv.end);
  if (!hits.length) return null;
  // Bij overlap telt de hoogste doeltemperatuur.
  return hits.reduce((a, b) => (b.target > a.target ? b : a));
}

// Geeft de eerstvolgende periode die nog moet beginnen (binnen ca. 24 uur).
export function nextPeriod(schedule, now) {
  return intervalsAround(schedule, now).find((iv) => iv.start > now) || null;
}
