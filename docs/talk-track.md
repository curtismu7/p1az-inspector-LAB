# P1AZ Inspector LAB: talk track

Generated from `content/stories.json` by `npm run talk-track`. Do not edit by hand.

Press P (or the Presenter button) for presenter mode: larger text, the Mock / Live toggle and the simulation banner stay on screen. Esc leaves it.
Say which mode you are in before you start: the header and the banner both show it. Mock is simulated; Live is owner-run against your own PingOne environment or PingAuthorize.

## S01. Ask

Pick a preset (a transaction or an MCP tool call) or type your own parameters, and send them. Mock is the default, so this needs no tenant and no network.

## S02. Decide

The engine answers with a verdict, the statements and obligations behind it, and how long it took. The Mock engine says it is Mock on every call.

## S03. Read the call

Open the call to see the exact request and the raw response next to the readable verdict. A permit with an obligation shows as step-up or consent, and INDETERMINATE is never shown as a permit.

## S04. Go live, on purpose

Switch to Live only when you mean to: set up a PingOne environment or an on-prem PingAuthorize on the Settings page. The app may then reach only the PingOne hosts for your region, or the PingAuthorize URL you typed, and nothing else.

## Caveat to say out loud

The request and response shapes follow an earlier internal integration and are UNVERIFIED against PingOne's documentation. The on-prem PingAuthorize call has only been checked against a stand-in, not a real PingAuthorize.
