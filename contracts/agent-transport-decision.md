# Transport decision: agent event delivery — FINAL

Date: 2026-08-29, night
Authority: OWNER-RATIFIED, mini lead thread. Preserved owner words:
"COOL SURE EDIT THE FILE" (~22:40 EDT, ratifying one-path-per-agent with no
mode or switch) and "REANALYZE EVERYTIN AND FINALIZE THE FILE" (~22:55 EDT,
ordering this final complete version). Synthesis by the lead; evidence from
three research passes (web + pinned repos), 2026-08-29.

IN FORCE. Supersedes the both-transports-simultaneously proposal in the
Cloudflare conversion plan and every earlier thread instruction requesting
simultaneous dual delivery. This file is complete: implement it without
returning for transport questions.

## The whole design in four lines

People text an Agent. The Agent is a program on some computer. If that
computer has a public address (a saved webhook subscription), Relay
delivers to the address. If it does not, the program connects out to Relay
and messages flow down the connection. One path per Agent, decided by its
configuration, with no mode, no toggle, and no setting anywhere.

## Scope

This file governs AGENT event delivery only. User/device delivery (iOS app
socket + APNs wake-up + device-applied-sync Delivered) is untouched. The
event envelope, cumulative ACK, checkpoint replay, FULL-sync rule, webhook
signing, Linq retry ladder, and 30-day retention are all already ruled and
unchanged here.

## The rules, complete

1. **The configuration is the path.** An Agent with at least one webhook
   subscription delivers by webhook. An Agent with none delivers by
   WebSocket. No mode field, no toggle, no transport setting exists
   anywhere — not in the API, not in the SDK, not in the Console.
2. **Never both.** No event is ever delivered down both paths.
3. **Conflicts are rejected clearly, both directions.**
   - Socket upgrade while a webhook subscription exists → reject with
     HTTP 409 and an error body saying: this Agent delivers by webhook;
     delete its webhook subscription to use the WebSocket. (Telegram's
     polling-vs-webhook 409, adapted.)
   - Creating a webhook subscription while sockets are connected → the
     subscription is created, all connected sockets are closed with a
     dedicated close code whose reason says webhook delivery is now
     configured, and undelivered events drain to the webhook.
4. **Path changes are loss-free.** Deleting the last webhook subscription
   or creating the first one moves undelivered pending events to the newly
   active path (30-day retention already ruled). Loss is impossible by
   design, not opt-in.
5. **Empty state queues.** A new Agent with no subscription and no
   connection has its events wait durably. Nothing is dropped because the
   developer has not chosen yet.
6. **Console shows state, not choices.** The Agent page shows webhook
   subscriptions (if any), live connection count, last delivery/ACK state,
   and delivery attempts. It offers no transport picker. Codex's earlier
   deletion of the "choose one transport" UI STANDS — what is rejected is
   only simultaneous dual delivery, not the toggle removal.
7. **Webhook hardening.** Reject webhook URLs resolving to localhost,
   private, link-local, or metadata addresses at delivery time (Photon's
   SSRF rule). Never follow redirects; 3xx is terminal. Keep Linq's
   10-second response window and retry ladder exactly.
8. **Socket reliability layer stands as ruled.** Durable queue, cumulative
   ACK, replay from checkpoint, FULL sync when the checkpoint is older than
   retention, multiple sockets per Agent sharing one checkpoint. Adopt
   Hermes' measured keepalive (ping 30 s, pong timeout 60 s —
   `hermes-agent/gateway/relay/ws_transport.py:558-576`, set after a real
   incident).
9. **`relay listen` is DELETED, not postponed.** Stripe built listen
   because webhooks are Stripe's only transport, so laptops needed a
   forwarding trick. Relay's socket makes it pointless: framework plugins
   (OpenClaw, Hermes, Claude Code) connect themselves with the Agent
   Token, and a developer building their own backend develops against the
   SDK socket on a laptop, then adds a webhook subscription at deploy — the
   envelope is identical on both paths, so handler code does not change.
   Do not reintroduce a listen/forward command without a demonstrated need
   the socket cannot serve.
10. **Dedupe guidance stays in the docs.** Webhooks remain at-least-once;
    retries can duplicate. Developers dedupe on `event_id`. Either-or
    removes cross-transport duplication, not retry duplication.

## Out of scope, explicitly (so nobody reopens them as transport questions)

- How many webhook subscriptions one Agent may have, and per-subscription
  event filtering: whatever the already-ruled contract says; rule 1 reads
  "at least one" and works under any answer.
- The shared `/v1/websocket` path serving user devices and Agents with
  auth-determined kind: unchanged from the Cloudflare plan.
- Retry schedule, signing scheme, ACK semantics, retention windows: already
  ruled elsewhere; this file changes none of them.

## What changes in the Cloudflare staging plan

- Delete: same-event dual delivery; "first webhook 2xx or socket ACK wins
  across transports"; cross-transport dedupe burden on developers.
