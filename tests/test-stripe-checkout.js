// ============================================================
// GAMECHANGE — tests/test-stripe-checkout.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda, dalszy ciąg — kontynuacja
// "Pracuj dalej"). api/stripe-checkout.js to NAJWYŻSZE ryzyko ze wszystkich
// dotąd nieprzetestowanych plików: prawdziwe pieniądze (Stripe) + ochrona
// niepełnoletnich (zgoda rodzica na płatność) + ręczna weryfikacja podpisu
// webhooka (HMAC-SHA256 + porównanie w stałym czasie) — dotąd bez ŻADNEGO
// testu. Ten plik to domyka.
//
// `verifyStripeSignature` dopisana dziś do `module.exports._internal` —
// czysta, krytyczna dla bezpieczeństwa funkcja, warta bezpośredniego testu
// (patrz komentarz w api/stripe-checkout.js) — czysto addytywne.
//
// STUBOWANE ZALEŻNOŚCI (ten sam, ustalony w tym projekcie wzorzec —
// Module._resolveFilename dla pakietów npm, require.cache dla lokalnych
// ścieżek):
//   - @supabase/supabase-js — pakiet niezainstalowany w tej piaskownicy.
//   - ../lib/email-sender — świadomie STUBOWANE (czyste I/O, wysyłka
//     realnego maila — nie chcemy tego wołać w teście).
//   - ../lib/parental-payment-consent — świadomie STUBOWANE.
//     `requiresParentalConsent`/`createConsentRequest` mają już WŁASNY,
//     dedykowany plik testowy (test-parental-payment-consent.js, 10/10) —
//     tu testujemy WYŁĄCZNIE orkiestrację stripe-checkout.js (czy woła je z
//     poprawnymi argumentami, czy poprawnie reaguje na ich wynik), nie ich
//     własną poprawność.
//   - ../lib/stripe-client — świadomie STUBOWANE (ma własny plik testowy,
//     test-stripe-client.js, 9/9) — tu kontrolujemy WYNIK stripeRequest(),
//     nie testujemy ponownie budowy URL/form-encoding.
//   - ../lib/email-templates — CELOWO NIE stubowane, ładowane naprawdę
//     (plik czysty, bez zależności, już przetestowany w
//     test-email-templates.js) — daje pełniejszy test integracyjny treści
//     maila do rodzica bez ryzyka (funkcja jest deterministyczna i pure).
//
// Uruchomienie: node tests/test-stripe-checkout.js
// ============================================================

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

// --- 1. Atrapa @supabase/supabase-js ---
let currentFakeSupabase = null;
const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_8__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath,
  filename: supabaseStubPath,
  loaded: true,
  exports: { createClient: () => currentFakeSupabase },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

// --- 2. Atrapy lokalnych zależności (require.cache) ---
let sendEmailImpl = async () => {};
const sendEmailCalls = [];
const emailSenderPath = require.resolve('../lib/email-sender.js');
require.cache[emailSenderPath] = {
  id: emailSenderPath, filename: emailSenderPath, loaded: true,
  exports: { sendEmail: async (args) => { sendEmailCalls.push(args); return sendEmailImpl(args); } },
};

let requiresParentalConsentImpl = () => false;
let createConsentRequestImpl = async () => ({ id: 'consent1', consent_token: 'tok123abc', expires_at: '2026-08-18T00:00:00.000Z' });
const requiresParentalConsentCalls = [];
const createConsentRequestCalls = [];
const parentalConsentPath = require.resolve('../lib/parental-payment-consent.js');
require.cache[parentalConsentPath] = {
  id: parentalConsentPath, filename: parentalConsentPath, loaded: true,
  exports: {
    requiresParentalConsent: (birthYear) => { requiresParentalConsentCalls.push(birthYear); return requiresParentalConsentImpl(birthYear); },
    createConsentRequest: async (supabase, args) => { createConsentRequestCalls.push(args); return createConsentRequestImpl(supabase, args); },
  },
};

