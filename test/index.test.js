const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const edge = require('../src/index.js');
const sampleEvent = require('./sample-event.json');

function cloneEvent() {
  return JSON.parse(JSON.stringify(sampleEvent));
}

// CloudFront doesn't expose the origin's response body to origin-response triggers,
// so the handler fetches the page's own HTML itself via https.get — this stubs that
// call to serve the given HTML, returning a restore function to undo the stub.
function mockPageFetch(html) {
  const originalGet = https.get;
  https.get = (options, callback) => {
    const res = {
      statusCode: 200,
      on(ev, cb) {
        if (ev === 'data') cb(Buffer.from(html));
        if (ev === 'end') cb();
        return res;
      },
    };
    callback(res);
    return { on() {}, destroy() {} };
  };
  return () => { https.get = originalGet; };
}

test('leaves non-HTML responses untouched', async () => {
  const event = cloneEvent();
  event.Records[0].cf.response.headers['content-type'][0].value = 'application/json';
  event.Records[0].cf.response.body = '{"ok":true}';
  const response = await edge.handler(event);
  assert.equal(response.body, '{"ok":true}');
});

test('leaves the body untouched when no articles-category-cards block is present', async () => {
  const event = cloneEvent();
  const restore = mockPageFetch('<html><body><main>Home</main></body></html>');
  const response = await edge.handler(event);
  restore();
  assert.equal(response.body, event.Records[0].cf.response.body);
});

// Mirrors how Universal Editor/xwalk authors this block in production: config
// fields are serialized into a `data-model` JSON attribute (HTML-attribute-escaped)
// directly on the block root div, with no child row markup.
function dataModelBlock(extraClasses, model) {
  const json = JSON.stringify(model)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return `<div class="articles-category-cards${extraClasses ? ` ${extraClasses}` : ''}" data-model="${json}"></div>`;
}

// Mirrors classic table-authored content: each direct child <div> is a "row".
function rowBasedBlock(extraClasses, title, ctaText, ctaLink, blockCategory) {
  return `<div class="articles-category-cards${extraClasses ? ` ${extraClasses}` : ''}"><div><div>${title}</div></div><div><div>${ctaText}</div></div><div><div><a href="${ctaLink}">${ctaText}</a></div></div><div><div>${blockCategory}</div></div></div>`;
}

test('server-renders articles-category-cards homepage mode (latest-four-articles) via data-model JSON', async () => {
  const original = edge.fetchQueryIndex;
  edge.fetchQueryIndex = async () => [
    {
      path: '/loans/articles/home-loan-tips', title: 'Home Loan Tips <script>', description: 'Tips desc', image: './media_1.jpg', publishedDate: '1st January, 2024',
    },
    {
      path: '/loans/articles/emi-guide', title: 'EMI Guide', description: 'EMI desc', image: './media_2.jpg', publishedDate: '15th December, 2024',
    },
    {
      path: '/business-loan/articles/apply-now', title: 'Apply Now', description: 'Apply desc', image: './media_3.jpg', publishedDate: '1st June, 2024',
    },
    {
      path: '/business-loan/articles/eligibility', title: 'Eligibility', description: 'Eligibility desc', image: './media_4.jpg', publishedDate: '1st March, 2024',
    },
    {
      path: '/articles', title: 'Rollup', description: '', image: '', publishedDate: '1st January, 2025',
    },
  ];

  const event = cloneEvent();
  const restore = mockPageFetch(`<html><body>${dataModelBlock('', {
    title: 'Latest Articles',
    'cta-text': 'See all',
    'cta-link': '/articles',
    'block-category': 'latest-four-articles',
  })}</body></html>`);

  const response = await edge.handler(event);
  restore();

  assert.match(response.body, /data-ssr-rendered="true"/);
  assert.match(response.body, /category-articles/);
  assert.match(response.body, /Latest Articles/);
  assert.match(response.body, /See all/);
  assert.doesNotMatch(response.body, /Rollup/);
  // Article titles are HTML-escaped to prevent injection.
  assert.doesNotMatch(response.body, /<script>/);
  assert.match(response.body, /&lt;script&gt;/);
  // Sorted newest-first, rollup page excluded.
  assert.ok(response.body.indexOf('EMI Guide') < response.body.indexOf('Home Loan Tips'));

  edge.fetchQueryIndex = original;
  edge.__clearQueryIndexCache();
});