- Keep: the toggle/mode UI deletion (rule 6), all architecture (Workers,
  Durable Objects, Queues, R2, Hyperdrive), replay machinery, staging
  layout.
- Test matrix: replace "both transports simultaneously" rows with — path
  determination by configuration; 409 on socket-while-subscribed; socket
  close-on-subscribe with drain; pending replay on both path-change
  directions; empty-state queueing; SSRF URL rejection; redirect-terminal.

## Why (kept short; full evidence below)

- Precedent is unanimous: Telegram, Slack, Discord, Twitch all ship one
  path at a time; no platform delivers one event down both pipes
  (searched, not found).
- Failure asymmetry: either-or fails visibly (events queue); dual delivery
  fails silently inside every customer's code (double-processing).
- Reversibility: one-path can widen later without breaking anyone; dual
  cannot narrow without breaking running agents.
- Machine classes: serverless cannot hold sockets; laptops cannot receive
  webhooks. One backend is one machine class; the config already says
  which.
- The no-switch shape is the two no-switch platforms' shape (Stripe: one
  transport, nothing to choose; Telegram: the config is the choice). The
  toggle was Slack's concept and earned nothing here.

## Evidence — web (URL per claim)

- Slack recommends HTTP for production; socket backend "recycles
  containers"; Marketplace bans socket apps
  → https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/
- Slack: 10-connection cap; lossy toggle; payloads to any connection
  → https://docs.slack.dev/apis/events-api/using-socket-mode/
- Observed socket failures: delayed/never-delivered events
  (https://github.com/slackapi/bolt-js/issues/1151), silent multi-day death
  (https://github.com/slackapi/node-slack-sdk/issues/1652), crash on
  disconnect (https://github.com/slackapi/node-slack-sdk/issues/1243),
  connected-but-deaf reproduced by OpenClaw
  (https://github.com/openclaw/openclaw/issues/67496)
- Telegram: "two mutually exclusive ways"; 24 h queue drains to the next
  transport; loss opt-in → https://core.telegram.org/bots/api#getting-updates
- Twitch: transport per subscription; disconnect disables subscriptions,
  "no replay" → https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
  ; Conduits decouple subscription from transport
  → https://dev.twitch.tv/docs/eventsub/handling-conduit-events/
- Discord: gateway vs interactions URL "mutually exclusive"
  → https://docs.discord.com/developers/interactions/receiving-and-responding
- Stripe listen (dev forwarding, no account config)
  → https://docs.stripe.com/cli/listen ; GitHub equivalent
  → https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing
- GitLab wanted sockets because self-hosted instances are not public
  → https://gitlab.com/gitlab-org/gitlab/-/issues/416491
- Netflix Dispatch ships both modes; each deployment picks one
  → https://netflix.github.io/dispatch/docs/administration/settings/plugins/configuring-slack

## Evidence — pinned repos (paths under /Users/advaitpaliwal/Code/Relay/_sources)

- Linq docs and 8/8 example repos require ngrok for local webhooks
  (`linq/official-docs/pages/v2/api/operations/webhooksevents/index.md:470-476`,
  `linq/repos/ai-agent-example/README.md:51-56`,
  `linq/repos/strava-agent/README.md:58-64`)
- Linq's own undocumented socket relay CLI
  (`linq/repos/linq-cli/src/commands/webhooks/listen.ts:60-61,173-178`)
- Claude Code channel polls every 3 s to avoid webhooks
  (`linq/repos/claude-code-imessage-channel/README.md:227,273`)
- Photon quickstart requires ngrok; localhost hard-blocked as SSRF
  (`photon/repos/docs/webhooks/quickstart.mdx:6,14`,
  `photon/official-docs/pages/webhooks/managing-webhooks.md:96-98`)
- Photon's own bridge ingests via outbound WebSocket, no HTTP port
  (`photon/repos/webhook/README.md:7-23,61`)
- Hermes retired inbound HTTP: public URL "impossible for hosted gateways"
  (`hermes-agent/docs/relay-connector-contract.md:135-145`)
- OpenClaw local setup non-functional as documented
  (`linq/repos/openclaw-linq-plugin/src/onboarding.ts:232-237`)
- Timeout landmine: Photon allows 30 s per webhook attempt, Linq 10 s;
  Relay copies Linq
  (`photon/official-docs/pages/webhooks/delivery.md:16` vs
  `linq/official-docs/pages/guides/webhooks/index.md:191`)

## The experience this buys

- Server developer: pastes one URL once; one delivery path; visible
  retries; dedupes on `event_id` against retries, as the docs say.
- Framework person (OpenClaw, Hermes, Claude Code, Codex): installs the
  plugin, pastes the Agent Token, starts it. No tunnel, no URL, no
  polling. Reconnect replays what was missed.
- Own-backend tinkerer: SDK socket on the laptop while building; add a
  webhook subscription at deploy; same handler code both ways.
- The person texting the agent: sees nothing, ever.
