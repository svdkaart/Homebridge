# Klimaat thuis (Homebridge)

Web-app die draait op je Raspberry Pi naast Homebridge. Hij regelt je Nest (cv op gas) en je airco's samen op een schema.

Voorbeeld: elke dag van 17:00 tot 20:00 is het 20,5°C in elke kamer. De Nest doet de basis, de airco's springen bij in kamers die achterblijven.

## Wat de app doet

- Leest elke minuut de temperatuur per kamer uit Homebridge.
- Zet de Nest op de doeltemperatuur tijdens het schema, en op de nachtstand daarbuiten.
- Zet per kamer de airco op verwarmen als die kamer achterblijft. Is de kamer op temperatuur, dan gaat de airco weer uit.
- Begint op tijd met voorverwarmen, zodat het om 17:00 al warm is. De app leert per kamer hoe snel die opwarmt en past de starttijd daarop aan.
- Laat een airco minimaal 15 minuten in dezelfde stand, zodat de compressor niet steeds aan en uit gaat.
- Zet alleen airco's uit die de app zelf heeft aangezet. Zet je een airco met de hand aan, dan blijft die aan.
- Pas je een airco met de hand aan terwijl de app hem regelt, dan pauzeert de app die kamer 3 uur.
- Slaat alle metingen op en toont ze in een grafiek (6 uur, 24 uur, 7 dagen).
- Koelen in de zomer kan ook. Zet dat aan in de instellingen.

## Strategieën

| Strategie | Nest | Airco gaat aan bij |
|---|---|---|
| Cv eerst | doel | 1,0°C te koud |
| Hybride (standaard) | doel | 0,5°C te koud |
| Airco eerst | doel min 1°C, als achtervang | 0,2°C te koud |
| Alleen airco | blijft op nachtstand | 0,2°C te koud |

Een airco (warmtepomp) is bij milde buitentemperaturen vaak goedkoper dan gas. Kies dan "Airco eerst". Bij vorst is "Hybride" of "Cv eerst" meestal beter.

## Wat je nodig hebt

- Raspberry Pi met Homebridge en de Homebridge UI (homebridge-config-ui-x).
- Je Nest en airco's zichtbaar in Homebridge. De airco's als HeaterCooler of Thermostat, zoals de meeste airco-plugins doen.
- Node.js 18 of nieuwer. Homebridge gebruikt dit al, dus het staat op je Pi.

## Installatie op de Raspberry Pi

1. Zet in de Homebridge UI "insecure mode" aan. Zonder dit kan de app je apparaten niet aansturen.
   - Homebridge UI, Instellingen (tandwiel), Homebridge Settings, "Homebridge Insecure Mode" aan.
   - Herstart Homebridge.

2. Zet de app op de Pi:

   ```bash
   cd /home/pi
   git clone -b claude/serene-clarke-jehv0j https://github.com/svdkaart/Homebridge.git klimaat
   cd klimaat
   cp config.example.json config.json
   nano config.json
   ```

3. Vul in `config.json` in:
   - `homebridge.url`: het adres van je Homebridge UI, bijvoorbeeld `http://localhost:8581` als de app op dezelfde Pi draait.
   - `homebridge.username` en `password`: je inlog van de Homebridge UI.
   - `thermostat.name`: de naam van je Nest zoals die in Homebridge staat.
   - `rooms`: per verdieping de naam van de airco zoals in Homebridge. Hoofdletters maken niet uit.
   - Heb je een losse temperatuursensor in een kamer, zet de naam dan bij `sensor`. Die meet beter dan de airco, want een airco meet bij het plafond.
   - Hangt de Nest in een kamer, zet bij die kamer `"useThermostatSensor": true`.
   - `webPassword`: optioneel wachtwoord voor het dashboard.

4. Test de app:

   ```bash
   npm start
   ```

   Open `http://<ip-van-je-pi>:3000` op je telefoon. Zie je bij een kamer "Airco niet gevonden", controleer dan de naam in `config.json`.

5. Laat de app automatisch starten:

   ```bash
   sudo cp deploy/klimaat.service /etc/systemd/system/
   sudo sed -i "s#/usr/bin/node#$(which node)#" /etc/systemd/system/klimaat.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now klimaat
   journalctl -u klimaat -f
   ```

   Gebruik je een andere gebruiker dan `pi`, pas dan `User` en de paden in het service-bestand aan.

6. Op je iPhone: open de pagina in Safari, tik op Delen, "Zet op beginscherm". Dan staat hij als app op je telefoon.

## Uitproberen zonder Pi

```bash
npm run demo
```

Open `http://localhost:3000`. Je ziet een gesimuleerd huis met een Nest en vier airco's. De tijd loopt 60 keer sneller en start om 15:30, zodat je het voorverwarmen en de periode van 17:00 tot 20:00 ziet.

## Tests

```bash
npm test
```

## Instellingen in config.json

Onder `settings.tuning` kun je fijnregelen:

- `aircoOffset` (1,0): hoeveel graden hoger de airco wordt gezet dan het doel. Een airco meet aan het plafond en schakelt anders te vroeg af.
- `maxPreheatMinutes` (120): nooit eerder dan dit beginnen met opwarmen.
- `defaultRate` (1,5): aangenomen opwarmsnelheid in °C per uur, tot de app hem heeft geleerd.
- `minCycleMinutes` (15): minimale tijd dat een airco aan of uit blijft.

Het schema, de strategie en de nachttemperatuur pas je aan in het dashboard. Die worden bewaard in `data/state.json`.

## Goed om te weten

- De app verandert de modus van de Nest niet. Staat de Nest uit (zomer), dan laat de app hem met rust.
- Staat je Nest in Eco-stand, dan weigert Google een nieuwe doeltemperatuur. Je ziet dat als foutmelding in het dashboard.
- Metingen worden 90 dagen bewaard in de map `data`.
- De app praat alleen met je eigen Homebridge in je eigen netwerk. Er gaat niets naar internet.

## Mappen

```
src/controller.js  regel-logica (wanneer moet wat aan)
src/schedule.js    schema
src/service.js     regelkring: ophalen, beslissen, aansturen, opslaan
src/devices.js     vertaling naar HomeKit-characteristics
src/homebridge.js  koppeling met de Homebridge UI API
src/demo.js        gesimuleerd huis voor de demo
src/server.js      webserver en API
public/            dashboard
test/              tests
```
