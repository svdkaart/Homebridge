#!/usr/bin/env node
// Test de koppeling met Frank Energie: npm run prijzen

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFrankPrices, priceAt, compareHeatCost, DEFAULT_PRICE_CONFIG } from './prices.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).prices || {};
} catch {
  // geen config, standaardwaarden gebruiken
}

const now = new Date();
try {
  const data = await fetchFrankPrices(now);
  const e = priceAt(data.electricity, now.getTime());
  const g = priceAt(data.gas, now.getTime());
  console.log(`Stroomprijzen ontvangen: ${data.electricity.length}, gasprijzen: ${data.gas.length}`);
  console.log(`Stroom nu: ${e == null ? 'onbekend' : `${(e * 100).toFixed(1)} ct/kWh`}`);
  console.log(`Gas nu:    ${g == null ? 'onbekend' : `€ ${g.toFixed(3)}/m3`}`);
  for (const t of [10, 5, 0, -5]) {
    const c = compareHeatCost({ electricity: e, gas: g, outdoor: t, cfg: { ...DEFAULT_PRICE_CONFIG, ...cfg } });
    if (c) console.log(`Bij ${String(t).padStart(3)}°C buiten: airco ${(c.aircoHeat * 100).toFixed(1)} ct, cv ${(c.gasHeat * 100).toFixed(1)} ct per kWh warmte, goedkoopst: ${c.choice}`);
  }
} catch (err) {
  console.error(`Fout bij Frank Energie: ${err.message}`);
  process.exit(1);
}
