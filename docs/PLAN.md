# MyNotes – Plan

Stand 2026-11-04. Ein Notizeditor für CachyOS und Windows 11: Tabs wie Notepad++, Struktur wie ein Wiki, Markdown wie Notion, Optik wie MyPods und MyCAD. Oberstes Ziel ist, dass nie eine Notiz verloren geht.

## 1. Entscheidungen

| Thema | Entscheidung | Folge |
|---|---|---|
| Technik | Electron | Gleiche Engine auf beiden Systemen, Bedienoberfläche aus den MyStyle-Web-Bausteinen |
| Markdown | Echtes WYSIWYG mit TipTap/ProseMirror | Markdown wird beim Speichern neu erzeugt, siehe § 4 |
| Code, JSON, Text | CodeMirror 6 | Zweiter Editor, hält den Text unverändert |
| Neue Tabs | Sofort echte Notiz in `Eingang/` | Nur ein Konzept, nur ein Speicherweg |
| Umfang | Notepad++-Kernfunktionen | Makros, Hex-Ansicht und Plugins erst später |
| Speicherformat | Normale Dateien im Notizordner | Notizen bleiben ohne die App lesbar und lassen sich mit Nextcloud, OneDrive oder Git abgleichen |
| Oberflächensprache | Deutsch | Weitere Sprachen erst bei Bedarf |

Direkt in die App eingebauter Abgleich zwischen Rechnern ist nicht geplant. Der Notizordner kann aber mit einem Sync-Tool abgeglichen werden, Konflikte fängt § 3.5 ab.

## 2. Aufbau

```
Renderer (sandboxed)              Main-Prozess                     Platte
TipTap / CodeMirror  ── Text ──▶  Store ── sofort, fsync ──▶  Journal (lokal, je Tab)
Tabs, Baum, Einstellungen         │  ── nach 1,5 s, atomar ─▶  Notizordner (.md, .json …)
                       ◀── Ack ── │  ── alle 5 min, bei Bedarf ▶  Verlauf (lokal, gzip)
                                  │  ── nach jedem Schreiben ──▶  Zweiter Sicherungsort (optional)
```

Ordner und Dateien:

```
src/main/index.js      Fenster, IPC, Lebenszyklus
src/main/store.js      Journal, atomares Schreiben, Wiederherstellung, Verlauf, Papierkorb (ohne Electron testbar)
src/main/preload.cjs   Schmale Brücke zum Renderer
src/shared/            Reine Logik: JSON-Formatierer, Encoding, Dateinamen
src/renderer/          Oberfläche in schlichtem JavaScript, ohne UI-Framework
tests/                 Unit-Tests mit node:test, Absturztest gegen die echte App
```

Datenorte:

| Was | Windows | CachyOS |
|---|---|---|
| Notizordner (Standard, änderbar) | `%USERPROFILE%\MyNotes` | `~/MyNotes` |
| Journal, Verlauf, Sitzung, Einstellungen | `%LOCALAPPDATA%\MyNotes` | `~/.local/share/MyNotes` |

Das Journal liegt bewusst außerhalb des Notizordners. So bleibt es auf der lokalen Platte, auch wenn der Notizordner auf einem Netzlaufwerk liegt, ausgesteckt ist oder gerade vom Sync-Tool gesperrt wird.

## 3. Datensicherheit

### 3.1 Ablauf beim Tippen

1. Der Editor meldet Änderungen spätestens nach 150 ms an den Main-Prozess.
2. Der Main-Prozess hängt nur den Unterschied an das Journal des Tabs an, mit Prüfsumme je Datensatz und anschließendem `fsync`.
3. Erst danach bestätigt er. Die Statusanzeige sagt „Gesichert“ nur nach dieser Bestätigung.
4. Nach 1,5 s Ruhe, spätestens alle 10 s, schreibt er die Datei atomar: temporäre Datei, `fsync`, Umbenennen, unter Linux auch `fsync` des Ordners.
5. Es gibt keinen Speichern-Dialog. `Strg+S` schreibt nur sofort in den Notizordner.

Zum Vergleich: Notepad++ sichert standardmäßig alle 7 Sekunden (`_snapshotBackupTiming = 7000`).

### 3.2 Schutzebenen

