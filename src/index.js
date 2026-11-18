// Lambda@Edge handler — CommonJS only, no ESM/import, no npm dependencies
// (Lambda@Edge disallows environment variables and has strict size/runtime limits).
//
// Associate this function's published version with your CloudFront distribution's
// cache behavior as an "Origin Response" trigger. Origin must point directly at
// your aem.live branch (e.g. release--sf-stage--hashout-technologies.aem.live for
// the UAT release branch) — do not chain this in front of aem.network.
//
// SSRs the `articles-category-cards` EDS block (query-index.json driven) at the
// edge, mirroring blocks/articles-category-cards/articles-category-cards.js in
// eds-shriram-finance so the browser gets fully-formed cards instead of a loading
// state + client fetch.

const https = require('https');

// Matches the block's opening tag regardless of attribute order, so blocks with
// extra classes (e.g. the gold-bordered-articles style) are still detected.
const ARTICLES_CARDS_OPEN_RE = /<div\b[^>]*\bclass="[^"]*\barticles-category-cards\b[^"]*"[^>]*>/gi;

const QUERY_INDEX_TTL_MS = 5 * 60 * 1000;
const queryIndexCache = new Map();

// block-category values that render a fixed 4-article grid (no pagination),
// mirroring the `limitedCategoryBlocks` list in articles-category-cards.js.
// POC note: hardcoded to match the client 1:1 — must be updated here whenever
// a category is added/removed there. Revisit a more dynamic approach post-POC.
const LIMITED_CATEGORY_BLOCKS = [
  'business-loan',
  'personal-loan',
  'fixed-deposit',
  'two-wheeler-loan',
  'gold-loan',
  'commercial-vehicle-loan',
  'credit-score',
  'shriram-one',
  'life-insurance',
  'loans',
  'bbps',
  'investments',
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// The `data-model` attribute is HTML-attribute-escaped JSON; unescape before parsing.
function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Finds the `</div>` matching the `<div ...>` whose opening tag ends at `openEnd`,
// tracking nesting depth so we don't stop at an inner block's closing tag.
function findMatchingDivEnd(html, openEnd) {
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = openEnd;
  let depth = 1;
  let m = tagRe.exec(html);
  while (m) {
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return { innerEnd: m.index, outerEnd: tagRe.lastIndex };
    } else {
      depth += 1;
    }
    m = tagRe.exec(html);
  }
  return null;
}

// Splits a block's innerHTML into its direct child `<div>` elements (rows),
// without a DOM parser (no npm deps allowed in Lambda@Edge).
function getTopLevelDivs(html) {
  const children = [];
  const tagRe = /<\/?div\b[^>]*>/gi;
  let depth = 0;
  let start = null;
  let m = tagRe.exec(html);
  while (m) {
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0 && start !== null) {
        children.push(html.slice(start, m.index));
        start = null;
      }
    } else {
      if (depth === 0) start = tagRe.lastIndex;
      depth += 1;
    }
    m = tagRe.exec(html);
  }
  return children;
}

function parseCustomDate(dateStr) {
  if (!dateStr) return new Date(0);
  return new Date(dateStr.replace(/(\d+)(st|nd|rd|th)/, '$1'));
}

function normalizeArticlePath(path) {
  return String(path || '')
    .replace(/^\/content\/shriramfinance/, '')
    .replace(/\.html$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

// Some query-index.json rows ship an obviously-placeholder publishedDate (e.g. "1111-11-11",
// a CMS "not set" sentinel); fall back to lastModified (Unix epoch seconds) when that's the case.
const MIN_PLAUSIBLE_YEAR = 2000;

function resolveArticleDate(article) {
  const published = parseCustomDate(article.publishedDate);
  if (published.getFullYear() >= MIN_PLAUSIBLE_YEAR) return published;
  if (typeof article.lastModified === 'number') return new Date(article.lastModified * 1000);
  return published;
}

// Mirrors utils.js's timeAgo(): renders a resolved Date as a relative "N days/months/years ago" string.
function timeAgo(date) {
  if (!date) return '';
  const now = new Date();
  let years = now.getFullYear() - date.getFullYear();
  let months = now.getMonth() - date.getMonth();
  let days = now.getDate() - date.getDate();

  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  if (years > 0) return `${years} year${years > 1 ? 's' : ''} ago`;
  if (months > 0) return `${months} month${months > 1 ? 's' : ''} ago`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  return 'Today';
}

function hasClass(openTagHtml, className) {
  const classMatch = openTagHtml.match(/\sclass="([^"]*)"/);
  return !!classMatch && classMatch[1].split(/\s+/).includes(className);
}

function addClassToOpenTag(openTagHtml, extraClass) {
  return openTagHtml.replace(/\sclass="([^"]*)"/, (match, classes) => ` class="${classes} ${extraClass}"`);
}

