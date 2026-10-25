# Kostenlosen Zusatzdienst einrichten (Entwurf, noch nicht produktiv geprüft)

GitHub Pages bleibt das Frontend. Firebase Authentication bleibt für anonyme, lokal persistierte Identitäten erhalten. Der optionale Cloudflare Worker prüft ID-Tokens bei Google und speichert Spielräume in D1. **Im Worker-Modus ist D1 die maßgebliche Raumdatenbank, nicht Firebase Realtime Database.** Bestehende Firebase-Lobbys werden nicht migriert. Diese Architekturänderung ist eine vorbereitete Alternative zum bisherigen Firebase-only-Prototyp.

Der Worker braucht keinen Firebase-Service-Account, privaten Schlüssel oder dauerhaft laufenden Mac. Die Firebase-Webkonfiguration ist öffentlich und kein Admin-Schlüssel. Eine Cloudflare-Anmeldung und eine einmalige Einrichtung sind erforderlich. Es wurde kein Cloudflare-Konto verbunden und kein Dienst veröffentlicht.

## Einrichtung auf dem Mac

1. Node.js 24 LTS installieren. Für die Emulatorprüfung zusätzlich ein zur aktuellen Firebase CLI passendes Java installieren. In Terminal prüfen:

   ```bash
   node --version
   npm --version
   java --version
   ```

2. Den nach Freigabe bereitgestellten Reparaturbranch in einen eigenen Projektordner laden und dort die lokalen Tests ausführen:

   ```bash
   npm test
   ```

3. In der Cloudflare-Konsole ein kostenloses Workers-Konto erstellen. Keine kostenpflichtigen Erweiterungen aktivieren. Danach im Projektordner:

   ```bash
   npx wrangler login
   npx wrangler d1 create hide-and-seek
   ```

4. Die von Cloudflare zurückgegebene `database_id` in `worker/wrangler.toml` anstelle von `REPLACE_WITH_CREATED_D1_ID` eintragen. `ALLOWED_ORIGIN` ist nur die Origin `https://knekkonn.github.io`, ohne Repositorypfad. Bei einem anderen Host exakt anpassen.

5. Datenbankschema anwenden und Worker zunächst nur für kontrollierte Tests veröffentlichen:

   ```bash
   npx wrangler d1 migrations apply hide-and-seek --remote --config worker/wrangler.toml
   npx wrangler deploy --config worker/wrangler.toml
   ```

   Die zurückgegebene HTTPS-Worker-URL aufbewahren. Sie ist ein öffentlich erreichbarer API-Endpunkt; Raumdaten erfordern zusätzlich einen gültigen Firebase-ID-Token und bestätigte Mitgliedschaft. CORS ersetzt diese Autorisierung nicht.

6. In `js/config.js` `WORKER_URL` auf diese HTTPS-Origin setzen, ohne abschließenden Pfad. Den Cache-Namen in `sw.js` für diese Konfigurationsänderung erneut erhöhen.

7. Firebase-Konsole öffnen: Authentication → Sign-in method → Anonymous aktivieren. Webkonfiguration mit `js/config.js` vergleichen. API-Key-Einschränkungen müssen Tokenprüfung über Identity Toolkit vom Worker erlauben; unpassende HTTP-Referrer-Einschränkungen können die Serverprüfung blockieren. Keine Admin-Schlüssel in GitHub eintragen.

8. Firebase-Regeln zunächst im Emulator prüfen (separat von `npm test`):

   ```bash
   npx firebase-tools emulators:exec --project demo-hide-seek --only auth,database 'node --test tests/emulator-rules.mjs'
   ```

   Dieser Test wurde hier **nicht ausgeführt**, weil die Umgebung ihren Netzwerkproxy nicht erreichen kann. Er prüft die beigefügten vollständig sperrenden RTDB-Regeln, keine nicht existierenden Firebase-Spielaktionsregeln.

9. Die neue Oberfläche auf einer isolierten HTTPS-Testadresse testen. Dafür kann ein separater GitHub-Pages-Testrepo oder später eine private Sites-Vorschau verwendet werden. Die produktive Pages-Seite erst nach den Tests ändern. Ein lokaler Mac-Server allein ersetzt den Test mit zwei echten Geräten nicht.

10. Wenn der Worker-Modus auf allen Clients erfolgreich läuft, **vor einer öffentlichen Nutzung** in Firebase Realtime Database → Rules den Inhalt aus `database.rules.production.json` veröffentlichen. Dadurch werden alle direkten RTDB-Clientzugriffe gesperrt. Bestehende Firebase-only-Versionen funktionieren danach nicht mehr. Die neue Worker-Version braucht diese Zugriffe nicht.

11. Erst nach bestandener Abnahme den geprüften Branch nach `main` übernehmen. Unter GitHub → Repository → Settings → Pages die bestehende Veröffentlichung aus `main`, Ordner `/ (root)`, beibehalten. Falls das Repository Actions für Pages nutzt, den bestehenden Workflow verwenden. Nach erfolgreichem Pages-Deployment alle alten App-Tabs/PWA-Fenster schließen und neu öffnen. Ein wartender Service Worker ersetzt absichtlich keine laufende Runde.

