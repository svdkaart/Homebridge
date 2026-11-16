// De regel-logica. Deze functie is "puur": ze krijgt de toestand van het huis
// en geeft terug wat de Nest en de airco's moeten doen. Er wordt hier niets
// naar Homebridge gestuurd. Dat doet de executor.

import { activePeriod, nextPeriod } from './schedule.js';

// Per strategie: wanneer springt de airco bij en wat doet de Nest.
//   boostOn:    airco gaat aan als de kamer zoveel graden onder doel zit
//   boostOff:   airco gaat uit als het tekort kleiner is dan dit (negatief = iets doorstoken)
//   nestOffset: Nest-doel ten opzichte van het schema-doel
//   nestOn:     Nest doet mee tijdens comfort-periodes
export const STRATEGIES = {
  'cv-eerst':     { label: 'Cv eerst, airco alleen bij groot tekort', boostOn: 1.0, boostOff: 0.3, nestOffset: 0, nestOn: true },
  'hybride':      { label: 'Hybride, cv basis en airco helpt mee', boostOn: 0.5, boostOff: 0.0, nestOffset: 0, nestOn: true },
  'airco-eerst':  { label: 'Airco eerst, cv als achtervang', boostOn: 0.2, boostOff: -0.2, nestOffset: -1.0, nestOn: true },
  'alleen-airco': { label: 'Alleen airco, cv blijft op nachtstand', boostOn: 0.2, boostOff: -0.2, nestOffset: 0, nestOn: false },
  'slim':         { label: 'Slim op prijs (Frank Energie)', dynamic: true },
};

// Bij "slim" kiest de app per moment de goedkoopste warmtebron.
export function effectiveStrategy(name, economics) {
  if (name !== 'slim') return STRATEGIES[name] && !STRATEGIES[name].dynamic ? name : 'hybride';
  if (!economics) return 'hybride';
  return economics.choice === 'airco' ? 'airco-eerst' : 'cv-eerst';
}

export const DEFAULT_TUNING = {
  aircoOffset: 1.0,       // airco meet bij het plafond; zet hem iets hoger dan het doel
  maxPreheatMinutes: 120, // nooit eerder dan dit voor de start beginnen met opwarmen
  defaultRate: 1.5,       // aangenomen opwarmsnelheid in graden per uur, tot hij geleerd is
  coolOffHysteresis: 0.3,
  minCycleMinutes: 15,    // airco minimaal zo lang aan of uit laten, tegen pendelen
};

function round1(x) {
  return Math.round(x * 10) / 10;
}

// Berekent hoeveel minuten een kamer nodig heeft om op doel te komen.
export function leadMinutes(deficit, rate, maxMinutes) {
  if (!(deficit > 0)) return 0;
  const r = rate > 0.1 ? rate : 0.1;
  return Math.min(maxMinutes, Math.ceil((deficit / r) * 60));
}

/**
 * @param {object} input
 * @param {Date}   input.now
 * @param {object} input.settings  { schedule, strategy, setbackTemperature, cooling, tuning }
 * @param {Array}  input.rooms     [{ id, temp }]  temp in graden of null
 * @param {object} input.thermostat { available, mode, temp } of null
 * @param {object} input.memory    { aircoOn, rates, overrides, away }
 */