| Ebene | Schützt vor | Wie |
|---|---|---|
| Journal | Absturz, `kill -9`, Stromausfall | Append-only, je Datensatz Prüfsumme und `fsync`, ein abgerissener letzter Datensatz wird beim Lesen erkannt und verworfen |
| Atomares Schreiben | Halb geschriebene Dateien | Die alte Datei bleibt ganz, bis die neue vollständig auf der Platte liegt |
| Verlauf | Versehentliches Löschen von Text, schlechte Umwandlung | Stand vor der ersten Änderung, danach alle 5 min und beim Schließen. Wird nie automatisch gelöscht, nur zusammen mit der Notiz beim Leeren des Papierkorbs |
| Papierkorb | Gelöschte Notizen | Löschen verschiebt nach `.trash/` im Notizordner, Leeren nur auf ausdrücklichen Wunsch |
| Zweiter Sicherungsort | Plattenausfall, Verlust des Rechners | Optionaler Ordner, zum Beispiel NAS oder USB. Folgt dem, was in der App passiert, siehe § 3.8 |

### 3.3 Wiederherstellung beim Start

Für jedes Journal: Datensätze einlesen, Prüfsummen kontrollieren, beim letzten gültigen Datensatz aufhören. Dann gilt:

| Journal | Datei im Notizordner | Aktion |
|---|---|---|
| Alles geschrieben | Unverändert | Nichts zu tun |
| Noch nicht geschrieben | Unverändert | Stand in die Datei schreiben |
| Noch nicht geschrieben | Extern geändert | Datei behalten, Journal-Stand als Konfliktkopie danebenlegen, Hinweis zeigen |
| Noch nicht geschrieben | Fehlt | Datei neu anlegen |
| Alles geschrieben | Fehlt | Bewusst gelöscht, der Stand bleibt im Verlauf |

### 3.4 Fehlerfälle im Betrieb

| Fall | Verhalten |
|---|---|
| Notizordner nicht erreichbar, Platte voll, keine Rechte | Tippen geht weiter ins Journal, Warnung mit Symbol und Text in der Statusleiste, alle 5 s neuer Versuch |
| Auch das Journal kann nicht schreiben | Rote Warnung, die sich nicht wegklicken lässt, Text bleibt im Editor und im Speicher des Main-Prozesses |
| Datei von Virenscanner oder OneDrive gesperrt | Mehrere Versuche mit wachsendem Abstand, danach wie „nicht erreichbar“ |
| Renderer stürzt ab | Main-Prozess lädt das Fenster neu, Tabs kommen aus dem Journal zurück |
| App oder Rechner schließen | Letzter Stand wird geschrieben, höchstens 3 s Wartezeit. Das Journal ist ohnehin aktuell |
| Zweite Instanz | Nicht möglich, die laufende App kommt nach vorn und öffnet die Datei |
| Ordnerwechsel in den Einstellungen | Kopieren und per Prüfsumme kontrollieren. Der alte Ordner bleibt unangetastet, gleichnamige Dateien werden nie überschrieben |

### 3.5 Änderungen von außen

Der Dateisystem-Watcher und eine Prüfung bei jedem Fensterfokus vergleichen die Prüfsumme der Datei mit dem zuletzt bekannten Stand.

- Tab ohne offene Änderungen: Verlauf sichern, neuen Stand laden.
- Tab mit offenen Änderungen: Die fremde Fassung kommt als `Name (extern geändert 2026-11-04 1532).md` daneben, der Tab behält seinen Text, und ein Hinweis erscheint. Beide Fassungen bleiben erhalten.

### 3.6 Grenzen

Absolute Sicherheit kann keine Software versprechen. Das bleibt offen:

- Bei Stromausfall können die letzten 150 ms Tippen fehlen.
- Fällt die Platte aus und ist kein zweiter Sicherungsort eingerichtet, sind die Daten weg. Deshalb ist diese Einstellung dabei und wird beim ersten Start empfohlen.
- SSDs, die `fsync` bestätigen, ohne wirklich zu schreiben, kann die App nicht erkennen.
- Der `kill -9`-Test beweist Absturzsicherheit, aber keine Stromausfallsicherheit. Dafür müsste man auf echter Hardware den Strom ziehen.

### 3.7 Tests

