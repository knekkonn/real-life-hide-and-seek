# Prüfstand und offene Abnahme

Stand: 25. Oktober 2026. Dies ist ein Reparatur- und Backend-Entwurf, keine abgenommene Produktionsversion.

## Ausgeführt

- Node-Syntaxprüfungen für alle JavaScript- und MJS-Dateien.
- `npm test`: drei Testdateien mit insgesamt 29 Einzelfällen.
- Bestehende Lobby-, Rollen-, Einstellungs- und Geometrieprüfungen.
- Regression für zunächst leeren Firebase-Transaktionscache; Firebase-Transaktionsantworten werden simuliert.
- Session-Grundlagen: bestehende Mitgliedschaft bleibt idempotent; keine Ersetzung anderer Spieler. Die Browser-Reload-Sequenz selbst ist noch nicht im Browser getestet.
- GPS-Toleranz inklusive fehlender/ungenauer/veralteter Daten und Offline-Unterbrechungen.
- Worker-Autorisierung, gefilterte Positionen, Geist-/Sonar-/Kompassverhalten, Host-Freigabe, einmalige Fangbestätigung und Aufgabenbelohnung.
- Tatsächliche SQLite-Abfragen aus dem Worker über einen lokalen D1-Testadapter, inklusive konkurrierender Beitrittsanfragen und Mitgliedschaftsschutz. Firebase-Tokenantworten sind in diesem Integrationstest simuliert.
- Serverseitige GPS-Verstoßzählung, keine Strafe aus Datenlücken, dritte Strafe.
- `git diff --check`.

## Noch nicht ausgeführt / Freigabesperren

- Firebase Emulator Suite und der beigefügte RTDB-Regeltest.
- Echtes Firebase Auth, Google-CDN-Importe und Firebase-RTDB-Transaktionen über Netzwerk.
- Wrangler-Bundle, echtes D1 und veröffentlichter Cloudflare Worker.
- Browserprüfung inklusive iOS-PWA, Audio-Freigabe, Service-Worker-Lebenszyklus, Kartenbedienung und Session-Reload.
- Zwei physische Geräte, echtes GPS, schlechte Messungen, Offline/Reconnect und komplette Runde.
- Missbrauchs-/Lastprüfung und ergänzender Schutz gegen massenhaft neue anonyme Identitäten.

Der Ausführungscontainer hat keinen erreichbaren Netzwerkproxy; Browser-Steuerwerkzeuge stehen nicht zur Verfügung. Kein erfolgreicher Netzwerk- oder Gerätetest wird daraus abgeleitet.

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
10. Fang ablehnen, bestätigen, Schild, veraltete Anfrage und doppelte Bestätigung testen. Classic: Zuschauer; Infiziert: Seeker; letzter Hider: Spielende.
11. Host kurz offline: Mitgliedschaft bleibt. Host ausdrücklich verlassen: alle sehen geschlossenen Raum.
12. Geänderte App-Shell mit erhöhtem Cache-Namen veröffentlichen. Laufende Runde bleibt bei einer Version. Alle Fenster schließen und neu öffnen: vollständige neue Version. Ein fehlgeschlagener JS-Abruf darf kein HTML zurückgeben.

## Weiterhin fachlich offen

Der bestehende Sprint-Alarm ist weiterhin ein aktivierbarer Effekt mit Meldung, keine fertig geprüfte Erkennung schneller Bewegung. Ein separates Puzzle-Minispiel war in den Ausgangsdateien nicht enthalten und wurde nicht ergänzt. Physische Shake-Bewegung und echte GPS-Koordinaten lassen sich mit diesem Browser-/Servermodell nicht manipulationssicher attestieren. Diese Punkte gehören vor einer Behauptung der vollständigen Erfüllung des Master-Prompts zur weiteren Arbeit.

## GitHub-Status

Der Upload der 25 geänderten/neuen Dateien nach `knekkonn/real-life-hide-and-seek` wurde durch die automatische Freigabeprüfung abgewiesen: Die ursprüngliche Anweisung galt nicht als hinreichend konkrete Autorisierung für diesen Upload und dieses Ziel. Es wurde kein Reparaturbranch und kein Pull Request erstellt. Der Arbeitsstand liegt im gemeinsamen Workspace; der vorgesehene Download-Ausgabeordner ist in dieser Umgebung nicht beschreibbar. Eine ausdrückliche Freigabe des Uploads ist nötig, bevor ein erneuter Versuch erfolgen darf.