test('server-renders a category-limited block (business-loan) filtered by category prefix', async () => {
  const original = edge.fetchQueryIndex;
  edge.fetchQueryIndex = async () => [
    {
      path: '/loans/articles/home-loan-tips', title: 'Home Loan Tips', description: '', image: './media_1.jpg', publishedDate: '1st January, 2024',
    },
    {
      path: '/business-loan/articles/apply-now', title: 'Apply Now', description: '', image: './media_3.jpg', publishedDate: '1st June, 2024',
    },
    {
      path: '/business-loan/articles/eligibility', title: 'Eligibility', description: '', image: './media_4.jpg', publishedDate: '1st March, 2024',
    },
  ];

  const event = cloneEvent();
  const restore = mockPageFetch(`<html><body>${dataModelBlock('', {
    title: 'Business Loan Articles',
    'block-category': 'business-loan',
  })}</body></html>`);

  const response = await edge.handler(event);
  restore();

  assert.match(response.body, /data-ssr-rendered="true"/);
  assert.match(response.body, /Apply Now/);
  assert.match(response.body, /Eligibility/);
  assert.doesNotMatch(response.body, /Home Loan Tips/);

  edge.fetchQueryIndex = original;
  edge.__clearQueryIndexCache();
});

test('server-renders the general paginated mode (12/page) honoring the ?page= query string', async () => {
  const original = edge.fetchQueryIndex;
  const rows = Array.from({ length: 26 }, (_, i) => ({
    path: `/general/articles/article-${i}`,
    title: `Article ${i}`,
    description: '',
    image: `./media_${i}.jpg`,
    publishedDate: new Date(2024, 0, i + 1).toISOString(),
  }));
  edge.fetchQueryIndex = async () => rows;

  const event = cloneEvent();
  event.Records[0].cf.request.querystring = 'page=2';
  const restore = mockPageFetch(`<html><body>${dataModelBlock('', {})}</body></html>`);

  const response = await edge.handler(event);
  restore();

  assert.match(response.body, /data-ssr-rendered="true"/);
  assert.match(response.body, /pagination-wrapper/);

  const sorted = [...rows].sort((a, b) => new Date(b.publishedDate) - new Date(a.publishedDate));
  // Page 2 (12/page) holds items at indices 12-23 of the newest-first sort.
  assert.ok(response.body.includes(sorted[12].title));
  assert.ok(response.body.includes(sorted[23].title));
  // The newest article (page 1) shouldn't leak onto page 2.
  assert.ok(!response.body.includes(sorted[0].title));

  edge.fetchQueryIndex = original;
  edge.__clearQueryIndexCache();
});

test('server-renders the gold-bordered carousel variant', async () => {
  const original = edge.fetchQueryIndex;
  edge.fetchQueryIndex = async () => [
    {
      path: '/loans/articles/a', title: 'Article A', description: '', image: './media_a.jpg', publishedDate: '1st January, 2024',
    },
    {
      path: '/loans/articles/b', title: 'Article B', description: '', image: './media_b.jpg', publishedDate: '2nd January, 2024',
    },
    {
      path: '/loans/articles/c', title: 'Article C', description: '', image: './media_c.jpg', publishedDate: '3rd January, 2024',
    },
  ];

  const event = cloneEvent();
  const restore = mockPageFetch(`<html><body>${dataModelBlock('gold-bordered-articles', {
    title: 'Featured',
    'cta-text': 'View all',
    'cta-link': '/loans/articles',
    'block-category': 'latest-four-articles',
  })}</body></html>`);

  const response = await edge.handler(event);
  restore();

  assert.match(response.body, /acc-carousel-wrapper/);
  assert.match(response.body, /acc-track/);
  assert.match(response.body, /acc-dots/);
  assert.match(response.body, /article-cards-cta-wrapper/);

  edge.fetchQueryIndex = original;
  edge.__clearQueryIndexCache();
});