| Test | Prüft |
|---|---|
| `tests/store.test.js` | Journal, abgerissene Datensätze, jede Zeile der Tabelle in § 3.3, Pfad-Ausbruch |
| `tests/crash.test.js` | Schreibprozess wird in einer Schleife per `kill -9` beendet. Jede bestätigte Änderung muss danach vorhanden sein |
| `tests/e2e.mjs` | Echte App: tippen, Prozess hart beenden, neu starten, Text und Tabs sind wieder da |

### 3.8 Kein Datenmüll

Daten sollen nicht verloren gehen, aber auch nicht liegen bleiben.

| Aktion in der App | Notizordner | Zweiter Sicherungsort |
|---|---|---|
| Umbenennen, Verschieben, Titel folgt der ersten Zeile | Datei und Verlauf ziehen um | Datei und Verlauf ziehen genauso um |
| In den Papierkorb legen | Nach `.trash/` | Nach `.trash/` |
| Wiederherstellen | Zurück | Zurück |
| Papierkorb leeren (mit Rückfrage) | Dateien und ihr Verlauf sind weg | Dateien und ihr Verlauf sind weg |
| Neue Notiz wieder geleert und Tab geschlossen | Nach `.trash/` | Nach `.trash/` |

Der Sicherungsort folgt nur Entscheidungen des Nutzers. Er vergleicht nie die Ordner und löscht, was fehlt: Eine tote Platte oder ein entgleistes Sync-Tool sieht genauso aus wie „alles wurde gelöscht“, und genau dann wird er gebraucht. Dateien, die außerhalb der App verschwinden und nicht offen sind, bleiben dort deshalb liegen.

Ist der Sicherungsort nicht erreichbar, warten die Entscheidungen der Reihe nach in `backup-pending.json` im lokalen Datenordner, auch über einen Neustart hinweg. Ein fehlender Sicherungsort wird nie neu angelegt. Ein Schritt, der zehnmal scheitert, wird aufgegeben: Eine liegen gebliebene Datei ist besser als ein Sicherungsort, der keine Kopien mehr bekommt.

## 4. Schutz bei WYSIWYG

TipTap erzeugt das Markdown beim Speichern neu. Aus `5 * 3` kann also `5 \* 3` werden, aus `*` als Listenzeichen `-`. Deshalb:

1. **Keine Änderung, kein Schreiben.** Öffnen und Lesen fasst die Datei nie an, geschrieben wird erst nach einer echten Eingabe.
2. **Originalstand zuerst sichern.** Vor der ersten Änderung geht der unveränderte Text in den Verlauf.
3. **Prüfung beim Öffnen.** Das Original und die neu erzeugte Fassung werden beide nach HTML umgewandelt und verglichen. Unterscheiden sie sich, etwa bei eingebettetem HTML, öffnet die Notiz in der Quelltextansicht mit einem Hinweis.
4. **Quelltextansicht.** `Strg+/` schaltet jede Markdown-Notiz in CodeMirror um. Dort bleibt jedes Zeichen, wie es ist.
5. **Einfügen.** JSON in einer leeren Notiz macht aus ihr eine `.json`-Datei im Code-Editor, JSON in einer gefüllten Notiz wird zum Code-Block, und in einer `.json`-Datei wird nach dem Einfügen die ganze Datei formatiert, wenn sie gültiges JSON ist. Alle drei Wege formatieren automatisch. In der `.json`-Datei nimmt `Strg+Z` nur das Formatieren zurück, sonst das ganze Einfügen. Beim Öffnen und beim Tippen wird nie formatiert, weil das von Hand gesetzte Layouts umschreiben würde. `Strg+Umschalt+V` fügt Text immer unverändert als Code-Block ein.

## 5. Funktionen der Version 1

**Tabs:** Neu, Schließen ohne Rückfrage, Umsortieren per Ziehen, `Strg+Tab`, geschlossenen Tab zurückholen, Wiederherstellung samt Reihenfolge, aktivem Tab und Cursor.

**Navigation:** Baum mit Ordnern und Unterordnern, Anlegen, Umbenennen, Verschieben und Sortieren per Ziehen, Schnellfilter, Papierkorb. Die manuelle Reihenfolge liegt in `.mynotes/order.json` im Notizordner.