## Verhalten des Workers

- Vierstellige Codes adressieren Räume, gewähren aber keinen Lesezugriff. Ein neuer Spieler stellt eine Beitrittsanfrage. Der Host bestätigt sie in der Lobby.
- D1-Änderungen verwenden Revisionen und Compare-and-Swap. Konkurrenz überschreibt keine fremden Spielzustände; nach acht Konflikten erhält der Client eine Wiederholungsaufforderung.
- Synchronisierung erfolgt mit HTTP-Abfragen alle 2,5 Sekunden. Das ist kein Firebase-`onValue` und kein WebSocket. Der ursprüngliche Firebase-Testpfad benutzt weiter `onValue`.
- Serverzeit bestimmt Phasen, Belohnungen und Fangfristen. Abgelaufene Phasen werden auch bei einem Lesezugriff anhand der ursprünglichen Fristen nachgeholt, wenn der Host gerade offline ist.
- Roh-GPS bleibt im serverseitigen Raumzustand. Antworten enthalten eigene Positionen und nur berechtigte fremde Signale: Sonar gerundet auf 0,001 Grad, Tracker während der Laufzeit, Kompass als 100-Meter-Richtungsprojektion, Seeker-Radar nur ohne Jammer. Geist-Modus unterbindet fremde Positionsfreigaben.
- GPS-Messungen älter als zehn Sekunden oder mit Genauigkeit über 50 Metern bestätigen keinen Zonenverstoß. Lücken über zehn Sekunden unterbrechen die durchgehende Beweiskette. Nach 30 Sekunden frischer, eindeutig außerhalb liegender Messungen: minus fünf Münzen, nie unter null. Bei jedem dritten bestätigten Verstoß: zusätzlich 30 Sekunden Aktionssperre. Pro ununterbrochener Überschreitung wird nur einmal gezählt. Neue präzise Innenmessung beendet diese Überschreitung.
- Fangänderungen erfordern die Identität des betroffenen Hiders, dieselbe Anfrage-ID, eine aktive Runde und eine höchstens 20 Sekunden alte Anfrage.
- Aufgaben brauchen eine serverseitig ausgegebene Challenge, Mindestdauer, Ablaufzeit und einmalige Einlösung. Die Code-Antwort wird serverseitig geprüft. Shake-Bewegung selbst ist im Browser **nicht manipulationssicher nachweisbar**; der Server prüft dafür nur Frist und einmalige Einlösung.
- Der Host schließt beim ausdrücklichen Verlassen den Raum. Es gibt keine automatische Entfernung oder Host-Übergabe bei einem kurzen Offline-Zustand.
- Räume laufen 24 Stunden nach Erstellung ab. Eine stündliche Bereinigung entfernt abgelaufene Räume und Rate-Limit-Einträge. Es wird kein dauerhaftes Bewegungsarchiv erzeugt; jeweils nur die letzte Position gespeichert.

## Kosten, Datenschutz und Grenzen

Workers/D1 haben kostenlose Kontingente, aber keine garantierte unbegrenzte Nutzung. Requests, D1-Lese-/Schreibvorgänge, CPU und Speicher in der aktuellen Cloudflare-Konsole prüfen. Die 2,5-Sekunden-Abfragen erzeugen pro Gerät ungefähr 1.440 Requests pro Stunde; GPS-Schreibvorgänge und Spielaktionen kommen hinzu. Bei verbrauchten kostenlosen Kontingenten muss die App Fehler anzeigen, statt Synchronisierung zu behaupten. Aktuelle Tarifgrenzen konnten hier nicht online verifiziert werden.

Rate Limits gelten pro Firebase-Identität: fünf Beitrittsversuche/Minute, drei Raum-Erstellungsversuche/Stunde, 90 Aktionen/Minute. Neue anonyme Konten können solche Grenzen umgehen. Für öffentliche Nutzung sind zusätzlicher Missbrauchsschutz (z. B. Cloudflare-Regeln/Turnstile oder Firebase App Check mit serverseitiger Verifikation) und Lasttests noch nötig. Das ist kein fertig nachgewiesener Schutz gegen gezielten Ressourcenmissbrauch.

Mitspieler erhalten über die App keine IP-Adressen. Firebase, Cloudflare, Karten- und Netzwerkdienstleister sehen technisch erforderliche Verbindungsdaten. Cloudflare-/Firebase-Protokollierung und Aufbewahrung in den jeweiligen Konten prüfen. GPS-Freigabe erfolgt nur über einen bewussten Klick. Betriebssystem-GPS und Shake-Sensoren können manipuliert werden; auch ein autorisierender Server beweist keine physische Begegnung oder Bewegung.

Eine Sites-Veröffentlichung wurde bewusst nicht durchgeführt: Der Auftrag verlangt, ungetestete oder unsichere Änderungen nicht als produktionsreif zu veröffentlichen. Für einen sicheren Site-Test müssten zuerst Worker/D1 eingerichtet und `WORKER_URL` gesetzt sein. Die bestehende GitHub-Pages-Version und ihre Firebase-Regeln wurden nicht verändert.
