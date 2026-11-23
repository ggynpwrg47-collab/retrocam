# RetroCam 📼

Eine iPhone-Kamera-App, die wie ein alter VHS-Camcorder funktioniert – **nicht im App Store**, sondern direkt aus diesem Git-Repo auf dein eigenes iPhone installierbar.

## Was die App kann

- **VHS-Look in Echtzeit:** Rauschen, Farbbluten, leichte Unschärfe, Scanlines, Farbversatz, durchlaufendes Tracking-Band, Störstreifen am unteren Bildrand, gelegentliche Dropouts, Vignette, 4:3 bei 640×480.
- **Datum & Uhrzeit** werden wie beim Camcorder ins Bild eingebrannt (unten rechts, abschaltbar mit der Taste `DATUM`).
- **Kurze Bildstörung beim Drücken von REC**, wie beim echten Gerät.
- **Kassetten = Projekte:** Lege beliebig viele Kassetten an. Jede Kassette ist ein durchgehendes Band.
- **Weiterfilmen wie auf Band:** REC → STOP → REC … jede neue Aufnahme hängt genau dort an, wo das Band steht. Es entsteht ein einziges durchgehendes Video.
- **Zurückspulen & Überschreiben:** Spul mit ◀◀ zurück (oder tipp/zieh auf der Bandanzeige), drück REC – ab dieser Stelle wird überschrieben, und zwar genau so lange, wie du filmst. Was danach auf dem Band war, bleibt erhalten. Genau wie bei VHS.
- **Laufwerkstasten:** REC, PLAY/PAUSE, STOP, ◀◀ REW, ▶▶ FF – mit Spul-Störbalken, „Schnee“ am Bandende und Bandzählwerk `0:00:00`.
- **Export:** In der Kassettenliste lange auf eine Kassette drücken → „In Fotos speichern“ – das ganze Band wird als ein Video in deiner Fotomediathek gespeichert.

## Installation auf dem iPhone (ohne App Store)

Apple erlaubt Apps außerhalb des App Stores nur über Xcode („Sideloading“). Dafür brauchst du **einen Mac** und eine **kostenlose Apple-ID** – keinen bezahlten Entwickler-Account.

1. **Xcode** (Version 15 oder neuer) aus dem Mac App Store installieren.
2. Dieses Repo herunterladen:
   ```bash
   git clone https://github.com/ggynpwrg47-collab/retrocam.git
   ```
   (oder auf GitHub: *Code → Download ZIP*)
3. Den Ordner **`RetroCam.swiftpm`** doppelklicken – er öffnet sich in Xcode.
4. In Xcode links auf **RetroCam** klicken → **Signing & Capabilities** → bei **Team** deine Apple-ID auswählen (ggf. erst über *Xcode → Settings → Accounts* hinzufügen).
   Falls Xcode meckert, dass die Bundle-ID schon vergeben ist: `de.privat.retrocam` in etwas Eigenes ändern, z. B. `de.deinname.retrocam`.
5. iPhone per Kabel anschließen, oben in Xcode als Ziel auswählen und auf **▶ (Run)** klicken.
6. Beim ersten Mal auf dem iPhone:
   - **Einstellungen → Datenschutz & Sicherheit → Entwicklermodus** einschalten (iPhone startet neu).
   - **Einstellungen → Allgemein → VPN & Geräteverwaltung** → deine Apple-ID → **Vertrauen**.
7. App öffnen, Kamera und Mikrofon erlauben – fertig.

> **Hinweis zur kostenlosen Apple-ID:** Apps, die so installiert werden, laufen **7 Tage**. Danach einfach das iPhone wieder anschließen und in Xcode nochmal auf ▶ drücken. Deine Kassetten bleiben dabei erhalten. Mit einem bezahlten Entwickler-Account (99 €/Jahr) hält die App ein Jahr.

Alternativ geht's auch mit der App **Swift Playgrounds** auf dem Mac: `RetroCam.swiftpm` dort öffnen und auf dem verbundenen iPhone ausführen.

## Bedienung

| Taste | Funktion |
|---|---|
| **REC** | Aufnahme starten/stoppen – ab der aktuellen Bandstelle |
| **▶ / ❚❚** | Abspielen / Pause |
| **■** | Stopp – zurück zum Sucher, Band bleibt an der Stelle stehen |
| **◀◀ / ▶▶** | Zurück-/Vorspulen mit Bild (nochmal drücken = Pause) |
| **Bandanzeige** | Antippen oder ziehen, um direkt an eine Stelle zu springen |
| **DATUM** | Datums-/Zeitstempel ein- oder ausblenden |
| **EJECT** | Zurück zur Kassettenliste |

Die orangefarbenen Blöcke in der Bandanzeige sind die einzelnen Aufnahmen, der weiße Strich ist der Tonkopf. Wenn der Tonkopf mitten im Band steht, zeigt der Sucher `REC = ÜBERSPIELEN` – dann wird beim Filmen überschrieben.

Die App läuft im Querformat (Kamera oben links), wie ein Camcorder.

## Technik

- SwiftUI-App als Xcode App Playground (`RetroCam.swiftpm`), iOS 17+
- Kamera über AVFoundation, VHS-Effekt per Core Image auf der GPU, Aufnahme mit AVAssetWriter (H.264, 640×480)
- Jede Aufnahme ist eine eigene Datei; die Kassette merkt sich, welcher Ausschnitt welcher Datei an welcher Bandstelle liegt. Beim Überschreiben werden ältere Aufnahmen passend zugeschnitten, komplett überschriebene Dateien werden gelöscht. Abspielen und Export setzen alles zu einem Video zusammen (AVComposition).

| Datei | Inhalt |
|---|---|
| `Tape.swift` | Datenmodell und Überschreib-Logik |
| `TapeStore.swift` | Speichern/Laden der Kassetten |
| `TapeComposer.swift` | Zusammensetzen zum Video, Export in Fotos |
| `VHSEffect.swift` | Der VHS-Look |
| `CameraController.swift` | Kamera, Mikrofon, Aufnahme |
| `CamcorderModel.swift` | Laufwerk: REC/PLAY/REW/FF/STOP |
| `CamcorderView.swift`, `TapeListView.swift`, `VideoViews.swift` | Oberfläche |


## Lizenz

**Alle Rechte vorbehalten.** Dieser Code ist zwar öffentlich sichtbar, darf aber ohne meine schriftliche Erlaubnis **nicht** verwendet, kopiert, verändert oder weitergegeben werden. Details stehen in der Datei [`LICENSE`](LICENSE).