**Titel:** Neue Notizen heißen nach dem Anfang ihrer ersten Zeile (höchstens 40 Zeichen, an einer Wortgrenze gekürzt), bis du sie umbenennst oder verschiebst. Dateinamen sind auf beiden Systemen gültig.

**Markdown:** Überschriften, Fett, Kursiv, Durchgestrichen, Inline-Code, Links, Listen, Checklisten, Zitate, Code-Blöcke mit Highlighting, Tabellen, Trennlinien, Bilder. Dazu Slash-Menü, Formatleiste bei Auswahl und Markdown-Kürzel beim Tippen.

**JSON:** Pretty Print und Minify für Auswahl, Code-Block oder ganze Datei. Der Formatierer ändert nur Leerraum: Große Zahlen, `1.0` und doppelte Schlüssel bleiben erhalten. Fehler zeigen Zeile und Spalte. Einzug einstellbar, Kürzel `Strg+Alt+J` und `Strg+Alt+Umschalt+J`, in `.json`-Dateien auch der Knopf „Formatieren“ in der Statusleiste.

**Notepad++-Kern:** Syntax-Highlighting für die gängigen Sprachen, Suchen und Ersetzen mit Regex, Suche über alle Notizen, Mehrfachcursor und Spaltenauswahl, Zeilen duplizieren, verschieben, löschen und sortieren, Falten, Zeilenumbruch, Zeilennummern, Encoding und Zeilenenden anzeigen und ändern, externe Dateien öffnen.

**Konvertieren:** Rechtsklick auf eine Notiz oder ihren Tab, dann „Konvertieren …“. Das Menü zeigt nur, was für diese Datei funktioniert: JSON ⇄ CSV, Text zu JSON, Markdown zu HTML, Base64, Hex und URL jeweils hin und zurück. Das Ergebnis ist eine neue Notiz direkt darunter, das Original bleibt unverändert. YAML und XML fehlen, weil sie neue Abhängigkeiten bräuchten.

**Tastenkürzel:** Eine Übersicht aller Kürzel, über die Seitenleiste oder `F1`. Der End-to-End-Test prüft, dass jedes Kürzel der Befehlsliste darin steht.

**Einstellungen:** Notizordner, zweiter Sicherungsort, Erscheinungsbild, Glas-Regler, Kontrast, Transparenz, Bewegung, Schriftgröße, Zeilenumbruch, volle Breite, JSON-Einzug.

**Verlauf:** Versionen je Notiz ansehen und wiederherstellen. Wiederherstellen sichert vorher den aktuellen Stand.

**Vergleichen:** Zwei Tabs nebeneinander lassen sich wie in WinMerge vergleichen, über eine eigene Glaspille über der Karte. Standard ist aus, das Ende der Nebeneinander-Ansicht schaltet es wieder aus. Gleiche Zeilen stehen auf einer Höhe, beide Seiten bleiben bearbeitbar. Verglichen wird der Text, Markdown zeigt dabei den Quelltext. Beide Seiten markieren in derselben Farbe, weil keine der beiden Dateien die falsche ist.

## 6. Oberfläche

Folgt `MyStyle/STYLEGUIDE.md`. `tokens.css` und `components.css` kommen unverändert aus `MyStyle/platforms/web/`, dazu Inter aus `MyStyle/fonts/` und die Icons aus MyPods.

```
┌───────────────────────────────────────────────────────── r 32 ─┐
│ ┌ Sidebar (Glas, r 20) ┐  ┌ Tabs (Glas) ─────────┐ ┌ ⠿ – □ ✕ ┐ │
│ │ MyNotes              │  │ Notiz │ log.json │ + │ └─────────┘ │
│ │ ⌕ Filter             │  └──────────────────────┘             │
│ │ ▾ Eingang            │  ┌ Karte (Material, r 20) ───────────┐│
│ │ ▾ Projekte           │  │ Projektplan                       ││
│ │   ▾ MyCAD            │  │ Fließtext, Tabellen, Checklisten  ││
│ │     Notiz            │  └───────────────────────────────────┘│
│ │ Papierkorb · ⚙       │   Gesichert · Z 12, S 4 · UTF-8 · LF  │
│ └──────────────────────┘                                       │
└────────────────────────────────────────────────────────────────┘
```

Bewusste Abweichungen, jeweils im Code begründet:

