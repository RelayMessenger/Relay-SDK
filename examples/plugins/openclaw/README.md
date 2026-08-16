# Relay OpenClaw channel (migration landing zone)

Production OpenClaw channel code currently ships from
[`integrations/openclaw`](../../../integrations/openclaw) in this repo
and is bundled by `@relaymessenger/cli`.

This package is the **migration landing zone**: it depends on
`@relaymessenger/core` and will absorb the full channel plugin once the core
transport is stable and Advait signs off on moving the OpenClaw SDK adapters.

Until then:

```bash
npm install -g @relaymessenger/cli
relaymessenger pair
relaymessenger install-openclaw
```
