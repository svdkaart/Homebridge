import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, updateRates, leadMinutes } from '../src/controller.js';
import { activePeriod, nextPeriod, validateSchedule } from '../src/schedule.js';
import { aircoWrites, findService } from '../src/devices.js';

const schedule = validateSchedule([{ days: [0, 1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00', target: 20.5 }]);
const settings = { schedule, strategy: 'hybride', setbackTemperature: 16, cooling: { enabled: false } };
const at = (h, m = 0) => { const d = new Date(2026, 10, 11); d.setHours(h, m, 0, 0); return d; };
const mem = (extra = {}) => ({ aircoOn: {}, rates: {}, overrides: {}, away: false, ...extra });
const nest = { available: true, mode: 1, temp: 18 };

test('schema: actief tussen 17 en 20 uur', () => {
  assert.equal(activePeriod(schedule, at(16, 59)), null);
  assert.equal(activePeriod(schedule, at(17, 0)).target, 20.5);
  assert.equal(activePeriod(schedule, at(19, 59)).target, 20.5);
  assert.equal(activePeriod(schedule, at(20, 0)), null);
  assert.equal(nextPeriod(schedule, at(12)).start.getHours(), 17);
});

test('schema: periode over middernacht', () => {
  const s = validateSchedule([{ days: [3], start: '22:00', end: '06:00', target: 18 }]);
  // 11 nov 2026 is een woensdag (3)
  assert.ok(activePeriod(s, at(23)));
  const thursdayEarly = new Date(2026, 10, 12, 5, 0);
  assert.ok(activePeriod(s, thursdayEarly));
});

test('comfort: koude kamer krijgt airco, warme kamer niet', () => {
  const d = decide({
    now: at(18), settings, thermostat: nest, memory: mem(),
    rooms: [{ id: 'a', temp: 19.5 }, { id: 'b', temp: 20.4 }],
  });
  assert.equal(d.mode, 'comfort');
  assert.deepEqual(d.thermostatCmd, { target: 20.5 });
  assert.deepEqual(d.aircoCmds.a, { mode: 'heat', setpoint: 21.5 });
  assert.equal(d.aircoCmds.b, null);
});

test('hysterese: airco blijft aan tot doel bereikt, gaat dan uit', () => {
  const m = mem({ aircoOn: { a: 'heat' } });
  let d = decide({ now: at(18), settings, thermostat: nest, memory: m, rooms: [{ id: 'a', temp: 20.3 }] });
  assert.equal(d.aircoCmds.a.mode, 'heat');
  d = decide({ now: at(18), settings, thermostat: nest, memory: m, rooms: [{ id: 'a', temp: 20.5 }] });
  assert.deepEqual(d.aircoCmds.a, { mode: 'off' });
});

test('na het schema: Nest naar nachtstand en airco van de app uit', () => {
  const d = decide({
    now: at(21), settings, thermostat: nest, memory: mem({ aircoOn: { a: 'heat' } }),
    rooms: [{ id: 'a', temp: 20 }, { id: 'b', temp: 20 }],
  });
  assert.equal(d.mode, 'nacht');
  assert.deepEqual(d.thermostatCmd, { target: 16 });
  assert.deepEqual(d.aircoCmds.a, { mode: 'off' });
  assert.equal(d.aircoCmds.b, null, 'handmatig aangezette airco blijft met rust');
});

test('voorverwarmen start op tijd op basis van opwarmsnelheid', () => {
  const rooms = [{ id: 'a', temp: 18.5 }]; // 2 graden tekort, 1.5 graad/u = 80 min
  assert.equal(leadMinutes(2, 1.5, 120), 80);
  let d = decide({ now: at(15, 30), settings, thermostat: nest, memory: mem(), rooms });
  assert.equal(d.mode, 'nacht');
  d = decide({ now: at(15, 45), settings, thermostat: nest, memory: mem(), rooms });
  assert.equal(d.mode, 'voorverwarmen');
  assert.equal(d.aircoCmds.a.mode, 'heat');
  // Snellere kamer: later starten
  d = decide({ now: at(15, 45), settings, thermostat: nest, memory: mem({ rates: { a: 3 } }), rooms });
  assert.equal(d.mode, 'nacht');
});

test('pauze per kamer: geen opdrachten', () => {
  const d = decide({
    now: at(18), settings, thermostat: nest, memory: mem({ overrides: { a: at(19).getTime() } }),
    rooms: [{ id: 'a', temp: 17 }],
  });
  assert.equal(d.aircoCmds.a, null);
});

test('Nest uit (zomer): niet aansturen', () => {
  const d = decide({ now: at(18), settings, thermostat: { available: true, mode: 0 }, memory: mem(), rooms: [] });
  assert.equal(d.thermostatCmd, null);
});

test('strategie airco-eerst: Nest als achtervang een graad lager', () => {
  const d = decide({
    now: at(18), settings: { ...settings, strategy: 'airco-eerst' }, thermostat: nest, memory: mem(),
    rooms: [{ id: 'a', temp: 20.2 }],
  });
  assert.deepEqual(d.thermostatCmd, { target: 19.5 });
  assert.equal(d.aircoCmds.a.mode, 'heat');
});

test('koelen alleen als ingeschakeld', () => {
  const rooms = [{ id: 'a', temp: 23 }];
  let d = decide({ now: at(18), settings, thermostat: nest, memory: mem(), rooms });
  assert.equal(d.aircoCmds.a, null);
  d = decide({ now: at(18), settings: { ...settings, cooling: { enabled: true, margin: 1.5 } }, thermostat: nest, memory: mem(), rooms });
  assert.deepEqual(d.aircoCmds.a, { mode: 'cool', setpoint: 20.5 });
});

test('opwarmsnelheid wordt geleerd', () => {
  const m = mem({ aircoOn: { a: 'heat' } });
  const t0 = at(17).getTime();
  updateRates(m, [{ id: 'a', temp: 19 }], t0);
  updateRates(m, [{ id: 'a', temp: 19.5 }], t0 + 20 * 60000);
  assert.equal(m.rates.a, 1.5);
});

test('airco opdracht naar HomeKit characteristics, alleen verschillen', () => {
  const acc = {
    type: 'HeaterCooler',
    values: { Active: 0, TargetHeaterCoolerState: 1, HeatingThresholdTemperature: 21 },
    serviceCharacteristics: [
      { type: 'Active' }, { type: 'TargetHeaterCoolerState' },
      { type: 'HeatingThresholdTemperature', minValue: 16, maxValue: 30, minStep: 0.5 },
    ],
  };
  assert.deepEqual(aircoWrites(acc, { mode: 'heat', setpoint: 21.6 }), [['Active', 1], ['HeatingThresholdTemperature', 21.5]]);
  assert.deepEqual(aircoWrites(acc, { mode: 'off' }), []);
});

test('accessoire zoeken op naam, zonder hoofdletters', () => {
  const list = [
    { type: 'Switch', serviceName: 'Airco Zolder' },
    { type: 'HeaterCooler', serviceName: 'Airco Zolder' },
  ];
  assert.equal(findService(list, 'airco zolder', ['HeaterCooler']).type, 'HeaterCooler');
  assert.equal(findService(list, 'Kelder', ['HeaterCooler']), null);
});

test('anti-pendel: airco blijft minimaal 15 minuten in dezelfde stand', () => {
  const m = mem({ aircoOn: { a: 'heat' }, aircoSince: { a: at(18).getTime() } });
  let d = decide({ now: at(18, 10), settings, thermostat: nest, memory: m, rooms: [{ id: 'a', temp: 21 }] });
  assert.equal(d.aircoCmds.a.mode, 'heat');
  d = decide({ now: at(18, 16), settings, thermostat: nest, memory: m, rooms: [{ id: 'a', temp: 21 }] });
  assert.deepEqual(d.aircoCmds.a, { mode: 'off' });
  // Uit blijft ook even uit
  const m2 = mem({ aircoSince: { a: at(18).getTime() } });
  d = decide({ now: at(18, 5), settings, thermostat: nest, memory: m2, rooms: [{ id: 'a', temp: 19 }] });
  assert.equal(d.aircoCmds.a, null);
  // Einde schema: direct uit
  d = decide({ now: at(20, 1), settings, thermostat: nest, memory: mem({ aircoOn: { a: 'heat' }, aircoSince: { a: at(19, 58).getTime() } }), rooms: [{ id: 'a', temp: 19 }] });
  assert.deepEqual(d.aircoCmds.a, { mode: 'off' });
});

import { compareHeatCost, copFor, DEFAULT_PRICE_CONFIG, priceAt } from '../src/prices.js';

test('prijs: airco goedkoper bij mild weer, gas bij vorst', () => {
  // stroom 25 ct, gas 1.30 per m3: cv-warmte ongeveer 14.8 ct/kWh
  const mild = compareHeatCost({ electricity: 0.25, gas: 1.3, outdoor: 10 });
  assert.equal(mild.choice, 'airco');
  const frost = compareHeatCost({ electricity: 0.45, gas: 1.3, outdoor: -5 });
  assert.equal(frost.choice, 'gas');
  assert.equal(copFor(7, DEFAULT_PRICE_CONFIG), 4);
  assert.equal(copFor(-7, DEFAULT_PRICE_CONFIG), 2.5);
});

test('prijs: marge voorkomt heen-en-weer schakelen', () => {
  // Bijna gelijk: blijft bij de vorige keuze
  const gasHeat = 1.3 / (9.77 * 0.9);
  const e = gasHeat * 3.5 * 1.02; // airco 2% duurder
  assert.equal(compareHeatCost({ electricity: e, gas: 1.3, outdoor: null, previous: 'airco' }).choice, 'airco');
  assert.equal(compareHeatCost({ electricity: e, gas: 1.3, outdoor: null, previous: 'gas' }).choice, 'gas');
});

test('prijs: juiste prijs voor het huidige kwartier of uur', () => {
  const list = [{ from: 0, till: 10, price: 1 }, { from: 10, till: 20, price: 2 }];
  assert.equal(priceAt(list, 10), 2);
  assert.equal(priceAt(list, 25), null);
});

test('strategie slim: kiest airco-eerst of cv-eerst op basis van prijs', () => {
  const s = { ...settings, strategy: 'slim' };
  const rooms = [{ id: 'a', temp: 20.2 }];
  let d = decide({ now: at(18), settings: s, thermostat: nest, memory: mem(), rooms, economics: { choice: 'airco' } });
  assert.equal(d.effectiveStrategy, 'airco-eerst');
  assert.deepEqual(d.thermostatCmd, { target: 19.5 });
  assert.equal(d.aircoCmds.a.mode, 'heat');
  d = decide({ now: at(18), settings: s, thermostat: nest, memory: mem(), rooms, economics: { choice: 'gas' } });
  assert.equal(d.effectiveStrategy, 'cv-eerst');
  assert.deepEqual(d.thermostatCmd, { target: 20.5 });
  assert.equal(d.aircoCmds.a, null);
  d = decide({ now: at(18), settings: s, thermostat: nest, memory: mem(), rooms });
  assert.equal(d.effectiveStrategy, 'hybride');
});