export function decide({ now, settings, rooms, thermostat, memory, economics = null }) {
  const effective = effectiveStrategy(settings.strategy, economics);
  const strategy = STRATEGIES[effective];
  const tuning = { ...DEFAULT_TUNING, ...(settings.tuning || {}) };
  const cooling = { enabled: false, margin: 1.5, ...(settings.cooling || {}) };
  const reasons = [];
  const nowMs = now.getTime();

  let mode = 'nacht';
  let target = settings.setbackTemperature;
  let period = null;
  let preheatFrom = null;

  const next = nextPeriod(settings.schedule, now);

  if (memory.away) {
    mode = 'afwezig';
    reasons.push('Afwezig-stand staat aan: alles op nachtstand.');
  } else {
    period = activePeriod(settings.schedule, now);
    if (period) {
      mode = 'comfort';
      target = period.target;
      reasons.push(`Schema actief tot ${hhmm(period.end)}, doel ${target}°C.`);
    } else if (next) {
      // Slim voorverwarmen: per kamer uitrekenen hoe lang opwarmen duurt.
      let lead = 0;
      for (const r of rooms) {
        if (r.temp == null) continue;
        const rate = memory.rates?.[r.id] ?? tuning.defaultRate;
        lead = Math.max(lead, leadMinutes(next.target - r.temp, rate, tuning.maxPreheatMinutes));
      }
      preheatFrom = new Date(next.start.getTime() - lead * 60000);
      if (lead > 0 && nowMs >= preheatFrom.getTime()) {
        mode = 'voorverwarmen';
        target = next.target;
        reasons.push(`Voorverwarmen: ${lead} min nodig om om ${hhmm(next.start)} op ${next.target}°C te zijn.`);
      }
    }
  }

  const comfort = mode === 'comfort' || mode === 'voorverwarmen';

  // Nest (cv op gas). We zetten alleen de doeltemperatuur, nooit de modus.
  // Staat de Nest zelf uit (zomer), dan laten we hem met rust.
  let thermostatCmd = null;
  if (thermostat && thermostat.available) {
    if (thermostat.mode === 0) {
      reasons.push('Nest staat uit, cv wordt niet aangestuurd.');
    } else {
      const t = comfort && strategy.nestOn ? target + strategy.nestOffset : settings.setbackTemperature;
      thermostatCmd = { target: round1(t) };
    }
  }

  // Airco's per kamer.
  const aircoCmds = {};
  for (const r of rooms) {
    const overrideUntil = memory.overrides?.[r.id];
    if (overrideUntil && overrideUntil > nowMs) {
      aircoCmds[r.id] = null;
      continue;
    }
    const was = memory.aircoOn?.[r.id] || null;
    if (r.temp == null) {
      aircoCmds[r.id] = null;
      reasons.push(`${r.name || r.id}: geen temperatuur bekend.`);
      continue;
    }

    // Anti-pendel: binnen de comfortperiode niet sneller schakelen dan minCycleMinutes.
    const since = memory.aircoSince?.[r.id];
    const locked = comfort && since && nowMs - since < tuning.minCycleMinutes * 60000;

    let want = null;
    if (locked) {
      if (was) want = { mode: was, setpoint: round1(was === 'heat' ? target + tuning.aircoOffset : target) };
    } else if (comfort) {
      const deficit = target - r.temp;
      const heat = was === 'heat' ? deficit > strategy.boostOff : deficit >= strategy.boostOn;
      const excess = r.temp - target;
      const cool = cooling.enabled &&
        (was === 'cool' ? excess > tuning.coolOffHysteresis : excess >= cooling.margin);
      if (heat) want = { mode: 'heat', setpoint: round1(target + tuning.aircoOffset) };
      else if (cool) want = { mode: 'cool', setpoint: round1(target) };
    }

    if (want) {
      aircoCmds[r.id] = want;
    } else if (was) {
      // Alleen uitzetten als de app hem zelf heeft aangezet.
      aircoCmds[r.id] = { mode: 'off' };
    } else {
      aircoCmds[r.id] = null;
    }
  }

  return {
    mode,
    target,
    strategy: settings.strategy in STRATEGIES ? settings.strategy : 'hybride',
    effectiveStrategy: effective,
    period: period ? { start: period.start.toISOString(), end: period.end.toISOString(), target: period.target } : null,
    next: next ? { start: next.start.toISOString(), end: next.end.toISOString(), target: next.target } : null,
    preheatFrom: preheatFrom ? preheatFrom.toISOString() : null,
    thermostatCmd,
    aircoCmds,
    reasons,
  };
}

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Leert per kamer hoe snel hij opwarmt als de airco stookt.
// Meet over blokken van minimaal 15 minuten om ruis te dempen.
export function updateRates(memory, rooms, nowMs) {
  memory.rates ||= {};
  memory.rateWindows ||= {};
  for (const r of rooms) {
    const heating = memory.aircoOn?.[r.id] === 'heat';
    const w = memory.rateWindows[r.id];
    if (!heating || r.temp == null) {
      delete memory.rateWindows[r.id];
      continue;
    }
    if (!w) {
      memory.rateWindows[r.id] = { t: nowMs, temp: r.temp };
      continue;
    }
    const hours = (nowMs - w.t) / 3600000;
    if (hours >= 0.25) {
      const sample = (r.temp - w.temp) / hours;
      if (sample > 0.05 && sample < 10) {
        const old = memory.rates[r.id];
        memory.rates[r.id] = old == null ? round2(sample) : round2(old * 0.8 + sample * 0.2);
      }
      memory.rateWindows[r.id] = { t: nowMs, temp: r.temp };
    }
  }
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
