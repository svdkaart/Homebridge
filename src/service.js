// De regelkring: elke minuut status ophalen, beslissen, aansturen, opslaan.

import { decide, updateRates, STRATEGIES, DEFAULT_TUNING } from './controller.js';
import { validateSchedule } from './schedule.js';
import {
  findService, readThermostat, readAirco, readTemp,
  aircoWrites, thermostatWrites, THERMOSTAT_TYPES, AIRCO_TYPES, SENSOR_TYPES,
} from './devices.js';

const MANUAL_OVERRIDE_MINUTES = 180;

export class ClimateService {
  constructor({ config, client, storage, clock = () => new Date(), log = console }) {
    this.config = config;
    this.client = client;
    this.storage = storage;
    this.clock = clock;
    this.log = log;
    this.lastStatus = null;
    this.lastError = null;
    this.events = [];

    const saved = storage.loadState() || {};
    const base = config.settings || {};
    this.settings = {
      strategy: base.strategy || 'hybride',
      setbackTemperature: base.setbackTemperature ?? 16,
      schedule: validateSchedule(base.schedule || []),
      cooling: { enabled: false, margin: 1.5, ...(base.cooling || {}) },
      tuning: { ...DEFAULT_TUNING, ...(base.tuning || {}) },
      ...(saved.settings || {}),
    };
    this.memory = {
      aircoOn: {}, aircoSince: {}, rates: {}, rateWindows: {}, overrides: {}, away: false, lastWrite: {},
      ...(saved.memory || {}),
    };
  }

  persist() {
    this.storage.saveState({ settings: this.settings, memory: this.memory });
  }

  event(text) {
    const e = { t: this.clock().getTime(), text };
    this.events.unshift(e);
    this.events.length = Math.min(this.events.length, 50);
    this.log.info?.(`[klimaat] ${text}`);
  }

  async tick() {
    const now = this.clock();
    const nowMs = now.getTime();
    try {
      const accessories = await this.client.getAccessories();
      const nestAcc = findService(accessories, this.config.thermostat?.name, THERMOSTAT_TYPES);
      const thermostat = readThermostat(nestAcc);

      const rooms = (this.config.rooms || []).map((r) => {
        const aircoAcc = findService(accessories, r.airco, AIRCO_TYPES);
        const sensorAcc = r.sensor ? findService(accessories, r.sensor, SENSOR_TYPES) : null;
        let temp = null;
        let source = null;
        if (r.useThermostatSensor && thermostat.temp != null) { temp = thermostat.temp; source = 'nest'; }
        else if (sensorAcc && readTemp(sensorAcc) != null) { temp = readTemp(sensorAcc); source = 'sensor'; }
        else if (aircoAcc && readTemp(aircoAcc) != null) { temp = readTemp(aircoAcc); source = 'airco'; }
        return { id: r.id, name: r.name, temp, source, aircoAcc, airco: readAirco(aircoAcc) };
      });

      this.detectManualChanges(rooms, nowMs);
      updateRates(this.memory, rooms, nowMs);

      // Verlopen overrides opruimen
      for (const [id, until] of Object.entries(this.memory.overrides)) {
        if (until <= nowMs) delete this.memory.overrides[id];
      }

      const decision = decide({ now, settings: this.settings, rooms, thermostat, memory: this.memory });

      // Nest aansturen
      if (nestAcc && decision.thermostatCmd) {
        for (const [type, value] of thermostatWrites(nestAcc, decision.thermostatCmd)) {
          await this.write(nestAcc, type, value, `Nest doel naar ${value}°C`);
        }
      }

      // Airco's aansturen
      for (const r of rooms) {
        const cmd = decision.aircoCmds[r.id];
        if (!cmd || !r.aircoAcc) continue;
        const writes = aircoWrites(r.aircoAcc, cmd);
        for (const [type, value] of writes) {
          await this.write(r.aircoAcc, type, value, null);
        }
        if (writes.length) {
          this.event(cmd.mode === 'off'
            ? `${r.name}: airco uit`
            : `${r.name}: airco ${cmd.mode === 'heat' ? 'verwarmen' : 'koelen'} op ${cmd.setpoint}°C (kamer ${r.temp}°C)`);
          this.memory.lastWrite[r.id] = nowMs;
        }
        const newMode = cmd.mode === 'off' ? null : cmd.mode;
        if (newMode !== (this.memory.aircoOn[r.id] || null)) this.memory.aircoSince[r.id] = nowMs;
        this.memory.aircoOn[r.id] = newMode;
      }

      this.lastStatus = {
        t: nowMs,
        decision,
        thermostat: nestAcc ? readThermostat(nestAcc) : thermostat,
        rooms: rooms.map((r) => ({
          id: r.id,
          name: r.name,
          temp: r.temp,
          source: r.source,
          airco: r.aircoAcc ? readAirco(r.aircoAcc) : r.airco,
          managed: this.memory.aircoOn[r.id] || null,
          overrideUntil: this.memory.overrides[r.id] || null,
          rate: this.memory.rates[r.id] ?? null,
        })),
      };
      this.lastError = null;

      this.storage.appendHistory({
        t: nowMs,
        mode: decision.mode,
        target: decision.target,
        nest: { temp: thermostat.temp, target: thermostat.target, heating: thermostat.heating },
        rooms: Object.fromEntries(rooms.map((r) => [r.id, {
          temp: r.temp,
          airco: this.memory.aircoOn[r.id] || (r.airco.mode !== 'off' ? r.airco.mode : null),
        }])),
      }, now);
      this.persist();
    } catch (err) {
      this.lastError = { t: nowMs, message: err.message };
      this.log.error?.(`[klimaat] ${err.message}`);
    }
  }

