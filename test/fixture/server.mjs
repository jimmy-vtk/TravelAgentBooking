// A tiny local "provider" for Tier 1 tests - not a real OTA, no external dependency, no network. Four
// pages: search -> results -> guest details -> payment. Import startFixture() from a test, or run this
// file directly (`node test/fixture/server.mjs`) to poke at it by hand.
import { createServer } from 'node:http';

const PAGES = {
  '/': `<!doctype html><html><body>
    <h1>Search</h1>
    <input placeholder="Hotel name" id="hotel" />
    <button onclick="location.href='/results'">Search</button>
  </body></html>`,

  '/results': `<!doctype html><html><body>
    <h1>Results</h1>
    <div>Fixture Hotel - 200 EUR/night</div>
    <button onclick="location.href='/guest'">Reserve</button>
  </body></html>`,

  // Deliberately includes a step breadcrumb that MENTIONS "Payment" as the upcoming step 3 label - this
  // reproduces the real false-positive found live on Halalbooking (2026-09): text-only payment detection
  // fired on this exact kind of page, before any card field or real payment content existed.
  '/guest': `<!doctype html><html><body>
    <nav>1 Options - 2 Guest details - 3 Payment</nav>
    <h1>Guest details</h1>
    <p>Total: 600.00 EUR</p>
    <label for="firstName">First name</label><input id="firstName" />
    <label for="lastName">Last name</label><input id="lastName" />
    <label for="email">Email</label><input id="email" type="email" />
    <label for="phone">Phone</label><input id="phone" />
    <button onclick="location.href='/payment'">Continue</button>
  </body></html>`,

  '/payment': `<!doctype html><html><body>
    <h1>Payment</h1>
    <p>Total: 600.00 EUR</p>
    <label for="cardNumber">Card number</label><input id="cardNumber" />
    <label for="cvv">CVV</label><input id="cvv" />
    <button id="payNow">Pay now</button>
  </body></html>`,

  // /payment-broken drops the "Continue" button's target and the guest form's email field - used to
  // simulate drift (a step that Replay recorded no longer exists).
  '/guest-broken': `<!doctype html><html><body>
    <h1>Guest details</h1>
    <label for="firstName">First name</label><input id="firstName" />
    <label for="lastName">Last name</label><input id="lastName" />
    <button onclick="location.href='/payment'">Continue</button>
  </body></html>`,

  // Stands in for an unrelated third-party ad/tracking iframe - reproduces the false positive found live
  // on Agoda (2026-09): a promo creative's own copy and a "redeem" input happened to satisfy both
  // PAYMENT_WORDS+PRICE_WORDS and CARD_FIELD_WORDS entirely on its own, on the SEARCH RESULTS page, before
  // any real booking flow had started. Served on a different hostname (see /results-with-ad-iframe) so it's
  // a genuinely different origin from the main page's point of view, same as a real ad network would be.
  '/ad': `<!doctype html><html><body>
    <p>Win a free credit card! Enter your card number for a chance at $500 cashback. Total prize: $500.00</p>
    <input placeholder="Card Number" />
  </body></html>`,

  // The main page a real user is on - itself has NO payment wording and NO card-shaped input - but embeds
  // the third-party ad iframe above. Only the frame-scoping fix (isRelevantFrame) tells these apart.
  '/results-with-ad-iframe': `<!doctype html><html><body>
    <h1>Results</h1>
    <div>Fixture Hotel - 200 EUR/night</div>
    <iframe src="http://localhost:__PORT__/ad" width="300" height="150"></iframe>
    <button onclick="location.href='/guest'">Reserve</button>
  </body></html>`,
};

export function startFixture(port = 0) {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const body = PAGES[path];
    if (!body) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body.replace('__PORT__', server.address().port));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actualPort } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${actualPort}` });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { baseUrl } = await startFixture(8199);
  console.log(`Fixture running at ${baseUrl}`);
}
