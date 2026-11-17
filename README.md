Indexador personal de Telegram con búsqueda, thumbnails, streaming y clasificación con IA.

## Features

- 📚 3 bases de datos separadas: `mangas`, `videos`, `otros` (SQLite nativo)
- 🔍 Búsqueda con filtros: extensión, serie, categoría, tamaño, tipo
- 🖼️ Thumbnails cacheados desde Telegram
- 🎬 Streaming HTML5 de videos sin descargarlos completos
- 🤖 Identificación con Gemini Vision (renombra archivos sintéticos)
- 📊 Estadísticas y agrupación por serie
- 🌐 Interfaz web (Express + vanilla JS)
- 💬 Bot WhatsApp (opcional)

## Requisitos

- Node.js 22.5+ (usa `node:sqlite` nativo)
- Cuenta Telegram con `API_ID` y `API_HASH` ([my.telegram.org](https://my.telegram.org/apps))
- API key de Google AI Studio (gratis, sin tarjeta) ([aistudio.google.com](https://aistudio.google.com/apikey))

## Instalación

```bash
git clone https://github.com/USERNAME/bot_Tg.git
cd bot_Tg
pnpm install
cp .env.example .env
nano .env   # rellenar API_ID, API_HASH, GEMINI_API_KEY
node index.js login
node index.js scan force -c @canal
node index.js thumbs -d videos -l 500
node index.js web
```

---

📖 Comandos disponibles

Todos los comandos se ejecutan con node index.js <comando> [opciones].

🔐 Autenticación

Comando Descripción
login Inicia sesión en Telegram. Guarda la sesión en .session para reutilizarla. Solo se hace una vez.

```bash
node index.js login
```

---

📥 Escanear canales

Comando Descripción
scan [mode] Escanea canales/grupos e indexa sus archivos en las DBs. mode puede ser new (solo mensajes nuevos desde data.json) o force (desde cero).
set-date <iso> Cambia la fecha base scanFrom en data.json. Solo afecta a futuros scan new.

Opciones de scan:

· -c, --channel <chat> — Solo este canal (@user, ID o título)
· --reset — Borrar progreso antes de escanear
· --max-msgs <n> — Límite de mensajes por chat (0 = sin límite)

```bash
node index.js scan new                          # solo nuevos
node index.js scan force -c @MangaBluease1080p  # un canal desde cero
node index.js scan force --max-msgs 500         # todos, máximo 500 msgs
node index.js scan new --reset                  # borra progreso y escanea
node index.js set-date 2024-06-01               # cambiar fecha base
```

---

🔍 Buscar

Comando Descripción
search [query...] Busca archivos por nombre en las 3 DBs (o en una específica).

Opciones de search:

· -d, --db <name> — DB específica (mangas, videos, otros)
· -l, --limit <n> — Máximo de resultados (default 20)
· -c, --category <cat> — Categoría
· -e, --ext <ext> — Extensión (pdf, mp4, cbz…)
· -s, --series <name> — Filtro por serie
· --kind <kind> — Tipo de video (anime_movie, anime_series, movie, serie)
· --min-size <mb> — Tamaño mínimo en MB
· --max-size <mb> — Tamaño máximo en MB
· -o, --offset <n> — Paginación

```bash
node index.js search "one piece"
node index.js search --db videos "naruto"
node index.js search --db videos --kind anime_series
node index.js search --db mangas -e cbz "berserk"
node index.js search --series "one piece" -l 50
```

---

⬇️ Descargar

Comando Descripción
download <db> <id> Descarga un archivo por ID (los IDs salen de search o files). db puede ser mangas, videos, otros o auto.
download-all [query...] Descarga todos los archivos que coincidan con la búsqueda.

Opciones de download:

· -o, --out <dir> — Carpeta destino (default ./downloads)
· --force — Sobrescribir si ya existe

Opciones de download-all:

· -d, --db <name> — DB (default auto = todas)
· -c, --category <cat> — Categoría
· -e, --ext <ext> — Extensión
· -l, --limit <n> — Máximo de archivos (default 10)
· -o, --out <dir> — Carpeta destino
· --force — Sobrescribir

```bash
node index.js download videos 42
node index.js download auto 42 -o ./mangas
node index.js download-all --db videos -l 5 "naruto"
node index.js download-all --db mangas -e cbz "one piece"
```

---

🖼️ Thumbnails

Comando Descripción
thumbs Descarga los thumbnails de Telegram (miniaturas de video, portadas de PDF) y los cachea en data/thumbnails/. Los marca como has_thumb = 1 en la DB.

Opciones de thumbs:

· -d, --db <name> — DB (videos, mangas, otros, all)
· -l, --limit <n> — Máximo a descargar (0 = sin límite)
· --delay <ms> — Pausa entre descargas (default 200ms)
· --force — Re-descargar aunque ya existan

```bash
node index.js thumbs -d videos -l 500
node index.js thumbs -d mangas -l 1000
node index.js thumbs --delay 100            # más rápido
node index.js thumbs --force                # re-descargar todo
```

---

🤖 Identificar con Gemini

Comando Descripción
synthetic Lista los archivos con nombre sintético (file_123, video_456, video.mp4) que necesitan ser identificados.
identify <db> <id> Identifica UN archivo con Gemini Vision y lo renombra en la DB.
identify-batch <db> Identifica varios archivos de una DB en lote.
identify-all Identifica TODOS los archivos con nombre sintético (o todos si --force).

Opciones de synthetic:

· -d, --db <name> — DB (videos, mangas, all)
· -c, --category <cat> — Filtro por categoría
· -e, --ext <ext> — Filtro por extensión
· -l, --limit <n> — Máximo a mostrar (default 50)

Opciones de identify:

· --no-apply — Solo mostrar resultado, no tocar la DB
· --rename-on-disk — También renombrar el archivo descargado

Opciones de identify-batch:

· -c, --category <cat> — Filtro por categoría
· -e, --ext <ext> — Filtro por extensión
· -l, --limit <n> — Máximo (default 10)
· --delay <ms> — Pausa entre requests (default 4500ms)
· --no-apply — Solo mostrar
· --rename-on-disk — Renombrar en disco

Opciones de identify-all:

· -d, --db <name> — DB (videos, mangas, all)
· -c, --category <cat> — Filtro por categoría
· -e, --ext <ext> — Filtro por extensión
· -l, --limit <n> — Máximo archivos (0 = sin límite)
· --delay <ms> — Pausa entre requests (default 4500ms)
· --force — Procesar TODOS (no solo sintéticos)
· --no-apply — Solo mostrar
· --rename-on-disk — Renombrar en disco

```bash
node index.js synthetic -l 20
node index.js identify videos 42 --no-apply          # dry-run
node index.js identify videos 42                     # aplicar
node index.js identify-batch videos -l 10
node index.js identify-all -d videos -l 100
node index.js identify-all --no-apply > report.txt
```

---

📊 Info y consultas

Comando Descripción
stats Estadísticas de las 3 DBs: total archivos, tamaño, canales, por categoría, por tipo de video.
channels Lista todos los canales indexados con conteo de archivos y tamaño.
files Lista archivos de una DB (con filtros).
series [chat] Con chat: series de mangas de ese canal. Sin chat: series de videos.
categories Lista las categorías disponibles y sus extensiones.
link <id> Devuelve el enlace directo de Telegram de un archivo por ID.

Opciones de files:

· -d, --db <name> — DB (mangas, videos, otros)
· -c, --channel <chat> — Filtro por canal
· --category <cat> — Filtro por categoría
· -e, --ext <ext> — Filtro por extensión
· -l, --limit <n> — Límite (default 50)
· -o, --offset <n> — Paginación

Opciones de series:

· -d, --db <name> — DB (videos o mangas)
· --top <n> — Top N series (default 50)
· --min <n> — Mínimo archivos por serie (default 1)

Opciones de link:

· -d, --db <name> — DB específica (si el ID existe en varias)

```bash
node index.js stats
node index.js channels
node index.js files --db videos -l 30
node index.js files --db mangas -c @MangaBluease1080p
node index.js series @MangaBluease1080p --top 20
node index.js series --db videos
node index.js categories
node index.js link 42 -d videos
```

---

🌐 Interfaz web

Comando Descripción
web Levanta el servidor web con búsqueda, thumbnails, streaming y controles de scan/thumbs/identify.

Opciones de web:

· -p, --port <n> — Puerto (default 3000)
· -h, --host <host> — Host (default 127.0.0.1, usa 0.0.0.0 para acceso LAN)

```bash
node index.js web                        # solo local
node index.js web -p 8080                # puerto custom
node index.js web -h 0.0.0.0             # accesible desde LAN
```

Abrir en el navegador: http://127.0.0.1:3000

---

💬 WhatsApp (opcional)

Comando Descripción
wa-bot Inicia el bot de WhatsApp que consulta las DBs (buscar, paginar, descargar).
wa-cli REPL interactivo de WhatsApp para debug (enviar mensajes, imágenes, docs).
wa-connect Solo conectar WhatsApp con pairing code, sin bot.

Opciones de wa-connect:

· -p, --phone <numero> — Número con código país (sin +)

```bash
node index.js wa-bot
node index.js wa-cli
node index.js wa-connect -p 5351092358
```

---

🏗️ Estructura

```
.
├── index.js              # CLI unificado (todos los comandos)
├── connection/           # Telegram + WhatsApp
│   ├── telegram.js
│   ├── whatsapp.js
│   └── wa-cli.js
├── db/                   # SQLite (3 DBs + helpers)
│   └── index.js
├── modules/              # Lógica de negocio
│   ├── categorizer.js    # Clasificación por extensión/MIME
│   ├── identifier.js     # Identificación con Gemini
│   ├── scanner.js        # Escaneo force/new
│   ├── series.js         # Agrupación de mangas
│   ├── thumbnails.js     # Descarga de thumbs
│   ├── title-normalizer.js
│   ├── video-classifier.js
│   ├── video-tagger.js
│   └── telegram-indexer.js
├── web/                  # Interfaz web
│   ├── server.js
│   ├── stream.js
│   ├── jobs.js
│   ├── routes/api.js
│   └── public/
└── data/                 # DBs + thumbnails (gitignored)
```

---

📊 Flujo típico

```bash
# 1. Login (una vez)
node index.js login

# 2. Escanear todo
node index.js scan force

# 3. Ver qué tienes
node index.js stats

# 4. Indexar thumbnails
node index.js thumbs -l 2000

# 5. Identificar sintéticos con Gemini
node index.js synthetic -l 20
node index.js identify-all -d videos -l 100

# 6. Ver la web
node index.js web

# 7. Día a día
node index.js scan new     # solo nuevos
node index.js thumbs       # solo los que falten
```

---

⚙️ Filtros automáticos

Al escanear, categorizer.js descarta basura automáticamente:

Categoría Tamaño mínimo Duración mínima (videos)
Libros (PDF/CBZ/EPUB) 1 MB —
Videos 10 MB 3 min (180s)
Audio 10 MB —
Resto 10 MB —

También descarta stickers, GIFs animados, videos redondos y notas de voz.

Configurable por .env: MIN_VIDEO_MB, MIN_VIDEO_SEC, MIN_BOOK_MB, MIN_GENERIC_MB.

---

Licencia

MIT