function addAttribute(openTagHtml, name, value) {
  return `${openTagHtml.slice(0, -1)} ${name}="${value}">`;
}

/**
 * Reads the block's config, matching readBlockConfig() in articles-category-cards.js:
 * prefers the `data-model` JSON attribute (how Universal Editor/xwalk authors this block
 * in production), falling back to positional row text (title/cta-text/cta-link/block-category)
 * for classic table-authored content.
 */
function parseBlockConfig(openTagHtml, innerHtml) {
  const modelMatch = openTagHtml.match(/\sdata-model="([^"]*)"/);
  if (modelMatch) {
    try {
      const model = JSON.parse(decodeHtmlEntities(modelMatch[1]));
      return {
        title: model.title || '',
        ctaText: model['cta-text'] || '',
        ctaLink: model['cta-link'] || '',
        blockCategory: model['block-category'] || '',
      };
    } catch (err) {
      // Malformed data-model — fall through to row-based parsing below.
    }
  }

  const rowValue = (rowHtml) => {
    const linkMatch = rowHtml.match(/<a\b[^>]*\bhref="([^"]*)"/i);
    return linkMatch ? decodeHtmlEntities(linkMatch[1]) : stripTags(rowHtml);
  };

  const rows = getTopLevelDivs(innerHtml);
  return {
    title: rowValue(rows[0] || ''),
    ctaText: rowValue(rows[1] || ''),
    ctaLink: rowValue(rows[2] || ''),
    blockCategory: rowValue(rows[3] || ''),
  };
}

// Mirrors createOptimizedPicture() in scripts/aem.js, resolving `./media_xxx.jpg` references
// relative to the article's own path (not the current page) and emitting the same
// webp-with-fallback <picture> markup.
const CARD_IMAGE_BREAKPOINTS = [{ media: '(min-width: 900px)', width: '606' }, { width: '500' }];

function resolveArticleImage(articlePath, imageRef) {
  if (!imageRef) return null;
  try {
    const { pathname } = new URL(imageRef, `https://edge-internal${articlePath || '/'}`);
    const ext = pathname.slice(pathname.lastIndexOf('.') + 1) || 'jpg';
    return { pathname, ext };
  } catch (err) {
    return null;
  }
}

function renderOptimizedPicture(articlePath, imageRef, alt, eager) {
  const resolved = resolveArticleImage(articlePath, imageRef);
  if (!resolved) return '';
  const { pathname, ext } = resolved;

  const webpSources = CARD_IMAGE_BREAKPOINTS
    .map((br) => `<source${br.media ? ` media="${br.media}"` : ''} type="image/webp" srcset="${pathname}?width=${br.width}&format=webply&optimize=medium">`)
    .join('');
  const fallbackSources = CARD_IMAGE_BREAKPOINTS
    .slice(0, -1)
    .map((br) => `<source${br.media ? ` media="${br.media}"` : ''} srcset="${pathname}?width=${br.width}&format=${ext}&optimize=medium">`)
    .join('');
  const last = CARD_IMAGE_BREAKPOINTS[CARD_IMAGE_BREAKPOINTS.length - 1];
  const img = `<img loading="${eager ? 'eager' : 'lazy'}" alt="${escapeHtml(alt)}" src="${pathname}?width=${last.width}&format=${ext}&optimize=medium">`;

  return `<picture>${webpSources}${fallbackSources}${img}</picture>`;
}

// Mirrors renderJsonCards() in articles-category-cards.js.
function renderArticleCard(article, index) {
  const picture = renderOptimizedPicture(article.path, article.image, article.title, index < 2);
  return `<a href="${escapeHtml(article.path)}" class="article-card-content" target="_blank" title="${escapeHtml(article.title)}"><div class="article-item-image">${picture}</div><div class="article-item-content"><p class="article-item-title">${escapeHtml(article.title)}</p><p class="article-item-subtitle">${escapeHtml(article.description || '')}</p><div class="article-item-meta"><div class="meta-info"><span class="published-time">${escapeHtml(timeAgo(resolveArticleDate(article)))}</span></div><span class="read-more">Read more</span></div></div></a>`;
}

function renderHeader(title, ctaText, ctaLink) {
  let html = '<div class="articles-header">';
  if (title) html += `<h3 class="title">${escapeHtml(title)}</h3>`;
  if (ctaText && ctaLink) html += `<a class="cta-link" href="${escapeHtml(ctaLink)}">${escapeHtml(ctaText)}</a>`;
  html += '</div>';
  return html;
}

