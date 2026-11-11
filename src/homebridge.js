// Client voor de REST API van de Homebridge UI (homebridge-config-ui-x).
// Let op: accessoires aansturen werkt alleen als Homebridge in "insecure mode"
// draait (Homebridge UI > Instellingen > Homebridge Insecure Mode aan).

export class HomebridgeClient {
  constructor({ url, username, password, otp }) {
    if (!url) throw new Error('homebridge.url ontbreekt in config.json');
    this.url = url.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.otp = otp;
    this.token = null;
  }

  async login() {
    let res;
    if (this.username) {
      res = await fetch(`${this.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password, otp: this.otp || undefined }),
      });
    } else {
      // Homebridge UI zonder authenticatie
      res = await fetch(`${this.url}/api/auth/noauth`, { method: 'POST' });
    }
    if (!res.ok) {
      throw new Error(`Inloggen bij Homebridge mislukt (${res.status}). Controleer url, gebruikersnaam en wachtwoord.`);
    }
    const data = await res.json();
    this.token = data.access_token;
  }

  async request(method, path, body, retry = true) {
    if (!this.token) await this.login();
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.request(method, path, body, false);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 400 && /insecure/i.test(text)) {
        throw new Error('Homebridge draait niet in insecure mode. Zet die aan in de Homebridge UI.');
      }
      throw new Error(`Homebridge ${method} ${path} gaf ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  getAccessories() {
    return this.request('GET', '/api/accessories');
  }

  setCharacteristic(uniqueId, characteristicType, value) {
    return this.request('PUT', `/api/accessories/${encodeURIComponent(uniqueId)}`, { characteristicType, value });
  }
}
