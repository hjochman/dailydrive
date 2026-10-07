# Plan: Spotify Client Abstraction & Dual-Backend Support

## Übersicht

Ziel ist es, alle Spotify-API-Aufrufe hinter einer gemeinsamen Schnittstelle (`SpotifyClient`) zu kapseln, so dass zwei austauschbare Implementierungen existieren:

1. **`OAuthSpotifyClient`** — bestehende Logik, basierend auf OAuth2 + `spotify-web-api-node`
2. **`CookieSpotifyClient`** — neue Implementierung in Node.js, die den Ansatz der `SpotAPI-async-v2` nachbaut (TOTP-basierter Token-Abruf über `open.spotify.com/api/token`, Pathfinder-GraphQL-Queries, kein Developer-Account nötig)

Der Nutzer kann im Setup-Wizard und auf der Config-Seite wählen, welches Backend er verwenden möchte. Die gesamte Playlist-Logik in `index.js` und alle Server-Routen in `server.js` bleiben davon unberührt — sie rufen nur noch die abstrakte Schnittstelle auf.

Der `TokenManager` wird als Teil des jeweiligen Clients gekapselt und nur instanziiert, wenn der Client verwendet wird.

---

## Sub-Task 1: Gemeinsame `SpotifyClient`-Schnittstelle definieren

**Status:** [ ] pending

### Intent
Eine klare JavaScript-Schnittstelle (als JSDoc-Interface oder Basisklasse) definieren, die alle benötigten Spotify-Operationen beschreibt. Beide Implementierungen müssen diese Schnittstelle vollständig erfüllen. So kann der Rest des Codes den Client ohne Kenntnisse der Implementierung verwenden.

### Expected Outcomes
- Neue Datei `spotify-client-base.js` mit der abstrakten Schnittstelle (Basisklasse oder Interface-Dokumentation)
- Klare JSDoc-Typen für Rückgabewerte aller Methoden
- Alle benötigten Methoden sind definiert (siehe Todo-Liste)

### Todo List
- [ ] Datei `spotify-client-base.js` anlegen
- [ ] Methoden der Schnittstelle definieren (alle als `async`, Rückgabe normalisiert):
  - `initialize()` — Token laden, TOTP-Session aufbauen oder OAuth-Token prüfen
  - `getShowEpisodes(showId, options)` — Podcast-Episoden abrufen
  - `getMyTopTracks(options)` — Top Tracks des Nutzers (`time_range`, `limit`, `offset`)
  - `getMySavedTracks(options)` — Gespeicherte Songs des Nutzers
  - `getPlaylistItems(playlistId, options)` — Tracks aus einer Playlist lesen
  - `searchTracks(query, options)` — Tracks nach Suchbegriff suchen
  - `replacePlaylistItems(playlistId, uris)` — Playlist-Inhalt ersetzen (PUT)
  - `addPlaylistItems(playlistId, uris)` — Tracks zur Playlist hinzufügen (POST)
  - `getMe()` — Nutzerprofil abrufen
  - `createPlaylist(name, options)` — Neue Playlist anlegen
  - `getUserPlaylists(options)` — Playlists des Nutzers auflisten
  - `getMySavedShows(options)` — Abonnierte Podcasts auflisten
  - `searchShows(query, options)` — Podcast-Shows suchen
  - `searchPlaylists(query, options)` — Playlists suchen
  - `getMyTopArtists(options)` — Top Artists (für Taste Profile)
  - `getPlaylistInfo(playlistId)` — Playlist-Metadaten (Name, Bild, Track-Anzahl)
  - `setPlaylistCoverImage(playlistId, base64Jpeg)` — Cover-Bild setzen (nur OAuth-Implementierung)
- [ ] Jede Methode mit JSDoc-Rückgabeformat dokumentieren (normalisierte Objekte, nicht Raw-API-Response)