let stripeRequestImpl = async () => ({ url: 'https://checkout.stripe.com/fake-session', id: 'cs_test_123' });
const stripeRequestCalls = [];
const stripeClientPath = require.resolve('../lib/stripe-client.js');
require.cache[stripeClientPath] = {
  id: stripeClientPath, filename: stripeClientPath, loaded: true,
  exports: { stripeRequest: async (path_, fields, method) => { stripeRequestCalls.push({ path: path_, fields, method }); return stripeRequestImpl(path_, fields, method); } },
};

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.STRIPE_PRICE_INDIVIDUAL = 'price_individual_fake';
process.env.STRIPE_PRICE_TEAM_BASIC = 'price_team_basic_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake_secret';
process.env.APP_BASE_URL = 'https://test.gamechange.app';

const handler = require('../api/stripe-checkout.js');
const { verifyStripeSignature } = handler._internal;

Module._resolveFilename = originalResolveFilename;

// --- 3. Atrapa Supabase dla subscriptions/users ---
function makeFakeSupabase({ subscriptions = [], users = [], updateError = null } = {}) {
  const state = { subscriptions: subscriptions.map((s) => ({ ...s })), users: users.map((u) => ({ ...u })) };
  return {
    _state: state,
    from(table) {
      const filters = [];
      let mode = 'select';
      let updatePayload = null;
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        update(payload) { mode = 'update'; updatePayload = payload; return builder; },
        maybeSingle() {
          const rows = state[table].filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve, reject) {
          if (mode === 'update') {
            if (updateError) return Promise.resolve({ error: updateError }).then(resolve, reject);
            const rows = state[table].filter((r) => filters.every((f) => f(r)));
            rows.forEach((r) => Object.assign(r, updatePayload));
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: state[table], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function makeReq({ method = 'POST', headers = {}, bodyObj, bodyRaw } = {}) {
  const raw = bodyRaw !== undefined ? bodyRaw : JSON.stringify(bodyObj !== undefined ? bodyObj : {});
  return {
    method,
    headers,
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(raw, 'utf8'); },
  };
}

function makeRes() {
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return res; },
    json(obj) { jsonBody = obj; return res; },
  };
  return { res, status: () => statusCode, json: () => jsonBody };
}

function signHeader(rawBodyStr, secret, { timestamp = Math.floor(Date.now() / 1000), badSig = false } = {}) {
  const signedPayload = `${timestamp}.${rawBodyStr}`;
  const sig = badSig ? '0'.repeat(64) : crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

let passed = 0;
let failed = 0;
async function scenario(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${e.stack || e.message}`);
  }
}

(async () => {
  console.log('stripe-checkout.js — testy jednostkowe (atrapy Supabase + lib/*)');

  console.log('\n1. verifyStripeSignature — weryfikacja kryptograficzna (funkcja czysta, bez I/O)');

  await scenario('brak nagłówka -> rzuca "Brak nagłówka stripe-signature."', () => {
    assert.throws(() => verifyStripeSignature(Buffer.from('{}'), undefined, 'sekret'), /Brak nagłówka stripe-signature/);
  });

  await scenario('nagłówek bez t= albo v1= -> rzuca "Nieprawidłowy format"', () => {
    assert.throws(() => verifyStripeSignature(Buffer.from('{}'), 'coś-innego=xyz', 'sekret'), /Nieprawidłowy format nagłówka/);
  });

  await scenario('timestamp starszy niż 5 minut -> rzuca "zbyt stare" (ochrona przed replay)', () => {
    const raw = '{"a":1}';
    const oldTs = Math.floor(Date.now() / 1000) - 400; // 400s > 300s tolerancji
    const header = signHeader(raw, 'sekret', { timestamp: oldTs });
    assert.throws(() => verifyStripeSignature(Buffer.from(raw), header, 'sekret'), /zbyt stare/);
  });

  await scenario('nieprawidłowy podpis (zły sekret) -> rzuca "Nieprawidłowy podpis"', () => {
    const raw = '{"a":1}';
    const header = signHeader(raw, 'zly-sekret');
    assert.throws(() => verifyStripeSignature(Buffer.from(raw), header, 'prawdziwy-sekret'), /Nieprawidłowy podpis/);
  });

  await scenario('podpis o INNEJ długości niż oczekiwana -> też rzuca (nie crashuje na timingSafeEqual)', () => {
    const raw = '{"a":1}';
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=zakrotki`;
    assert.throws(() => verifyStripeSignature(Buffer.from(raw), header, 'sekret'), /Nieprawidłowy podpis/);
  });

  await scenario('poprawny podpis, świeży timestamp -> NIE rzuca', () => {
    const raw = '{"a":1,"b":"tekst"}';
    const header = signHeader(raw, 'prawdziwy-sekret');
    assert.doesNotThrow(() => verifyStripeSignature(Buffer.from(raw), header, 'prawdziwy-sekret'));
  });

  console.log('\n2. dispatcher — metoda i routing webhook vs checkout session');

  await scenario('metoda != POST -> 405', async () => {
    const { res, status } = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    assert.strictEqual(status(), 405);
  });

  console.log('\n3. handleCreateCheckoutSession (brak nagłówka stripe-signature)');

  await scenario('nieprawidłowy JSON w body -> 400', async () => {
    const { res, status } = makeRes();
    await handler(makeReq({ bodyRaw: '{zly json' }), res);
    assert.strictEqual(status(), 400);
  });

  await scenario('brak userId -> 400', async () => {
    const { res, status } = makeRes();
    await handler(makeReq({ bodyObj: { pricingTier: 'individual' } }), res);
    assert.strictEqual(status(), 400);
  });

  await scenario('nieprawidłowy pricingTier -> 400', async () => {
    const { res, status } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'u1', pricingTier: 'coś-innego' } }), res);
    assert.strictEqual(status(), 400);
  });

  await scenario('brak skonfigurowanego price_id w Vercel -> 500 z czytelnym komunikatem', async () => {
    delete process.env.STRIPE_PRICE_INDIVIDUAL;
    const { res, status, json } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'u1', pricingTier: 'individual' } }), res);
    assert.strictEqual(status(), 500);
    assert.match(json().error, /Brak skonfigurowanego price_id/);
    process.env.STRIPE_PRICE_INDIVIDUAL = 'price_individual_fake';
  });

  await scenario('subskrypcja nie istnieje dla usera -> 404', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [] });
    const { res, status } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'brak-subskrypcji', pricingTier: 'individual' } }), res);
    assert.strictEqual(status(), 404);
  });

  await scenario('niepełnoletni (wymaga zgody), BRAK parentEmail -> 400 parent_email_required, BRAK próby Checkout', async () => {
    requiresParentalConsentImpl = () => true;
    stripeRequestCalls.length = 0;
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'nastolatek', stripe_customer_id: null }],
      users: [{ id: 'nastolatek', birth_year: 2010 }],
    });
    const { res, status, json } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'nastolatek', pricingTier: 'individual' } }), res);
    assert.strictEqual(status(), 400);
    assert.strictEqual(json().error, 'parent_email_required');
    assert.strictEqual(stripeRequestCalls.length, 0);
  });

  await scenario('niepełnoletni, parentEmail BEZ "@" -> traktowany jak brak -> 400', async () => {
    requiresParentalConsentImpl = () => true;
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'nastolatek2', stripe_customer_id: null }],
      users: [{ id: 'nastolatek2', birth_year: 2010 }],
    });
    const { res, status } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'nastolatek2', pricingTier: 'individual', parentEmail: 'nieprawidlowy' } }), res);
    assert.strictEqual(status(), 400);
  });

  await scenario('niepełnoletni, parentEmail poprawny -> przechodzi, metadata[parent_email] w fields', async () => {
    requiresParentalConsentImpl = () => true;
    stripeRequestCalls.length = 0;
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'nastolatek3', stripe_customer_id: null }],
      users: [{ id: 'nastolatek3', birth_year: 2010 }],
    });
    const { res, status, json } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'nastolatek3', pricingTier: 'individual', parentEmail: 'rodzic@example.com' } }), res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(json().ok, true);
    assert.strictEqual(stripeRequestCalls[0].fields['metadata[parent_email]'], 'rodzic@example.com');
  });

  await scenario('pełnoletni -> requiresParentalConsent=false -> BRAK metadata[parent_email] nawet bez podania e-maila', async () => {
    requiresParentalConsentImpl = () => false;
    stripeRequestCalls.length = 0;
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'dorosly', stripe_customer_id: null }],
      users: [{ id: 'dorosly', birth_year: 1990 }],
    });
    const { res, status, json } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'dorosly', pricingTier: 'individual' } }), res);
    assert.strictEqual(status(), 200);
    assert.strictEqual('metadata[parent_email]' in stripeRequestCalls[0].fields, false);
  });

  await scenario('happy path, pricingTier="team_basic" -> używa STRIPE_PRICE_TEAM_BASIC', async () => {
    requiresParentalConsentImpl = () => false;
    stripeRequestCalls.length = 0;
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'trener1', stripe_customer_id: null }],
      users: [{ id: 'trener1', birth_year: 1985 }],
    });
    const { res } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'trener1', pricingTier: 'team_basic' } }), res);
    assert.strictEqual(stripeRequestCalls[0].fields['line_items[0][price]'], 'price_team_basic_fake');
  });

  await scenario('happy path, pricingTier="team_upgraded" -> używa STRIPE_PRICE_INDIVIDUAL (współdzielony Price)', async () => {
    requiresParentalConsentImpl = () => false;
    stripeRequestCalls.length = 0;
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'trener2', stripe_customer_id: null }],
      users: [{ id: 'trener2', birth_year: 1985 }],
    });
    const { res } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'trener2', pricingTier: 'team_upgraded' } }), res);
    assert.strictEqual(stripeRequestCalls[0].fields['line_items[0][price]'], 'price_individual_fake');
  });

  await scenario('istniejący stripe_customer_id -> reużyty jako fields.customer (nie tworzy duplikatu klienta)', async () => {
    requiresParentalConsentImpl = () => false;
    stripeRequestCalls.length = 0;
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'wracajacy', stripe_customer_id: 'cus_existing_123' }],
      users: [{ id: 'wracajacy', birth_year: 1985 }],
    });
    const { res } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'wracajacy', pricingTier: 'individual' } }), res);
    assert.strictEqual(stripeRequestCalls[0].fields.customer, 'cus_existing_123');
  });

  await scenario('brak stripe_customer_id -> BRAK pola customer w fields (Stripe sam poprosi o e-mail)', async () => {
    requiresParentalConsentImpl = () => false;
    stripeRequestCalls.length = 0;
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'nowy-klient', stripe_customer_id: null }],
      users: [{ id: 'nowy-klient', birth_year: 1985 }],
    });
    const { res } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'nowy-klient', pricingTier: 'individual' } }), res);
    assert.strictEqual('customer' in stripeRequestCalls[0].fields, false);
  });

  await scenario('stripeRequest rzuca (np. Stripe API padło) -> 500, komunikat przekazany', async () => {
    requiresParentalConsentImpl = () => false;
    stripeRequestImpl = async () => { throw new Error('Stripe API error (POST checkout/sessions): karta odrzucona'); };
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'blad-stripe', stripe_customer_id: null }],
      users: [{ id: 'blad-stripe', birth_year: 1985 }],
    });
    const { res, status, json } = makeRes();
    await handler(makeReq({ bodyObj: { userId: 'blad-stripe', pricingTier: 'individual' } }), res);
    assert.strictEqual(status(), 500);
    assert.match(json().error, /karta odrzucona/);
    stripeRequestImpl = async () => ({ url: 'https://checkout.stripe.com/fake-session', id: 'cs_test_123' });
  });

  console.log('\n4. handleWebhook — bramka bezpieczeństwa (sekret, podpis, JSON)');

  await scenario('brak STRIPE_WEBHOOK_SECRET w Vercel -> 500, PRZED weryfikacją podpisu', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { res, status, json } = makeRes();
    await handler(makeReq({ headers: { 'stripe-signature': 'cokolwiek' }, bodyObj: {} }), res);
    assert.strictEqual(status(), 500);
    assert.match(json().error, /Brak STRIPE_WEBHOOK_SECRET/);
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake_secret';
  });

  await scenario('nieprawidłowy podpis -> 400, event NIE przetworzony (Supabase nietknięty)', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [] });
    const { res, status } = makeRes();
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    await handler(makeReq({ headers: { 'stripe-signature': 'zly-podpis' }, bodyRaw: raw }), res);
    assert.strictEqual(status(), 400);
  });

  await scenario('poprawny podpis, ale niepoprawny JSON w body -> 400', async () => {
    const raw = '{zly json po podpisaniu';
    const sig = signHeader(raw, 'whsec_fake_secret');
    const { res, status } = makeRes();
    await handler(makeReq({ headers: { 'stripe-signature': sig }, bodyRaw: raw }), res);
    assert.strictEqual(status(), 400);
  });

  console.log('\n5. handleWebhook — checkout.session.completed');

  function signedWebhookReq(eventObj) {
    const raw = JSON.stringify(eventObj);
    const sig = signHeader(raw, 'whsec_fake_secret');
    return makeReq({ headers: { 'stripe-signature': sig }, bodyRaw: raw });
  }

  await scenario('brak metadata.user_id -> 200, skipped, BRAK aktualizacji subscriptions', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [{ id: 's1', subscriber_user_id: 'ktos', status: 'trialing' }] });
    const { res, status, json } = makeRes();
    await handler(signedWebhookReq({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', customer: 'cus_1' } } }), res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(json().skipped, 'brak user_id w metadanych');
    assert.strictEqual(currentFakeSupabase._state.subscriptions[0].status, 'trialing');
  });

  await scenario('happy path -> subscriptions zaktualizowane (customer_id, subscription_id, status=active, pricing_tier)', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [{ id: 's1', subscriber_user_id: 'placacy', status: 'trialing' }] });
    const { res, status, json } = makeRes();
    await handler(signedWebhookReq({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', customer: 'cus_2', subscription: 'sub_2', metadata: { user_id: 'placacy', pricing_tier: 'individual' } } },
    }), res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(json().ok, true);
    const row = currentFakeSupabase._state.subscriptions[0];
    assert.strictEqual(row.stripe_customer_id, 'cus_2');
    assert.strictEqual(row.stripe_subscription_id, 'sub_2');
    assert.strictEqual(row.status, 'active');
    assert.strictEqual(row.pricing_tier, 'individual');
  });

  await scenario('błąd UPDATE subscriptions -> 500', async () => {
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'blad-update' }],
      updateError: { message: 'baza niedostępna' },
    });
    const { res, status, json } = makeRes();
    await handler(signedWebhookReq({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_3', customer: 'cus_3', metadata: { user_id: 'blad-update' } } },
    }), res);
    assert.strictEqual(status(), 500);
    assert.match(json().error, /baza niedostępna/);
  });

  await scenario('metadata niesie parent_email -> tworzy prośbę o zgodę I wysyła e-mail z poprawną treścią', async () => {
    createConsentRequestCalls.length = 0;
    sendEmailCalls.length = 0;
    createConsentRequestImpl = async () => ({ id: 'consent-x', consent_token: 'TOKEN123', expires_at: '2026-08-18T00:00:00.000Z' });
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'nastolatek-placi' }],
      users: [{ id: 'nastolatek-placi', full_name: 'Jan Kowalski' }],
    });
    const { res, status } = makeRes();
    await handler(signedWebhookReq({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_4', customer: 'cus_4', subscription: 'sub_4',
          metadata: { user_id: 'nastolatek-placi', pricing_tier: 'individual', parent_email: 'rodzic-x@example.com' },
        },
      },
    }), res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(createConsentRequestCalls.length, 1);
    assert.strictEqual(createConsentRequestCalls[0].userId, 'nastolatek-placi');
    assert.strictEqual(createConsentRequestCalls[0].parentEmail, 'rodzic-x@example.com');
    assert.strictEqual(createConsentRequestCalls[0].stripeSubscriptionId, 'sub_4');
    assert.strictEqual(sendEmailCalls.length, 1);
    assert.strictEqual(sendEmailCalls[0].to, 'rodzic-x@example.com');
    assert.match(sendEmailCalls[0].html, /TOKEN123/, 'link w mailu musi zawierać wygenerowany token zgody');
  });

  await scenario('błąd w tworzeniu prośby o zgodę (createConsentRequest rzuca) -> NIE psuje odpowiedzi webhooka (200, dostęp już aktywny)', async () => {
    createConsentRequestImpl = async () => { throw new Error('insert padł'); };
    currentFakeSupabase = makeFakeSupabase({
      subscriptions: [{ id: 's1', subscriber_user_id: 'odporny-test' }],
      users: [{ id: 'odporny-test', full_name: 'X' }],
    });
    const { res, status, json } = makeRes();
    await handler(signedWebhookReq({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_5', customer: 'cus_5', metadata: { user_id: 'odporny-test', parent_email: 'rodzic@example.com' } } },
    }), res);
    assert.strictEqual(status(), 200, 'błąd w kroku zgody rodzica nie może zablokować już aktywnego dostępu zawodnika');
    assert.strictEqual(json().ok, true);
    createConsentRequestImpl = async () => ({ id: 'consent1', consent_token: 'tok123abc', expires_at: '2026-08-18T00:00:00.000Z' });
  });

  await scenario('brak parent_email w metadanych -> BRAK próby stworzenia zgody/wysyłki maila', async () => {
    createConsentRequestCalls.length = 0;
    sendEmailCalls.length = 0;
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [{ id: 's1', subscriber_user_id: 'bez-rodzica' }] });
    const { res } = makeRes();
    await handler(signedWebhookReq({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_6', customer: 'cus_6', metadata: { user_id: 'bez-rodzica' } } },
    }), res);
    assert.strictEqual(createConsentRequestCalls.length, 0);
    assert.strictEqual(sendEmailCalls.length, 0);
  });

  console.log('\n6. handleWebhook — customer.subscription.updated / .deleted / nieznany typ');

  await scenario('customer.subscription.updated -> status + current_period_end (unix -> ISO)', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [{ id: 's1', stripe_subscription_id: 'sub_upd_1', status: 'active' }] });
    const { res, status } = makeRes();
    const unixTs = 1755000000; // dowolny, deterministyczny znacznik czasu
    await handler(signedWebhookReq({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_upd_1', status: 'past_due', current_period_end: unixTs } },
    }), res);
    assert.strictEqual(status(), 200);
    const row = currentFakeSupabase._state.subscriptions[0];
    assert.strictEqual(row.status, 'past_due');
    assert.strictEqual(row.current_period_end, new Date(unixTs * 1000).toISOString());
  });

  await scenario('customer.subscription.updated BEZ current_period_end -> aktualizuje tylko status', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [{ id: 's1', stripe_subscription_id: 'sub_upd_2', status: 'active', current_period_end: 'stara-wartosc' }] });
    const { res } = makeRes();
    await handler(signedWebhookReq({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_upd_2', status: 'unpaid' } },
    }), res);
    const row = currentFakeSupabase._state.subscriptions[0];
    assert.strictEqual(row.status, 'unpaid');
    assert.strictEqual(row.current_period_end, 'stara-wartosc', 'brak current_period_end w evencie nie powinien nadpisać istniejącej wartości');
  });

  await scenario('customer.subscription.updated, błąd UPDATE -> 500', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [{ id: 's1', stripe_subscription_id: 'sub_upd_3' }], updateError: { message: 'update padł' } });
    const { res, status } = makeRes();
    await handler(signedWebhookReq({ type: 'customer.subscription.updated', data: { object: { id: 'sub_upd_3', status: 'active' } } }), res);
    assert.strictEqual(status(), 500);
  });

  await scenario('customer.subscription.deleted -> status=canceled', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [{ id: 's1', stripe_subscription_id: 'sub_del_1', status: 'active' }] });
    const { res, status } = makeRes();
    await handler(signedWebhookReq({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_del_1' } } }), res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(currentFakeSupabase._state.subscriptions[0].status, 'canceled');
  });

  await scenario('nieznany typ zdarzenia -> 200 ok, Supabase update NIGDY wywołany', async () => {
    currentFakeSupabase = makeFakeSupabase({ subscriptions: [{ id: 's1', stripe_subscription_id: 'sub_x', status: 'active' }] });
    const { res, status, json } = makeRes();
    await handler(signedWebhookReq({ type: 'invoice.payment_failed', data: { object: { id: 'in_1' } } }), res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(json().ok, true);
    assert.strictEqual(currentFakeSupabase._state.subscriptions[0].status, 'active', 'nieobsługiwany typ zdarzenia nie powinien nic zmieniać');
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
