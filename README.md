# P1AZ Inspector LAB

Send a decision request to PingOne Authorize and see the verdict, the statements it returned, and the exact call behind it, against a built-in Mock engine or, owner-run, your own PingOne environment or on-prem PingAuthorize.

Tier: Tester
Repo: https://github.com/curtismu7/p1az-inspector-LAB
Catalog: B2 (a stand-in: the shelf catalog has no exact row for this app, and B2, "Authorize policy playground", is the nearest one. The owner assigns the real id.)

## What is simulated

- **Mock mode (default):** a small rule set built into this app answers in PingOne's shape (amount limit, step-up for large withdrawals, consent for transfers, MCP tool deny and human-approval lists; the rules are in `server/src/mockEngine.js`). It works offline with no setup. It is not PingOne Authorize, and every call says Mock answered.
- **Live mode (owner-run):** the same request goes to a decision service you own: a PingOne environment (a worker token, then `/decisionEndpoints/{id}`) or an on-prem PingAuthorize in Docker (`POST <url>/governance/pap/alpha/policy/<policyId>/decision`, no token). The app may reach only the PingOne hosts for your region (the token host, then the API host) or the on-prem URL you typed, and nothing else.
- The simulation banner on every page says which mode is on. The request and response shapes follow an earlier internal integration and are **UNVERIFIED** against PingOne's documentation; the on-prem call has only been checked against a stand-in mock, not a real PingAuthorize.

## Run from a clone

Prerequisites: Node 26 or newer (`.nvmrc` says 26). Docker only for the Docker form.

```sh
git clone https://github.com/curtismu7/p1az-inspector-LAB.git
cd p1az-inspector-LAB
npm ci
npm run build        # builds web/dist, which the server serves
npm start            # http://127.0.0.1:4840/  (loopback only)
```

Open http://127.0.0.1:4840/. With no setup at all, Mock works: press Send on the Console. `npm run dev` runs the API on 4840 and Vite on 4841 for development.

## Settings file

Mock needs no settings. For Live, the app reads four optional PingOne keys from the family's one shared settings file, `~/Development/.env` (mode 600; `STANDALONE_ENV` overrides the path). It only reads that file, never writes it, and takes only these four keys:

- `PINGONE_ENVIRONMENT_ID` (optional): the PingOne environment UUID, used as a default.
- `PINGONE_REGION` (optional): `com`, `eu`, `ca`, `asia`, `com.au` or `sg`, used as a default.
- `PINGONE_CLIENT_ID` (optional): the PingOne worker application's client ID, used as a default.
- `PINGONE_CLIENT_SECRET` (optional): that worker application's secret, used as a default. It is write-only here: no API, log, error or call detail ever returns it.

Admin credentials and vault passwords never go in that file.

**Host runs only.** These four keys are read when you run the app on your machine (`npm start`). The Docker form reads no host files (it mounts nothing from your home folder), so in Docker enter the same values on the **Settings** page; they are kept in the container's named volume. Mounting the shared file into the container is an owner decision and is not done.

Anything you enter on the **Settings** page the app keeps in its own owner-only file, `~/.p1az-inspector/settings.json` (folder mode 700, file mode 600; `DATA_DIR` moves it): the environment, region and worker client if you want to override the shared file, the default decision endpoint, and the on-prem PingAuthorize URL and policy ID. The worker secret is write-only (no API or page ever returns it, and any server echo of it is scrubbed). **Precedence:** a value saved on the Settings page wins over the shared file. The worker client ID and secret are one unit: if you save a client ID or secret on the Settings page, both come from the app's own file, otherwise both come from the shared file. Live stays refused until the environment, client ID and secret are all set. A Save that changes nothing does not copy the shared environment, region or client into the app's own file, so later edits to the shared file still take effect; a value you actually change is saved and wins. The old `~/.config/demo-kit/pingone.json` is no longer read or written.

## Ports, and what to do if the port is taken

Ports: P1AZ Inspector LAB listens on 4840 (set with PORT, default 4840). The Vite dev server uses 4841 (set with VITE_PORT). Docker publishes 4840 on 127.0.0.1 (set with HOST_PORT).
Port range for this app: 4840-4849.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:4840 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.

## Mock and live modes

The header has a **Mock / Live** toggle on every page (Console, Settings, How it fits), also in presenter mode. It shows the current mode (`Mode: mock` or `Mode: live`), and the banner says the same mode. The choice is remembered in the browser; Mock is the default.