- **Sidebar:** Mehr als 2 Ebenen und veränderbare Breite, weil der Baum das Hauptwerkzeug ist.
- **Inhaltsbreite:** Code-Editor nutzt die volle Breite statt 560 px. Fließtext bleibt bei gut lesbarer Breite.
- **Glas:** `backdrop-filter` liefert Blur, Tint und Rand. Die Linse des Qt-Shaders fehlt zunächst, § 3.6 des Styleguides sieht das für CSS so vor.
- **Monospace:** `--ms-font-family-mono` aus den Tokens. JetBrains Mono ist nicht gebündelt, also greift die System-Monospace-Schrift.

## 7. Sicherheit der App

Renderer mit `sandbox` und `contextIsolation`, kein Node im Renderer, strenge CSP, keine Navigation weg von der App. Links gehen nur mit `http`, `https` und `mailto` an den Browser. Jeder Pfad wird im Main-Prozess geprüft und muss im Notizordner liegen, externe Dateien nur nach Dateidialog, Drag & Drop oder Kommandozeile. Eingebettetes HTML in Notizen wird nie ausgeführt.

## 8. Umsetzungsschritte

| # | Schritt | Fertig, wenn |
|---|---|---|
| 1 | Projektgerüst, Devcontainer | App startet, Tests laufen |
| 2 | Speicherkern | `store.test.js` und `crash.test.js` grün |
| 3 | Fenster, Tabs, Baum im MyStyle-Look | Bedienbar, Sitzung kommt wieder |
| 4 | CodeMirror und JSON-Formatierer | Code-Tabs komplett, `e2e` grün |
| 5 | TipTap mit Schutz aus § 4 | Rundlauf-Test über Beispieldateien grün |
| 6 | Verlauf, Papierkorb, Einstellungen, Sicherungsort, Suche | Alles über die Oberfläche erreichbar |
| 7 | Pakete: MSI, AppImage, Arch-Paket, CI mit Release bei jedem Push auf `main` | Pakete gebaut, Test unter Linux im Container grün |
| 8 | Styleguide-Checkliste § 14 | Alle Modi per Screenshot geprüft |

**Stand 2026-11-04:** Schritte 1 bis 8 sind umgesetzt. Unit-Tests und `tests/e2e.mjs` laufen unter Windows 11 und im Arch-Container, jeweils auch gegen die gepackte App. Offen, weil nur am echten Gerät prüfbar:

- Fenstergröße mit der echten Maus ändern. Windows meldet die Randzonen korrekt, der Zug selbst ist ungetestet.
- Stromausfall (§ 3.6).
- Update per MSI über eine ältere Version und die erste Installation auf einem frischen Rechner. Das MSI selbst ist gebaut, und sein entpackter Inhalt besteht den End-to-End-Test.

## 9. Später, wenn es fehlt

Makros, Änderungen beim Vergleichen per Klick übernehmen, Hex-Ansicht, Plugins, Links zwischen Notizen, Glas-Linse, englische Oberfläche, Ausdünnen des Verlaufs.

## 10. Scribbles und Grafiktablett wie in MyCAD (Wunsch 2026-11-23)

Dieselben Scribbles wie in MyCAD, 1:1, mit Schönschrift und Berichtigen der Schrift, dazu voller Support für das Huion H640P (6 Tasten am Tablett, 2 am Stift). Vorbild in MyCAD: `src/Mod/Design/Gui/Scribble.cpp`, `ScribbleTidy.h`, `ScribbleShapes.h`, `ScribbleRead.cpp`, `src/Gui/Shell/TabletKeys.h`, `TabletActions` und die Seite Tablett in `src/Gui/Shell/Settings.cpp`, MyCAD-PLAN S1–S7 und T1.

### 10.1 Was übernommen wird

