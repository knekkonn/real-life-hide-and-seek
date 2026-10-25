# HIDE//SEEK — Real Life Multiplayer

Eine responsive, PWA-fähige Web-App für ein GPS-basiertes Real-Life-Hide-and-Seek-Spiel. Die Oberfläche ist auf Smartphones ausgelegt und funktioniert auch auf Tablet/Desktop.

## Enthalten

- Lobby-Erstellung mit vierstelligem Raumcode und Beitritt über Codename
- Host-Einstellungen: Classic/Infiziert, Versteckzeit, Matchdauer, Spielradius, Skill-Pool und Gefangen-Meldungen
- Synchronisierte Countdown-, Rollen-Enthüllungs-, Versteck-, Live-Match- und Endphase
- Leaflet/OpenStreetMap-Karte mit Dark Tiles, Spielradius, GPS-Punkt, Signal Caches, Täusch-Markern und Fallen
- Seeker-/Hider-Arsenal, Münzen, Skill-Inventar, Aufgaben, Code-Knacken und Shake-Challenge
- Catch-Anfrage mit Bestätigung am Zielgerät, Classic-Zuschauerstatus, Infiziert-Rollenwechsel und Ingame-Banner
- Soundeffekte über Web Audio API, optionale Vibration, Reconnect-Feedback, GPS-Fehlerzustände
- PWA-Manifest und Service Worker für das App-Shell-Caching
- Lokaler Demo-Modus, der Änderungen im selben Browserprofil über `localStorage` synchronisiert (zum Testen in mehreren Tabs)

## Schnell starten

Die App benötigt einen lokalen HTTP-Server (GPS und Service Worker funktionieren nicht zuverlässig bei `file://`). Im Projektordner:

```bash
python -m http.server 8080
```

Dann im Browser `http://localhost:8080` öffnen. Mit unveränderter Konfiguration startet sie im **Demo-Modus**. Für einen schnellen Lobby-Test zwei Tabs im selben Browserprofil öffnen; eine Person erstellt die Lobby, die andere tritt mit dem Code bei. Im Demo-Modus ist das keine Synchronisierung über verschiedene Geräte oder Browserprofile hinweg.

## Firebase-Multiplayer einrichten

1. Erstelle ein Firebase-Projekt und eine Web-App.
2. Aktiviere **Authentication → Sign-in method → Anonymous**.
3. Erstelle eine **Realtime Database** und kopiere `apiKey`, `authDomain`, `databaseURL`, `projectId` und `appId` aus der Firebase-Webkonfiguration in `js/config.js`.
4. Lege die Realtime-Database-URL für genau deine Datenbank fest. Der Firebase-Modus wird automatisch aktiviert, sobald keine `YOUR_…`-Platzhalter mehr in der Konfiguration übrig sind.
5. Lade die App auf einen HTTPS-fähigen Host (z. B. Firebase Hosting). GPS und Service Worker benötigen für echte Geräte HTTPS, ausgenommen `localhost`.
6. Installiere bzw. öffne die App auf jedem Smartphone und gib den vierstelligen Raumcode ein.

Die App importiert den modularen Firebase Web SDK dynamisch von Google CDN und verwendet `onValue` sowie Transaktionen gegen die Room-Referenz in der Realtime Database.

### Datenbankregeln — nur für kontrollierte Entwicklung

`database.rules.dev.json` zeigt minimale Entwicklungsregeln, damit du den Datenfluss mit anonym angemeldeten Testern untersuchen kannst. **Diese Regeln sind absichtlich offen und dürfen nicht für öffentliche Spiele eingesetzt werden.** Ein vierstelliger Code ist kein ausreichender Zugriffsschutz.

### Wichtig vor einem öffentlichen Produktivbetrieb

Die aktuelle Anwendung ist ein funktionsreicher Client-Prototyp; die Realtime-Database-Transaktionen halten den Spielfluss zwischen Clients konsistent, ersetzen aber keine vertrauenswürdige Server-Autorisierung. Für öffentliche Spiele sind vor allem diese Punkte serverseitig umzusetzen:

- Host-/Mitgliedschaftsprüfung für Beitritt, Rollen, Einstellungen, Käufe, Catch-Bestätigung und Match-Phasen (z. B. Cloud Functions/Cloud Run).
- Private GPS-Daten getrennt von öffentlichen Spielerdaten speichern. Nicht jeder Client darf alle Rohkoordinaten lesen können. Ein Client-seitiger „Geist-Modus“ allein ist kein Datenschutzmechanismus.
- Serverseitige Zeit- und Münzberechnung sowie Schutz vor Replay-/Manipulationsversuchen.
- Rate Limits, Room-Ablauf/TTL, maximale Datenmengen und streng validierende Rules.
- Vor dem echten Einsatz die Regeln auf einem Firebase Emulator testen; keine pauschalen `.read: true`/`.write: true` Regeln deployen.

## Gameplay-Hinweise

- Der Host sollte GPS vor Spielbeginn freigeben, damit der Spielradius und Signal Caches auf einen tatsächlichen Standort gesetzt werden können.
- Signal Caches sind innerhalb von 15 m sammelbar; die Genauigkeit hängt vom Endgerät und GPS-Empfang ab.
- Fangmeldungen werden auf dem Zielgerät bestätigt. GPS-Nähe allein bedeutet keinen Fang.
- Die Shake-Challenge nutzt Bewegungsdaten, sofern das Gerät sie bereitstellt. Auf Desktop ist eine Demo-Simulation verfügbar.
- Der Radar-Jammer blendet die Seeker-Radaransicht der Hider visuell aus; echtes sicheres Zurückhalten von Positionsdaten benötigt die oben beschriebene serverseitige Datenaufteilung.

## Projektstruktur

```text
real-life-hide-seek/
├── index.html
├── styles.css
├── manifest.webmanifest
├── sw.js
├── database.rules.dev.json
├── assets/icon.svg
└── js/
    ├── config.js         # Firebase- und Spielgrenzen-Konfiguration
    ├── backend.js        # Firebase RTDB + lokaler Demo-Adapter
    ├── skills.js         # Skill-Definitionen und Default-Settings
    ├── utils.js          # Zeit, GPS-Mathematik, Audio und Haptik
    ├── map.js            # Leaflet-Karte, Radius und Marker
    ├── game-service.js   # Spielphasen und transaktionale Aktionen
    └── main.js           # UI, Rendering und Event-Handling
```

## Externe Abhängigkeiten

- Firebase JavaScript SDK 13.1.0 (dynamischer CDN-Import)
- Leaflet 1.9.4
- OpenStreetMap-Daten und CARTO Dark Tiles
- Google Fonts (Inter, Barlow Condensed, DM Mono)

Für Offline-Installationen wird das lokale App-Shell gecacht. Firebase-Synchronisierung, Kartentiles, externe Bibliotheken und Google Fonts brauchen weiterhin eine Netzwerkverbindung.