test('renders the fallback markup when the filtered article list is empty', async () => {
  const original = edge.fetchQueryIndex;
  edge.fetchQueryIndex = async () => [
    {
      path: '/loans/articles/a', title: 'Article A', description: '', image: '', publishedDate: '1st January, 2024',
    },
  ];

  const event = cloneEvent();
  const restore = mockPageFetch(`<html><body>${dataModelBlock('', { 'block-category': 'fixed-deposit' })}</body></html>`);

  const response = await edge.handler(event);
  restore();

  assert.match(response.body, /no-results-wrapper/);
  assert.match(response.body, /data-ssr-rendered="true"/);

  edge.fetchQueryIndex = original;
  edge.__clearQueryIndexCache();
});

test('renders the fallback markup when the requested page is out of range', async () => {
  const original = edge.fetchQueryIndex;
  edge.fetchQueryIndex = async () => [
    {
      path: '/general/articles/a', title: 'Article A', description: '', image: '', publishedDate: '1st January, 2024',
    },
  ];

  const event = cloneEvent();
  event.Records[0].cf.request.querystring = 'page=5';
  const restore = mockPageFetch(`<html><body>${dataModelBlock('', {})}</body></html>`);

  const response = await edge.handler(event);
  restore();

  assert.match(response.body, /no-results-wrapper/);

  edge.fetchQueryIndex = original;
  edge.__clearQueryIndexCache();
});

test('parses row-based (classic table) config when no data-model attribute is present', async () => {
  const original = edge.fetchQueryIndex;
  edge.fetchQueryIndex = async () => [
    {
      path: '/loans/articles/a', title: 'Article A', description: '', image: '', publishedDate: '1st January, 2024',
    },
    {
      path: '/loans/articles/b', title: 'Article B', description: '', image: '', publishedDate: '2nd January, 2024',
    },
  ];

  const event = cloneEvent();
  const restore = mockPageFetch(`<html><body>${rowBasedBlock('', 'Row Title', 'See all', '/articles', 'latest-four-articles')}</body></html>`);

  const response = await edge.handler(event);
  restore();

  assert.match(response.body, /data-ssr-rendered="true"/);
  assert.match(response.body, /Row Title/);
  assert.match(response.body, /See all/);
  assert.match(response.body, /Article B/);

  edge.fetchQueryIndex = original;
  edge.__clearQueryIndexCache();
});

test('leaves the articles-category-cards block untouched when query-index.json fetch fails', async () => {
  const original = edge.fetchQueryIndex;
  edge.fetchQueryIndex = async () => null;

  const event = cloneEvent();
  const pageHtml = `<html><body>${dataModelBlock('', { 'block-category': 'latest-four-articles' })}</body></html>`;
  const restore = mockPageFetch(pageHtml);

  const response = await edge.handler(event);
  restore();

  assert.doesNotMatch(response.body, /data-ssr-rendered/);
  assert.match(response.body, /articles-category-cards/);

  edge.fetchQueryIndex = original;
});

test('leaves the response untouched when fetching the page\'s own HTML fails', async () => {
  const originalGet = https.get;
  https.get = (options, callback) => {
    const res = { statusCode: 502, resume() {} };
    callback(res);
    return { on() {}, destroy() {} };
  };

  const event = cloneEvent();
  const response = await edge.handler(event);

  https.get = originalGet;
  assert.equal(response.body, event.Records[0].cf.response.body);
});

test('fetchQueryIndex pages through query-index.json using total/offset/limit so no rows are dropped', async () => {
  const originalGet = https.get;
  const totalRows = 1200; // bigger than a single 500-row page, forcing the pagination loop

  https.get = (options, callback) => {
    const url = new URL(`https://${options.host}${options.path}`);
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    const count = Math.min(limit, totalRows - offset);
    const data = Array.from({ length: count }, (_, i) => ({ path: `/article-${offset + i}` }));
    const body = JSON.stringify({ total: totalRows, offset, limit, data });
    const res = {
      statusCode: 200,
      on(ev, cb) {
        if (ev === 'data') cb(Buffer.from(body));
        if (ev === 'end') cb();
        return res;
      },
    };
    callback(res);
    return { on() {}, destroy() {} };
  };

  const rows = await edge.fetchQueryIndex('example.com');

  assert.equal(rows.length, totalRows);
  assert.equal(rows[0].path, '/article-0');
  assert.equal(rows[totalRows - 1].path, `/article-${totalRows - 1}`);

  https.get = originalGet;
  edge.__clearQueryIndexCache();
});



