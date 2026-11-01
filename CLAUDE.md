# CLAUDE.md

P1AZ Inspector LAB (Tier: Tester, port 4840, range 4840-4849). Send a decision request to a built-in **Mock** engine (the default) or, owner-run, **Live** (a PingOne environment you own, or an on-prem PingAuthorize in Docker) and see the verdict, the statements and the exact call. Rulebooks: `~/Development/STANDALONE-RULES-FOR-AGENTS.md` and `~/Development/STANDALONE-CSS-STANDARD.md` (use the `standalone-demo` skill).

## Commands (from package.json)

```bash
npm ci
npm test             # server (node:test, glob) + web (vitest) + scripts/*.test.mjs
npm run build        # builds web/dist, served by the server itself
npm start            # http://127.0.0.1:4840/  (PORT to change)
npm run dev          # API on 4840, Vite on 4841
npm run doctor       # node 26, bind, state-dir modes, netguard self-test, free port (PORT=4849 to dodge a running copy)
npm run reset        # POST /api/reset on the running app (clears the call log; Settings are kept)
npm run smoke        # health, one Mock decision, call log, Reset, against the running app (never sends Live)
npm run e2e          # real browser, loopback only; build first
npm run content-pack # regenerates and validates content-pack.json (do not hand-edit it)
npm run talk-track   # regenerates docs/talk-track.md from content/stories.json (a test fails on drift)
```

Docker (OrbStack, never Docker Desktop): `docker compose up --build -d` (publishes `127.0.0.1:` only; HOST_PORT in 4840-4849).

## Rules that bite here

- **Mock / Live toggle in the header on every page**, the mode shown (`Mode: mock|live`) and the banner saying the same mode, presenter mode (P / Esc) included. The mode lives in `App.jsx`; pages read it. Never a bare `MODE` env var (the shared settings file is read by every app); Live is refused until set up (server 400 `not_configured`, Send disabled).
- **Zero outbound by default (netguard).** `server/src/netguard.js` refuses every non-loopback socket, DNS lookup, fetch and UDP send. Live calls take a permit for each host they call, one at a time (PingOne token host, then API host, or the on-prem URL) (`permit(host)` -> `release()` in `live.js`). Mock never touches the network. Never add an outbound call that does not go through `live.js`.
- **Secrets are write-only.** The worker client secret and tokens are never in a response, log line or error (`settings.js` publicView, `redact.js` scrub). Tokens in the UI are shown raw only when they are Mock-issued and labelled.
- **Settings.** `~/Development/.env` (or `STANDALONE_ENV`) is READ ONLY and only `PINGONE_ENVIRONMENT_ID`, `PINGONE_REGION`, `PINGONE_CLIENT_ID` and `PINGONE_CLIENT_SECRET` are taken from it (`util.parseEnv`, then picked; owner 2026-11-01). Admin credentials and vault passwords never go in it. Precedence: values saved on the Settings page win; the worker client is one unit (an own client ID or secret means both come from the own file, else both from the shared file). The app's own file is `<DATA_DIR>/settings.json` (default `~/.p1az-inspector`, 700/600). `~/.config/demo-kit/pingone.json` is superseded: not read, not written. Host runs only: the Docker form reads no host files (owner decision pending on mounting it). `settings.secrets()` also returns the base64 `clientId:secret` Basic form. A no-change Save pins nothing. Tests point `STANDALONE_ENV` at a temp file; never read the real one.
- **Loopback only.** Bind `127.0.0.1`; keep the Host check and the same-origin write check (`security.js`) in front of every route. Docker publishes `127.0.0.1:` only.
- **CSS standard.** `web/src/styles/standalone-ui.css` is vendored byte-for-byte from `~/Development/AI-DEMO-Standalone/shared/standalone-ui.css` (never edit it) and loads before `app.css`. App CSS: tokens only, no colour literals, no `prefers-color-scheme`, no `!important`, no italics, breakpoints 600/900 only. Check: `bash ~/Development/AI-DEMO-Standalone/scripts/check-css.sh .`
- **No identifiers from other projects.** Test fixtures use `00000000-0000-4000-8000-000000000000` and `.example` / `.invalid` hosts. The forbidden-strings scan must print 0: `git log -p --all | grep -cF -f ~/.config/demo-kit/forbidden-strings.txt`. Never print or copy that file. gitleaks runs in `.githooks/pre-commit`; do not bypass it.
- **Test scripts use globs, never directories** (`node --test test/*.test.js`). Never parse `node:test` stdout: use the exit code.
- **Never use `crypto.generateKeyPairSync('ec')` or async `generateKeyPair`** (SIGABRT on Node 20 in CI); a repo test greps for it.
- **Product claims are UNVERIFIED unless sourced.** The decision-endpoint shapes follow an earlier internal integration, and the on-prem PingAuthorize call has only been checked against a stand-in mock. Say so in docs and UI.
- **No k8s, no SE build** (deferred by the owner, 2026-10-31); a repo test pins that.
- Diagram (rule 17): ReactFlow, drawn from `diagram-studio/1` DATA in `server/diagrams/<name>.json`. `server/src/diagramData.js` validates every file at startup (validator copy `diagramStudioValidate.js`; a bad file stops the server, doctor fails) and `GET /api/diagrams/:name` serves it by allow-listed name (JSON 404, no echo, no prototype keys). `web/src/pages/Diagram.jsx` fetches it by name; `web/src/lib/flowFromDiagram.js` only maps data to ReactFlow props. Never write nodes or edges in the component; change the JSON. To add a diagram: add the file, add its name to `DIAGRAM_NAMES`. The Dockerfile copies `server/diagrams`.

## Where the safety claims are pinned

- `server/test/netguard.test.js`: the guard's self-test, permits, and ZERO attempts across a whole default session.
- `server/test/api.test.js`: Host/Origin guards, secret never returned, mock and live answer in the same shape, the shared settings file is read for its four PingOne keys only (secret never returned or logged) and never written.
- `server/test/doctor.test.js`: `demo-health/1`, doctor checks.
- `server/test/diagrams.test.js`: diagram data valid, served by name, unknown / prototype names refused, invalid file refused at startup.
- `server/test/reset.test.js`: Reset clears the log and keeps Settings.
- `web/src/pages/__tests__/`: Console, Diagram (renders from fetched data), Settings, the header toggle and banner, Reset, presenter mode.
- `scripts/repo.test.mjs`: README standard, CSS standard, CI, shelf entry and catalog id, talk-track drift, no k8s/MODE/EC keygen.
- `scripts/content-pack.test.mjs`: the hub pack validates and is exactly what the build script generates.

## Shelf and content pack

- Edit `content/terms.json` and `content/stories.json`, then `npm run content-pack` and `npm run talk-track`. The catalog id `B2` (`CATALOG` in `scripts/build-content-pack.mjs`) is a stand-in until the owner assigns one; the shelf entry and README carry the same id and a test pins all three.
- The shelf entry is `docs/shelf-entry.json` (port 4840, relative `composeFile`). Change the port or id only with the shelf owner.