function renderFallback() {
  return '<div class="no-results-wrapper"><div class="fallback-image"><img src="../../images/no-record.svg" alt="No articles found"></div><p class="fallback-message">Article not found</p></div>';
}

// Mirrors setupCarousel(): wraps the already-rendered cards into a carousel track
// alongside prev/next arrows and dots. No-ops for a single (or zero) card, same as the source.
function renderCarousel(cardItemsHtml) {
  if (cardItemsHtml.length <= 1) return '';
  const track = cardItemsHtml.map((card) => `<div class="acc-slide">${card}</div>`).join('');
  const dots = cardItemsHtml
    .map((_, i) => `<button class="acc-dot${i === 0 ? ' acc-dot-active' : ''}" aria-label="Go to article ${i + 1}"></button>`)
    .join('');
  return `<div class="acc-carousel-wrapper"><div class="acc-carousel"><div class="acc-track">${track}</div></div><div class="acc-controls"><button class="acc-arrow acc-arrow-prev" aria-label="Previous article" disabled></button><div class="acc-dots">${dots}</div><button class="acc-arrow acc-arrow-next" aria-label="Next article"></button></div></div>`;
}

function getPageLink(currentUri, page) {
  return page === 1 ? currentUri : `?page=${page}`;
}

function renderPaginationItem(currentUri, label, page, disabled, active) {
  const classes = ['pagination-link'];
  if (active) classes.push('active');
  if (disabled) classes.push('disabled');
  const tabindex = disabled ? ' tabindex="-1"' : '';
  return `<li class="pagination-box${disabled ? ' disabled' : ''}"><a href="${escapeHtml(getPageLink(currentUri, page))}" class="${classes.join(' ')}"${tabindex}>${label}</a></li>`;
}

// Mirrors renderPagination()'s page-number + ellipsis layout in articles-category-cards.js.
function renderPagination(currentUri, totalPages, currentPage) {
  let items = renderPaginationItem(currentUri, 'Previous', currentPage - 1, currentPage === 1, false);

  const showLastBlock = 5;
  const appendRange = (from, to) => {
    for (let i = from; i <= to; i += 1) {
      items += renderPaginationItem(currentUri, String(i), i, false, i === currentPage);
    }
  };

  if (totalPages <= 7) {
    appendRange(1, totalPages);
  } else if (currentPage >= totalPages - showLastBlock + 1) {
    appendRange(totalPages - showLastBlock + 1, totalPages);
  } else {
    const start = currentPage <= 2 ? 1 : Math.max(currentPage - 1, 1);
    const end = currentPage <= 2 ? 3 : Math.min(currentPage + 1, totalPages - 2);
    appendRange(start, end);
    items += '<li class="pagination-ellipsis">...</li>';
    appendRange(totalPages - 1, totalPages);
  }

  items += `<li class="pagination-mobile-count"><span class="page-count"><span class="current">${currentPage}</span> / <span class="total">${totalPages}</span></span></li>`;
  items += renderPaginationItem(currentUri, 'Next', currentPage + 1, currentPage === totalPages, false);

  return `<div class="pagination-wrapper"><ul class="pagination-list">${items}</ul></div>`;
}

// Mirrors fetchWithCache()'s special-case filtering for the 'articlesQueryIndex' cache key:
// drop the `/articles` index page + `/{category}/articles` rollups, sort newest first.
function getBaseArticles(queryIndex) {
  return queryIndex
    .filter((item) => item.path !== '/articles' && !/^\/[^/]+\/articles$/.test(item.path))
    .sort((a, b) => resolveArticleDate(b) - resolveArticleDate(a));
}

function buildBlockHtml(openTagHtml, addCategoryArticlesClass, innerContent) {
  let tag = openTagHtml;
  if (addCategoryArticlesClass) tag = addClassToOpenTag(tag, 'category-articles');
  tag = addAttribute(tag, 'data-ssr-rendered', 'true');
  return `${tag}${innerContent}</div>`;
}

/**
 * Replicates decorate() in blocks/articles-category-cards/articles-category-cards.js
 * server-side: reads the block config, filters/paginates query-index.json, and renders
 * the resulting markup. Returns null to leave the raw block untouched (e.g. query-index.json
 * fetch failed, or the requested page is out of range — matches the client's fallback there too).
 * @param {object} request CloudFront `cf.request` (uri/querystring)
 * @param {string} openTagHtml the block's opening `<div ...>` tag
 * @param {string} innerHtml the block's raw inner HTML (pre-decoration)
 * @param {Array<object>|null} baseArticles pre-filtered/sorted query-index rows, or null on fetch failure
 * @returns {string|null}
 */
