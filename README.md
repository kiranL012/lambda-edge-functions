# sfl-cdn-edge-functions

Lambda@Edge function(s) fronting `aem.live` on the SFL-managed CloudFront
distribution. This is **not** part of the `eds-shriram-finance` content repo —
it's deployed straight to AWS and owned by the CDN/infra team.

## Architecture

```
Browser -> CloudFront Distribution -> Lambda@Edge (origin-response) -> aem.live
```

- CloudFront's origin is your `aem.live` branch URL directly
  (e.g. `release--sf-stage--hashout-technologies.aem.live` for the UAT release
  branch, instead of `main`) — not `aem.network`.
- A single Lambda@Edge function handles all customizations (articles-category-cards
  SSR, geo-personalization, etc.) rather than chaining multiple workers.

## What it does

On every HTML origin response, the function detects the raw (pre-decoration)
`articles-category-cards` EDS block, fetches `/query-index.json` from the same
origin, and server-renders the article cards directly into the response —
mirroring `blocks/articles-category-cards/articles-category-cards.js` in
`eds-shriram-finance`. All three render modes are SSR'd:

- **Homepage mode** (`block-category: latest-four-articles`): a fixed 4-article
  grid with a header (title + optional CTA link).
- **Category-limited mode** (`block-category` is one of a fixed set of product
  categories, e.g. `business-loan`, `personal-loan`, `gold-loan`, ...): a fixed
  4-article grid filtered to that category's `/{category}/articles/...` paths.
- **General paginated mode** (no/other `block-category`, typically on an
  `/{category}/articles` listing page): 12 articles per page, paginated via the
  `?page=` query string, with full pagination markup (prev/next, page numbers,
  ellipsis for large page counts).

Blocks carrying the `gold-bordered-articles` class are additionally rendered as
a carousel (`acc-carousel-wrapper`/`acc-track`/`acc-dots`) alongside the CTA
button, mirroring `setupCarousel()` in the source block.

Block config is read from the `data-model` JSON attribute (how Universal
Editor/xwalk authors this block in production), falling back to classic
table-row parsing for non-xwalk content. When the filtered article list is
empty, or an out-of-range `?page=` is requested, the block renders the same
"no results" fallback markup as the client-side block. Rendered blocks are
marked `data-ssr-rendered="true"`.

`query-index.json` is paginated and can run into the thousands of rows, so
the fetch pages through `total`/`offset`/`limit` until every row is
collected (capped at 10,000 rows as a safety net), then caches the merged
list in-memory per warm Lambda container for 5 minutes.

**Caveat**: `articles-category-cards.js`'s client-side `decorate()` doesn't yet
know about this — it will still wipe the SSR'd markup and re-fetch on page
load. Making the POC actually "stick" requires a small follow-up change in
`eds-shriram-finance` to skip re-rendering when `data-ssr-rendered="true"` is
already present.

## Local development

```
npm test
```

Runs `test/index.test.js` against the handler using `test/sample-event.json`
(a mock CloudFront origin-response event). Edit the sample event to try
different headers/response bodies.

## One-time setup (console or IaC, not scripted here)

1. Create the Lambda function in **us-east-1** (required for Lambda@Edge,
   regardless of where the CloudFront origin is), runtime Node.js 18+.
2. Attach an execution role whose trust policy allows both
   `lambda.amazonaws.com` and `edgelambda.amazonaws.com` to assume it.
3. In the CloudFront distribution, add a Lambda function association on the
   relevant cache behavior for the **Origin Response** event type, pointing at
   a specific published version ARN (never `$LATEST`).

## Deploying updates

```
npm run deploy -- -FunctionName sfl-edge-worker -DistributionId EXXXXXXXXXXXXX
```

This zips `src/`, updates the function code, and publishes a new version.
You still need to manually (or via IaC) point the CloudFront association at
the new version ARN printed at the end — Lambda@Edge does not auto-update
associations on publish, and propagation to all edge locations takes several
minutes after that.

## Cache invalidation

CloudFront has no native awareness of AEM publish events. Two options:

- Respect `aem.live`'s own `Cache-Control` headers (short/no caching for HTML
  at CloudFront) — simplest, recommended to start.
- Poll AEM's [Audit Log API](https://www.aem.live/docs/admin.html#tag/log/operation/getLogs)
  for publish events and call CloudFront's `CreateInvalidation` for changed
  paths.
