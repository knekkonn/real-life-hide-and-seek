# Prüfstand und offene Abnahme

Stand: 25. Oktober 2026. Worker und EU-D1 sind provisioniert; die Geräte-Abnahme ist noch offen.

## Ausgeführt

- Node-Syntaxprüfungen für alle JavaScript- und MJS-Dateien.
- `npm test`: vier Testdateien, alle Tests bestanden.
- Bestehende Lobby-, Rollen-, Einstellungs- und Geometrieprüfungen.
- Regression für zunächst leeren Firebase-Transaktionscache; Firebase-Transaktionsantworten werden simuliert.
- Session-Grundlagen: bestehende Mitgliedschaft bleibt idempotent; keine Ersetzung anderer Spieler. Die Browser-Reload-Sequenz selbst ist noch nicht im Browser getestet.
- GPS-Toleranz inklusive fehlender/ungenauer/veralteter Daten und Offline-Unterbrechungen.
- Worker-Autorisierung, gefilterte Positionen, Geist-/Sonar-/Kompassverhalten, Host-Freigabe, sofortiger Fang mit 5-m-Grenze, OSM-Cache-Prüfung und Aufgabenbelohnung.
- Tatsächliche SQLite-Abfragen aus dem Worker über einen lokalen D1-Testadapter, inklusive konkurrierender Beitrittsanfragen und Mitgliedschaftsschutz. Firebase-Tokenantworten sind in diesem Integrationstest simuliert.
- Serverseitige GPS-Verstoßzählung, keine Strafe aus Datenlücken, dritte Strafe.
- `git diff --check`.
- Cloudflare-Konto, D1 EU-Datenbank, angewendetes Schema, Worker-Upload, D1-Bindung, `workers.dev`-Route und stündlichen Cron-Trigger per Cloudflare API geprüft.

## Noch nicht ausgeführt / Freigabesperren

- Firebase Emulator Suite und der beigefügte RTDB-Regeltest.
- Echtes Firebase Auth, Google-CDN-Importe und Firebase-RTDB-Transaktionen über Netzwerk.
- Externer HTTP-Smoke-Test gegen den veröffentlichten Worker; der Netzwerk-Proxy blockiert ausgehende Worker-Aufrufe aus dieser Laufumgebung.
- Browserprüfung inklusive iOS-PWA, Audio-Freigabe, Service-Worker-Lebenszyklus, Kartenbedienung und Session-Reload.
- Zwei physische Geräte, echtes GPS, schlechte Messungen, Offline/Reconnect und komplette Runde.
- Missbrauchs-/Lastprüfung und ergänzender Schutz gegen massenhaft neue anonyme Identitäten.

Der Ausführungscontainer blockiert ausgehende Worker-Aufrufe; Browser-Steuerwerkzeuge stehen nicht zur Verfügung. Die API-Konfiguration und der Upload wurden von Cloudflare bestätigt, daraus folgt kein erfolgreicher End-to-End- oder Gerätetest.

## Abnahme auf zwei Geräten

1. Worker und Oberfläche gemäß `BACKEND.md` auf Testadressen einrichten, RTDB erst nach korrekter Worker-Anbindung sperren.
2. Gerät A erstellt Lobby. Gerät B fragt per Code Beitritt an. Vor Host-Freigabe darf B keine Spielerdaten erhalten. A lässt B zu. Beide sehen dieselbe Besetzung.
3. A ändert Modus, Radius und Mittelpunkt. B sieht diese Werte nach spätestens dem nächsten erfolgreichen Abruf. Radius bis 2.000 Meter prüfen.
4. Beide Geräte einzeln neu laden. Dieselbe Firebase-UID und Mitgliedschaft müssen wiederhergestellt werden; GPS erneut bewusst freigeben.
5. A startet: Countdown → Enthüllung → Versteckphase → Spiel. Uhren dürfen ungefähr um Netzlaufzeit, nicht um unabhängige Timer abweichen.
6. Flugmodus auf B aktivieren. Keine zusätzliche Verstoßzählung. Wieder online gehen; Abrufe müssen fortgesetzt werden und die Toleranz anhand neuer Messungen beginnen.
7. Ungültigen/geschlossenen/abgelaufenen Code, konkurrierende Anfragen und volle Lobby prüfen. Fremde Identität darf keine Einstellungen oder Rollen schreiben.
8. GPS verweigern, Genauigkeit >50 Meter, letzte Messung >10 Sekunden: keine Strafe. Präzise Innenposition: kein Verstoß. Präzise Außenposition über 30 Sekunden mit durchgehenden neuen Messungen: eine Strafe. Dritte bestätigte Überschreitung: zusätzliche Aktionssperre.
9. Skills kaufen/aktivieren, Tracker/Geist/Jammer, Cache-Nähe, Code-Aufgabe und Shake prüfen. In Netzwerkantworten nach fremden Rohkoordinaten suchen; außerhalb einer Berechtigung dürfen sie nicht enthalten sein.
10. Fang innerhalb und außerhalb von 5 m, GPS-Genauigkeit, Schild und doppelte Aktion testen. Classic: Zuschauer; Infiziert: Seeker; letzter Hider: Spielende.
11. Host kurz offline: Mitgliedschaft bleibt. Host ausdrücklich verlassen: alle sehen geschlossenen Raum.
12. Geänderte App-Shell mit erhöhtem Cache-Namen veröffentlichen. Laufende Runde bleibt bei einer Version. Alle Fenster schließen und neu öffnen: vollständige neue Version. Ein fehlgeschlagener JS-Abruf darf kein HTML zurückgeben.

## Weiterhin fachlich offen

Der bestehende Sprint-Alarm ist weiterhin ein aktivierbarer Effekt mit Meldung, keine fertig geprüfte Erkennung schneller Bewegung. Ein separates Puzzle-Minispiel war in den Ausgangsdateien nicht enthalten und wurde nicht ergänzt. Physische Shake-Bewegung und echte GPS-Koordinaten lassen sich mit diesem Browser-/Servermodell nicht manipulationssicher attestieren. Diese Punkte gehören vor einer Behauptung der vollständigen Erfüllung des Master-Prompts zur weiteren Arbeit.

## GitHub-Status

Die Folgeänderungen liegen im offenen Entwurfs-PR #5. Erst nach dessen Veröffentlichung lädt GitHub Pages die konfigurierte Worker-URL aus `js/config.js`.