function renderArticlesCategoryCardsBlock(request, openTagHtml, innerHtml, baseArticles) {
  if (!baseArticles) return null;

  const config = parseBlockConfig(openTagHtml, innerHtml);
  const isHomepageArticles = config.blockCategory === 'latest-four-articles';
  const isGoldBordered = hasClass(openTagHtml, 'gold-bordered-articles');
  const isCategoryLimitedBlock = LIMITED_CATEGORY_BLOCKS.includes(config.blockCategory);

  const currentUri = request.uri || '/';
  const currentPath = normalizeArticlePath(currentUri);
  const pathSegments = currentPath.split('/').filter(Boolean);
  const isCategoryPage = pathSegments.length === 2 && pathSegments[1] === 'articles';
  const currentCategory = isCategoryPage ? pathSegments[0] : null;

  const blockCategoryPrefix = isCategoryLimitedBlock ? `/${config.blockCategory}/articles/` : null;
  const pageCategoryPrefix = isCategoryPage ? `/${currentCategory}/articles/` : null;

  const articles = baseArticles.filter((item) => {
    const path = normalizeArticlePath(item.path);
    if (path.startsWith('/sitemap/articles/')) return false;
    if (blockCategoryPrefix && !path.startsWith(blockCategoryPrefix)) return false;
    if (pageCategoryPrefix && !path.startsWith(pageCategoryPrefix)) return false;
    return true;
  });

  const isFixedFour = isHomepageArticles || isCategoryLimitedBlock || isGoldBordered;
  const perPage = isFixedFour ? 4 : 12;
  const addCategoryArticlesClass = isHomepageArticles || isCategoryLimitedBlock;

  let paginated;
  let currentPage = 1;
  let totalPages = 1;

  if (isFixedFour) {
    paginated = articles.slice(0, perPage);
  } else {
    const params = new URLSearchParams(request.querystring || '');
    currentPage = parseInt(params.get('page'), 10) || 1;
    totalPages = Math.max(1, Math.ceil(articles.length / perPage));
    if (currentPage > totalPages || currentPage < 1) {
      return buildBlockHtml(openTagHtml, addCategoryArticlesClass, renderFallback());
    }
    const start = (currentPage - 1) * perPage;
    paginated = articles.slice(start, start + perPage);
  }

  if (!paginated.length) {
    return buildBlockHtml(openTagHtml, addCategoryArticlesClass, renderFallback());
  }

  let inner = '';
  const hasValidConfig = Boolean(config.title) || (!isGoldBordered && Boolean(config.ctaText));
  if ((isHomepageArticles || isCategoryLimitedBlock) && hasValidConfig) {
    const headerCtaText = isGoldBordered ? '' : config.ctaText;
    const headerCtaLink = isGoldBordered ? '' : config.ctaLink;
    inner += renderHeader(config.title, headerCtaText, headerCtaLink);
  }

  const cardItems = paginated.map((article, index) => `<div class="articles-card-item">${renderArticleCard(article, index)}</div>`);
  inner += `<div class="articles-cards-list">${cardItems.join('')}</div>`;

  if (isGoldBordered) inner += renderCarousel(cardItems);

  if (!isFixedFour && totalPages > 1) {
    inner += renderPagination(currentUri, totalPages, currentPage);
  }

  if (isGoldBordered && config.ctaText && config.ctaLink) {
    inner += `<div class="article-cards-cta-wrapper"><a class="button gold-primary" href="${escapeHtml(config.ctaLink)}">${escapeHtml(config.ctaText)}</a></div>`;
  }

  return buildBlockHtml(openTagHtml, addCategoryArticlesClass, inner);
}

// Finds every raw `articles-category-cards` block, renders them, then splices the
// results back in from last to first so earlier offsets stay valid.
async function renderArticlesCategoryCards(body, host, request) {
  const matches = [];
  let m = ARTICLES_CARDS_OPEN_RE.exec(body);
  while (m) {
    const bounds = findMatchingDivEnd(body, ARTICLES_CARDS_OPEN_RE.lastIndex);
    if (bounds) {
      matches.push({ outerStart: m.index, openTag: m[0], innerStart: ARTICLES_CARDS_OPEN_RE.lastIndex, ...bounds });
    }
    m = ARTICLES_CARDS_OPEN_RE.exec(body);
  }
  if (!matches.length) return body;

  const queryIndex = await exports.fetchQueryIndex(host);
  const baseArticles = queryIndex ? getBaseArticles(queryIndex) : null;

  const rendered = matches.map(({ openTag, innerStart, innerEnd }) => renderArticlesCategoryCardsBlock(
    request,
    openTag,
    body.slice(innerStart, innerEnd),
    baseArticles,
  ));

  let result = body;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (rendered[i] === null) continue; // eslint-disable-line no-continue
    const { outerStart, outerEnd } = matches[i];
    result = `${result.slice(0, outerStart)}${rendered[i]}${result.slice(outerEnd)}`;
  }
  return result;
}