  // Heeft iemand een airco die wij aanstuurden met de hand uitgezet of omgezet?
  // Dan krijgt die kamer een pauze, zodat de app niet gaat "vechten".
  detectManualChanges(rooms, nowMs) {
    for (const r of rooms) {
      const ours = this.memory.aircoOn[r.id];
      if (!ours || !r.airco.available) continue;
      const recent = nowMs - (this.memory.lastWrite[r.id] || 0) < 2 * 60000;
      if (!recent && r.airco.mode !== ours) {
        this.memory.aircoOn[r.id] = null;
        this.memory.overrides[r.id] = nowMs + MANUAL_OVERRIDE_MINUTES * 60000;
        this.event(`${r.name}: airco met de hand aangepast, automaat pauzeert ${MANUAL_OVERRIDE_MINUTES / 60} uur`);
      }
    }
  }

  async write(acc, type, value, message) {
    await this.client.setCharacteristic(acc.uniqueId, type, value);
    acc.values = { ...(acc.values || {}), [type]: value };
    if (message) this.event(message);
  }

  // ---- Bediening vanuit de web-app ----

  updateSettings(patch) {
    const next = { ...this.settings };
    if (patch.schedule !== undefined) next.schedule = validateSchedule(patch.schedule);
    if (patch.strategy !== undefined) {
      if (!STRATEGIES[patch.strategy]) throw new Error('Onbekende strategie');
      next.strategy = patch.strategy;
    }
    if (patch.setbackTemperature !== undefined) {
      const t = Number(patch.setbackTemperature);
      if (!(t >= 5 && t <= 25)) throw new Error('Nachttemperatuur moet tussen 5 en 25 liggen');
      next.setbackTemperature = t;
    }
    if (patch.cooling !== undefined) {
      next.cooling = {
        enabled: Boolean(patch.cooling.enabled),
        margin: Number(patch.cooling.margin ?? next.cooling.margin) || 1.5,
      };
    }
    this.settings = next;
    this.persist();
    this.event('Instellingen aangepast');
  }

  setOverride(roomId, minutes) {
    const ids = roomId === 'all' ? (this.config.rooms || []).map((r) => r.id) : [roomId];
    const nowMs = this.clock().getTime();
    for (const id of ids) {
      if (!(this.config.rooms || []).some((r) => r.id === id)) throw new Error('Onbekende kamer');
      if (minutes > 0) this.memory.overrides[id] = nowMs + minutes * 60000;
      else delete this.memory.overrides[id];
    }
    this.persist();
  }

  setAway(away) {
    this.memory.away = Boolean(away);
    this.persist();
    this.event(away ? 'Afwezig-stand aan' : 'Afwezig-stand uit');
  }

  status() {
    return {
      ...(this.lastStatus || {}),
      error: this.lastError,
      settings: this.settings,
      strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v.label])),
      away: this.memory.away,
      events: this.events,
      timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverTime: this.clock().getTime(),
    };
  }
}
