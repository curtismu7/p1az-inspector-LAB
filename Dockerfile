# Build the web app, then run the API server, which also serves web/dist. Node 26 only (rulebook). Docker on OrbStack, never Docker Desktop.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w web

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4840 DATA_DIR=/data
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts -w server && npm cache clean --force && mkdir /data && chown node:node /data && chmod 700 /data
COPY server/src server/src
COPY server/diagrams server/diagrams
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 4840
# Inside the container the server must listen on all interfaces, so P1AZ_BIND is set here on purpose. The compose file publishes the
# port on 127.0.0.1 only; do not publish it more widely. The Host check still accepts only loopback names.
ENV P1AZ_BIND=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD node -e "fetch('http://127.0.0.1:4840/api/health').then(r=>r.json()).then(j=>process.exit(j.schema==='demo-health/1'&&j.state!=='broken'?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
