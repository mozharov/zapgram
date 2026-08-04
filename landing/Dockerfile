# ZapGram marketing site — static EN/RU on nginx
# Build context: ./landing (see docker-compose landing service)

FROM node:22-alpine AS build

WORKDIR /build

RUN npm install --global --no-fund --no-update-notifier clean-css-cli@5.3.3

COPY . .

RUN mkdir -p /out \
    && cp -a assets ru /out/ \
    && cp index.html 404.html robots.txt sitemap.xml llms.txt pricing.md /out/ \
    && cleancss -O1 --output /out/styles.css styles.css

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out/ /usr/share/nginx/html/

EXPOSE 80
