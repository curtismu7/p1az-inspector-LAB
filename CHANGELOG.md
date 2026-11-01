# Changelog

## 0.2.0 (unreleased): brought to the -LAB standard
- New repo `p1az-inspector-LAB` with a clean single-commit history, exported from the previous repo's main (no history carried over).
- Header **Mock / Live** toggle on every page with the mode shown and a banner that says the same mode (was a Mock | Real P1AZ control on the Console only). "Real P1AZ" is now "Live". Live stays refused until set up.
- Settings: `~/Development/.env` (read only, four keys: `PINGONE_ENVIRONMENT_ID`, `PINGONE_REGION`, `PINGONE_CLIENT_ID`, `PINGONE_CLIENT_SECRET`) as defaults; values saved on the Settings page win, and the worker client ID and secret are taken as one unit. The secret stays write-only. The shared `~/.config/demo-kit/pingone.json` is no longer read or written, and no per-app `.env` is loaded. The shared file applies to host runs only (Docker reads no host files). A Save with no changes does not pin shared values into the app's own file. The Basic-header form of the client is scrubbed from responses like the secret.
- Removed: the hosted/SE build (`MODE`, `P1AZ_HOSTED`, per-visitor workspaces, `k8s/`, "Hosted and simulated" banner), deferred by the owner.
- Shared stylesheet vendored byte-for-byte; app CSS rewritten with tokens only (BEM names, breakpoints 600/900); tabs instead of links; Theme picker is Auto / Light / Dark.
- Node 26 only (engines, `.nvmrc`, Dockerfile, CI on GitHub-hosted runners with forbidden-strings and gitleaks jobs). Added `smoke`, talk track generated from the stories, repo tests.
- The default token audience in the MCP preset is `mcp-gateway.example`.
- Rule 17: the "How it fits" diagram is `diagram-studio/1` data in `server/diagrams/`, validated at startup, served by name at `GET /api/diagrams/:name` and fetched by the page (it was bundled into the web app). Same boxes, arrows, steps and layout. Doctor checks the data; the Docker image copies it.

## 0.1.0 (previous repo)
- First cut: Console (Transaction, MCP tool and Custom decisions), a Mock engine and real PingOne Authorize in one UI, Settings page, "How it fits" diagram, on-prem PingAuthorize connection, hosted mock-only build (removed in 0.2.0).
