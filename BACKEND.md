# Cloudflare Worker und D1

GitHub Pages bleibt das Frontend. Firebase Authentication stellt anonyme Spieler-Identitäten bereit; der Cloudflare Worker prüft die ID-Tokens bei Google und speichert Spielräume in einer D1-Datenbank mit EU-Jurisdiktion. **Im Worker-Modus ist D1 die maßgebliche Raumdatenbank, nicht Firebase Realtime Database.** Bestehende Firebase-Lobbys werden nicht migriert.

Der Worker ist unter `https://real-life-hide-and-seek-api.knekkonn-hide-and-seek.workers.dev` veröffentlicht. Das Schema ist angewendet; eine stündliche Bereinigung entfernt abgelaufene Räume und Rate-Limit-Einträge. Der Worker braucht keinen Firebase-Service-Account oder privaten Schlüssel. `js/config.js` zeigt auf den Worker; `worker/wrangler.toml` enthält die D1-Bindung.

## Wartung und erneute Bereitstellung

1. Node.js 24 LTS installieren. Für die Emulatorprüfung zusätzlich ein zur aktuellen Firebase CLI passendes Java installieren. In Terminal prüfen:

   ```bash
   node --version
   npm --version
   java --version
   ```

2. Repository laden und Tests ausführen:

   ```bash
   npm test
   ```

3. Mit dem bestehenden Cloudflare-Konto anmelden. Es ist kein zusätzliches Konto erforderlich:

   ```bash
   npx wrangler login
   npx wrangler whoami
   ```

4. Die bestehende D1-ID steht in `worker/wrangler.toml`. `ALLOWED_ORIGIN` ist exakt `https://knekkonn.github.io`, ohne Repositorypfad. Bei einem anderen Host exakt anpassen.

5. Migration und Worker bei Änderungen aktualisieren:

   ```bash
   npx wrangler d1 migrations apply hide-and-seek --remote --config worker/wrangler.toml
   npx wrangler deploy --config worker/wrangler.toml
   ```

   Der Worker-Endpunkt ist öffentlich erreichbar; Raumdaten erfordern zusätzlich einen gültigen Firebase-ID-Token und bestätigte Mitgliedschaft. CORS ersetzt diese Autorisierung nicht.

6. Wenn sich die Worker-URL ändert, `WORKER_URL` in `js/config.js` aktualisieren und den Cache-Namen in `sw.js` erhöhen.

7. Firebase-Konsole öffnen: Authentication → Sign-in method → Anonymous aktivieren. Webkonfiguration mit `js/config.js` vergleichen. API-Key-Einschränkungen müssen Tokenprüfung über Identity Toolkit vom Worker erlauben; unpassende HTTP-Referrer-Einschränkungen können die Serverprüfung blockieren. Keine Admin-Schlüssel in GitHub eintragen.

8. Firebase-Regeln zunächst im Emulator prüfen (separat von `npm test`):

   ```bash
   npx firebase-tools emulators:exec --project demo-hide-seek --only auth,database 'node --test tests/emulator-rules.mjs'
   ```

   Dieser Test wurde hier **nicht ausgeführt**, weil die Umgebung ihren Netzwerkproxy nicht erreichen kann. Er prüft die beigefügten vollständig sperrenden RTDB-Regeln, keine nicht existierenden Firebase-Spielaktionsregeln.

9. Die Oberfläche nach Veröffentlichung auf HTTPS und mit zwei echten Geräten prüfen. Ein lokaler Mac-Server allein ersetzt diesen Test nicht.

10. Wenn der Worker-Modus auf allen Clients erfolgreich läuft, **vor einer öffentlichen Nutzung** in Firebase Realtime Database → Rules den Inhalt aus `database.rules.production.json` veröffentlichen. Dadurch werden alle direkten RTDB-Clientzugriffe gesperrt. Bestehende Firebase-only-Versionen funktionieren danach nicht mehr. Die neue Worker-Version braucht diese Zugriffe nicht.

11. Nach erfolgreichem Pages-Deployment alte App-Tabs/PWA-Fenster schließen und neu öffnen. Ein wartender Service Worker ersetzt absichtlich keine laufende Runde.

## Verhalten des Workers

