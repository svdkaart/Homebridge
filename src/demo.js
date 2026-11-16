import { PriceService } from './prices.js';

// Nep-Homebridge met een simpele warmte-simulatie. Zo kun je de app
// uitproberen zonder Raspberry Pi: npm run demo

let seq = 0;
const uid = () => `demo-${++seq}`;

function characteristic(type, value, extra = {}) {
  return { type, value, canWrite: true, ...extra };
}

function makeHeaterCooler(name, temp) {
  return {
    uniqueId: uid(),
    type: 'HeaterCooler',
    serviceName: name,
    accessoryInformation: { Name: name, Manufacturer: 'Demo' },
    serviceCharacteristics: [
      characteristic('Active', 0),
      characteristic('TargetHeaterCoolerState', 1),
      characteristic('CurrentHeaterCoolerState', 0),
      characteristic('CurrentTemperature', temp),
      characteristic('HeatingThresholdTemperature', 21, { minValue: 16, maxValue: 30, minStep: 0.5 }),
      characteristic('CoolingThresholdTemperature', 24, { minValue: 16, maxValue: 30, minStep: 0.5 }),
    ],
    values: {
      Active: 0, TargetHeaterCoolerState: 1, CurrentHeaterCoolerState: 0, CurrentTemperature: temp,
      HeatingThresholdTemperature: 21, CoolingThresholdTemperature: 24,
    },
  };
}

function makeNest(name, temp) {
  return {
    uniqueId: uid(),
    type: 'Thermostat',
    serviceName: name,
    accessoryInformation: { Name: name, Manufacturer: 'Demo' },
    serviceCharacteristics: [
      characteristic('TargetHeatingCoolingState', 1),
      characteristic('CurrentHeatingCoolingState', 0),
      characteristic('CurrentTemperature', temp),
      characteristic('TargetTemperature', 16, { minValue: 9, maxValue: 32, minStep: 0.5 }),
    ],
    values: { TargetHeatingCoolingState: 1, CurrentHeatingCoolingState: 0, CurrentTemperature: temp, TargetTemperature: 16 },
  };
}

// Nepprijzen: stroom duur in de avondpiek, goedkoop 's nachts en midden op de dag.
export class DemoPrices extends PriceService {
  constructor(cfg, clock) {
    super(cfg);
    this.clock = clock;
  }

  async refresh(now) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const electricity = [];
    for (let h = 0; h < 48; h++) {
      const from = start.getTime() + h * 3600000;
      const hour = h % 24;
      const price = 0.22 + (hour >= 17 && hour < 21 ? 0.12 : 0) - (hour >= 11 && hour < 15 ? 0.08 : 0) - (hour < 6 ? 0.05 : 0);
      electricity.push({ from, till: from + 3600000, price: Math.round(price * 10000) / 10000 });
    }
    const gas = [{ from: start.getTime(), till: start.getTime() + 48 * 3600000, price: 1.32 }];
    this.data = { electricity, gas };
  }
}

export class DemoHomebridge {
  constructor(config, clock) {
    this.clock = clock;
    this.outdoor = 7;
    this.nest = makeNest(config.thermostat?.name || 'Nest', 17);
    // Per verdieping: verlies naar buiten en hoeveel cv-warmte er aankomt.
    const profiles = [
      { loss: 0.10, cv: 0.6 },
      { loss: 0.14, cv: 1.6 },
      { loss: 0.16, cv: 1.1 },
      { loss: 0.22, cv: 0.7 },
    ];
    this.rooms = (config.rooms || []).map((r, i) => ({
      cfg: r,
      temp: 16.5 + i * 0.3,
      ...profiles[i % profiles.length],
      acc: makeHeaterCooler(r.airco, 16.5 + i * 0.3),
    }));
    this.outdoorAcc = {
      uniqueId: uid(),
      type: 'TemperatureSensor',
      serviceName: config.outdoorSensor || 'Buitentemperatuur',
      serviceCharacteristics: [characteristic('CurrentTemperature', this.outdoor)],
      values: { CurrentTemperature: this.outdoor },
    };
    this.lastT = clock().getTime();
  }

  step() {
    const now = this.clock().getTime();
    const hours = Math.min(1, (now - this.lastT) / 3600000);
    this.lastT = now;
    if (hours <= 0) return;

    const nestRoom = this.rooms.find((r) => r.cfg.useThermostatSensor) || this.rooms[1] || this.rooms[0];
    const nv = this.nest.values;
    const burning = nv.TargetHeatingCoolingState !== 0 && nestRoom && nestRoom.temp < nv.TargetTemperature - 0.1;
    nv.CurrentHeatingCoolingState = burning ? 1 : 0;

    for (const r of this.rooms) {
      const v = r.acc.values;
      let airco = 0;
      if (v.Active === 1) {
        if (v.TargetHeaterCoolerState === 1 && v.CurrentTemperature < v.HeatingThresholdTemperature) airco = 2.2;
        if (v.TargetHeaterCoolerState === 2 && v.CurrentTemperature > v.CoolingThresholdTemperature) airco = -2.0;
      }
      v.CurrentHeaterCoolerState = v.Active !== 1 ? 0 : airco > 0 ? 2 : airco < 0 ? 3 : 1;
      r.temp += hours * ((this.outdoor - r.temp) * r.loss + (burning ? r.cv * 1.6 : 0) + airco);
      // Airco meet bij het plafond, dus iets warmer als hij stookt.
      v.CurrentTemperature = Math.round((r.temp + (airco > 0 ? 0.6 : 0.2)) * 10) / 10;
    }
    if (nestRoom) nv.CurrentTemperature = Math.round(nestRoom.temp * 10) / 10;
  }

  async getAccessories() {
    this.step();
    const all = [this.nest, ...this.rooms.map((r) => r.acc), this.outdoorAcc];
    return structuredClone(all);
  }

  async setCharacteristic(uniqueId, type, value) {
    const acc = [this.nest, ...this.rooms.map((r) => r.acc)].find((a) => a.uniqueId === uniqueId);
    if (!acc) throw new Error('Onbekend accessoire');
    acc.values[type] = value;
  }
}
