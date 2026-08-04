// ============================================================
// GAMECHANGE — tests/test-send-push.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda — kontynuacja "Pracuj dalej").
// api/send-push.js (wysyłka FCM przez firebase-admin) było dotąd bez
// żadnego testu — ryzykowne, bo (a) `getFirebaseApp()` cache'uje instancję
// modułowo (`appInstance`), więc błąd w tej logice ujawniłby się dopiero
// przy DRUGIM wywołaniu w danym cold starcie, trudne do złapania ręcznie;
// (b) rozróżnienie "token nieaktualny" vs "inny błąd wysyłki"
// (`invalidTokens`) to warunek na konkretnych kodach błędów FCM, łatwo o
// literówkę bez testu.
//
// `firebase-admin` NIE jest zainstalowany w tej piaskownicy (ten sam powód
// co @supabase/supabase-js — zerowy dostęp do rejestru npm tutaj) — ten sam
// mechanizm stubowania: przechwycenie Module._resolveFilename dla samej
// nazwy pakietu, przekierowane na własną, w pełni kontrolowaną atrapę
// `admin` (mutowalne pola, żeby dało się zmieniać zachowanie między
// scenariuszami bez ponownego require()).
//
// WAŻNA KOLEJNOŚĆ SCENARIUSZY: `getFirebaseApp()` cache'uje `appInstance`
// modułowo (raz zainicjalizowany, zostaje na resztę procesu) — dlatego
// scenariusze sprawdzające błędy KONFIGURACJI (brak zmiennej środowiskowej,
// niepoprawny JSON) muszą wykonać się PRZED pierwszym udanym wywołaniem,
// inaczej dostałyby cache'owaną instancję zamiast realnie przetestować
// ścieżkę błędu.
//
// Uruchomienie: node tests/test-send-push.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- Atrapa firebase-admin (pakiet niezainstalowany w tym środowisku) ---
let credentialCertFn = (sa) => ({ __fakeCert: true, sa });
let initializeAppFn = () => ({ __fakeApp: true });
let sendEachForMulticastFn = async () => ({ successCount: 0, failureCount: 0, responses: [] });
let initializeAppCallCount = 0;

const fakeAdmin = {
  credential: { cert: (sa) => credentialCertFn(sa) },
  initializeApp: (opts) => { initializeAppCallCount++; return initializeAppFn(opts); },
  messaging: () => ({ sendEachForMulticast: (message) => sendEachForMulticastFn(message) }),
};

const adminStubPath = path.join(__dirname, '__stub_firebase_admin__.js');
require.cache[adminStubPath] = {
  id: adminStubPath,
  filename: adminStubPath,
  loaded: true,
  exports: fakeAdmin,
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'firebase-admin') return adminStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const { sendPush, verifyFirebaseConfig } = require('../api/send-push.js');