- **Mock** answers inside this app. Nothing leaves the machine: a netguard (`server/src/netguard.js`) refuses every non-loopback socket, DNS lookup, fetch and UDP send, with a self-test and a test that a whole default session makes zero attempts.
- **Live** is refused until it is set up: with no connection saved, Send is disabled, the banner says "not set up", and the server answers 400 `not_configured` without touching the network. Once set up, a Live call takes a short-lived permit for each host it is about to call, one at a time, and gives it back when the answer arrives. For the PingOne cloud path that is the token host for your region (`auth.pingone.<region>`) and then the API host (`api.pingone.<region>`); for on-prem it is the one URL you typed. No other host is ever reachable. The optional PingOne base URL setting must be loopback (a stand-in server on this machine), so the secret cannot be sent to a pasted remote URL.
- **The on-prem URL is the one address you type that the server will fetch.** It accepts any `http://` or `https://` address without a user name or password, including a private, link-local or other internal one, and the reply to a successful decision is shown in the call detail. Only a person on this machine can save it or trigger the call (writes need a same-origin request and a loopback Host header), and it is a Live-only opt-in. Enter only a PingAuthorize you own.
- Every call in the list says which engine answered. Live decisions are real calls: use your own environment. CI and the tests never reach a real PingOne or PingAuthorize.
- The Console's deliberate 4xx answers (for example Live before it is set up) show as console messages in the browser.
- Diagram: the "How it fits" page is a ReactFlow diagram with movable boxes, Simulate, Reset and a speed control (rule 17). The diagram is `diagram-studio/1` data in `server/diagrams/p1az-inspector-flow.json`. The server checks it with a copy of the studio validator when it starts (an invalid or missing file stops it from starting, and `npm run doctor` fails) and serves it by name at `GET /api/diagrams/<name>` (names come from a fixed allow-list; anything else is a JSON 404 that does not echo the name). The page fetches the diagram by name and draws it; no boxes or arrows are written in the code. The Docker image copies `server/diagrams`.

## Health, doctor and reset

```
npm run doctor   # Node 26, bind, diagram data valid, state-dir modes, shared settings file mode, netguard self-test, port free
npm run reset    # clears the call log of the running app; saved settings are kept
npm run smoke    # health, one Mock decision, the call log and Reset against the running app (Mock only)
```

`GET /api/health` answers `demo-health/1` (public, GET only, no detail). `POST /api/reset` and the header's **Reset session** button clear the call log and put the diagram boxes back in place (the page remounts). The script cannot move boxes in a browser, so only the button restores box positions. Presenter mode (P, or the Presenter button; Esc leaves it) keeps the banner and the toggle on screen. The talk track is `docs/talk-track.md`, generated from `content/stories.json` (`npm run talk-track`).

## Docker (optional)

```sh
docker compose up --build -d   # http://127.0.0.1:4840
```

The port is published on 127.0.0.1 only (`HOST_PORT` changes the host port). The container runs read-only as a non-root user with no capabilities, mounts nothing from your home folder, and keeps its Live settings in a named volume (it does not read `~/Development/.env`: enter Live settings on the Settings page). Use OrbStack, never Docker Desktop. From inside a container, `localhost` is the container itself: point the on-prem URL at `host.docker.internal` or the other container's name.

## Tests

```sh
npm test
```

On Node 26 this runs the server tests (`node --test test/*.test.js`), the web tests (vitest) and the repo tests (`node --test scripts/*.test.mjs`). Expected on a clean `npm ci`: 65 server, 29 web and 17 repo tests, all passing (111). `npm run e2e` drives a real browser (build first; Mock only, no PingOne). The Learning Hub pack is `content-pack.json`; `npm run content-pack` regenerates and validates it (never hand-edit it).

## Troubleshooting

- **The port is taken.** See "Ports, and what to do if the port is taken" above.
- **Live says "not set up".** Open Settings and enter the environment ID, worker client ID and secret (cloud), or the PingAuthorize URL (on-prem), then save.
- **On-prem is unreachable from Docker.** Use `host.docker.internal` or the container name, not `localhost`.
- **Doctor fails on a file mode.** Run `chmod 700` on the settings folder, or `chmod 600` on the settings file or `~/Development/.env`.
- **The page is blank after `npm start`.** Run `npm run build` first; the server serves `web/dist`.

## Ownership

- Owner: the Ping demo family owner (Tester tier).
- License: MIT (see `LICENSE`).
- Found a problem? Open an issue on the repo.
