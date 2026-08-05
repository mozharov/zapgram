# ZapGram marketing site

Static EN + RU landing (no build step). Separate from the Bun Telegram bot runtime.

## Structure

```
landing/
  public/                  # document root (everything here is served)
    index.html             # EN canonical + JSON-LD
    ru/index.html          # RU + JSON-LD
    404.html               # EN noindex error page
    ru/404.html            # RU noindex error page
    styles.css
    assets/logo.svg          # ZapGram mark (edit in place only)
    assets/favicon.svg       # tab icon (fixed-size logo)
    assets/favicon.ico       # multi-size ICO (16 + 32)
    assets/favicon-16.png    # 16×16 PNG
    assets/favicon-32.png    # 32×32 PNG
    assets/apple-touch-icon.png  # 180×180 iOS home screen
    favicon.ico              # root copy for /favicon.ico probes
    assets/telegram-logo.svg # official Telegram logo (telegram.org)
    assets/og-card.html      # OG EN source
    assets/og-card-ru.html   # OG RU source
    assets/og.png            # EN Open Graph / Twitter 1200×630
    assets/og-ru.png         # RU Open Graph / Twitter 1200×630
    assets/fonts/            # self-hosted Sora + IBM Plex (woff2)
    robots.txt
    sitemap.xml
    llms.txt               # AI agent context
    pricing.md             # machine-readable fees
  scripts/render-og.mjs    # HTML → PNG via Chromium
  Dockerfile               # production nginx image with minified CSS
  nginx.conf               # compression, caching, locale-aware 404
  README.md
```

## 404 routing (nginx)

- Missing paths under `/ru/` serve `ru/404.html` with HTTP 404.
- All other missing paths serve `404.html` with HTTP 404.
- Both error documents are `internal` (not directly browsable).
- Error page asset URLs are root-absolute (`/styles.css`, `/assets/…`) so CSS and the logo load even when the browser address bar shows a deep missing path.


## Local preview

From repo root:

```bash
bunx --bun serve landing/public -p 4321
# open http://localhost:4321
```

Or run it with the project Compose stack:

```bash
docker compose up --build landing
# open http://localhost:4321
```

The Compose image minifies `public/styles.css` during the build and copies the
entire `public/` tree into nginx. Add new static files under `public/` only —
no Dockerfile changes.

## Schema (JSON-LD)

Both locales ship an `@graph` with:

- `Organization`
- `WebSite` (no SearchAction — no site search)
- `WebPage`
- `SoftwareApplication` (free Telegram bot)
- `HowTo` (start flow)
- `FAQPage` (matches visible FAQ)

## Brand

Logo: `public/assets/logo.svg` only — owner-edited; no separate brand folder; CSS must not invert/outline the mark.

## Favicons

Derived from `logo.svg` (do not redesign the mark):

| File | Use |
|---|---|
| `assets/favicon.svg` | modern browsers |
| `assets/favicon.ico` + root `favicon.ico` | legacy / auto `/favicon.ico` |
| `assets/favicon-16.png` / `favicon-32.png` | PNG fallbacks |
| `assets/apple-touch-icon.png` | iOS home screen (180×180) |

After editing the logo:

```bash
bun landing/scripts/render-favicon.mjs
```

## Open Graph images

Sources: `public/assets/og-card.html` (EN) and `public/assets/og-card-ru.html` (RU) — logo + H1 + sub, no CTA.

```bash
bun landing/scripts/render-og.mjs   # → public/assets/og.png + og-ru.png
```

Requires Playwright Chromium in `~/Library/Caches/ms-playwright` (or `CHROME_PATH`).

## CTA

Primary: https://t.me/zap_gram_bot  
Secondary: https://github.com/mozharov/zapgram

## Analytics (PostHog)

Optional. Empty / unreplaced token disables PostHog only.

| Build arg / env | Used by | Default | Role |
|---|---|---|---|
| `POSTHOG_PROJECT_TOKEN` | bot + landing | — | Public project API key |
| `POSTHOG_HOST` | bot (`host`) | `https://eu.i.posthog.com` | Cloud ingest / UI region |
| `POSTHOG_PROXY_HOST` | landing only (`api_host`) | `https://proxy-url.com` | Managed reverse proxy (ad-block bypass) |

Speed model (critical path stays free of PostHog):

1. Deferred `/assets/analytics.js` rewrites bot CTAs locally (`?start=lp_<visitor_id>` from `localStorage`) — no network.
2. After `window.load` + `requestIdleCallback`, loads the official PostHog snippet + `array.js` via the reverse proxy (pageviews / `landing_cta_click`).
3. Bot `/start` aliases that id onto the Telegram user and captures `bot_started` with `from_landing`.

Session replay and feature flags stay off on the landing; autocapture is on.

```bash
docker compose build landing
```
