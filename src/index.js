#!/usr/bin/env node
// Start de klimaat-app.
//   node src/index.js                 gebruikt config.json en echte Homebridge
//   node src/index.js --demo          gebruikt een gesimuleerd huis
//   node src/index.js --demo --speed 60   simulatie 60x sneller dan echt

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomebridgeClient } from './homebridge.js';
import { DemoHomebridge, DemoPrices } from './demo.js';
import { ClimateService } from './service.js';
import { Storage } from './storage.js';
import { createServer } from './server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const demo = flag('--demo');
const configPath = path.resolve(option('--config', path.join(ROOT, demo && !fs.existsSync(path.join(ROOT, 'config.json')) ? 'config.example.json' : 'config.json')));

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Kan ${configPath} niet lezen: ${err.message}`);
  console.error('Kopieer config.example.json naar config.json en vul je gegevens in.');
  process.exit(1);
}

if (config.timezone && !process.env.TZ) process.env.TZ = config.timezone;

let clock = () => new Date();
const speed = demo ? Math.max(1, Number(option('--speed', 1))) : 1;
if (speed > 1) {
  // Start de demo om 15:30 zodat je het voorverwarmen en de 17:00-periode ziet.
  const start = new Date();
  start.setHours(15, 30, 0, 0);
  const real0 = Date.now();
  clock = () => new Date(start.getTime() + (Date.now() - real0) * speed);
}

const dataDir = path.resolve(option('--data', path.join(ROOT, demo ? 'data-demo' : 'data')));
if (demo) fs.rmSync(dataDir, { recursive: true, force: true });
const storage = new Storage(dataDir);
const client = demo ? new DemoHomebridge(config, clock) : new HomebridgeClient(config.homebridge || {});
const prices = demo ? new DemoPrices(config.prices, clock) : undefined;
const service = new ClimateService({ config, client, storage, clock, prices });

const pollMs = Math.max(2000, ((config.pollSeconds || 60) * 1000) / speed);
const port = Number(option('--port', config.port || 3000));

createServer({ service, storage, password: config.webPassword }).listen(port, () => {
  console.log(`Klimaat-app draait op http://localhost:${port}${demo ? ' (demo)' : ''}`);
});

await service.tick();
setInterval(() => service.tick(), pollMs);
setInterval(() => storage.cleanup(clock()), 6 * 3600000);
