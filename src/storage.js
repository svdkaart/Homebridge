// Opslag op schijf: state.json (instellingen en geheugen) en
// history-JJJJ-MM-DD.jsonl (één regel per meting).

import fs from 'node:fs';
import path from 'node:path';

export class Storage {
  constructor(dir, keepDays = 90) {
    this.dir = dir;
    this.keepDays = keepDays;
    fs.mkdirSync(dir, { recursive: true });
  }

  get statePath() {
    return path.join(this.dir, 'state.json');
  }

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return null;
    }
  }

  saveState(state) {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  dayFile(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return path.join(this.dir, `history-${y}-${m}-${day}.jsonl`);
  }

  appendHistory(record, now) {
    fs.appendFileSync(this.dayFile(now), JSON.stringify(record) + '\n');
  }

  readHistory(fromMs, toMs, now) {
    const out = [];
    const start = new Date(fromMs);
    start.setHours(0, 0, 0, 0);
    for (let d = new Date(start); d.getTime() <= toMs; d.setDate(d.getDate() + 1)) {
      let text;
      try {
        text = fs.readFileSync(this.dayFile(d), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.t >= fromMs && rec.t <= toMs) out.push(rec);
        } catch {
          // kapotte regel overslaan
        }
      }
    }
    return out;
  }

  cleanup(now) {
    const limit = now.getTime() - this.keepDays * 86400000;
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^history-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (t < limit) fs.unlinkSync(path.join(this.dir, f));
    }
  }
}