### Relevant Context
- Alle aktuell verwendeten Methoden sind in der Analyse (Abschnitte 1 & 8) dokumentiert
- Rückgabeformate orientieren sich an den bestehenden Datenstrukturen in `index.js`
- `setPlaylistCoverImage` wird nur von `OAuthSpotifyClient` implementiert; `CookieSpotifyClient` wirft einen `NotSupportedError`

---

## Sub-Task 2: `OAuthSpotifyClient` — bestehende Logik kapseln

**Status:** [ ] pending

### Intent
Die bestehende Spotify-Logik aus `index.js`, `server.js` und `token-manager.js` in eine Klasse `OAuthSpotifyClient` überführen, die die Schnittstelle aus Sub-Task 1 implementiert. Der Token-Manager wird dabei als private Instanz innerhalb der Klasse gehalten.

### Expected Outcomes
- Neue Datei `spotify-client-oauth.js` mit der Klasse `OAuthSpotifyClient`
- Klasse kapselt `SpotifyWebApi`-Instanz und Token-Refresh-Logik
- `token-manager.js` wird als Modul innerhalb des Clients verwendet, nicht mehr direkt von außen importiert
- `index.js` und `server.js` können den neuen Client per `require('./spotify-client-oauth')` laden

### Todo List
- [ ] Datei `spotify-client-oauth.js` anlegen, Klasse `OAuthSpotifyClient extends SpotifyClientBase` erstellen
- [ ] Konstruktor: Credentials (`client_id`, `client_secret`, `redirect_uri`) entgegennehmen, `SpotifyWebApi`-Instanz als private Property anlegen
- [ ] `initialize()`: Token aus Datei laden, Token-Refresh-Daemon starten (nur wenn als Server-Modus genutzt), Access Token in `SpotifyWebApi` setzen
- [ ] Alle Schnittstellen-Methoden implementieren — Code 1:1 aus `index.js` und `server.js` übernehmen:
  - `getShowEpisodes` ← aus `fetchPodcastEpisodes`-Logik in `index.js`
  - `getMyTopTracks` ← aus `index.js` Zeile 314
  - `getMySavedTracks` ← aus `index.js` Zeile 271
  - `getPlaylistItems` ← direkte `fetch()`-Logik aus `index.js` Zeile 220 (wegen `/items`-Deprecation)
  - `searchTracks` ← aus `index.js` Zeile 364
  - `replacePlaylistItems` ← direkte `fetch()`-Logik aus `index.js` Zeile 501
  - `addPlaylistItems` ← direkte `fetch()`-Logik aus `index.js` Zeile 519
  - `getMe`, `createPlaylist`, `getUserPlaylists`, `getMySavedShows`, `searchShows`, `searchPlaylists`, `getMyTopArtists`, `getPlaylistInfo` ← aus `server.js`-Routen
  - `setPlaylistCoverImage` ← aus `server.js` Zeile 541
- [ ] Methode `getOAuthUrl(scopes, state)` zusätzlich zur Basis-Schnittstelle (OAuth-spezifisch für Setup Wizard)
- [ ] Methode `exchangeCode(code)` für OAuth-Callback (OAuth-spezifisch)
- [ ] Token-Refresh vor jedem API-Aufruf intern sicherstellen (wie bisher per `refreshTokenIfNeeded`)

### Relevant Context
- `token-manager.js` bleibt als eigenständiges Modul erhalten — der Client importiert es intern
- Direkte `fetch()`-Aufrufe für Playlist-Operationen bleiben erhalten (API-Deprecation, siehe AGENTS.md)
- `SpotifyQuotaError` aus `index.js` in die Klasse übernehmen oder in eine eigene Datei auslagern

---

## Sub-Task 3: `CookieSpotifyClient` — SpotAPI-Ansatz in Node.js implementieren

**Status:** [ ] pending