- Vierstellige Codes adressieren Räume, gewähren aber keinen Lesezugriff. Ein neuer Spieler stellt eine Beitrittsanfrage. Der Host bestätigt sie in der Lobby.
- D1-Änderungen verwenden Revisionen und Compare-and-Swap. Konkurrenz überschreibt keine fremden Spielzustände; nach acht Konflikten erhält der Client eine Wiederholungsaufforderung.
- Synchronisierung erfolgt mit HTTP-Abfragen alle 2,5 Sekunden. Das ist kein Firebase-`onValue` und kein WebSocket. Der ursprüngliche Firebase-Testpfad benutzt weiter `onValue`.
- Serverzeit bestimmt Phasen, Belohnungen und Fangfristen. Abgelaufene Phasen werden auch bei einem Lesezugriff anhand der ursprünglichen Fristen nachgeholt, wenn der Host gerade offline ist.
- Roh-GPS bleibt im serverseitigen Raumzustand. Antworten enthalten eigene Positionen und nur berechtigte fremde Signale: Sonar gerundet auf 0,001 Grad, Tracker während der Laufzeit, Kompass als 100-Meter-Richtungsprojektion, Seeker-Radar nur ohne Jammer. Geist-Modus unterbindet fremde Positionsfreigaben.
- GPS-Messungen älter als zehn Sekunden oder mit Genauigkeit über 50 Metern bestätigen keinen Zonenverstoß. Lücken über zehn Sekunden unterbrechen die durchgehende Beweiskette. Nach 30 Sekunden frischer, eindeutig außerhalb liegender Messungen: minus fünf Münzen, nie unter null. Bei jedem dritten bestätigten Verstoß: zusätzlich 30 Sekunden Aktionssperre. Pro ununterbrochener Überschreitung wird nur einmal gezählt. Neue präzise Innenmessung beendet diese Überschreitung.
- Ein Fang wird sofort registriert und braucht keine Bestätigung des Hiders. Der Worker verlangt aktuelle GPS-Messungen beider Spieler mit höchstens 25 m Messungenauigkeit und höchstens 5 m Abstand. Das ist ein Näherungsfilter, kein Beweis einer Berührung.
- Signal Caches werden im Worker nur auf von OSM als öffentlich zugänglich kartierten Fußwegen platziert. Gebäude, Wasserflächen, militärische Bereiche, Schutzgebiete und explizit beschränkte Wege werden ausgeschlossen. Gibt es keine passenden Kartendaten oder ist Overpass nicht erreichbar, entstehen keine Caches. OSM ist nicht überall vollständig; vor jeder Runde muss die Spielzone weiterhin sicher und öffentlich begehbar sein.
- Hider-Aufgaben brauchen eine serverseitig ausgegebene Challenge, Mindestdauer, Ablaufzeit und einmalige Einlösung. Die Chiffre kombiniert Vigenère und eine zufällige 4×3-Spaltentransposition. Zielpunkte bleiben bis zur persönlichen Zuweisung geheim; Halte-Aufgaben scheitern bei Bewegung oder veralteten GPS-Messungen.
- Fotos werden vom Client verkleinert, der Worker lehnt Bilder mit EXIF/XMP ab und liefert Bytes nur über einen authentifizierten Seeker-Endpunkt in der Livephase. Rundenende oder eine neue Runde entfernt sie; der letzte Austritt löscht alle Spieler- und Ortsdaten.
- Verlässt der Host eine aktive Runde, erhält der älteste aktive Mitspieler die Host-Rolle. Verlässt der Host die Lobby, wird der Raum geschlossen.
- Räume laufen 24 Stunden nach Erstellung ab. Eine stündliche Bereinigung entfernt abgelaufene Räume und Rate-Limit-Einträge. Es wird kein dauerhaftes Bewegungsarchiv erzeugt; jeweils nur die letzte Position gespeichert.

## Kosten, Datenschutz und Grenzen

Workers/D1 haben kostenlose Kontingente, aber keine garantierte unbegrenzte Nutzung. Requests, D1-Lese-/Schreibvorgänge, CPU und Speicher in der aktuellen Cloudflare-Konsole prüfen. Die 2,5-Sekunden-Abfragen erzeugen pro Gerät ungefähr 1.440 Requests pro Stunde; GPS-Schreibvorgänge und Spielaktionen kommen hinzu. Bei verbrauchten kostenlosen Kontingenten muss die App Fehler anzeigen, statt Synchronisierung zu behaupten. Aktuelle Tarifgrenzen konnten hier nicht online verifiziert werden.

Rate Limits gelten pro Firebase-Identität: fünf Beitrittsversuche/Minute, drei Raum-Erstellungsversuche/Stunde, 90 Aktionen/Minute. Neue anonyme Konten können solche Grenzen umgehen. Für öffentliche Nutzung sind zusätzlicher Missbrauchsschutz (z. B. Cloudflare-Regeln/Turnstile oder Firebase App Check mit serverseitiger Verifikation) und Lasttests noch nötig. Das ist kein fertig nachgewiesener Schutz gegen gezielten Ressourcenmissbrauch.

Mitspieler erhalten über die App keine IP-Adressen. Firebase, Cloudflare, Karten- und Netzwerkdienstleister sehen technisch erforderliche Verbindungsdaten. Cloudflare-/Firebase-Protokollierung und Aufbewahrung in den jeweiligen Konten prüfen. GPS-Freigabe erfolgt nur über einen bewussten Klick. Betriebssystem-GPS und Shake-Sensoren können manipuliert werden; auch ein autorisierender Server beweist keine physische Begegnung oder Bewegung.

Die sichtbare GitHub-Pages-Version erhält die neue `WORKER_URL` erst mit der Veröffentlichung des Folge-PRs. Die aktuelle App-Version bleibt bis dahin auf ihrem bisherigen Stand. Im Workers-Free-Plan gilt ein Tageslimit von 100.000 Worker-Aufrufen; bei 20 dauerhaft sichtbaren Spielgeräten und 5-Sekunden-Abfragen wären das rund 14.400 Aufrufe pro Stunde, zuzüglich Spielaktionen. Hintergrund-Tabs fragen nur alle 30 Sekunden ab. Das kostenlose Kontingent ist daher für zeitlich begrenzte Runden vorgesehen, nicht für dauerhaft offene Sitzungen.
