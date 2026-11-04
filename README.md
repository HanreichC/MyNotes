# MyNotes

Ein Notizeditor für CachyOS und Windows 11. Tabs wie in Notepad++, Ordner und Unterordner wie in einem Wiki, Markdown-Live-Editor wie in Notion. Du musst nie speichern: Jede Eingabe liegt nach spätestens 150 ms abgesichert auf der Platte.

## Installieren

Die Pakete entstehen unter `release/`, siehe [Bauen](#bauen).

- **Windows:** `MyNotes Setup x.y.z.exe`
- **CachyOS:** `sudo pacman -U release/mynotes-x.y.z.pacman` oder das AppImage

## Benutzen

| Kürzel | Funktion |
|---|---|
| `Strg+T`, `Strg+N` | Neuer Tab, einfach lostippen |
| `Strg+W`, `Strg+Umschalt+T` | Tab schließen, zurückholen |
| `Strg+Tab` | Nächster Tab |
| `Strg+P` | Notiz nach Namen öffnen |
| `Strg+Umschalt+P` | Alle Befehle |
| `Strg+F`, `Strg+H` | Suchen und Ersetzen, auch mit Regex |
| `Strg+Umschalt+F` | In allen Notizen suchen |
| `Strg+Alt+J` | JSON formatieren (Pretty Print) |
| `Strg+Alt+Umschalt+J` | JSON komprimieren |
| `Strg+/` | Zwischen Live-Ansicht und Markdown-Quelltext wechseln |
| `/` im Live-Editor | Blockmenü: Überschrift, Tabelle, Checkliste … |
| `Strg+D`, `Strg+L`, `Strg+Umschalt+↑↓` | Im Code-Editor: Zeile duplizieren, löschen, verschieben |
| `Alt` + Ziehen, `Strg` + Klick | Im Code-Editor: Spaltenauswahl, Mehrfachcursor |

Neue Tabs landen sofort als Datei im Ordner `Eingang` und heißen nach ihrer ersten Zeile, bis du sie umbenennst oder verschiebst. JSON in eine leere Notiz eingefügt macht daraus eine `.json`-Datei.

## Wo die Daten liegen

| Was | Windows | CachyOS |
|---|---|---|
| Notizen (normale Dateien, Ordner in den Einstellungen änderbar) | `%USERPROFILE%\MyNotes` | `~/MyNotes` |
| Journal, Verlauf, Einstellungen | `%LOCALAPPDATA%\MyNotes` | `~/.local/share/MyNotes` |

Gelöschte Notizen liegen in `.trash` im Notizordner. Mit einem zweiten Sicherungsort in den Einstellungen überstehen Notizen und Verlauf auch einen Plattenausfall. Wie die Absicherung funktioniert und wo ihre Grenzen liegen, steht in [docs/PLAN.md](docs/PLAN.md#3-datensicherheit).

**Live-Editor:** Er erzeugt das Markdown beim Speichern neu, aus `5 * 3` kann also `5 \* 3` werden. Die Bedeutung bleibt gleich, und der Originalstand liegt immer im Verlauf. Notizen, deren Inhalt der Editor verändern würde, öffnen in der Quelltextansicht.

## Bauen

Node.js 22 oder neuer genügt, alles andere bleibt lokal im Projekt.

```sh
npm ci
npm start       # App starten
npm test        # Speicherkern, Absturztest, Formatierer
npm run e2e     # echte App: tippen, hart beenden, neu starten
npm run dist    # Pakete nach release/
```

Für Linux gibt es einen Arch-Devcontainer in `.devcontainer/`. Testlauf ohne Bildschirm im Container:

```sh
xvfb-run -a node tests/e2e.mjs
```
