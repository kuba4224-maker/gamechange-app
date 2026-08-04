// ============================================================
// GAMECHANGE — tests/test-cron-onboard-diagnosis.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda, dalszy ciąg — kontynuacja
// "Pracuj dalej"). cron-onboard-diagnosis.js to "brakująca klamra" między
// ankietą a pierwszą rekomendacją — TWORZY pierwszy cel (goal) i wywołuje
// generateRecommendation() dla każdego zawodnika z powiązaną diagnozą, ale
// bez żadnego celu. Realny, side-effecting cron (zapisuje dane w bazie),
// dotąd bez ŻADNEGO testu — jedyna linia obrony przed np. podwójnym
// onboardowaniem tego samego użytkownika, przekroczeniem limitu wsadu,
// albo błędem jednego użytkownika psującym cały przebieg.
//
// `pickTopDeficitSegment` (lokalna, czysta funkcja wyboru segmentu) dopisana
// dziś do `module.exports._internal` — czysto addytywne, żeby dało się ją
// pokryć testem (patrz komentarz w api/cron-onboard-diagnosis.js).
//
// DECYZJA O ZAKRESIE STUBOWANIA: ten plik importuje `generateRecommendation`
// ORAZ `_internal.{computeRelativeDeficits, pickLowestScoringSegment}` z
// `./generate-recommendation` — świadomie stubuję WSZYSTKIE TRZY (ten sam
// wzorzec co już w test-submit-recommendation-feedback.js), bo:
// (a) generateRecommendation() sama w sobie woła Anthropic + kilka
//     zapytań Supabase — nie do rozsądnego odtworzenia tutaj, i to NIE jest
//     plik pod testem;
// (b) computeRelativeDeficits/pickLowestScoringSegment to prawdziwa,
//     nietrywialna logika statystyczna, ale ŻYJE i jest odpowiedzialnością
//     generate-recommendation.js (już ma tam własny _internal) — jej
//     poprawność to osobny temat testowy (jeszcze nie zrobiony, wart
//     odnotowania w DO_ZROBIENIA_PRZEZ_KUBE.md jako następna okazja,
//     PODOBNIE jak reszta silnika rekomendacji). Tu testujemy WYŁĄCZNIE
//     orkiestrację tego pliku: parsowanie JSON, wybór ścieżki deficyt-vs-
//     fallback, filtrowanie kandydatów, limit wsadu, odporność na błąd
//     pojedynczego użytkownika, liczenie wyników.
//
// Uruchomienie: node tests/test-cron-onboard-diagnosis.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- 1. Atrapa @supabase/supabase-js (pakiet niezainstalowany w tym środowisku) ---
let currentFakeSupabase = null;
const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_7__.js');
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

// --- 2. Atrapa ./generate-recommendation (ten sam wzorzec co reszta folderu) ---
let computeRelativeDeficitsImpl = () => [];
let pickLowestScoringSegmentImpl = () => null;
let generateRecommendationImpl = async () => ({ ok: true });
const computeRelativeDeficitsCalls = [];
const pickLowestScoringSegmentCalls = [];
const generateRecommendationCalls = [];
const genRecStubPath = require.resolve('../api/generate-recommendation.js');
require.cache[genRecStubPath] = {
  id: genRecStubPath,
  filename: genRecStubPath,
  loaded: true,
  exports: {
    generateRecommendation: async (...args) => {
      generateRecommendationCalls.push(args[0]);
      return generateRecommendationImpl(...args);
    },
    _internal: {
      computeRelativeDeficits: (...args) => {
        computeRelativeDeficitsCalls.push(args);
        return computeRelativeDeficitsImpl(...args);
      },
      pickLowestScoringSegment: (...args) => {
        pickLowestScoringSegmentCalls.push(args);
        return pickLowestScoringSegmentImpl(...args);
      },
    },
  },
};

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.CRON_SECRET = 'test-cron-secret';

const handler = require('../api/cron-onboard-diagnosis.js');
const { pickTopDeficitSegment } = handler._internal;

Module._resolveFilename = originalResolveFilename;

