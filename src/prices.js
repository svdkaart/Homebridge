// Energieprijzen van Frank Energie (dynamisch contract) en de afweging:
// is warmte uit de airco (stroom / COP) goedkoper dan warmte uit de cv (gas / rendement)?

const FRANK_URL = 'https://graphql.frankenergie.nl';

const FIELDS = 'from till marketPrice marketPriceTax sourcingMarkupPrice energyTaxPrice';

export const DEFAULT_PRICE_CONFIG = {
  provider: 'frank',
  gasKwhPerM3: 9.77,       // energie-inhoud van 1 m3 aardgas (bovenwaarde)
  boilerEfficiency: 0.9,   // rendement van een HR-ketel
  copAt7: 4.0,             // rendement airco bij 7°C buiten
  copAtMinus7: 2.5,        // rendement airco bij -7°C buiten
  copDefault: 3.5,         // als er geen buitentemperatuur is
  switchMargin: 0.05,      // 5% verschil nodig om van bron te wisselen
  fallback: { electricity: 0.25, gas: 1.3 }, // €/kWh en €/m3 als de API niet werkt
};

function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function total(p) {
  return (p.marketPrice || 0) + (p.marketPriceTax || 0) + (p.sourcingMarkupPrice || 0) + (p.energyTaxPrice || 0);
}

function normalize(list) {
  return (list || []).map((p) => ({
    from: new Date(p.from).getTime(),
    till: new Date(p.till).getTime(),
    price: Math.round(total(p) * 10000) / 10000,
  })).filter((p) => Number.isFinite(p.from) && Number.isFinite(p.till));
}

async function gql(query, variables) {
  const res = await fetch(FRANK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Frank Energie gaf ${res.status}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(`Frank Energie: ${data.errors[0].message}`);
  return data.data;
}

// Haalt prijzen op voor vandaag en morgen. Probeert twee vormen van de API.
export async function fetchFrankPrices(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 2);
  const variables = { startDate: dateStr(start), endDate: dateStr(end) };
  try {
    const d = await gql(
      `query MarketPrices($startDate: Date!, $endDate: Date!) {
        marketPricesElectricity(startDate: $startDate, endDate: $endDate) { ${FIELDS} }
        marketPricesGas(startDate: $startDate, endDate: $endDate) { ${FIELDS} }
      }`, variables);
    return { electricity: normalize(d.marketPricesElectricity), gas: normalize(d.marketPricesGas) };
  } catch (first) {
    const d = await gql(
      `query MarketPrices($startDate: Date!, $endDate: Date!) {
        marketPrices(startDate: $startDate, endDate: $endDate) {
          electricityPrices { ${FIELDS} }
          gasPrices { ${FIELDS} }
        }
      }`, variables).catch(() => { throw first; });
    return { electricity: normalize(d.marketPrices?.electricityPrices), gas: normalize(d.marketPrices?.gasPrices) };
  }
}

export function priceAt(list, ms) {
  const hit = (list || []).find((p) => p.from <= ms && ms < p.till);
  return hit ? hit.price : null;
}

export function copFor(outdoor, cfg) {
  if (outdoor == null) return cfg.copDefault;
  const slope = (cfg.copAt7 - cfg.copAtMinus7) / 14;
  const cop = cfg.copAt7 + (outdoor - 7) * slope;
  return Math.round(Math.min(5.5, Math.max(1.5, cop)) * 100) / 100;
}

/**
 * Vergelijkt de prijs van 1 kWh warmte uit gas en uit de airco.
 * previous: de vorige keuze ('airco' of 'gas'), voor een kleine marge tegen heen-en-weer schakelen.
 */
export function compareHeatCost({ electricity, gas, outdoor, cfg, previous }) {
  const c = { ...DEFAULT_PRICE_CONFIG, ...(cfg || {}) };
  if (electricity == null || gas == null) return null;
  const cop = copFor(outdoor, c);
  const gasHeat = gas / (c.gasKwhPerM3 * c.boilerEfficiency);
  const aircoHeat = electricity / cop;
  let choice;
  if (previous === 'airco') choice = aircoHeat <= gasHeat * (1 + c.switchMargin) ? 'airco' : 'gas';
  else if (previous === 'gas') choice = aircoHeat < gasHeat * (1 - c.switchMargin) ? 'airco' : 'gas';
  else choice = aircoHeat < gasHeat ? 'airco' : 'gas';
  const r4 = (x) => Math.round(x * 10000) / 10000;
  return { electricity, gas, outdoor, cop, gasHeat: r4(gasHeat), aircoHeat: r4(aircoHeat), choice };
}

// Houdt de prijzen bij en ververst ze elk uur.
export class PriceService {
  constructor(cfg, log = console) {
    this.cfg = { ...DEFAULT_PRICE_CONFIG, ...(cfg || {}), fallback: { ...DEFAULT_PRICE_CONFIG.fallback, ...(cfg?.fallback || {}) } };
    this.log = log;
    this.data = null;
    this.fetchedAt = 0;
    this.error = null;
  }

  async refresh(now, force = false) {
    const ms = now.getTime();
    const stale = ms - this.fetchedAt > 3600000;
    const missing = !this.data || priceAt(this.data.electricity, ms) == null;
    if (!force && !stale && !missing) return;
    if (!force && this.error && ms - this.fetchedAt < 10 * 60000) return; // na een fout 10 min wachten
    this.fetchedAt = ms;
    try {
      this.data = await fetchFrankPrices(now);
      this.error = null;
    } catch (err) {
      this.error = err.message;
      this.log.error?.(`[prijzen] ${err.message}`);
    }
  }

  current(now) {
    const ms = now.getTime();
    const e = priceAt(this.data?.electricity, ms);
    const g = priceAt(this.data?.gas, ms);
    return {
      electricity: e ?? this.cfg.fallback.electricity,
      gas: g ?? this.cfg.fallback.gas,
      live: e != null && g != null,
      error: this.error,
    };
  }

  // Stroomprijzen van nu tot de komende 24 uur, voor de grafiek in de app.
  upcoming(now) {
    const ms = now.getTime();
    return (this.data?.electricity || []).filter((p) => p.till > ms && p.from < ms + 24 * 3600000);
  }
}
