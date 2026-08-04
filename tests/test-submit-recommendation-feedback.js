// ============================================================
// GAMECHANGE — tests/test-submit-recommendation-feedback.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, druga runda po "Wracaj do kolejki i pracuj" /
// "Pracuj dalej") — api/submit-recommendation-feedback.js domyka realną,
// żywą ścieżkę produktową (automatyczna eskalacja do specialist_referral po
// 3+ odrzuceniach "nie miało to sensu" z rzędu, patrz komentarz na górze
// tamtego pliku) i była dotąd BEZ ŻADNEGO testu — jedyny plik w api/, który
// faktycznie WYWOŁUJE computeRejectionStreak()/generateRecommendation(), a
// mimo to nikt nigdy nie sprawdził automatycznie, czy próg 3 działa
// poprawnie, czy błąd eskalacji faktycznie nie psuje zapisu feedbacku, czy
// walidacje 400/404/409 są na miejscu. Ten plik to domyka.
//
// DLACZEGO TU INNY MECHANIZM STUBOWANIA NIŻ W RESZCIE TEGO FOLDERU:
// Pozostałe testy w tym folderze (test-training-focus-rotation.js,
// test-push-rate-limiter.js) testują pliki z lib/, które ŚWIADOMIE dostają
// klienta Supabase jako parametr — nigdy same nie importują
// @supabase/supabase-js, więc wystarczy podmienić require.cache dla
// LOKALNEJ ścieżki (np. ../api/generate-recommendation.js), żeby ominąć
// ciężką zależność, której ten projekt nie instaluje tylko po to, żeby
// odpalić testy logiki.
//
// api/submit-recommendation-feedback.js jest inny: to plik WEJŚCIOWY
// (handler Vercel), który sam konstruuje własnego klienta przez
// createClient() z '@supabase/supabase-js' — więc podmiana require.cache po
// samej ścieżce nie wystarczy (require.resolve('@supabase/supabase-js')
// rzuca błędem, bo pakiet nie jest zainstalowany w tym środowisku — pakiet
// JEST w package.json, ale node_modules nie jest tu obecne). Rozwiązanie:
// tymczasowe przechwycenie Module._resolveFilename, żeby nazwę pakietu
// (nie ścieżkę pliku) przekierować na własną atrapę — ten sam efekt co
// require.cache dla lokalnych plików, tylko jeden poziom niżej. Przywracane
// zaraz po require() pliku pod testem, żeby nie wpływać na nic innego.
//
// Uruchomienie: node tests/test-submit-recommendation-feedback.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- 1. Atrapa @supabase/supabase-js (pakiet niezainstalowany w tym środowisku) ---
let currentFakeSupabase = null;
const supabaseStubPath = path.join(__dirname, '__stub_supabase_js__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath,
  filename: supabaseStubPath,
  loaded: true,
  exports: {
    createClient: () => currentFakeSupabase,
  },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

// --- 2. Atrapa ./generate-recommendation (ten sam wzorzec co reszta folderu) ---
let streakToReturn = 0;
let generateRecommendationResult = { ok: true };
let generateRecommendationShouldThrow = null;
const generateRecommendationCalls = [];
const genRecStubPath = require.resolve('../api/generate-recommendation.js');
require.cache[genRecStubPath] = {
  id: genRecStubPath,
  filename: genRecStubPath,
  loaded: true,
  exports: {
    generateRecommendation: async (params) => {
      generateRecommendationCalls.push(params);
      if (generateRecommendationShouldThrow) throw generateRecommendationShouldThrow;
      return generateRecommendationResult;
    },
    _internal: {
      computeRejectionStreak: async () => streakToReturn,
    },
  },
};

// Zmienne środowiskowe wymagane przez getAdminClient() — wartości dowolne,
// createClient() jest podmieniony wyżej i tak ich nie zużywa naprawdę.
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

const handler = require('../api/submit-recommendation-feedback.js');

// Przywrócenie oryginalnego resolvera od razu po require — reszta tego
// procesu testowego (i tak nie potrzebuje już @supabase/supabase-js) wraca
// do normalnego zachowania Node.
Module._resolveFilename = originalResolveFilename;

// --- 3. Atrapa Supabase dla samej tabeli decision_recommendations ---
function makeFakeSupabase(seedRecommendations = []) {
  const state = { decision_recommendations: seedRecommendations.map((r) => ({ ...r })) };
  return {
    _state: state,
    from(table) {
      const filters = [];
      let mode = 'select';
      let updatePayload = null;
      const builder = {
        select() { mode = 'select'; return builder; },
        update(payload) { mode = 'update'; updatePayload = payload; return builder; },
        eq(col, val) { filters.push((row) => row[col] === val); return builder; },
        maybeSingle() {
          return applyAndReturn().then((r) => ({ data: r.data[0] || null, error: null }));
        },
        then(resolve, reject) {
          applyAndReturn().then(resolve, reject);
        },
      };
      function applyAndReturn() {
        const rows = state[table].filter((r) => filters.every((f) => f(r)));
        if (mode === 'update') {
          rows.forEach((row) => Object.assign(row, updatePayload));
        }
        return Promise.resolve({ data: rows, error: null });
      }
      return builder;
    },
  };
}

function makeReqRes(body) {
  const req = { method: 'POST', body };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return res; },
    json(obj) { jsonBody = obj; return res; },
  };
  return { req, res, status: () => statusCode, json: () => jsonBody };
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
  console.log('submit-recommendation-feedback.js — testy jednostkowe (atrapa Supabase + generate-recommendation)');

  await scenario('metoda != POST -> 405', async () => {
    const { req, res, status } = makeReqRes({});
    req.method = 'GET';
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 405);
  });

  await scenario('brak userId -> 400', async () => {
    const { req, res, status } = makeReqRes({ recommendationId: 'r1', response: 'done' });
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 400);
  });

  await scenario('nieprawidłowa wartość response -> 400', async () => {
    const { req, res, status } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'coś-innego' });
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 400);
  });

  await scenario('rekomendacja nie istnieje -> 404', async () => {
    const { req, res, status } = makeReqRes({ userId: 'u1', recommendationId: 'brak-takiej', response: 'done' });
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 404);
  });

  await scenario('rekomendacja należy do INNEGO użytkownika -> 404 (nie 403 — nie zdradzamy istnienia)', async () => {
    const { req, res, status } = makeReqRes({ userId: 'intruz', recommendationId: 'r1', response: 'done' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'wlasciciel', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    await handler(req, res);
    assert.strictEqual(status(), 404);
  });

  await scenario('rekomendacja ma już zapisany feedback -> 409, brak nadpisania', async () => {
    const { req, res, status } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'done' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'not_done' },
    ]);
    await handler(req, res);
    assert.strictEqual(status(), 409);
    assert.strictEqual(currentFakeSupabase._state.decision_recommendations[0].feedback_response, 'not_done');
  });

  await scenario('happy path, response="done" -> 200, feedback zapisany, brak eskalacji', async () => {
    const { req, res, status, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'done' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    generateRecommendationCalls.length = 0;
    await handler(req, res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(json().escalation, null);
    assert.strictEqual(currentFakeSupabase._state.decision_recommendations[0].feedback_response, 'done');
    assert.ok(currentFakeSupabase._state.decision_recommendations[0].feedback_at);
    assert.strictEqual(generateRecommendationCalls.length, 0, 'response=done nigdy nie eskaluje');
  });

  await scenario('komentarz dłuższy niż 1000 znaków -> obcięty do 1000', async () => {
    const dlugiKomentarz = 'x'.repeat(1500);
    const { req, res } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'done', comment: dlugiKomentarz });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    await handler(req, res);
    assert.strictEqual(currentFakeSupabase._state.decision_recommendations[0].feedback_comment.length, 1000);
  });

  await scenario('did_not_make_sense, training_focus, streak < 3 -> BRAK eskalacji', async () => {
    const { req, res, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'did_not_make_sense' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    streakToReturn = 2;
    generateRecommendationCalls.length = 0;
    await handler(req, res);
    assert.strictEqual(json().escalation, null);
    assert.strictEqual(generateRecommendationCalls.length, 0);
  });

  await scenario('did_not_make_sense, training_focus, streak >= 3 -> ESKALACJA, poprawne parametry', async () => {
    const { req, res, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'did_not_make_sense' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    streakToReturn = 3;
    generateRecommendationResult = { ok: true };
    generateRecommendationShouldThrow = null;
    generateRecommendationCalls.length = 0;
    await handler(req, res);
    assert.deepStrictEqual(json().escalation, { fired: true });
    assert.strictEqual(generateRecommendationCalls.length, 1);
    assert.strictEqual(generateRecommendationCalls[0].userId, 'u1');
    assert.strictEqual(generateRecommendationCalls[0].recommendationType, 'specialist_referral');
    assert.strictEqual(generateRecommendationCalls[0].referralReason, 'feedback_escalation');
    assert.strictEqual(generateRecommendationCalls[0].segmentId, 'moc');
  });

  await scenario('streak dokładnie na progu (3) traktowany jak >= (nie tylko >)', async () => {
    const { req, res, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'did_not_make_sense' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    streakToReturn = 3;
    generateRecommendationResult = { ok: true };
    generateRecommendationCalls.length = 0;
    await handler(req, res);
    assert.strictEqual(json().escalation.fired, true);
  });

  await scenario('eskalacja zablokowana silnikiem (ok:false) -> escalation.fired=false z powodem, feedback i tak zapisany, 200', async () => {
    const { req, res, status, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'did_not_make_sense' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    streakToReturn = 5;
    generateRecommendationResult = { ok: false, reason: 'cooldown_active' };
    generateRecommendationCalls.length = 0;
    await handler(req, res);
    assert.strictEqual(status(), 200);
    assert.deepStrictEqual(json().escalation, { fired: false, reason: 'cooldown_active' });
    assert.strictEqual(currentFakeSupabase._state.decision_recommendations[0].feedback_response, 'did_not_make_sense');
  });

  await scenario('generateRecommendation RZUCA błąd -> nie psuje odpowiedzi, feedback zapisany, 200, escalation.fired=false', async () => {
    const { req, res, status, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'did_not_make_sense' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    streakToReturn = 4;
    generateRecommendationShouldThrow = new Error('Anthropic API niedostępne');
    await handler(req, res);
    generateRecommendationShouldThrow = null; // sprzątanie dla kolejnych scenariuszy
    assert.strictEqual(status(), 200, 'błąd w kroku eskalacji nie może zamienić się w 500 dla użytkownika');
    assert.strictEqual(json().escalation.fired, false);
    assert.strictEqual(json().escalation.reason, 'Anthropic API niedostępne');
    assert.strictEqual(currentFakeSupabase._state.decision_recommendations[0].feedback_response, 'did_not_make_sense');
  });

  await scenario('did_not_make_sense, ale recommendation_type != training_focus -> BRAK próby eskalacji (nawet przy wysokim streak)', async () => {
    const { req, res, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'did_not_make_sense' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'specialist_referral', segment_id: 'moc', feedback_response: null },
    ]);
    streakToReturn = 99;
    generateRecommendationCalls.length = 0;
    await handler(req, res);
    assert.strictEqual(json().escalation, null);
    assert.strictEqual(generateRecommendationCalls.length, 0);
  });

  await scenario('did_not_make_sense, training_focus, ale segment_id brak (null) -> BRAK próby eskalacji', async () => {
    const { req, res, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'did_not_make_sense' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: null, feedback_response: null },
    ]);
    streakToReturn = 99;
    generateRecommendationCalls.length = 0;
    await handler(req, res);
    assert.strictEqual(json().escalation, null);
    assert.strictEqual(generateRecommendationCalls.length, 0);
  });

  await scenario('response="not_interested" (dozwolona wartość, ale nie eskalacyjna) -> zapisuje, brak eskalacji', async () => {
    const { req, res, status, json } = makeReqRes({ userId: 'u1', recommendationId: 'r1', response: 'not_interested' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: null },
    ]);
    streakToReturn = 99;
    generateRecommendationCalls.length = 0;
    await handler(req, res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(json().escalation, null);
    assert.strictEqual(generateRecommendationCalls.length, 0);
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