| MyCAD | MyNotes |
|---|---|
| Bleistift, Fineliner, Marker in 5 Farben; Breite in Bildschirm-px; Druckkurve `p³` (gemessen an der H640P unter KDE) | 1:1, Druckkurve je System nachmessen (10.3, Schritt 0) |
| Radierer: Stift-Ende, **E**, Tablett-Taste | 1:1 |
| Halten (450 ms) macht Linie, Bogen, Kreis, Ellipse, Dreieck, Rechteck; Einrasten an Achsen und Strich-Enden; Halten auf einem Strich greift ihn | 1:1 |
| Form-Werkzeuge, Füllen nach Umlaufzahl, Auswählen (**V**, Lasso, Leiste), Text | 1:1 |
| Schönschrift nach 1 s Pause (`tidy`, `follow`, Gleiten), Strg+Z holt die rohe Schrift | 1:1 |
| Schrift lesen (DE·HTR v2), `looksRead`, `words`, CAD-Schreibweise (`correct`, `applyInk`: Ø12, 2×45°, 25 mm, ±) | 1:1 |
| Handschrift suchen (Palette) | Die normale Volltextsuche findet Geschriebenes |
| Nur das Blatt (**Tab**) | Seitenleiste und Tabs ausblenden |
| Gerade aufs Blatt (**L**) | Blatt einpassen |
| Tablett-Seite: Modell, Erkennung, Zeichnung, Belegung, Vorschlag H640P, Lernen, Zugriff erlauben, KDE-Kürzel überhören | 1:1; Drehen wird Verschieben; Windows über Treiber-Kombinationen |
| Transparentpapier, Blatt verschieben, Rotstift, In Skizze umwandeln | Entfällt (nur mit 3D-Modell sinnvoll) |

### 10.2 Aufbau

- **Ein Scribble ist eine eigene Notiz, gespeichert als `.svg`.** Der Store journalisiert sie wie jeden Text, also gelten Journal, Verlauf, Papierkorb und zweiter Sicherungsort ohne neuen Speicherweg. Inhalt der Datei:
  - Die Markierung `data-mynotes-scribble="1"`.
  - `<desc>` mit dem gelesenen Text, eine Zeile pro Zeile.
  - Ein `<path>` pro Strich auf einer eigenen Zeile, mit `d` (Umriss) und `data-p` (Rohpunkte x y w).

  Eingebettet in Markdown als `![](….svg)`. Der Name kommt aus der ersten gelesenen Zeile. Andere SVG-Dateien bleiben im Code-Editor.
- **Logik** in JS ohne Umbau portiert: `src/shared/scribble.js` (Tidy, Shapes, Grammatik aus ScribbleRead), `src/shared/tablet.js` (TabletKeys).
- **Erkennung** mit `onnxruntime-web` in einem Web Worker (reines WASM, kein Native-Build).
  - `build.mjs` lädt `naeyn/de-htr-web-v2` (Revision `6241c1ff…`) und prüft SHA-256 `b576a0a1281b9be46b2574028b75575e041b7d7cb650f063886e733467cc1499`.
  - Die CSP braucht `'wasm-unsafe-eval'`.
  - Ohne Modell räumt die Schönschrift auf, liest aber nicht.
- **Tablett-Tasten unter Linux** liest der Main-Prozess selbst:
  - Pad-Geräte sind die mit `ID_INPUT_TABLET_PAD=1` aus `/run/udev/data`. Gelesen werden die `input_event` aus `/dev/input/event*`, Tastennummern in der Reihenfolge der Codes wie bei libinput.
  - Zugriff gibt dieselbe udev-Regel wie in MyCAD.
  - KDE-Kürzel überhört MyNotes per `before-input-event`, 150 ms nach einer selbst gelesenen Taste.
- **Tablett-Tasten unter Windows:** Der Huion-Treiber legt die Tasten in einem Profil für `MyNotes.exe` auf Kombinationen (Vorschlag Strg+Alt+Umschalt+F1…F6), MyNotes erkennt diese als Taste 1–6.
- **Stift:** Pointer Events mit `getCoalescedEvents()`; Seitentaste `buttons & 2`, Radierer `buttons & 32`; Schweben über `pointermove` ohne Taste.

### 10.3 Schritte

