# MyNotes – Plan

Stand 2026-11-04. Ein Notizeditor für CachyOS und Windows 11: Tabs wie Notepad++, Struktur wie ein Wiki, Markdown wie Notion, Optik wie MyPods und MyCAD. Oberstes Ziel ist, dass nie eine Notiz verloren geht.

## 1. Entscheidungen

| Thema | Entscheidung | Folge |
|---|---|---|
| Technik | Electron | Gleiche Engine auf beiden Systemen, Bedienoberfläche aus den MyStyle-Web-Bausteinen |
| Markdown | Echtes WYSIWYG mit TipTap/ProseMirror | Markdown wird beim Speichern neu erzeugt, siehe § 4 |
| Code, JSON, Text | CodeMirror 6 | Zweiter Editor, hält den Text unverändert |
| Neue Tabs | Sofort echte Notiz in `Eingang/` | Nur ein Konzept, nur ein Speicherweg |
| Umfang | Notepad++-Kernfunktionen | Makros, Dateivergleich, Hex-Ansicht und Plugins erst später |
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
| Verlauf | Versehentliches Löschen von Text, schlechte Umwandlung | Stand vor der ersten Änderung, danach alle 5 min und beim Schließen. Wird in Version 1 nie automatisch gelöscht |
| Papierkorb | Gelöschte Notizen | Löschen verschiebt nach `.trash/` im Notizordner, Leeren nur auf ausdrücklichen Wunsch |
| Zweiter Sicherungsort | Plattenausfall, Verlust des Rechners | Optionaler Ordner, zum Beispiel NAS oder USB. Dort wird nie etwas gelöscht |

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

## 4. Schutz bei WYSIWYG

TipTap erzeugt das Markdown beim Speichern neu. Aus `5 * 3` kann also `5 \* 3` werden, aus `*` als Listenzeichen `-`. Deshalb:

1. **Keine Änderung, kein Schreiben.** Öffnen und Lesen fasst die Datei nie an, geschrieben wird erst nach einer echten Eingabe.
2. **Originalstand zuerst sichern.** Vor der ersten Änderung geht der unveränderte Text in den Verlauf.
3. **Prüfung beim Öffnen.** Das Original und die neu erzeugte Fassung werden beide nach HTML umgewandelt und verglichen. Unterscheiden sie sich, etwa bei eingebettetem HTML, öffnet die Notiz in der Quelltextansicht mit einem Hinweis.
4. **Quelltextansicht.** `Strg+/` schaltet jede Markdown-Notiz in CodeMirror um. Dort bleibt jedes Zeichen, wie es ist.
5. **Einfügen.** JSON in einer leeren Notiz macht aus ihr eine `.json`-Datei im Code-Editor. JSON in einer gefüllten Notiz wird zum Code-Block. `Strg+Umschalt+V` fügt Text immer als Code-Block ein.

## 5. Funktionen der Version 1

**Tabs:** Neu, Schließen ohne Rückfrage, Umsortieren per Ziehen, `Strg+Tab`, geschlossenen Tab zurückholen, Wiederherstellung samt Reihenfolge, aktivem Tab und Cursor.

**Navigation:** Baum mit Ordnern und Unterordnern, Anlegen, Umbenennen, Verschieben und Sortieren per Ziehen, Schnellfilter, Papierkorb. Die manuelle Reihenfolge liegt in `.mynotes/order.json` im Notizordner.

**Titel:** Neue Notizen heißen nach dem Anfang ihrer ersten Zeile (höchstens 40 Zeichen, an einer Wortgrenze gekürzt), bis du sie umbenennst oder verschiebst. Dateinamen sind auf beiden Systemen gültig.

**Markdown:** Überschriften, Fett, Kursiv, Durchgestrichen, Inline-Code, Links, Listen, Checklisten, Zitate, Code-Blöcke mit Highlighting, Tabellen, Trennlinien, Bilder. Dazu Slash-Menü, Formatleiste bei Auswahl und Markdown-Kürzel beim Tippen.

**JSON:** Pretty Print und Minify für Auswahl, Code-Block oder ganze Datei. Der Formatierer ändert nur Leerraum: Große Zahlen, `1.0` und doppelte Schlüssel bleiben erhalten. Fehler zeigen Zeile und Spalte. Einzug einstellbar, Kürzel `Strg+Alt+J` und `Strg+Alt+Umschalt+J`.

**Notepad++-Kern:** Syntax-Highlighting für die gängigen Sprachen, Suchen und Ersetzen mit Regex, Suche über alle Notizen, Mehrfachcursor und Spaltenauswahl, Zeilen duplizieren, verschieben, löschen und sortieren, Falten, Zeilenumbruch, Zeilennummern, Encoding und Zeilenenden anzeigen und ändern, externe Dateien öffnen.

**Einstellungen:** Notizordner, zweiter Sicherungsort, Erscheinungsbild, Glas-Regler, Kontrast, Transparenz, Bewegung, Schriftgröße, Zeilenumbruch, volle Breite, JSON-Einzug.

**Verlauf:** Versionen je Notiz ansehen und wiederherstellen. Wiederherstellen sichert vorher den aktuellen Stand.

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
- Lauf auf CachyOS unter Wayland mit echter GPU. Getestet ist Arch unter Xvfb.
- Stromausfall (§ 3.6).
- Update per MSI über eine ältere Version und die erste Installation auf einem frischen Rechner. Das MSI selbst ist gebaut, und sein entpackter Inhalt besteht den End-to-End-Test.

## 9. Später, wenn es fehlt

Makros, Dateivergleich, Hex-Ansicht, geteilte Ansicht, Plugins, Links zwischen Notizen, Glas-Linse, englische Oberfläche, Ausdünnen des Verlaufs.
