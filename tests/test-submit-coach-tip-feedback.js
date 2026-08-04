// ============================================================
// GAMECHANGE — tests/test-submit-coach-tip-feedback.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda — kontynuacja "Pracuj dalej").
// AKTUALIZACJA tej samej nocy, ósma runda: testowana logika przeniesiona z
// api/submit-coach-tip-feedback.js do lib/coach-tip-feedback.js (scalenie
// endpointów) — patrz komentarz przy require() niżej. Reszta tego nagłówka
// (kontekst/uzasadnienie testu) zostaje bez zmian, bo logika się nie zmieniła.
// lib/coach-tip-feedback.js to bliźniaczy plik do już przetestowanego
// api/submit-recommendation-feedback.js — ten sam wzorzec ("frontend NIE
// robi bezpośredniego PATCH, bo brak polityki RLS, tylko woła ten endpoint,
// który najpierw sprawdza własność rekordu"), tylko prostszy: brak logiki
// eskalacji, tylko zapis "useful"/"not_now" na coach_tips. Dotąd bez
// żadnego testu mimo że to jedyna linia obrony przed zapisaniem feedbacku
// na cudzej podpowiedzi.
//
// Ten sam mechanizm stubowania co w test-submit-recommendation-feedback.js:
// ten plik sam woła createClient() z '@supabase/supabase-js' (handler
// wejściowy Vercel, nie plik z lib/), więc zwykłe podmienienie
// require.cache po lokalnej ścieżce nie wystarczy — trzeba przechwycić
// Module._resolveFilename dla samej nazwy pakietu.
//
// Uruchomienie: node tests/test-submit-coach-tip-feedback.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- Atrapa @supabase/supabase-js (pakiet niezainstalowany w tym środowisku) ---
let currentFakeSupabase = null;
const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_6__.js');
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

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

// PRZENIESIONE (04.08.2026, noc) — logika przeniesiona z api/submit-coach-tip-feedback.js
// do lib/coach-tip-feedback.js w ramach scalenia endpointów (limit 12 funkcji Vercel
// Hobby, opcja (b) z claude/INTEGRACJA_STRIPE_K2.md). ZERO zmiany testowanej logiki —
// wyłącznie inna ścieżka require, wszystkie scenariusze niżej bez zmian.
const handler = require('../lib/coach-tip-feedback.js');

Module._resolveFilename = originalResolveFilename;

// --- Atrapa Supabase dla tabeli coach_tips (select + update) ---
function makeFakeSupabase(seedTips = [], { selectError = null, updateError = null } = {}) {
  const state = { coach_tips: seedTips.map((r) => ({ ...r })) };
  return {
    _state: state,
    from(table) {
      const filters = [];
      let mode = 'select';
      let updatePayload = null;
      const builder = {
        select() { return builder; },
        update(payload) { mode = 'update'; updatePayload = payload; return builder; },
        eq(col, val) { filters.push((row) => row[col] === val); return builder; },
        maybeSingle() {
          if (selectError) return Promise.resolve({ data: null, error: selectError });
          const rows = state[table].filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        single() {
          if (mode === 'update') {
            if (updateError) return Promise.resolve({ data: null, error: updateError });
            const rows = state[table].filter((r) => filters.every((f) => f(r)));
            rows.forEach((row) => Object.assign(row, updatePayload));
            return Promise.resolve({ data: rows[0] || null, error: null });
          }
          const rows = state[table].filter((r) => filters.every((f) => f(r)));
          return Promise.resolve(rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } });
        },
      };
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
  console.log('submit-coach-tip-feedback.js — testy jednostkowe (atrapa Supabase)');

  await scenario('metoda != POST -> 405', async () => {
    const { req, res, status } = makeReqRes({});
    req.method = 'GET';
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 405);
  });

  await scenario('brak coachUserId -> 400', async () => {
    const { req, res, status } = makeReqRes({ tipId: 't1', response: 'useful' });
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 400);
  });

  await scenario('brak tipId -> 400', async () => {
    const { req, res, status } = makeReqRes({ coachUserId: 'c1', response: 'useful' });
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 400);
  });

  await scenario('nieprawidłowa wartość response -> 400', async () => {
    const { req, res, status } = makeReqRes({ coachUserId: 'c1', tipId: 't1', response: 'coś-innego' });
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 400);
  });

  await scenario('podpowiedź nie istnieje -> 404', async () => {
    const { req, res, status } = makeReqRes({ coachUserId: 'c1', tipId: 'brak-takiej', response: 'useful' });
    currentFakeSupabase = makeFakeSupabase([]);
    await handler(req, res);
    assert.strictEqual(status(), 404);
  });

  await scenario('podpowiedź należy do INNEGO trenera -> 404 (nie zdradzamy istnienia)', async () => {
    const { req, res, status } = makeReqRes({ coachUserId: 'intruz', tipId: 't1', response: 'useful' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 't1', coach_user_id: 'wlasciciel', feedback_response: null },
    ]);
    await handler(req, res);
    assert.strictEqual(status(), 404);
  });

  await scenario('podpowiedź ma już zapisany feedback -> 409, brak nadpisania', async () => {
    const { req, res, status } = makeReqRes({ coachUserId: 'c1', tipId: 't1', response: 'useful' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 't1', coach_user_id: 'c1', feedback_response: 'not_now' },
    ]);
    await handler(req, res);
    assert.strictEqual(status(), 409);
    assert.strictEqual(currentFakeSupabase._state.coach_tips[0].feedback_response, 'not_now');
  });

  await scenario('happy path, response="useful" -> 200, feedback zapisany z datą', async () => {
    const { req, res, status, json } = makeReqRes({ coachUserId: 'c1', tipId: 't1', response: 'useful' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 't1', coach_user_id: 'c1', feedback_response: null },
    ]);
    await handler(req, res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(json().ok, true);
    assert.strictEqual(currentFakeSupabase._state.coach_tips[0].feedback_response, 'useful');
    assert.ok(currentFakeSupabase._state.coach_tips[0].feedback_at);
  });

  await scenario('happy path, response="not_now" -> 200, feedback zapisany', async () => {
    const { req, res, status } = makeReqRes({ coachUserId: 'c1', tipId: 't1', response: 'not_now' });
    currentFakeSupabase = makeFakeSupabase([
      { id: 't1', coach_user_id: 'c1', feedback_response: null },
    ]);
    await handler(req, res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(currentFakeSupabase._state.coach_tips[0].feedback_response, 'not_now');
  });

  await scenario('błąd Supabase przy odczycie podpowiedzi -> 500, nie 404 (nie udajemy że "nie istnieje")', async () => {
    const { req, res, status, json } = makeReqRes({ coachUserId: 'c1', tipId: 't1', response: 'useful' });
    currentFakeSupabase = makeFakeSupabase([], { selectError: { message: 'timeout bazy' } });
    await handler(req, res);
    assert.strictEqual(status(), 500);
    assert.strictEqual(json().ok, false);
  });

  await scenario('błąd Supabase przy zapisie -> 500, komunikat zawiera przyczynę', async () => {
    const { req, res, status, json } = makeReqRes({ coachUserId: 'c1', tipId: 't1', response: 'useful' });
    currentFakeSupabase = makeFakeSupabase(
      [{ id: 't1', coach_user_id: 'c1', feedback_response: null }],
      { updateError: { message: 'zapis nieudany' } }
    );
    await handler(req, res);
    assert.strictEqual(status(), 500);
    assert.strictEqual(json().ok, false);
    assert.match(json().error, /zapis nieudany/);
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
