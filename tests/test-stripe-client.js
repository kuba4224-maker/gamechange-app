// ============================================================
// GAMECHANGE — tests/test-stripe-client.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda — kontynuacja "Pracuj dalej").
// lib/stripe-client.js była wcześniej w tym pliku (DO_ZROBIENIA_PRZEZ_KUBE.md)
// oznaczona jako "niska wartość testu bez atrapy fetch" — po bliższym
// przejrzeniu okazało się, że w odróżnieniu od plików wołających Anthropic
// (gdzie fetch zwraca złożoną, trudną do realistycznego zasymulowania
// odpowiedź LLM), tu `fetch` to WBUDOWANA globalna funkcja Node (nie pakiet
// npm) — podmiana `global.fetch` jest prosta, bez żadnej sztuczki z
// Module._resolveFilename, i pokrywa realną logikę wartą testu: budowę
// URL/nagłówków/kodowania form-encoded, rozróżnienie GET/DELETE (query
// string) vs POST (body), i mapowanie błędu Stripe na czytelny wyjątek.
//
// Po tym pliku: `lib/stripe-client.js` przenosi się z "niska wartość" na
// "przetestowane" w spisie pokrycia testami — decyzja zmieniona, dopisane
// w DO_ZROBIENIA_PRZEZ_KUBE.md.
//
// Uruchomienie: node tests/test-stripe-client.js
// ============================================================

const assert = require('assert');
const { stripeRequest } = require('../lib/stripe-client.js');

const originalFetch = global.fetch;
let fetchImpl = null;
global.fetch = (...args) => fetchImpl(...args);

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

function fakeOkResponse(data) {
  return { ok: true, statusText: 'OK', json: async () => data };
}
function fakeErrorResponse(statusText, errorBody) {
  return { ok: false, statusText, json: async () => errorBody };
}

(async () => {
  console.log('stripe-client.js — testy jednostkowe (atrapa global.fetch)');

  await scenario('brak STRIPE_SECRET_KEY -> rzuca PRZED jakąkolwiek próbą fetch', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    let fetchCalled = false;
    fetchImpl = async () => { fetchCalled = true; return fakeOkResponse({}); };
    await assert.rejects(() => stripeRequest('customers', {}), /STRIPE_SECRET_KEY nie skonfigurowany/);
    assert.strictEqual(fetchCalled, false, 'nie powinien nawet próbować kontaktu z Stripe bez klucza');
  });

  process.env.STRIPE_SECRET_KEY = 'sk_test_fakeKey123';

  await scenario('domyślna metoda POST -> body form-encoded, Content-Type ustawiony, brak query stringa w URL', async () => {
    let capturedUrl = null, capturedInit = null;
    fetchImpl = async (url, init) => { capturedUrl = url; capturedInit = init; return fakeOkResponse({ id: 'cus_123' }); };
    const r = await stripeRequest('customers', { email: 'test@example.com', name: 'Jan Kowalski' });
    assert.strictEqual(capturedUrl, 'https://api.stripe.com/v1/customers');
    assert.strictEqual(capturedInit.method, 'POST');
    assert.strictEqual(capturedInit.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.strictEqual(capturedInit.body, 'email=test%40example.com&name=Jan+Kowalski');
    assert.deepStrictEqual(r, { id: 'cus_123' });
  });

  await scenario('nagłówek Authorization -> Basic base64(secretKey + ":")', async () => {
    let capturedInit = null;
    fetchImpl = async (url, init) => { capturedInit = init; return fakeOkResponse({}); };
    await stripeRequest('customers', {});
    const expected = `Basic ${Buffer.from('sk_test_fakeKey123:').toString('base64')}`;
    assert.strictEqual(capturedInit.headers.Authorization, expected);
  });

  await scenario('metoda GET -> pola trafiają do query stringa, BRAK body/Content-Type', async () => {
    let capturedUrl = null, capturedInit = null;
    fetchImpl = async (url, init) => { capturedUrl = url; capturedInit = init; return fakeOkResponse({ data: [] }); };
    await stripeRequest('subscriptions', { customer: 'cus_123', status: 'active' }, 'GET');
    assert.strictEqual(capturedUrl, 'https://api.stripe.com/v1/subscriptions?customer=cus_123&status=active');
    assert.strictEqual(capturedInit.body, undefined);
    assert.strictEqual(capturedInit.headers['Content-Type'], undefined);
  });

  await scenario('metoda DELETE -> pola też trafiają do query stringa (np. anulowanie subskrypcji)', async () => {
    let capturedUrl = null, capturedInit = null;
    fetchImpl = async (url, init) => { capturedUrl = url; capturedInit = init; return fakeOkResponse({ canceled: true }); };
    await stripeRequest('subscriptions/sub_123', { prorate: 'false' }, 'DELETE');
    assert.strictEqual(capturedUrl, 'https://api.stripe.com/v1/subscriptions/sub_123?prorate=false');
    assert.strictEqual(capturedInit.method, 'DELETE');
    assert.strictEqual(capturedInit.body, undefined);
  });

  await scenario('metoda GET bez pól -> URL bez "?" na końcu (pusty encoded string pominięty)', async () => {
    let capturedUrl = null;
    fetchImpl = async (url) => { capturedUrl = url; return fakeOkResponse({}); };
    await stripeRequest('balance', {}, 'GET');
    assert.strictEqual(capturedUrl, 'https://api.stripe.com/v1/balance');
  });

  await scenario('odpowiedź Stripe z błędem (res.ok=false) -> rzuca z treścią error.message ze Stripe', async () => {
    fetchImpl = async () => fakeErrorResponse('Bad Request', { error: { message: 'No such customer: cus_nieistnieje' } });
    await assert.rejects(
      () => stripeRequest('customers/cus_nieistnieje', {}, 'GET'),
      /Stripe API error \(GET customers\/cus_nieistnieje\): No such customer: cus_nieistnieje/
    );
  });

  await scenario('odpowiedź z błędem, ale bez data.error.message -> pada na res.statusText', async () => {
    fetchImpl = async () => fakeErrorResponse('Internal Server Error', {});
    await assert.rejects(
      () => stripeRequest('customers', {}),
      /Stripe API error \(POST customers\): Internal Server Error/
    );
  });

  await scenario('happy path -> zwraca sparsowany JSON bez zmian', async () => {
    const payload = { id: 'sub_456', status: 'active', items: { data: [] } };
    fetchImpl = async () => fakeOkResponse(payload);
    const r = await stripeRequest('subscriptions', {});
    assert.deepStrictEqual(r, payload);
  });

  global.fetch = originalFetch;

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