### Intent
Eine zweite Implementierung der Schnittstelle erstellen, die ohne OAuth2/Developer-Account auskommt. Sie nutzt den TOTP-basierten Token-Abruf von `open.spotify.com/api/token` (wie in `SpotAPI-async-v2`) und Spotifys internes Pathfinder-GraphQL-System (`api-partner.spotify.com/pathfinder/v2/query`) — alles in Node.js nachgebaut.

### Expected Outcomes
- Neue Datei `spotify-client-cookie.js` mit der Klasse `CookieSpotifyClient`
- TOTP-Token-Abruf funktioniert (Spotify Web Player JS-Bundle analysieren, TOTP berechnen, Access Token erhalten)
- Alle Schnittstellen-Methoden sind implementiert — außer `setPlaylistCoverImage` (wirft `NotSupportedError`)
- `getMyTopTracks` ist implementiert via `userTopContent` Pathfinder-Operation

### Todo List
- [ ] Datei `spotify-client-cookie.js` anlegen, Klasse `CookieSpotifyClient extends SpotifyClientBase`
- [ ] **TOTP-Session aufbauen** (Kern der Implementierung):
  - `initialize()`: GET `https://open.spotify.com/` → JS-Bundle-Links aus HTML extrahieren
  - JS-Bundles laden → SHA-256-Hashes der Pathfinder-Operations aus Bundle-Code extrahieren (wie `BundleSession` in `SpotAPI-async-v2/spotapi/v2/session.py`)
  - TOTP berechnen (wie `SpotAPI-async-v2/spotapi/v2/specialized/totp.py` — Algorithmus in JS portieren)
  - GET `https://open.spotify.com/api/token?reason=init&productType=web-player&totp=...` → `access_token` erhalten
  - POST `https://clienttoken.spotify.com/v1/clienttoken` → `client_token` erhalten
  - Automatisches Token-Refresh (Access Token läuft nach ~1h ab)
- [ ] **Pathfinder-Query-Methode** implementieren:
  - `pathfinderQuery(operationName, variables)` — POST zu `https://api-partner.spotify.com/pathfinder/v2/query`
  - Headers: `Authorization: Bearer {token}`, `client-token: {client_token}`, `spotify-app-version`, `app-platform: WebPlayer`
  - Paginierung via `paginateQuery(operationName, variables)` (offset-basiert)
- [ ] **Alle Schnittstellen-Methoden** implementieren via Pathfinder oder REST:
  - `getShowEpisodes` → Pathfinder `queryPodcastEpisodes`
  - `getMyTopTracks` → Pathfinder `userTopContent` (entity_type: TRACKS)
  - `getMySavedTracks` → Pathfinder `fetchLibraryTracks`
  - `getPlaylistItems` → Pathfinder `fetchPlaylistContents`
  - `searchTracks` → Pathfinder `searchTracks`
  - `replacePlaylistItems` → spclient `PUT https://spclient.wg.spotify.com/playlist/v2/playlist` (wie in `SpotAPI-async-v2/spotapi/v2/playlist.py`)
  - `addPlaylistItems` → Pathfinder `addToPlaylist`
  - `getMe` → Pathfinder `profileAttributes`
  - `createPlaylist` → spclient (wie `PlaylistHandler.create_playlist()`)
  - `getUserPlaylists` → Pathfinder `libraryV3`
  - `getMySavedShows` → Pathfinder `libraryV3` (Podcasts)
  - `searchShows` → Pathfinder `searchPodcasts`
  - `searchPlaylists` → Pathfinder `searchPlaylists`
  - `getMyTopArtists` → Pathfinder `userTopContent` (entity_type: ARTISTS)
  - `getPlaylistInfo` → Pathfinder `fetchPlaylistMetadata`
  - `setPlaylistCoverImage` → `throw new NotSupportedError(...)`
- [ ] **Credentials-Speicherung:** Session-Cookies + Access Token in `DATA_DIR/.cookie-session.json` persistieren (analog zu `.spotify-token.json`)
- [ ] **Login-Flow dokumentieren:** Im Setup-Wizard muss der Nutzer Spotify-Benutzername und Passwort eingeben (oder Cookies aus dem Browser exportieren)