// CloudFront does NOT expose the origin's response body to origin-response triggers
// (confirmed in AWS's Lambda@Edge event structure docs — Records.cf.response only has
// headers/status/statusDescription). So the page HTML has to be fetched independently
// here, the same way query-index.json is, rather than read off `response.body`.
exports.handler = async (event) => {
  const { request, response } = event.Records[0].cf;

  const contentType = response.headers['content-type']?.[0]?.value || '';
  if (response.status !== '200' || !contentType.includes('text/html')) {
    return response;
  }

  const host = request.headers.host?.[0]?.value;
  if (!host) {
    return response;
  }

  const path = request.querystring ? `${request.uri}?${request.querystring}` : request.uri;
  const body = await fetchJson(host, path, 8000, true);
  if (body === null) {
    return response;
  }

  const hasArticlesCards = ARTICLES_CARDS_OPEN_RE.test(body);
  ARTICLES_CARDS_OPEN_RE.lastIndex = 0; // reset shared regex state after .test()

  if (!hasArticlesCards) {
    return response;
  }

  const rendered = await renderArticlesCategoryCards(body, host, request);

  response.body = rendered;
  response.bodyEncoding = 'text';
  return response;
};

/**
 * Performs a single GET against the origin and resolves the body — either parsed as
 * JSON (default) or as a raw UTF-8 string (`raw: true`, used to fetch the page's own
 * HTML, since that isn't exposed on origin-response events). Resolves null on a
 * non-200 status, timeout, network error, or (when not raw) invalid JSON.
 * @param {string} host
 * @param {string} path
 * @param {number} timeout
 * @param {boolean} [raw]
 * @returns {Promise<object|string|null>}
 */
function fetchJson(host, path, timeout, raw) {
  return new Promise((resolve) => {
    const req = https.get({ host, path, timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (raw) {
          resolve(text);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

// query-index.json is paginated (`total`/`offset`/`limit` in the response) — fetching it with
// no query params only returns the origin's default page, which silently truncates the 2000+
// row sheet. QUERY_INDEX_PAGE_SIZE drives how many rows we request per page while paging through
// `total`; QUERY_INDEX_MAX_ROWS is a safety cap against an unexpectedly huge/runaway sheet.
const QUERY_INDEX_PAGE_SIZE = 500;
const QUERY_INDEX_MAX_ROWS = 10000;

/**
 * Fetches and parses the full (paginated) query-index.json from the origin, caching the
 * merged article list per host. Returns null (not a stale fallback) on failure, since
 * callers treat null as "leave the raw block untouched" rather than render stale data.
 * @param {string} host
 * @returns {Promise<Array<object>|null>}
 */
exports.fetchQueryIndex = async (host) => {
  const cached = queryIndexCache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  // 2000+ rows can take a while to download; give each page generous headroom.
  const first = await fetchJson(host, `/query-index.json?limit=${QUERY_INDEX_PAGE_SIZE}&offset=0`, 8000);
  if (!first || !Array.isArray(first.data)) return null;

  const total = Math.min(
    typeof first.total === 'number' ? first.total : first.data.length,
    QUERY_INDEX_MAX_ROWS,
  );
  let rows = first.data;

  if (rows.length < total) {
    const offsets = [];
    for (let offset = rows.length; offset < total; offset += QUERY_INDEX_PAGE_SIZE) {
      offsets.push(offset);
    }
    const pages = await Promise.all(
      offsets.map((offset) => fetchJson(host, `/query-index.json?limit=${QUERY_INDEX_PAGE_SIZE}&offset=${offset}`, 8000)),
    );
    for (const page of pages) {
      if (page && Array.isArray(page.data)) rows = rows.concat(page.data);
    }
  }

  queryIndexCache.set(host, { data: rows, expiresAt: Date.now() + QUERY_INDEX_TTL_MS });
  return rows;
};

// Test-only: clears the in-memory query-index cache between test cases.
exports.__clearQueryIndexCache = () => queryIndexCache.clear();