| # | Schritt | Fertig, wenn |
|---|---|---|
| 0 | An der echten H640P messen: `npx electron tests/pen-probe.cjs`, unter CachyOS mit Wayland, mit `--ozone-platform=x11` und unter Windows | Bekannt: Druck pro System, Namen der Stift-Tasten, Punktrate, Pad-Tasten über evdev, Reihenfolge Pad-Taste vor KDE-Kürzel |
| 1 | Logik-Port mit `tests/scribble.test.js` (Fälle aus `scribble_tidy_check`, `scribble_shapes_check`, `tablet_keys_check`, Grammatik aus `scribble_read_check`); einmal gegen C++ verglichen | `npm test` grün |
| 2 | Scribble-Editor als Tab-Typ: Stifte, Druck, Radierer, Fangen, Formen, Füllen, Auswählen, Text, Rückgängig, Zoom, Punktraster, Dunkelmodus | Zeichnen mit Stift und Maus, Absturztest überlebt |
| 3 | Schönschrift und Karte „Stift & Handschrift“ (Schalter, Stärke, 6 Schritte, Glätten 1–30 %) | e2e mit Stift-Ereignissen (CDP `pointerType: 'pen'`): gerade nach 1 s, Strg+Z roh |
| 4 | Lesen und Berichtigen, `<desc>`, Suche liest bei Scribbles nur `<desc>` | Synthetische Schrift gelesen, o12 bekommt den Schrägstrich, Suche findet Geschriebenes |
| 5 | Tablett-Seite, `src/main/tablet.js`, pkexec-Regel, `install.sh` | Am H640P tun alle Tasten, was eingestellt ist, ohne Doppel durch KDE |
| 6 | Scribble in Markdown einfügen, Doppelklick öffnet es daneben | Bild aktualisiert sich |
| 7 | README, MyStyle § 14, Englisch in `i18n.js` | CI grün |

**Stand 2026-11-23:** Schritte 1 bis 5 und 7 sind umgesetzt, ohne echtes Tablett (Wunsch: alles emulieren, Werte aus MyCAD). Schritt 0 ist durch die Messwerte aus MyCAD ersetzt (Druckkurve `p³` von der H640P unter KDE, 6 Tasten, Vorschlag aus T1); `tests/pen-probe.cjs` bleibt für die Messung am Gerät.

- Logik: `src/shared/scribble-shapes.js`, `scribble-tidy.js`, `scribble-read.js`, `tablet.js` (1:1 aus MyCAD), `htr.js` (Zeilenbild und CTC-Lesen, ohne Canvas, läuft im Worker und in Node), `scribble-svg.js` (Dateiformat).
- Editor: `src/renderer/scribble.js`, Lesen im Worker `src/renderer/htr-worker.js`. Text-Werkzeug über ein verstecktes Textfeld (Tottasten, AltGr, IME). Typ-Text ist eine eigene Strichart 8 mit Kasten als Geometrie, statt Schrift-Umrissen wie in MyCAD (Umrisse bräuchten opentype.js).
- Tablett-Tasten: `src/main/tablet.js` (evdev, ohne libinput), Belegung und KDE-Kürzel in `app.js`, Seite in den Einstellungen.
- Tests: `scribble-*.test.js`, `tablet.test.js` (auch ein emuliertes H640P-Pad als `input_event`-Strom), Modell-Tests mit dem echten Modell; e2e schreibt mit emuliertem Stift (CDP `pointerType: 'pen'`, Druck), drückt Tablett-Tasten über das IPC-Ereignis des Linux-Lesers und über die Windows-Kombination.
- Gemessen: Lesen in WebAssembly ist langsamer als in MyCAD, Aufräumen kommt rund 2 s statt 1 s nach dem Absetzen.

Am echten H640P offen: welche Stift-Taste Chromium als 2 (untere) meldet, Druck unter Wayland und unter Windows, Reihenfolge Pad-Taste vor KDE-Kürzel.

### 10.4 Offen

- Schritt 6: „Scribble einfügen“ in Markdown und Öffnen per Doppelklick aufs Bild. Einbetten von Hand (`![](….svg)`) zeigt es schon.
- Lesen schneller: onnxruntime-node im Main-Prozess statt WebAssembly, wenn die 2 s stören.
- Malen direkt im Notiztext (Zeichenblock wie in OneNote) statt eigener Notiz: erst, wenn die eigene Notiz nicht reicht.
- Windows-Tasten über WebHID roh lesen: nur, wenn die Treiber-Kombinationen stören.
- Schalter für die CAD-Schreibweise in Notizen: vorerst immer an (1:1).
- Druck unter Wayland in Electron 45, Leseergebnisse mit Canvas statt QPainter, Tempo von WASM (gelesene Zeilen zwischenspeichern): klärt Schritt 0 bzw. 4.