### Relevant Context
- Referenz-Implementierung: `webapi/SpotAPI-async-v2/spotapi/v2/` — insbesondere `session.py`, `query.py`, `public.py`, `playlist.py`
- TOTP-Algorithmus: `webapi/SpotAPI-async-v2/spotapi/v2/specialized/totp.py`
- Operation-Namen: `Operations`-Enum in `webapi/SpotAPI-async-v2/spotapi/v2/public.py`
- Der `userTopContent`-Pathfinder-Query ist in der Python-Lib als bekannte Operation registriert (`Operations.USER_TOP_CONTENT`) aber noch nicht als Methode implementiert — muss mit richtigen Variablen herausgefunden werden (entity_type, time_range, limit, offset)
- Kein `ugc-image-upload`-Scope verfügbar → `setPlaylistCoverImage` nicht unterstützt

---

## Sub-Task 4: `index.js` auf `SpotifyClient`-Schnittstelle umstellen

**Status:** [ ] pending

### Intent
Die Playlist-Builder-Logik in `index.js` so anpassen, dass sie statt direkt `spotify-web-api-node` zu nutzen die abstrakte `SpotifyClient`-Schnittstelle verwendet. Die eigentliche Logik (Mix-Pattern, Paginierung, State-Caching etc.) bleibt unverändert.

### Expected Outcomes
- `index.js` importiert keinen `SpotifyWebApi` mehr direkt
- Der Client wird über eine Factory-Funktion oder per Parameter übergeben
- Alle Funktionen (fetchPodcastEpisodes, fetchMusicTracks, etc.) verwenden nur noch Client-Methoden der Schnittstelle
- Bestehende Funktionsweise und CLI-Kompatibilität bleiben erhalten

### Todo List
- [ ] `main()` liest `api_mode` aus der Config (`oauth` oder `cookie`) und instanziiert den richtigen Client
- [ ] `spotifyApi`-Instanz durch Client-Instanz ersetzen, `initialize()` aufrufen
- [ ] Alle direkten `spotifyApi.*`-Aufrufe durch Client-Methoden ersetzen
- [ ] Direkte `fetch()`-Aufrufe für Playlist-Operationen in die Client-Methode `replacePlaylistItems`/`addPlaylistItems` verschieben (wurden bereits in Sub-Task 2 & 3 in die Clients eingebaut)
- [ ] `SpotifyQuotaError`-Behandlung bleibt in `index.js` (wirft Client, fängt `main()`)
- [ ] Token-Manager nicht mehr direkt importieren — Token-Lifecycle läuft vollständig im Client

### Relevant Context
- Aktuelle `main()`-Funktion in `index.js` ab ca. Zeile 550
- `refreshTokenIfNeeded(spotifyApi, token)` entfällt als separate Funktion — wird intern vom Client gehandhabt
- CLI-Einstiegspunkt (`node index.js`) muss weiter funktionieren

---

## Sub-Task 5: `server.js` auf `SpotifyClient`-Schnittstelle umstellen

**Status:** [ ] pending

### Intent
Alle Spotify-API-Aufrufe in den Express-Routen von `server.js` auf die gemeinsame Schnittstelle umstellen. Pro Request wird weiterhin ein frischer Client erstellt (oder ein gecachter genutzt) — aber über die gemeinsame Schnittstelle, nicht mehr direkt.

### Expected Outcomes
- Kein direkter `new SpotifyWebApi(...)` mehr in `server.js`
- Eine Hilfsfunktion `createSpotifyClient(mode, creds)` liefert je nach gespeicherter `api_mode`-Config den richtigen Client zurück
- Alle Routen (`/api/*`, `/setup`, `/callback`) nutzen nur noch Client-Methoden
- OAuth-spezifische Routen (`/setup/authorize`, `/callback`) prüfen, ob `OAuthSpotifyClient` aktiv ist

