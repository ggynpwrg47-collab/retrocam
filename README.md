# RetroCam 📼

Ein VHS-Camcorder fürs iPhone – als **Web-App**: einmal über Safari auf den Home-Bildschirm legen, fertig. Kein App Store, kein Mac, kein wöchentliches Neuinstallieren. Updates kommen automatisch.

## Was die App kann

- **VHS-Look in Echtzeit:** Rauschen, Farbbluten, Überschärfung, Zeilenstruktur, Farbversatz, durchlaufendes Tracking-Band, Störstreifen am unteren Rand, Dropouts, Vignette – 4:3, 640×480.
- **Datum & Uhrzeit** werden wie beim Camcorder ins Bild eingebrannt (abschaltbar mit `DATUM`).
- **Kurze Bildstörung beim Drücken von REC**, wie beim echten Gerät.
- **Kassetten = Projekte.** Jede Kassette ist ein durchgehendes Band.
- **Weiterfilmen:** REC → STOP → REC … jede Aufnahme hängt genau dort an, wo das Band steht.
- **Zurückspulen & Überschreiben:** Mit ◀◀ zurückspulen (oder auf die Bandanzeige tippen/ziehen) und REC drücken – ab dieser Stelle wird so lange überschrieben, wie du filmst. Was danach kommt, bleibt erhalten.
- **Laufwerk:** REC, PLAY/PAUSE, STOP, ◀◀, ▶▶, Bandzählwerk, Spul-Störbalken, Schnee am Bandende.
- **Als Video speichern:** In der Kassettenliste auf `•••` → „Als Video speichern“, danach „Teilen → Video sichern“ (Fotos) oder „In Dateien sichern“. Das geht schnell:
  - Ohne Überspielstellen mitten in alten Aufnahmen werden die Aufnahmen direkt zusammenkopiert – Sekunden, auch bei langen Bändern.
  - Mit Überspielstellen wird das Video mit dem Video-Chip des iPhones neu berechnet – deutlich schneller als Echtzeit, bildgenau geschnitten.
  - Nur falls beides auf einem Gerät nicht klappt, wird als Notlösung in Echtzeit überspielt.
  - Während des Exports bleibt der Bildschirm an. Kurzzeitig wird zusätzlicher freier Speicher in Größe der Kassette gebraucht.
- Funktioniert offline. Alle Videos bleiben auf deinem iPhone (im Speicher der Web-App).

## Einrichten (einmalig)

### 1. Web-App online stellen (GitHub Pages, kostenlos)

1. Auf GitHub im Repo auf **Settings → Pages** gehen.
2. Bei **Source** „Deploy from a branch“ wählen.
3. Branch **`claude/retrocam-web`** und Ordner **`/docs`** auswählen → **Save**.
4. Nach 1–2 Minuten ist die App erreichbar unter:
   **https://ggynpwrg47-collab.github.io/retrocam/**

> GitHub Pages ist kostenlos für **öffentliche** Repos. Ist das Repo privat, musst du es entweder auf öffentlich stellen (Settings → General → Danger Zone → Change visibility) oder GitHub Pro haben. Deine Videos landen dabei nie auf GitHub – die bleiben auf dem Handy.

### 2. Aufs iPhone holen

1. Die Adresse oben in **Safari** öffnen.
2. **Teilen**-Knopf → **Zum Home-Bildschirm**.
3. RetroCam vom Home-Bildschirm starten, Kamera und Mikrofon erlauben – fertig.

Die App bleibt dauerhaft auf dem iPhone. Wenn sich am Code etwas ändert, holt sie sich das Update beim nächsten Start automatisch.

## Bedienung

| Taste | Funktion |
|---|---|
| **REC** | Aufnahme starten/stoppen – ab der aktuellen Bandstelle |
| **▶ / ❚❚** | Abspielen / Pause |
| **■** | Stopp – zurück zum Sucher, das Band bleibt an der Stelle |
| **◀◀ / ▶▶** | Zurück-/Vorspulen mit Bild (nochmal drücken = Pause) |
| **Bandanzeige** | Antippen/ziehen = direkt an diese Stelle spulen |
| **W / T** | Zoom (gedrückt halten), oder mit zwei Fingern auf dem Bild |
| **DATUM** | Datums-/Zeitstempel ein/aus |
| **EJECT** | Zurück zur Kassettenliste |

Orange Blöcke in der Bandanzeige = einzelne Aufnahmen, weißer Strich = Tonkopf. Steht der Tonkopf mitten im Band, zeigt der Sucher `REC = ÜBERSPIELEN`.

Am besten **quer halten** – dann gibt's das volle 4:3-Camcorderbild. Hochkant geht auch, dann wird der Bildausschnitt enger.

## Gut zu wissen

- **Zoom:** Wenn das iPhone es dem Browser erlaubt, wird der echte Kamera-Zoom benutzt, sonst ein Digitalzoom bis 4x (Anzeige „D.ZOOM“ – wie bei alten Camcordern).
- **Speicheranzeige:** Die Zahl „Safari erlaubt RetroCam bis ca. …“ legt Safari selbst fest (abhängig vom Speicher des iPhones), sie ist nicht in der App eingestellt.
- **Speicher:** Die Videos liegen im Speicher der Web-App auf dem iPhone. Wenn du die App vom Home-Bildschirm löschst, sind auch die Kassetten weg – also wichtige Kassetten vorher „Als Video speichern“.
- **Während der Aufnahme** die App im Vordergrund lassen (beim Wechsel in eine andere App wird die Aufnahme automatisch gestoppt).
- Beim Abspielen schaltet die App Kamera und Mikrofon kurz ab (sonst ist der Ton auf dem iPhone sehr leise) – genau wie beim Umschalten CAMERA/VCR am echten Camcorder.

## Technik

Reines HTML/JavaScript ohne Build-Schritt, alles im Ordner [`docs/`](docs):

| Datei | Inhalt |
|---|---|
| `vhs.js` | VHS-Effekt als WebGL-Shader + Datumsstempel |
| `deck.js` | Laufwerk: Kamera, Aufnahme (MediaRecorder), Wiedergabe, Spulen, Überschreiben |
| `tape.js` | Datenmodell und Überschreib-Logik |
| `db.js` | Speicherung in IndexedDB |
| `remux.js` | Schneller Export: Zusammenkopieren bzw. Umrechnen per WebCodecs |
| `exporter.js` | Export-Ablauf inkl. Echtzeit-Notlösung |
| `vendor/` | [mp4box.js](https://github.com/gpac/mp4box.js) und [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MP4 lesen/schreiben) |
| `app.js` | Kassettenliste |
| `sw.js`, `manifest.webmanifest` | Offline-Betrieb und Home-Bildschirm-App |

Lokal testen: `cd docs && python3 -m http.server` und http://localhost:8000 öffnen.

---

## Alternative: native iPhone-App

Im Ordner `RetroCam.swiftpm` liegt zusätzlich eine native SwiftUI-Version (siehe Branch `claude/epic-carson-enw0mf`). Die muss allerdings per Mac/Xcode installiert werden und läuft mit kostenloser Apple-ID nur 7 Tage.
