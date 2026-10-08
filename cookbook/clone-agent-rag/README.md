# Clone agent with retrieval

A Relay agent that speaks as a real person. It answers from that person's own
public words: before it gives a view, it searches a store of their writing and
talks, and says where the view comes from. This folder ships with a few
passages from Benjamin Franklin's Autobiography, which is in the public domain.

It runs on Cloudflare Workers with
[Cloudflare Think](https://developers.cloudflare.com/agents/), Workers AI
[`@cf/baai/bge-m3`](https://developers.cloudflare.com/workers-ai/models/bge-m3/)
embeddings and a [Vectorize](https://developers.cloudflare.com/vectorize/)
index. Every Relay tool (`send`, `react`, `stay_silent` and the rest) comes
from [`@relaymessenger/think`](https://www.npmjs.com/package/@relaymessenger/think).

## How it works

1. **Collect the person's public words.** Put each text in `sources/` and list
   it in `sources/sources.json` with its title, date, URL and attribution.
2. **Chunk and embed them.** `npm run ingest` splits each text into passages
   of about 300 words that overlap by 40, embeds each passage with bge-m3
   (1,024 dimensions), and upserts it into Vectorize with its source fields.
3. **Search them at answer time.** The agent has one tool of its own,
   `search_sources`. The model asks it the question in the person's own
   terms; the tool embeds the question with bge-m3 and returns the eight
   closest passages.
4. **Cite sources.** The tool tells the model to answer in its own voice from
   the passages and to say which source a view comes from. It may quote exact
   words only from passages the person wrote or said themselves
   (`own-writing`, `monologue`, `speaker-labeled`), never from a conversation
   without speaker names or from someone writing about them. If nothing
   relevant comes back, it answers in character without inventing a citation.
5. **Keep the persona to one line.** The whole persona is in
   [`src/persona.ts`](src/persona.ts):

   ```ts
   export const PERSONA = "You are Benjamin Franklin, an AI clone built from his public words.";
   ```

   There are no rules about how the person talks. The model already knows who
   they are, and the passages give it their words.

## Label it as an AI clone

An agent that speaks as a real person must never pass as that person.

- Say it is an AI clone in its name, its profile, and its persona line, as
  above.
- Use only words the person made public, and keep the source URL with each
  passage, so every view can be traced back.
- For a living person, get their consent before you publish a clone of them.
  Follow the rules of the platforms you take their words from.

## Run it

You need Node.js 22.22.3 or newer, a Cloudflare account with Workers AI and
Vectorize, and an agent and its Agent Token from
[Relay Console](https://console.relayapp.im).

```sh
npm install
cp .dev.vars.example .dev.vars        # set RELAY_AGENT_TOKEN and RELAY_WEBHOOK_SECRET
```

Set `RELAY_AGENT_HANDLE` in `wrangler.jsonc` to your agent's Relay Handle.

Create the index once, then load the sources into it:

```sh
npx wrangler vectorize create clone-sources --dimensions=1024 --metric=cosine
npm run ingest -- --dry-run           # print the passages; calls nothing
export CLOUDFLARE_ACCOUNT_ID='<your account id>'
export CLOUDFLARE_API_TOKEN='<a token with Workers AI and Vectorize edit>'
npm run ingest
```

Each passage keeps the same id on every run, so running `npm run ingest`
again after you edit a source replaces its passages.

Start the Worker:

```sh
npm start
```

Vectorize has no local mode, so `npm start` reads and writes the real index.
For a public URL, use an HTTPS tunnel and create a Relay webhook subscription
for its `/webhooks/relay` path. To deploy:

```sh
npx wrangler secret put RELAY_AGENT_TOKEN
npx wrangler secret put RELAY_WEBHOOK_SECRET
npm run deploy
```

Then create the webhook subscription for the deployed Worker's
`/webhooks/relay` URL.

## Make your own clone

1. Replace the files in `sources/` with the person's public words, and list
   each one in `sources/sources.json`. Mark each file's `attribution`
   honestly: an interview where every turn names its speaker is
   `speaker-labeled`, a transcript without names is `unlabeled-dialogue`, and
   an article about the person is `about-them`.
2. Change the name in `src/persona.ts`.
3. Run `npm run ingest`.

`MODEL_ID` in `wrangler.jsonc` picks the Workers AI model that answers.

## Files

| File | What it does |
| --- | --- |
| `src/persona.ts` | The one-line persona. |
| `src/passages.ts` | Splits a source into passages with stable ids. |
| `src/search-sources.ts` | The `search_sources` tool: bge-m3, then Vectorize. |
| `src/agent.ts` | The Think agent: the persona, `relayActions(...)` and `search_sources`. |
| `src/index.ts` | Verifies each signed Relay webhook and routes it to its Chat's agent. |
| `scripts/ingest.ts` | Embeds the passages and upserts them into Vectorize. |
| `sources/` | The sample public-domain passages and their manifest. |

## Test

```sh
npm run check
npm test
```

The tests run offline. Workers AI, Vectorize and the Cloudflare API are
mocks, so they make no paid calls.

## Sources

The sample passages are from the *Autobiography of Benjamin Franklin*, edited
by Frank Woodworth Pine (1916),
[Project Gutenberg eBook #20203](https://www.gutenberg.org/ebooks/20203).
Franklin's words are unchanged; the editor's footnotes, footnote numbers and
italic marks are removed.