### Todo List
- [ ] Hilfsfunktion `createSpotifyClient(mode, creds)` in `server.js` oder neuer Datei `spotify-client-factory.js` anlegen
- [ ] Token-Daemon-Start beim Server-Start (`tokenManager.startTokenRefreshDaemon`) in `OAuthSpotifyClient.startDaemon()` verschieben — wird nur im OAuth-Modus gestartet
- [ ] Alle `/api/*`-Routen umschreiben: pro Route `createSpotifyClient(...)` aufrufen, dann Client-Methoden nutzen
- [ ] OAuth-Routen (`/setup/authorize`, `/callback`, `/reauth`) auf `OAuthSpotifyClient`-spezifische Methoden `getOAuthUrl()` und `exchangeCode()` umstellen
- [ ] Für `CookieSpotifyClient`: `/setup/authorize` und `/callback` sind nicht relevant — Setup-Wizard zeigt stattdessen Username/Passwort-Eingabe (Step 2 im Cookie-Modus)

### Relevant Context
- `server.js` erstellt aktuell pro Route eine neue `SpotifyWebApi`-Instanz (z.B. Zeilen 508, 568, 604, 925, 963, 1009, 1041)
- `startTokenRefreshDaemon` wird aktuell direkt beim Server-Start aufgerufen (Ende von `server.js`)

---

## Sub-Task 6: Setup-Wizard und Config-Seite erweitern

**Status:** [ ] pending

### Intent
Dem Nutzer im Setup-Wizard und auf der Config-Seite die Wahl zwischen den zwei API-Backends geben. Im OAuth-Modus bleibt der Flow exakt wie heute. Im Cookie-Modus wird stattdessen ein Benutzername/Passwort-Formular angezeigt.

### Expected Outcomes
- Config enthält ein neues Feld `api_mode: oauth | cookie`
- Setup-Wizard zeigt Schritt 1 als Auswahl: "Mit Spotify Developer App (OAuth)" vs. "Mit Spotify Account (kein Developer-Account nötig)"
- Im Cookie-Modus zeigt Step 2 ein einfaches Username/Passwort-Formular statt des OAuth-Flows
- Config-Seite zeigt den aktiven Modus und erlaubt Wechsel
- Warnung auf der Config-Seite wenn Cookie-Modus aktiv: "Cover-Bild setzen nicht verfügbar"

### Todo List
- [ ] `config.yaml`-Schema um Feld `api_mode` erweitern (Default: `oauth`)
- [ ] `views/setup.ejs` — Schritt 0 (neu) oder Schritt 1 als Modus-Auswahl:
  - Zwei Karten: "OAuth (empfohlen)" und "Spotify Account"
  - Kurzbeschreibung pro Modus (Vor-/Nachteile)
  - Wahl speichert `api_mode` in Config
- [ ] `views/setup.ejs` — Schritt 2 konditionell rendern:
  - Modus `oauth`: Bestehender OAuth-Flow (unverändert)
  - Modus `cookie`: Formular mit Spotify-Benutzername + Passwort → POST `/setup/cookie-login`
- [ ] Neue Route `POST /setup/cookie-login` in `server.js`:
  - `CookieSpotifyClient` instanziieren, `initialize()` mit Username/Passwort aufrufen
  - Session-Cookies in `.cookie-session.json` speichern
  - Weiterleitung zu Schritt 3 (Playlist-Auswahl)
- [ ] `views/config.ejs` — Abschnitt "API-Modus":
  - Anzeige des aktiven Modus
  - Dropdown zum Wechseln (mit Warnung: "Wechsel erfordert erneutes Login")
  - Wenn Cookie-Modus: Hinweis "Playlist-Cover-Bild nicht unterstützt"
- [ ] `config.example.yaml` um alle neuen Felder ergänzen (siehe unten)

