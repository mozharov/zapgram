# ZapGram marketing site — static EN/RU on nginx
# Build context: ./landing (see docker-compose landing service)
# Document root: everything under public/

FROM node:22-alpine AS build

WORKDIR /build

RUN npm install --global --no-fund --no-update-notifier clean-css-cli@5.3.3

COPY nginx.conf ./nginx.conf
COPY public/ ./public/

RUN cleancss -O1 --output public/styles.css public/styles.css

FROM nginx:1.27-alpine

COPY --from=build /build/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/public/ /usr/share/nginx/html/

EXPOSE 80
