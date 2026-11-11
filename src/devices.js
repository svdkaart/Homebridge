// Zoekt de juiste accessoires in de Homebridge-lijst en vertaalt opdrachten
// ("airco verwarmen op 21.5") naar losse HomeKit-characteristics.

const norm = (s) => String(s || '').trim().toLowerCase();

function names(acc) {
  return [acc.serviceName, acc.accessoryInformation?.Name, acc.displayName].filter(Boolean).map(norm);
}

export function findService(accessories, name, types) {
  if (!name) return null;
  const n = norm(name);
  const byType = accessories.filter((a) => types.includes(a.type));
  return (
    byType.find((a) => names(a).includes(n)) ||
    byType.find((a) => names(a).some((x) => x.includes(n))) ||
    null
  );
}

export const THERMOSTAT_TYPES = ['Thermostat'];
export const AIRCO_TYPES = ['HeaterCooler', 'Thermostat'];
export const SENSOR_TYPES = ['TemperatureSensor', 'Thermostat', 'HeaterCooler'];

function charMeta(acc, type) {
  return (acc.serviceCharacteristics || []).find((c) => c.type === type) || null;
}

function hasChar(acc, type) {
  return Boolean(charMeta(acc, type)) || (acc.values && type in acc.values);
}

function clampValue(acc, type, value) {
  const meta = charMeta(acc, type);
  let v = value;
  if (meta) {
    if (typeof meta.minValue === 'number') v = Math.max(meta.minValue, v);
    if (typeof meta.maxValue === 'number') v = Math.min(meta.maxValue, v);
    if (typeof meta.minStep === 'number' && meta.minStep > 0) {
      v = Math.round(v / meta.minStep) * meta.minStep;
      v = Math.round(v * 100) / 100;
    }
  }
  return v;
}

export function readTemp(acc) {
  const t = acc?.values?.CurrentTemperature;
  return typeof t === 'number' ? Math.round(t * 10) / 10 : null;
}

export function readThermostat(acc) {
  if (!acc) return { available: false };
  const v = acc.values || {};
  return {
    available: true,
    name: acc.serviceName,
    temp: readTemp(acc),
    target: v.TargetTemperature ?? null,
    mode: v.TargetHeatingCoolingState ?? null, // 0 uit, 1 verwarmen, 2 koelen, 3 auto
    heating: v.CurrentHeatingCoolingState === 1,
    humidity: v.CurrentRelativeHumidity ?? null,
  };
}

export function readAirco(acc) {
  if (!acc) return { available: false };
  const v = acc.values || {};
  if (acc.type === 'HeaterCooler') {
    const active = v.Active === 1;
    const m = v.TargetHeaterCoolerState; // 0 auto, 1 verwarmen, 2 koelen
    return {
      available: true,
      name: acc.serviceName,
      temp: readTemp(acc),
      mode: !active ? 'off' : m === 1 ? 'heat' : m === 2 ? 'cool' : 'auto',
      setpoint: m === 2 ? v.CoolingThresholdTemperature ?? null : v.HeatingThresholdTemperature ?? null,
      working: v.CurrentHeaterCoolerState === 2 ? 'heating' : v.CurrentHeaterCoolerState === 3 ? 'cooling' : 'idle',
    };
  }
  const m = v.TargetHeatingCoolingState;
  return {
    available: true,
    name: acc.serviceName,
    temp: readTemp(acc),
    mode: m === 1 ? 'heat' : m === 2 ? 'cool' : m === 3 ? 'auto' : 'off',
    setpoint: v.TargetTemperature ?? null,
    working: v.CurrentHeatingCoolingState === 1 ? 'heating' : v.CurrentHeatingCoolingState === 2 ? 'cooling' : 'idle',
  };
}

// Bepaalt welke characteristics geschreven moeten worden. Alleen wat afwijkt.
export function aircoWrites(acc, cmd) {
  const v = acc.values || {};
  const writes = [];
  const set = (type, value, isTemp = false) => {
    if (!hasChar(acc, type)) return;
    const val = isTemp ? clampValue(acc, type, value) : value;
    const cur = v[type];
    const same = isTemp ? typeof cur === 'number' && Math.abs(cur - val) < 0.05 : cur === val;
    if (!same) writes.push([type, val]);
  };

  if (acc.type === 'HeaterCooler') {
    if (cmd.mode === 'off') {
      set('Active', 0);
    } else {
      set('Active', 1);
      set('TargetHeaterCoolerState', cmd.mode === 'heat' ? 1 : 2);
      set(cmd.mode === 'heat' ? 'HeatingThresholdTemperature' : 'CoolingThresholdTemperature', cmd.setpoint, true);
    }
  } else {
    if (cmd.mode === 'off') {
      set('TargetHeatingCoolingState', 0);
    } else {
      set('TargetHeatingCoolingState', cmd.mode === 'heat' ? 1 : 2);
      set('TargetTemperature', cmd.setpoint, true);
    }
  }
  return writes;
}

export function thermostatWrites(acc, cmd) {
  const v = acc.values || {};
  const val = clampValue(acc, 'TargetTemperature', cmd.target);
  if (typeof v.TargetTemperature === 'number' && Math.abs(v.TargetTemperature - val) < 0.05) return [];
  return [['TargetTemperature', val]];
}