### Relevant Context
- Setup-Wizard aktuell: 3 Schritte (Credentials → OAuth → Playlist)
- Im Cookie-Modus entfällt Schritt 1 (keine Client-ID/Secret nötig)
- Cookie-Login kann fehlschlagen (falsches Passwort, 2FA) — Fehlerbehandlung in der Route notwendig

---

## Config-Schema: Neue Felder in `config.yaml`

Die folgenden Felder werden neu hinzugefügt. Bestehende Felder bleiben unverändert.

### Neues Top-Level-Feld `api_mode`

```yaml
# --- API-Modus ---
# Legt fest, welches Spotify-Backend verwendet wird.
#
# oauth  (Standard) — Offizielle Spotify Web API über OAuth 2.0.
#         Erfordert eine Spotify Developer App (client_id + client_secret).
#         Unterstützt alle Funktionen inkl. Playlist-Cover-Bild setzen.
#
# cookie — Inoffizieller Ansatz ohne Developer-Account.
#         Nutzt den internen Spotify Web Player Token-Endpunkt (TOTP-basiert).
#         Erfordert Spotify-Benutzername und Passwort (siehe spotify.username/password).
#         Playlist-Cover-Bild setzen wird NICHT unterstützt.
#         Wird automatisch gesetzt, wenn der Setup-Wizard den Cookie-Modus wählt.
api_mode: "oauth"   # "oauth" | "cookie"
```

### Erweitertes `spotify`-Objekt

Das bestehende `spotify:`-Objekt wird um optionale Felder für den Cookie-Modus ergänzt:

```yaml
spotify:
  # OAuth-Modus: Pflichtfelder
  client_id: "your-client-id-here"
  client_secret: "your-client-secret-here"
  redirect_uri: "http://127.0.0.1:8888/callback"

  # Cookie-Modus: Pflichtfelder (nur wenn api_mode: cookie)
  # SICHERHEITSHINWEIS: config.yaml ist in .gitignore — niemals committen!
  # username: "deine-spotify-email@beispiel.de"
  # password: "dein-spotify-passwort"
```

### Persistente Laufzeit-Datei: `.cookie-session.json`

Neu in `DATA_DIR` (analog zu `.spotify-token.json`), wird automatisch angelegt:

```json
{
  "access_token": "...",
  "client_token": "...",
  "expires_at": 1234567890000,
  "client_id": "...",
  "client_version": "...",
  "cookies": [{ "name": "sp_t", "value": "..." }]
}
```

Diese Datei enthält keine Credentials (nur Session-Tokens) und wird bei erneutem Login überschrieben.

### Vollständiges Beispiel der neuen Felder in `config.example.yaml`

```yaml
# --- API-Modus ---
# Legt fest, welches Spotify-Backend verwendet wird.
# oauth  = Offizielle API mit Developer App (empfohlen, alle Features)
# cookie = Kein Developer-Account nötig, kein Playlist-Cover-Bild
api_mode: "oauth"

# --- Spotify App Credentials ---
spotify:
  # OAuth-Modus (api_mode: oauth):
  client_id: "your-client-id-here"
  client_secret: "your-client-secret-here"
  redirect_uri: "http://127.0.0.1:8888/callback"

  # Cookie-Modus (api_mode: cookie) — auskommentiert lassen wenn OAuth genutzt wird:
  # username: "your-spotify-email@example.com"
  # password: "your-spotify-password"
```

### Behandlung in `paths.js`

`resolveSpotifyCredentials()` wird erweitert:

- Liest `api_mode` aus Config (Default: `oauth`)
- Im Cookie-Modus: liest `spotify.username` / `spotify.password` aus Config
- Env-Var-Overrides: `SPOTIFY_USERNAME`, `SPOTIFY_PASSWORD`
- Gibt `api_mode` im zurückgegebenen Objekt mit zurück, damit die Factory-Funktion den richtigen Client instanziieren kann
