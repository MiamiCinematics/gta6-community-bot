# GTA 6 Community Discord-Bot

Läuft komplett auf GitHub (GitHub Actions), dein PC kann aus sein. GitHub startet den Bot alle 15 Minuten, er erledigt alles und beendet sich wieder.

| Aufgabe | Wie | Wann |
|---|---|---|
| Rockstar-Posts | YouTube-Feed von Rockstar Games | spätestens ca. 15–30 Min. nach dem Post |
| Deine Posts | YouTube-Feed von Miami Cinematics | spätestens ca. 15–30 Min. nach dem Post |
| 3 Memes pro Tag | Texte aus `memes.json`, Bild über memegen.link (kostenlos) | ab 12 Uhr deutscher Zeit, einmal täglich |
| Begrüßung | neue Mitglieder im General-Chat | spätestens ca. 15–30 Min. nach dem Beitritt |
| Umfrage des Tages | Discord-Umfrage im General-Chat (24 h), Fragen aus `polls.json` | ab 10 Uhr |
| Thema des Tages | Post + Thread im Leaks-and-Speculations-Channel, aus `today.json` (wenn für heute vorhanden) sonst `discussions.json` | ab 15 Uhr |
| Clip-Aufruf | im Clips-Channel (sonst General), mit Clip-Formular | freitags ab 18 Uhr |
| Meilensteine | Post im General-Chat bei 25, 50, 100, 250 … Mitgliedern | beim nächsten Lauf |

Zusätzliche Rechte für den Bot (Servereinstellungen → Rollen → Bot-Rolle): `Create Polls`, `Create Public Threads`, `Send Messages in Threads`.

`today.json` (optional, z. B. von der Tagesanalyse geschrieben):
```json
{ "date": "2026-11-11", "discussion": { "title": "…", "text": "…", "source": "Rockstar Newswire" } }
```

Alle Texte, die im Discord erscheinen, sind auf Englisch und stehen in `config.json` unter `messages`.

## Einmalig einrichten

### 1. Discord-Bot anlegen
1. https://discord.com/developers/applications → **New Application** → Name z. B. "GTA 6 Community".
2. Links **Bot** → **Reset Token** → Token kopieren (geheim halten, nirgends posten).
3. Auf derselben Seite **Server Members Intent** einschalten (für die Begrüßung) → Save.
4. Links **OAuth2 → URL Generator**: Scope `bot`, Rechte `View Channels`, `Send Messages`, `Attach Files`, `Embed Links`. Link unten öffnen und den Bot auf deinen Server einladen.

### 2. Channels
Der Bot sucht die Channels selbst über den Namen:
- Memes: Channel mit "meme" im Namen
- Begrüßung: "general" oder "allgemein"
- Rockstar-Posts: "rockstar", "news" oder "announcement", sonst General
- Deine Posts: "miami-cinematics", "uploads", "social", "content" oder "promo", sonst General

Willst du feste Channels: Im Discord Entwicklermodus an (Einstellungen → Erweitert), Rechtsklick auf den Channel → **Kanal-ID kopieren** und in `config.json` unter `channelIds` eintragen.

### 3. Token bei GitHub hinterlegen
Im Repo auf GitHub: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `DISCORD_TOKEN`
- Wert: der Bot-Token aus Schritt 1

Dann **Actions → GTA 6 Community Bot → Run workflow** zum ersten Test. Der erste Lauf merkt sich nur die vorhandenen Videos und postet noch nichts alt Bekanntes.

## Weitere Plattformen (Instagram, TikTok, X)
Rockstar und du postet auch auf X, Instagram und TikTok. Diese Plattformen haben keine kostenlose Schnittstelle, deshalb sind ab Werk nur die YouTube-Feeds drin. Wenn du für einen Account einen RSS-Feed hast (z. B. über rss.app oder eine RSSHub-Instanz), trag ihn einfach in `config.json` unter `feeds` ein:

```json
{ "name": "Rockstar Games", "platform": "X", "type": "rockstar", "url": "https://..." }
```

`type` ist `rockstar` oder `own` (deine eigenen Posts). `name` muss genau gleich sein wie beim YouTube-Feed desselben Accounts.

**Doppelte vermeiden:** Posts von X, Instagram und TikTok wartet der Bot erst 60 Minuten ab (`holdMinutes`). Erscheint in der Zeit (oder in den 7 Tagen davor) dasselbe auf YouTube, also ein Video mit ähnlichem Titel vom selben Account, postet er nur den YouTube-Link. Sonst postet er den Beitrag ganz normal.

## Memes anpassen
`memes.json`: jede Zeile ist ein Meme (`template` = Vorlage von memegen.link, `text` = Textzeilen). `"phase": "pre"` = nur vor dem Release (19.11.2026), `"post"` = erst danach. Pro Tag werden 3 mit verschiedenen Vorlagen gewählt, Wiederholungen erst, wenn fast alle dran waren.

Lokal testen (ohne Discord):
```
node bot.mjs --test-memes   # 3 Memes nach test-output/
node bot.mjs --dry          # zeigt, was gepostet würde
```

## Gut zu wissen
- `state.json` ist das Gedächtnis des Bots (gesehene Videos, letzte Begrüßung, Meme-Tag). GitHub speichert sie nach jedem Lauf automatisch.
- GitHub startet geplante Läufe manchmal mit Verspätung, deshalb "ca. 15–30 Minuten".
- Bei öffentlichen Repos sind GitHub Actions kostenlos und unbegrenzt. Bei einem privaten Repo reichen die 2.000 Gratis-Minuten pro Monat nicht für alle 15 Minuten; dann in `.github/workflows/bot.yml` auf `*/30` stellen.
- Falls GitHub nach 60 Tagen ohne Aktivität die geplanten Läufe pausiert, schickt GitHub eine Mail; dann unter Actions einmal auf **Enable workflow** klicken.