// --- 3. Atrapa Supabase dla diagnostics/goals ---
function makeFakeSupabase({ diagnostics = [], goalsUserIds = [], diagnosticsError = null, insertErrorForUserIds = [] } = {}) {
  const state = { diagnostics, goals: goalsUserIds.map((u) => ({ user_id: u })), inserted: [] };
  const fromCalls = [];
  return {
    _state: state,
    _fromCalls: fromCalls,
    from(table) {
      fromCalls.push(table);
      let mode = 'select';
      let insertPayload = null;
      const builder = {
        select() { return builder; },
        not() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        eq() { return builder; },
        insert(payload) { mode = 'insert'; insertPayload = payload; return builder; },
        single() {
          if (mode !== 'insert') return Promise.resolve({ data: null, error: { message: 'unexpected .single() outside insert' } });
          if (insertErrorForUserIds.includes(insertPayload.user_id)) {
            return Promise.resolve({ data: null, error: { message: `insert zablokowany dla ${insertPayload.user_id}` } });
          }
          const row = { id: `goal_${insertPayload.user_id}`, ...insertPayload };
          state.inserted.push(row);
          return Promise.resolve({ data: row, error: null });
        },
        then(resolve, reject) {
          if (table === 'diagnostics') {
            if (diagnosticsError) return Promise.resolve({ data: null, error: diagnosticsError }).then(resolve, reject);
            return Promise.resolve({ data: state.diagnostics, error: null }).then(resolve, reject);
          }
          if (table === 'goals') {
            return Promise.resolve({ data: state.goals, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function makeReqRes({ auth = 'test-cron-secret' } = {}) {
  const req = { headers: { authorization: auth ? `Bearer ${auth}` : undefined } };
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
  console.log('cron-onboard-diagnosis.js — testy jednostkowe (atrapa Supabase + generate-recommendation)');

  console.log('\n1. pickTopDeficitSegment — orkiestracja (parsowanie JSON + wybór deficyt-vs-fallback)');

  await scenario('scoresRaw jako string JSON -> parsowany przed przekazaniem dalej', () => {
    computeRelativeDeficitsCalls.length = 0;
    computeRelativeDeficitsImpl = (scores) => (scores.moc === 10 ? [['moc', 10]] : []);
    const r = pickTopDeficitSegment('{"moc":10,"wytrzymalosc":80}');
    assert.strictEqual(r, 'moc');
    assert.deepStrictEqual(computeRelativeDeficitsCalls[0][0], { moc: 10, wytrzymalosc: 80 });
  });

  await scenario('scoresRaw niepoprawny JSON -> zwraca null, NIE woła computeRelativeDeficits', () => {
    computeRelativeDeficitsCalls.length = 0;
    const r = pickTopDeficitSegment('{niepoprawny,,,');
    assert.strictEqual(r, null);
    assert.strictEqual(computeRelativeDeficitsCalls.length, 0);
  });

  await scenario('scoresRaw = null -> zwraca null, NIE woła computeRelativeDeficits', () => {
    computeRelativeDeficitsCalls.length = 0;
    const r = pickTopDeficitSegment(null);
    assert.strictEqual(r, null);
    assert.strictEqual(computeRelativeDeficitsCalls.length, 0);
  });

  await scenario('scoresRaw = liczba (nie string, nie obiekt) -> zwraca null', () => {
    const r = pickTopDeficitSegment(42);
    assert.strictEqual(r, null);
  });

  await scenario('scoresRaw już jako obiekt (nie string) -> pomija JSON.parse, działa wprost', () => {
    computeRelativeDeficitsImpl = () => [];
    pickLowestScoringSegmentImpl = (scores) => (scores.wytrzymalosc === 5 ? 'wytrzymalosc' : null);
    const r = pickTopDeficitSegment({ wytrzymalosc: 5, moc: 80 });
    assert.strictEqual(r, 'wytrzymalosc');
  });

  await scenario('brak statystycznego deficytu -> pada na pickLowestScoringSegment (fallback)', () => {
    computeRelativeDeficitsImpl = () => []; // profil wyrównany, brak deficytu
    pickLowestScoringSegmentImpl = () => 'moc';
    const r = pickTopDeficitSegment('{"moc":75,"wytrzymalosc":75}');
    assert.strictEqual(r, 'moc');
  });

  await scenario('deficyt ZNALEZIONY -> zwraca deficits[0][0], NIE woła fallbacku', () => {
    pickLowestScoringSegmentCalls.length = 0;
    computeRelativeDeficitsImpl = () => [['odpornosc', 40]];
    const r = pickTopDeficitSegment('{"odpornosc":40}');
    assert.strictEqual(r, 'odpornosc');
    assert.strictEqual(pickLowestScoringSegmentCalls.length, 0);
  });

  await scenario('oba (deficyt i fallback) zwracają pusto -> zwraca null (np. pusty obiekt scores)', () => {
    computeRelativeDeficitsImpl = () => [];
    pickLowestScoringSegmentImpl = () => null;
    const r = pickTopDeficitSegment({});
    assert.strictEqual(r, null);
  });

  console.log('\n2. handler — autoryzacja');

  await scenario('brak nagłówka Authorization -> 401, Supabase nietknięty', async () => {
    const { req, res, status } = makeReqRes({ auth: null });
    currentFakeSupabase = makeFakeSupabase({});
    await handler(req, res);
    assert.strictEqual(status(), 401);
    assert.strictEqual(currentFakeSupabase._fromCalls.length, 0);
  });

  await scenario('zły CRON_SECRET -> 401', async () => {
    const { req, res, status } = makeReqRes({ auth: 'zly-sekret' });
    currentFakeSupabase = makeFakeSupabase({});
    await handler(req, res);
    assert.strictEqual(status(), 401);
  });

  console.log('\n3. handler — filtrowanie kandydatów, limit wsadu, odporność, liczenie wyników');

  await scenario('użytkownik z diagnozą ALE już mający cel -> pominięty (nie w candidates)', async () => {
    computeRelativeDeficitsImpl = () => [];
    pickLowestScoringSegmentImpl = (scores) => scores.pick || null;
    generateRecommendationImpl = async () => ({ ok: true });
    generateRecommendationCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      diagnostics: [{ user_id: 'ma-juz-cel', scores: { pick: 'moc' }, created_at: '2026-08-01' }],
      goalsUserIds: ['ma-juz-cel'],
    });
    await handler(req, res);
    assert.strictEqual(json().results.onboarded, 0);
    assert.strictEqual(generateRecommendationCalls.length, 0);
  });

  await scenario('kandydat bez celu, segment znaleziony -> onboarded++, goal wstawiony, generateRecommendation wywołany z poprawnymi parametrami', async () => {
    computeRelativeDeficitsImpl = () => [];
    pickLowestScoringSegmentImpl = (scores) => scores.pick || null;
    generateRecommendationImpl = async () => ({ ok: true });
    generateRecommendationCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      diagnostics: [{ user_id: 'nowy1', scores: { pick: 'wytrzymalosc' }, created_at: '2026-08-01' }],
      goalsUserIds: [],
    });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.results.onboarded, 1);
    assert.strictEqual(currentFakeSupabase._state.inserted[0].segment_id, 'wytrzymalosc');
    assert.strictEqual(currentFakeSupabase._state.inserted[0].origin, 'system_proposed');
    assert.strictEqual(currentFakeSupabase._state.inserted[0].is_priority, true);
    assert.strictEqual(generateRecommendationCalls.length, 1);
    assert.strictEqual(generateRecommendationCalls[0].userId, 'nowy1');
    assert.strictEqual(generateRecommendationCalls[0].recommendationType, 'training_focus');
    assert.strictEqual(generateRecommendationCalls[0].goalId, 'goal_nowy1');
  });

  await scenario('segment NIE znaleziony -> skippedNoSegment++, BRAK próby insertu/generateRecommendation', async () => {
    computeRelativeDeficitsImpl = () => [];
    pickLowestScoringSegmentImpl = () => null;
    generateRecommendationCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      diagnostics: [{ user_id: 'brak-segmentu', scores: {}, created_at: '2026-08-01' }],
      goalsUserIds: [],
    });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.results.skippedNoSegment, 1);
    assert.strictEqual(r.results.onboarded, 0);
    assert.strictEqual(generateRecommendationCalls.length, 0);
    assert.strictEqual(currentFakeSupabase._state.inserted.length, 0);
  });

  await scenario('generateRecommendation zwraca ok:false -> blocked++ (nie failed, nie crash)', async () => {
    pickLowestScoringSegmentImpl = (scores) => scores.pick || null;
    generateRecommendationImpl = async () => ({ ok: false, reason: 'cooldown_active' });
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      diagnostics: [{ user_id: 'zablokowany', scores: { pick: 'moc' }, created_at: '2026-08-01' }],
      goalsUserIds: [],
    });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.results.blocked, 1);
    assert.strictEqual(r.results.onboarded, 0);
    assert.strictEqual(r.results.failed, 0);
  });

  await scenario('błąd insertu goals dla JEDNEGO kandydata NIE przerywa przetwarzania pozostałych', async () => {
    pickLowestScoringSegmentImpl = (scores) => scores.pick || null;
    generateRecommendationImpl = async () => ({ ok: true });
    generateRecommendationCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      diagnostics: [
        { user_id: 'psuje-sie', scores: { pick: 'moc' }, created_at: '2026-08-02' },
        { user_id: 'dziala-ok', scores: { pick: 'wytrzymalosc' }, created_at: '2026-08-01' },
      ],
      goalsUserIds: [],
      insertErrorForUserIds: ['psuje-sie'],
    });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.results.failed, 1);
    assert.strictEqual(r.results.errors[0].userId, 'psuje-sie');
    assert.strictEqual(r.results.onboarded, 1);
    assert.strictEqual(generateRecommendationCalls.length, 1, 'druga osoba mimo błędu pierwszej nadal przetworzona');
    assert.strictEqual(generateRecommendationCalls[0].userId, 'dziala-ok');
  });

  await scenario('generateRecommendation RZUCA błąd -> failed++, błąd przechwycony, batch kontynuowany', async () => {
    pickLowestScoringSegmentImpl = (scores) => scores.pick || null;
    generateRecommendationImpl = async () => { throw new Error('Anthropic niedostępne'); };
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      diagnostics: [{ user_id: 'rzuca-blad', scores: { pick: 'moc' }, created_at: '2026-08-01' }],
      goalsUserIds: [],
    });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.results.failed, 1);
    assert.strictEqual(r.results.errors[0].error, 'Anthropic niedostępne');
    // Cel MIMO TO już zapisany w bazie (insert był przed wywołaniem generateRecommendation) —
    // błąd eskalacji/rekomendacji nie cofa transakcji (świadome zachowanie tego pliku, brak
    // rollbacku), sprawdzamy że test to poprawnie odzwierciedla, nie zakłada inaczej.
    assert.strictEqual(currentFakeSupabase._state.inserted.length, 1);
  });

  await scenario('MAX_PER_RUN=20 -> capped=true przy >20 kandydatach, przetwarza tylko pierwszych 20', async () => {
    pickLowestScoringSegmentImpl = (scores) => scores.pick || null;
    generateRecommendationImpl = async () => ({ ok: true });
    generateRecommendationCalls.length = 0;
    const diagnostics = Array.from({ length: 25 }, (_, i) => ({
      user_id: `user${i}`,
      scores: { pick: 'moc' },
      created_at: `2026-08-${String(25 - i).padStart(2, '0')}`,
    }));
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({ diagnostics, goalsUserIds: [] });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.results.capped, true);
    assert.strictEqual(generateRecommendationCalls.length, 20);
  });

  await scenario('DOKŁADNIE 20 kandydatów -> capped=false (próg to >20, nie >=20)', async () => {
    pickLowestScoringSegmentImpl = (scores) => scores.pick || null;
    generateRecommendationImpl = async () => ({ ok: true });
    const diagnostics = Array.from({ length: 20 }, (_, i) => ({
      user_id: `u${i}`,
      scores: { pick: 'moc' },
      created_at: `2026-08-${String(20 - i).padStart(2, '0')}`,
    }));
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({ diagnostics, goalsUserIds: [] });
    await handler(req, res);
    assert.strictEqual(json().results.capped, false);
  });

  await scenario('DUPLIKAT diagnoz tego samego usera -> liczy się tylko NAJNOWSZA (pierwsza w kolejności malejącej daty)', async () => {
    pickLowestScoringSegmentImpl = (scores) => scores.pick || null;
    generateRecommendationImpl = async () => ({ ok: true });
    const { req, res } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      diagnostics: [
        { user_id: 'dwie-diagnozy', scores: { pick: 'najnowszy-segment' }, created_at: '2026-08-03' },
        { user_id: 'dwie-diagnozy', scores: { pick: 'stary-segment' }, created_at: '2026-08-01' },
      ],
      goalsUserIds: [],
    });
    await handler(req, res);
    assert.strictEqual(currentFakeSupabase._state.inserted[0].segment_id, 'najnowszy-segment');
  });

  await scenario('błąd na poziomie zapytania diagnostics (setup) -> 500, ok:false, komunikat z przyczyną', async () => {
    const { req, res, status, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({ diagnosticsError: { message: 'timeout bazy' } });
    await handler(req, res);
    assert.strictEqual(status(), 500);
    assert.strictEqual(json().ok, false);
    assert.match(json().error, /fetchLatestDiagnosisPerUser: timeout bazy/);
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
