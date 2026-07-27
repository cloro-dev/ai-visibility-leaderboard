# AI Visibility Leaderboard

A public weekly dataset of which brands AI assistants actually recommend.

Every Monday, [cloro](https://cloro.dev) asks ChatGPT, Perplexity, Gemini,
Copilot, and Google AI Mode the same buyer-intent questions across twelve
software categories, and measures which brands the answers **mention** and
which they **cite**. Each week is committed here as a dated, immutable
snapshot.

Rendered at **<https://cloro.dev/ai-visibility/>**.

## Snapshots

| Path | Contents |
| --- | --- |
| `index.json` | Every published week, newest in `latest` |
| `snapshots/<YYYY-MM-DD>.json` | One week, keyed by the Monday it covers |

```bash
# newest week
curl -s https://raw.githubusercontent.com/cloro-dev/ai-visibility-leaderboard/main/index.json \
  | jq -r .latest

# fetch it
curl -s https://raw.githubusercontent.com/cloro-dev/ai-visibility-leaderboard/main/snapshots/2026-07-27.json
```

## Schema

```jsonc
{
  "meta": {
    "schema_version": "1.0",
    "week_start": "2026-07-27",     // the Monday (UTC) this week covers
    "generated_at": "...",           // when this file was written
    "methodology_version": 1,        // bump = scoring changed, weeks not comparable
    "methodology_url": "https://cloro.dev/ai-visibility/methodology/",
    "license": { "data": "CC-BY-4.0", "code": "MIT" }
  },
  "engines": [{ "key": "chatgpt", "label": "ChatGPT" }],
  "categories": [
    {
      "slug": "serp-apis",
      "name": "SERP APIs",
      "sample_size": { "prompts": 5, "responses": 25 },
      "entries": [
        {
          "rank": 1,
          "brand": "SerpApi",
          "domain": "serpapi.com",
          "score": 75.4,             // AI Visibility Score, 0-100
          "share_of_voice": 0.21,    // this brand's mentions / all mentions
          "mention_rate": 0.8,       // answers naming the brand
          "citation_rate": 0.44,     // answers linking the brand's own domain
          "avg_position": 2.1,       // mean position when named, null if never
          "mentions": 20,
          "citations": 11,
          "rank_delta": 2,           // vs last week, null if new or first week
          "engines": { "chatgpt": 1.0 },  // per-engine mention rate
          "top_source": { "hostname": "g2.com", "count": 7 }
        }
      ],
      "top_cited_domains": [{ "hostname": "cloro.dev", "count": 21 }]
    }
  ]
}
```

**Score.** `100 × (0.6 × mention_rate + 0.25 × citation_rate + 0.15 ×
position_factor)`. Detection is deterministic string and URL matching, not an
LLM judgement, so the same answers always produce the same score. Full
derivation: <https://cloro.dev/ai-visibility/methodology/>.

**Mention vs citation.** A *mention* means the engine named the brand in its
answer text. A *citation* means it linked the brand's own domain as a source.
Tracked separately because they are different kinds of visibility — a brand can
be cited as a source without ever being recommended, and the reverse.

**`methodology_version`** is the compatibility marker. Snapshots sharing a
version are comparable week to week; when it increments, the scoring changed
and cross-version deltas are not meaningful.

## What is not in here

The **prompt texts**. Only their count is published (`sample_size.prompts`).
Releasing the exact questions would let a brand optimise for the specific
wording we score against, which turns the leaderboard into a target rather
than a measurement. The methodology page describes how the prompts are
constructed.

## Reuse

Data is **CC BY 4.0**, the code in `scripts/` is **MIT**. Attribution should
name cloro and link either this repository or
<https://cloro.dev/ai-visibility/>.

```bibtex
@misc{cloro_ai_visibility_leaderboard,
  title        = {AI Visibility Leaderboard},
  author       = {{cloro}},
  year         = {2026},
  howpublished = {\url{https://github.com/cloro-dev/ai-visibility-leaderboard}},
  note         = {Weekly snapshots of brand visibility across AI assistants}
}
```

## How it is built

`.github/workflows/snapshot.yml` runs every Monday at 14:00 UTC, calls
`scripts/build-snapshot.mjs`, commits the result, and then triggers a rebuild
of <https://cloro.dev/ai-visibility/>. Every snapshot is therefore a
re-runnable job with a public log.

That last step matters more than it looks: the site is a static build that
reads this dataset at build time, so a committed snapshot is not a published
one until a Pages build runs. It needs two repository secrets:

| Name | Kind | Value |
| --- | --- | --- |
| `FEED_BASE` | secret | Base URL of the monitor app serving the leaderboard API. A secret, not a variable: this repo's Actions logs are public and the script names the URL on a failed fetch — secrets are masked there, variables are not. |
| `PAGES_DEPLOY_HOOK` | secret | Cloudflare Pages → `landing` → Settings → Builds & deployments → Deploy hook, on the production branch |

The step only fires when a snapshot was actually committed, so an unchanged
week costs nothing. If the secret is missing on a week that *did* change, the
job fails loudly rather than leaving fresh data stranded in the repo.

```bash
FEED_BASE=<monitor-url> node scripts/build-snapshot.mjs            # write
FEED_BASE=<monitor-url> node scripts/build-snapshot.mjs --dry-run  # print only
```

Stdlib-only, no install step. The script refuses to write when categories
disagree about which week they belong to, so a snapshot taken mid-aggregate
fails the job instead of committing torn data.

Corrections and questions: open an issue.
