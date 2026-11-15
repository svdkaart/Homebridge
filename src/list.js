#!/usr/bin/env node
// Toont alle apparaten uit Homebridge met hun precieze naam.
// Gebruik: npm run apparaten

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomebridgeClient } from './homebridge.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const client = new HomebridgeClient(config.homebridge || {});

const USEFUL = {
  Thermostat: 'thermostaat (Nest of airco)',
  HeaterCooler: 'airco',
  TemperatureSensor: 'temperatuursensor',
};

try {
  const list = await client.getAccessories();
  const rows = list.filter((a) => USEFUL[a.type]);
  if (!rows.length) {
    console.log('Geen thermostaten, airco\'s of sensoren gevonden.');
  }
  for (const a of rows) {
    const t = a.values?.CurrentTemperature;
    console.log(`${USEFUL[a.type].padEnd(28)} "${a.serviceName}"${typeof t === 'number' ? `  (${t}°C)` : ''}`);
  }
  console.log('\nZet de naam tussen aanhalingstekens precies zo in config.json.');
} catch (err) {
  console.error(`Fout: ${err.message}`);
  process.exit(1);
}
