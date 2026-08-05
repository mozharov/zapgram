# ZapGram marketing site — static EN/RU on nginx
# Build context: ./landing (see docker-compose landing service)
# Document root: everything under public/
#
# Optional analytics: pass POSTHOG_PROJECT_TOKEN + POSTHOG_HOST + POSTHOG_PROXY_HOST.
# Same public project token as the bot; empty token leaves analytics disabled.
# POSTHOG_HOST       → cloud
# POSTHOG_PROXY_HOST → api_host (managed reverse proxy for the browser)

FROM node:22-alpine AS build

WORKDIR /build

ARG POSTHOG_PROJECT_TOKEN=
ARG POSTHOG_HOST=https://eu.i.posthog.com
ARG POSTHOG_PROXY_HOST=

RUN npm install --global --no-fund --no-update-notifier clean-css-cli@5.3.3

COPY nginx.conf ./nginx.conf
COPY public/ ./public/

RUN cleancss -O1 --output public/styles.css public/styles.css

# Inject PostHog config when a project token is provided at build time.
RUN if [ -n "$POSTHOG_PROJECT_TOKEN" ]; then \
      sed -i \
        -e "s#__POSTHOG_PROJECT_TOKEN__#${POSTHOG_PROJECT_TOKEN}#g" \
        -e "s#__POSTHOG_HOST__#${POSTHOG_HOST}#g" \
        -e "s#__POSTHOG_PROXY_HOST__#${POSTHOG_PROXY_HOST}#g" \
        public/assets/analytics.js; \
    fi

FROM nginx:1.27-alpine

COPY --from=build /build/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/public/ /usr/share/nginx/html/

EXPOSE 80
