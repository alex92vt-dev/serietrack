# SerieTrack

App per monitorare gli episodi delle serie TV (stile TV Time).

- **Da guardare**: il prossimo episodio di ogni serie, con ✓ per segnarlo visto
- **Le mie serie**: locandine, avanzamento ed episodi mancanti
- **Calendario**: vista mensile con le uscite e lista delle prossime 30 giorni
- **Cerca**: trova e aggiungi serie (dati TVmaze, gratuiti e senza registrazione)
- **Senza spoiler**: immagini e trame degli episodi non visti restano sfocate finché non le tocchi
- **Trame in italiano** (facoltativo): inserisci una chiave gratuita TMDB nelle Impostazioni
- **Dove vederlo in Italia**: piattaforme in abbonamento, gratis o a noleggio (dati JustWatch via TMDB, serve la stessa chiave), con filtro per piattaforma in "Le mie serie"
- Backup/ripristino dei dati e statistiche delle ore passate davanti alla TV

I dati restano sul telefono (nessun account).

## Struttura

```
www/                  l'app (HTML, CSS, JavaScript, senza build)
capacitor.config.json configurazione per Android
package.json          dipendenze Capacitor
.github/workflows/    compilazione automatica dell'APK su GitHub
```

## Provarla sul computer

```bash
python -m http.server 8765 --directory www
```

Poi apri http://localhost:8765

## Creare l'APK

### Metodo A — GitHub (niente da installare)

1. Crea un repository su GitHub e carica questa cartella (ramo `main`).
2. Vai su **Actions** → **Build APK**: parte da solo a ogni push (o con "Run workflow").
3. Finita la compilazione (~5 min), scarica l'artifact **SerieTrack-apk** e decomprimilo.
4. Copia `app-debug.apk` sul telefono e installalo (consenti "installa app sconosciute").

### Metodo B — Sul tuo PC

Serve: [Node.js](https://nodejs.org) e [Android Studio](https://developer.android.com/studio).

```bash
npm install
npx cap add android
npx cap sync android
npx cap open android
```

In Android Studio: **Build → Build App Bundle(s) / APK(s) → Build APK(s)**.

Dopo ogni modifica ai file in `www/`, rilancia `npx cap sync android`.

### Icona dell'app

Per un'icona personalizzata: metti un PNG 1024×1024 in `assets/icon.png` ed esegui
`npx @capacitor/assets generate --android` dopo `npx cap add android`.
