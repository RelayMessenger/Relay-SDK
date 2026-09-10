# Contributing

Relay SDK changes must stay inside the current Relay v1 OpenAPI contract.

```bash
npm ci
npm run validate
```

Do not add polling, realtime transport, responding state, typing no-ops,
service discriminators, or APIs absent from the contract.

## Updating the Relay contract

`contracts/relay-v1-openapi.yaml` is vendored from Relay-Server. When it
changes (precedent: commit 010980a):

1. Copy the new file byte-for-byte to every vendored path that
   `scripts/validate-contract-copies.mjs` lists, and move `api.commit` and
   `api.openapi_sha256` in `skills/relay/references/relay-v1-lock.json` and its
   copy `plugins/relay/skills/relay/references/relay-v1-lock.json`. Run
   `npm run metadata:sync`. Commit.
2. Run `node scripts/contract-pin.mjs`. It tags that commit as
   `contract/<first 8 of api.openapi_sha256>`, pushes the tag, and prints the
   commit to pin.
3. Set `api.public_source.commit` in both lock files to the printed commit and
   commit again. The tag is what keeps that commit readable after the squash
   merge drops the PR-branch commits; `npm run validate` refuses a pin that is
   not reachable from `origin/main`, `origin/staging`, or that tag.