Module._resolveFilename = originalResolveFilename;

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
  console.log('send-push.js — testy jednostkowe (atrapa firebase-admin)');

  console.log('\n1. sendPush — walidacja wejścia (przed jakąkolwiek próbą kontaktu z Firebase)');

  await scenario('brak title -> rzuca', async () => {
    await assert.rejects(() => sendPush(['tok1'], { body: 'treść' }), /brak title\/body/);
  });

  await scenario('brak body -> rzuca', async () => {
    await assert.rejects(() => sendPush(['tok1'], { title: 'tytuł' }), /brak title\/body/);
  });

  await scenario('pusta tablica tokenów -> zera od razu, BEZ kontaktu z Firebase (bezpieczne mimo braku konfiguracji)', async () => {
    const r = await sendPush([], { title: 't', body: 'b' });
    assert.deepStrictEqual(r, { successCount: 0, failureCount: 0, invalidTokens: [] });
  });

  console.log('\n2. getFirebaseApp — błędy konfiguracji (MUSZĄ wykonać się przed pierwszym udanym init, patrz nagłówek)');

  await scenario('brak FIREBASE_SERVICE_ACCOUNT_JSON -> rzuca czytelny komunikat o brakującej konfiguracji', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    await assert.rejects(() => sendPush(['tok1'], { title: 't', body: 'b' }), /FIREBASE_SERVICE_ACCOUNT_JSON nie skonfigurowany/);
  });

  await scenario('FIREBASE_SERVICE_ACCOUNT_JSON niepoprawny JSON -> rzuca z przyczyną parsowania', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{niepoprawny json,,,';
    await assert.rejects(() => sendPush(['tok1'], { title: 't', body: 'b' }), /nie jest poprawnym JSON-em/);
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  });

  console.log('\n3. sendPush — ścieżka sukcesu (od tego momentu appInstance zostaje cache\'owany)');

  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'gamechange-fake', client_email: 'x@y.z', private_key: 'fake-key' });

  await scenario('happy path, wiele tokenów -> poprawne successCount/failureCount, dane zamienione na stringi', async () => {
    let capturedMessage = null;
    sendEachForMulticastFn = async (message) => {
      capturedMessage = message;
      return {
        successCount: 2,
        failureCount: 0,
        responses: [{ success: true }, { success: true }],
      };
    };
    const r = await sendPush(['tokA', 'tokB'], { title: 'Cześć', body: 'Trening czeka', data: { focusBlockId: 'fb1', stage: 3 } });
    assert.strictEqual(r.successCount, 2);
    assert.strictEqual(r.failureCount, 0);
    assert.deepStrictEqual(r.invalidTokens, []);
    assert.deepStrictEqual(capturedMessage.tokens, ['tokA', 'tokB']);
    assert.deepStrictEqual(capturedMessage.notification, { title: 'Cześć', body: 'Trening czeka' });
    // Dane FCM muszą być Record<string,string> — liczba 3 zamieniona na string "3".
    assert.deepStrictEqual(capturedMessage.data, { focusBlockId: 'fb1', stage: '3' });
  });

  await scenario('pojedynczy token (nie tablica) -> traktowany tak samo jak tablica jednoelementowa', async () => {
    let capturedMessage = null;
    sendEachForMulticastFn = async (message) => {
      capturedMessage = message;
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    };
    await sendPush('tylko-jeden-token', { title: 't', body: 'b' });
    assert.deepStrictEqual(capturedMessage.tokens, ['tylko-jeden-token']);
  });

  await scenario('brak data -> pole data w wiadomości to undefined (nie {})', async () => {
    let capturedMessage = null;
    sendEachForMulticastFn = async (message) => {
      capturedMessage = message;
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    };
    await sendPush(['tok1'], { title: 't', body: 'b' });
    assert.strictEqual(capturedMessage.data, undefined);
  });

  await scenario('token z błędem "registration-token-not-registered" -> trafia do invalidTokens', async () => {
    sendEachForMulticastFn = async () => ({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'gone' } },
      ],
    });
    const r = await sendPush(['dobry', 'martwy'], { title: 't', body: 'b' });
    assert.strictEqual(r.failureCount, 1);
    assert.deepStrictEqual(r.invalidTokens, ['martwy']);
  });

  await scenario('token z błędem "invalid-registration-token" -> też trafia do invalidTokens', async () => {
    sendEachForMulticastFn = async () => ({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: { code: 'messaging/invalid-registration-token', message: 'zły format' } }],
    });
    const r = await sendPush(['zly'], { title: 't', body: 'b' });
    assert.deepStrictEqual(r.invalidTokens, ['zly']);
  });

  await scenario('token z INNYM błędem (np. tymczasowy błąd sieci FCM) -> NIE trafia do invalidTokens (nie kasujemy tokenu na wyrost)', async () => {
    sendEachForMulticastFn = async () => ({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: { code: 'messaging/internal-error', message: 'tymczasowy problem FCM' } }],
    });
    const r = await sendPush(['tok-tymczasowy-problem'], { title: 't', body: 'b' });
    assert.strictEqual(r.failureCount, 1);
    assert.deepStrictEqual(r.invalidTokens, []);
  });

  console.log('\n4. getFirebaseApp — cache (initializeApp wołany tylko RAZ, nawet przy wielu sendPush)');

  await scenario('kolejne sendPush NIE wywołują initializeApp ponownie (instancja Firebase cache\'owana)', async () => {
    const callsBefore = initializeAppCallCount;
    sendEachForMulticastFn = async () => ({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
    await sendPush(['tok1'], { title: 't', body: 'b' });
    await sendPush(['tok2'], { title: 't', body: 'b' });
    assert.strictEqual(initializeAppCallCount, callsBefore, 'initializeApp nie powinien być wołany ponownie po pierwszej udanej inicjalizacji');
  });

  console.log('\n5. verifyFirebaseConfig');

  await scenario('konfiguracja poprawna (już zainicjalizowana wcześniej w tym przebiegu) -> zwraca true', () => {
    assert.strictEqual(verifyFirebaseConfig(), true);
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
