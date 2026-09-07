# Contributing

Relay SDK changes must stay inside the current Relay v1 OpenAPI contract.

```bash
npm ci
npm run validate
```

Do not add polling, realtime transport, responding state, typing no-ops,
service discriminators, or APIs absent from the contract.
