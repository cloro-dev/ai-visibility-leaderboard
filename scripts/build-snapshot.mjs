#!/usr/bin/env node
// Composes one weekly snapshot from the cloro monitor leaderboard API and
// writes it to snapshots/<week-start>.json, then refreshes index.json.
//
// Run by .github/workflows/snapshot.yml every Monday, and runnable by hand:
//
//   node scripts/build-snapshot.mjs                     # write
//   node scripts/build-snapshot.mjs --dry-run           # print, write nothing
//   FEED_BASE=http://localhost:3000 node scripts/...    # point elsewhere
//
// Deliberately stdlib-only so the workflow needs no install step.
//
// What is NOT published: the prompt texts. Only their count reaches the
// snapshot (`sample_size.prompts`). Publishing the questions would let a
// brand optimise for the exact wording we score against, which turns the
// leaderboard into a target instead of a measurement.

import {
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = join(ROOT, "snapshots");

const FEED_BASE = (process.env.FEED_BASE ?? "https://REDACTED").replace(
  /\/+$/,
  "",
);
const SCHEMA_VERSION = "1.0";
const DRY_RUN = process.argv.includes("--dry-run");

const feed = (path = "") => `${FEED_BASE}/api/public/leaderboard${path}`;

async function getJson(url, { optional = false } = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": "cloro-ai-visibility-leaderboard/1.0" },
  });
  if (!res.ok) {
    if (optional && res.status === 404) return null;
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return res.json();
}

// The feed sorts engines by however Postgres returned them, which is not
// stable between runs. Snapshots are diffed by humans and by git, so the
// column order has to be fixed here or every commit shows phantom churn.
const ENGINE_ORDER = ["chatgpt", "perplexity", "gemini", "copilot", "aimode"];
const byEngineOrder = (a, b) => {
  const ai = ENGINE_ORDER.indexOf(a.key);
  const bi = ENGINE_ORDER.indexOf(b.key);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.key.localeCompare(b.key);
};

// Same reason: object key order is part of the committed bytes.
const orderedEngines = (engines) =>
  Object.fromEntries(
    Object.keys(engines)
      .sort((a, b) => byEngineOrder({ key: a }, { key: b }))
      .map((k) => [k, engines[k]]),
  );

function entry(e) {
  return {
    rank: e.rank,
    brand: e.brand,
    domain: e.domain,
    score: e.score,
    share_of_voice: e.shareOfVoice,
    mention_rate: e.mentionRate,
    citation_rate: e.citationRate,
    avg_position: e.avgPosition,
    mentions: e.mentions,
    citations: e.citations,
    rank_delta: e.rankDelta,
    engines: orderedEngines(e.engines),
    top_source: e.topSource
      ? { hostname: e.topSource.hostname, count: e.topSource.count }
      : null,
  };
}

async function build() {
  const index = await getJson(feed());
  if (!index.weekStart || !index.categories?.length) {
    throw new Error(`${feed()} has no published snapshots yet`);
  }

  const categories = [];
  let engines = [];
  for (const c of index.categories) {
    const s = await getJson(feed(`/${c.slug}`));
    if (s.weekStart !== index.weekStart) {
      throw new Error(
        `${c.slug} is week ${s.weekStart} but the index says ${index.weekStart} — ` +
          "the aggregate run is mid-flight; re-run once it finishes.",
      );
    }
    if (!engines.length) engines = [...s.sampleSize.engines].sort(byEngineOrder);
    categories.push({
      slug: s.category.slug,
      name: s.category.name,
      description: s.category.description,
      sample_size: {
        prompts: s.sampleSize.prompts,
        responses: s.sampleSize.responses,
      },
      entries: s.entries.map(entry),
      top_cited_domains: s.topCitedDomains.map((d) => ({
        hostname: d.hostname,
        count: d.count,
      })),
    });
  }

  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      week_start: index.weekStart,
      generated_at: new Date().toISOString(),
      methodology_version: 1,
      methodology_url: "https://cloro.dev/ai-visibility/methodology/",
      canonical_url: "https://cloro.dev/ai-visibility/",
      repository_url:
        "https://github.com/cloro-dev/ai-visibility-leaderboard",
      publisher: { name: "cloro", url: "https://cloro.dev" },
      license: {
        data: "CC-BY-4.0",
        data_url: "https://creativecommons.org/licenses/by/4.0/",
        code: "MIT",
        code_url: "https://opensource.org/license/mit",
      },
      category_count: categories.length,
      brand_count: categories.reduce((n, c) => n + c.entries.length, 0),
    },
    engines: engines.map((e) => ({ key: e.key, label: e.label })),
    categories,
  };
}

// index.json is derived from the files on disk rather than appended to, so a
// hand-deleted or hand-added snapshot cannot leave the index lying.
function buildIndex() {
  const weeks = readdirSync(SNAPSHOT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  return {
    schema_version: SCHEMA_VERSION,
    latest: weeks.length ? weeks[weeks.length - 1].replace(".json", "") : null,
    count: weeks.length,
    snapshots: weeks.map((f) => {
      const s = JSON.parse(readFileSync(join(SNAPSHOT_DIR, f), "utf8"));
      return {
        week_start: s.meta.week_start,
        path: `snapshots/${f}`,
        categories: s.meta.category_count,
        brands: s.meta.brand_count,
        generated_at: s.meta.generated_at,
      };
    }),
  };
}

const snapshot = await build();
const file = join(SNAPSHOT_DIR, `${snapshot.meta.week_start}.json`);

if (DRY_RUN) {
  console.log(JSON.stringify(snapshot, null, 2));
  console.error(
    `\n[dry-run] would write ${file} — ${snapshot.meta.category_count} categories, ` +
      `${snapshot.meta.brand_count} brand rows`,
  );
  process.exit(0);
}

// `generated_at` moves on every run, so writing unconditionally would dirty
// the file even when the data is identical — and the workflow's "commit only
// if something changed" guard would then commit a timestamp-only no-op every
// time it runs before a new week exists. Compare everything except that field
// and leave the file alone when nothing moved.
const sansTimestamp = (s) => {
  const { generated_at, ...meta } = s.meta;
  return JSON.stringify({ ...s, meta });
};

if (
  existsSync(file) &&
  sansTimestamp(JSON.parse(readFileSync(file, "utf8"))) ===
    sansTimestamp(snapshot)
) {
  console.log(
    `snapshots/${snapshot.meta.week_start}.json is already current — nothing to write.`,
  );
  process.exit(0);
}

mkdirSync(SNAPSHOT_DIR, { recursive: true });
writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
writeFileSync(
  join(ROOT, "index.json"),
  `${JSON.stringify(buildIndex(), null, 2)}\n`,
);
console.log(
  `wrote snapshots/${snapshot.meta.week_start}.json ` +
    `(${snapshot.meta.category_count} categories, ${snapshot.meta.brand_count} brand rows) + index.json`,
);
