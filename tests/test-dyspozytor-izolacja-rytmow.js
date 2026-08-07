// ============================================================
// GAMECHANGE — tests/test-dyspozytor-izolacja-rytmow.js
// ============================================================
// NOWY PLIK (DYSPOZYTOR C6 08.08.2026).
//
// PO CO ISTNIEJE, SKORO JEST JUŻ test-cron-send-notifications.js (60 ✅):
// tamten plik testuje KAŻDY RYTM Z OSOBNA, przez `_internal`, podając
// syntetyczny `warsawNow`. Ten testuje coś, czego tamten z założenia nie
// dotyka: HANDLER JAKO KOLEJKĘ — czyli co się dzieje z rytmami 4–15, kiedy
// rytm 3 rzuci wyjątkiem. Dopisanie tego tam zmusiłoby mnie do zmiany
// pliku, którego NIETKNIĘCIE jest dowodem, że ta runda nie zepsuła
// dotychczasowych 60 scenariuszy.
//
// DLACZEGO ZAMRAŻAM ZEGAR (a tamten plik nie musiał): handler woła
// `getWarsawNow()` sam, wewnątrz siebie — nie da się wstrzyknąć mu czasu
// parametrem, tak jak pojedynczemu rytmowi. Bez zamrożenia zegara test
// „rytm 3 rzuca" przechodziłby PUSTO poza oknem 19:00 (rytm 3 wychodziłby
// przed zapytaniem, nic by nie rzuciło, asercja „kolejka poszła dalej"
// byłaby prawdziwa z nudów). To jest dokładnie ten „cichy brak", którego
// szukamy w produkcie — w teście też go nie chcemy. Każdy scenariusz
// izolacji ASERTUJE WPROST, że wyjątek faktycznie poleciał.
//
// JAK ROZPOZNAJĘ RYTM 3 W ATRAPIE: rytm 2 i rytm 3 pytają o tę samą
// tabelę `calendar_events`, ale o INNE kolumny — rytm 2 o
// 'id, user_id, event_type', rytm 3 (przez sendPreMatchForDate) o
// 'id, user_id'. Atrapa rzuca po parze (tabela, kolumny), więc trafia
// dokładnie w rytm 3 i nie muska rytmu 2.
//
// STUBOWANE (ten sam wzorzec require.cache co w pozostałych plikach):
//   @supabase/supabase-js, ./send-push, ./generate-focus-block-content,
//   ../lib/stripe-client oraz SZEŚĆ rytmów mieszkających w lib/
//   (focus-block-adaptation, coach-digest, retention-check,
//   training-focus-rotation, coach-scheduled-reports, parent-reports) —
//   każdy z licznikiem wywołań, żeby dało się udowodnić, że kolejka
//   dojechała do końca.
//
// Uruchomienie: node tests/test-dyspozytor-izolacja-rytmow.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- 1. Atrapa @supabase/supabase-js ---
let currentFakeSupabase = null;
const supabaseStubPath = path.join(__dirname, '__stub_supabase_c6__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath, filename: supabaseStubPath, loaded: true,
  exports: { createClient: () => { if (!currentFakeSupabase) throw new Error('atrapa: brak klienta'); return currentFakeSupabase; } },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

// --- 2. Atrapy send-push / generate-focus-block-content / stripe-client ---
const sendPushCalls = [];
let sendPushImpl = async () => ({ successCount: 1, failureCount: 0, invalidTokens: [] });
let verifyFirebaseConfigImpl = () => true;
const sendPushStubPath = require.resolve('../api/send-push.js');
require.cache[sendPushStubPath] = {
  id: sendPushStubPath, filename: sendPushStubPath, loaded: true,
  exports: {
    sendPush: async (tokens, opts) => { sendPushCalls.push({ tokens, opts }); return sendPushImpl(tokens, opts); },
    verifyFirebaseConfig: () => verifyFirebaseConfigImpl(),
  },
};

let generateCheckinImpl = async () => ({ ok: true, question: 'Jak idzie?', contentDose: false });
const focusContentStubPath = require.resolve('../api/generate-focus-block-content.js');
require.cache[focusContentStubPath] = {
  id: focusContentStubPath, filename: focusContentStubPath, loaded: true,
  exports: { _internal: { generateCheckin: async (args) => generateCheckinImpl(args) } },
};

const stripeClientStubPath = require.resolve('../lib/stripe-client.js');
require.cache[stripeClientStubPath] = {
  id: stripeClientStubPath, filename: stripeClientStubPath, loaded: true,
  exports: { stripeRequest: async () => ({}) },
};

// --- 3. Atrapy SZEŚCIU rytmów z lib/ — każdy z licznikiem i przełącznikiem "rzuć" ---
// Te sześć to jedyne rytmy, których wykonanie da się udowodnić WPROST,
// niezależnie od okna godzinowego. Rytm 15 jest wśród nich i jest ostatni
// w kolejce — jego wywołanie to najmocniejszy dowód, że nic po drodze nie
// przerwało dyspozytora.
const wywolaniaLib = {};
const rzucaLib = {};
function stubLib(sciezka, nazwaFunkcji) {
  const p = require.resolve(sciezka);
  wywolaniaLib[nazwaFunkcji] = 0;
  rzucaLib[nazwaFunkcji] = null;
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      [nazwaFunkcji]: async () => {
        wywolaniaLib[nazwaFunkcji]++;
        if (rzucaLib[nazwaFunkcji]) throw rzucaLib[nazwaFunkcji];
      },
    },
  };
}
stubLib('../lib/focus-block-adaptation.js', 'runFocusBlockAdaptation');       // rytm 8
stubLib('../lib/coach-digest.js', 'runCoachDigestCheck');                     // rytm 11
stubLib('../lib/retention-check.js', 'runRetentionCheck');                    // rytm 12
stubLib('../lib/training-focus-rotation.js', 'runTrainingFocusRotation');     // rytm 13
stubLib('../lib/coach-scheduled-reports.js', 'runCoachScheduledReportsCheck');// rytm 14
stubLib('../lib/parent-reports.js', 'runParentReportsCheck');                 // rytm 15

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.CRON_SECRET = 'test-cron-secret';

const handler = require('../api/cron-send-notifications.js');
const { runFocusBlockCheckins } = handler._internal;

Module._resolveFilename = originalResolveFilename;

// --- 4. Atrapa Supabase z logiem zapytań i punktowym rzucaniem ---
// `rzucNa({tabela, kolumny})` -> Error|null. Rzuca SYNCHRONICZNIE w .select(),
// czyli dokładnie tam, gdzie realny klient rzuciłby przy zerwanym połączeniu.
function makeFakeSupabase(tables = {}, rzucNa = null) {
  const state = {};
  for (const [k, v] of Object.entries(tables)) state[k] = v.map((r) => ({ ...r }));
  const log = [];
  return {
    _state: state,
    _log: log,
    from(table) {
      if (!state[table]) state[table] = [];
      const filters = [];
      let mode = 'select';
      let payload = null;
      const orderSpecs = [];
      let limitN = null;
      function applyFilters() {
        let rows = state[table].filter((r) => filters.every((f) => f(r)));
        if (orderSpecs.length) {
          rows = rows.slice().sort((a, b) => {
            for (const { col, ascending } of orderSpecs) {
              const av = a[col], bv = b[col];
              if (av === bv) continue;
              const cmp = av > bv ? 1 : -1;
              return ascending ? cmp : -cmp;
            }
            return 0;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return rows;
      }
      const builder = {
        select(cols) {
          log.push({ tabela: table, kolumny: cols || null });
          if (rzucNa) {
            const e = rzucNa({ tabela: table, kolumny: cols || null });
            if (e) throw e;
          }
          return builder;
        },
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        not(col, op, val) { if (op === 'is' && val === null) filters.push((r) => r[col] != null); return builder; },
        is(col, val) { if (val === null) filters.push((r) => r[col] == null); return builder; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return builder; },
        gte(col, val) { filters.push((r) => r[col] >= val); return builder; },
        lt(col, val) { filters.push((r) => r[col] < val); return builder; },
        order(col, opts) { orderSpecs.push({ col, ascending: !opts || opts.ascending !== false }); return builder; },
        limit(n) { limitN = n; return builder; },
        update(p) { mode = 'update'; payload = p; return builder; },
        insert(p) { mode = 'insert'; payload = p; return builder; },
        maybeSingle() { const rows = applyFilters(); return Promise.resolve({ data: rows[0] || null, error: null }); },
        single() {
          if (mode === 'insert') {
            const row = { id: `id_${table}_${state[table].length + 1}`, ...payload };
            state[table].push(row);
            return Promise.resolve({ data: row, error: null });
          }
          const rows = applyFilters();
          return rows[0] ? Promise.resolve({ data: rows[0], error: null }) : Promise.resolve({ data: null, error: { message: 'not found' } });
        },
        then(resolve, reject) {
          if (mode === 'update') {
            const rows = applyFilters();
            rows.forEach((r) => Object.assign(r, payload));
            return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
          }
          if (mode === 'insert') {
            const row = { id: `id_${table}_${state[table].length + 1}`, ...payload };
            state[table].push(row);
            return Promise.resolve({ data: [row], error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: applyFilters(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

// --- 5. Zamrożenie zegara ---
// Podmienia globalny Date tak, żeby `new Date()` (bez argumentów) i `Date.now()`
// zwracały ustalony moment. Wywołania z argumentem (`new Date('2026-08-16T00:00:00')`,
// używane w runPreMatch) działają normalnie — inaczej rytm 3 policzyłby złą datę.
const PrawdziwyDate = Date;
function zamrozZegar(isoUtc) {
  const t = PrawdziwyDate.parse(isoUtc);
  class ZamrozonyDate extends PrawdziwyDate {
    constructor(...args) { if (args.length === 0) super(t); else super(...args); }
    static now() { return t; }
  }
  global.Date = ZamrozonyDate;
}
function odmrozZegar() { global.Date = PrawdziwyDate; }

function zrobRes() {
  const out = {};
  const res = {
    status(c) { out.status = c; return res; },
    json(o) { out.body = o; return res; },
  };
  return { res, out };
}
const REQ_OK = { headers: { authorization: 'Bearer test-cron-secret' } };

function zerujLiczniki() {
  for (const k of Object.keys(wywolaniaLib)) { wywolaniaLib[k] = 0; rzucaLib[k] = null; }
  sendPushCalls.length = 0;
}

// Klucze, które `results` MUSI mieć przy przebiegu bez wyjątków — dokładnie
// te i tylko te. Kształt sprzed tej rundy, przepisany ręcznie z pliku
// (celowo NIE generowany z kodu — inaczej test zgodziłby się na każdą zmianę).
const KLUCZE_RESULTS_PRZY_SUKCESIE = [
  'morning_readiness', 'post_training', 'pre_match', 'weekly_summary', 'contextual_insight',
  'focus_block_checkins', 'focus_block_maintenance', 'focus_block_adaptation',
  'trial_expiry', 'parental_consent_expiry', 'coach_digest',
  'retention_check', 'training_focus_rotation', 'coach_scheduled_reports',
  'parent_reports', 'parent_reports_failed', 'parent_reports_skipped_no_report',
  'parent_reports_missing_extras', 'parent_reports_snapshot_failed',
];

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
  } finally {
    odmrozZegar();
  }
}

(async () => {
  console.log('dyspozytor cron-send-notifications — izolacja 15 rytmów + dopisek o nowej dawce');

  // ══════════════════════════════════════════════════════════
  console.log('\n1. Przebieg bez wyjątków — odpowiedź co do znaku taka jak przed tą rundą');

  await scenario('sukces: 200, ok:true, ZERO kluczy _error, ZERO pola rytmy_z_bledem', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z'); // niedziela, 19:00 w Warszawie
    currentFakeSupabase = makeFakeSupabase({});
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.ok, true);
    const zErrorem = Object.keys(out.body.results).filter((k) => k.endsWith('_error'));
    assert.deepStrictEqual(zErrorem, [], 'przebieg bez wyjątków nie może produkować ŻADNEGO klucza _error');
    assert.strictEqual('rytmy_z_bledem' in out.body, false, 'pole ma się pojawiać wyłącznie przy błędzie');
  });

  await scenario('sukces: results ma DOKŁADNIE 19 kluczy sprzed tej rundy, ani jednego więcej', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({});
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.deepStrictEqual(
      Object.keys(out.body.results).sort(),
      KLUCZE_RESULTS_PRZY_SUKCESIE.slice().sort(),
      'kształt results przy SUKCESIE nie może się zmienić — zmiana przy błędzie jest dopuszczalna, przy sukcesie nie'
    );
  });

  await scenario('sukces: pięć liczników parent_reports* jawnie wyzerowanych (zabezpieczenie z rundy 4)', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({});
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    for (const k of ['parent_reports', 'parent_reports_failed', 'parent_reports_skipped_no_report',
      'parent_reports_missing_extras', 'parent_reports_snapshot_failed']) {
      assert.strictEqual(out.body.results[k], 0, `${k} musi być jawnym zerem, nie brakiem pola`);
    }
  });

  await scenario('sukces: wszystkie sześć rytmów z lib/ wywołanych dokładnie raz', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({});
    const { res } = zrobRes();
    await handler(REQ_OK, res);
    for (const [nazwa, ile] of Object.entries(wywolaniaLib)) {
      assert.strictEqual(ile, 1, `${nazwa} miał być wołany raz, był ${ile}x`);
    }
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n2. SEDNO — rytm 3 rzuca, rytmy 4–15 i tak się wykonują');

  // Atrapa rzuca na (calendar_events, 'id, user_id') — to podpis rytmu 3.
  // Rytm 2 pyta tę samą tabelę o 'id, user_id, event_type' i NIE jest ruszany.
  const RZUC_W_RYTM_3 = ({ tabela, kolumny }) =>
    (tabela === 'calendar_events' && kolumny === 'id, user_id')
      ? new Error('supabase: connection reset (symulacja awarii rytmu 3)')
      : null;

  await scenario('rytm 3 rzuca -> results.pre_match_error z komunikatem (wyjątek FAKTYCZNIE poleciał)', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z'); // 19:00 Warszawa -> okno rytmu 3 (wieczór przed meczem) OTWARTE
    currentFakeSupabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', status: 'scheduled', scheduled_date: '2026-08-17', event_type: 'match' }],
    }, RZUC_W_RYTM_3);
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.ok('pre_match_error' in out.body.results, 'bez tego cały scenariusz przechodziłby pusto');
    assert.match(out.body.results.pre_match_error, /connection reset/);
  });

  await scenario('rytm 3 rzuca -> rytmy 8, 11, 12, 13, 14 i 15 mimo to wykonane', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', status: 'scheduled', scheduled_date: '2026-08-17', event_type: 'match' }],
    }, RZUC_W_RYTM_3);
    const { res } = zrobRes();
    await handler(REQ_OK, res);
    for (const [nazwa, ile] of Object.entries(wywolaniaLib)) {
      assert.strictEqual(ile, 1, `${nazwa} NIE został wykonany — rytm 3 zabrał kolejkę ze sobą`);
    }
  });

  await scenario('rytm 3 rzuca -> RYTM 15 (raport rodzica, ostatni w kolejce) i tak dojechał', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', status: 'scheduled', scheduled_date: '2026-08-17', event_type: 'match' }],
    }, RZUC_W_RYTM_3);
    const { res } = zrobRes();
    await handler(REQ_OK, res);
    assert.strictEqual(wywolaniaLib.runParentReportsCheck, 1,
      'najmocniejszy pojedynczy dowód: piętnasty rytm nie ma szans się wykonać, jeśli którykolwiek wcześniejszy przerwał kolejkę');
  });

  await scenario('rytm 3 rzuca -> rytmy 4, 5 i 10 (mieszkające w TYM pliku) też odpytały bazę', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z'); // niedziela -> okno rytmu 4 otwarte
    // Fixture musi doprowadzić rytm 4 aż do tabeli `goals` (jedynej, której
    // nie dzieli z innym rytmem): potrzebny wiersz w `users` ORAZ preferencja
    // z godziną 19:00, bo `goals` jest pytane dopiero po przejściu okna
    // godzinowego per zawodnik. Bez tego asercja przechodziłaby pusto.
    currentFakeSupabase = makeFakeSupabase({
      users: [{ id: 'u1' }],
      notification_preferences: [{ user_id: 'u1', notification_type: 'weekly_summary', enabled: true, preferred_time: '19:00' }],
      calendar_events: [{ id: 'ev1', user_id: 'u1', status: 'scheduled', scheduled_date: '2026-08-17', event_type: 'match' }],
    }, RZUC_W_RYTM_3);
    const { res } = zrobRes();
    await handler(REQ_OK, res);
    const tabele = currentFakeSupabase._log.map((w) => w.tabela);
    assert.ok(tabele.includes('goals'), 'rytm 4 (weekly_summary) nie dotknął bazy');
    assert.ok(tabele.includes('decision_recommendations'), 'rytm 5 (contextual_insight) nie dotknął bazy');
    assert.ok(tabele.includes('payment_parental_consents'), 'rytm 10 (parental_consent_expiry) nie dotknął bazy');
  });

  await scenario('rytm 3 rzuca -> rytmy 6 i 7 też odpytały bazę (zegar ustawiony na ich okno)', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T08:00:00Z'); // 10:00 Warszawa -> okno rytmów 6 i 7
    currentFakeSupabase = makeFakeSupabase({}, ({ tabela }) =>
      tabela === 'decision_recommendations' ? new Error('symulacja awarii rytmu 5') : null);
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.ok('contextual_insight_error' in out.body.results, 'wyjątek miał polecieć w rytmie 5');
    const tabele = currentFakeSupabase._log.map((w) => w.tabela);
    assert.ok(tabele.includes('focus_blocks'), 'rytmy 6/7 (focus_blocks) nie dotknęły bazy po awarii rytmu 5');
  });

  await scenario('rytm 5 rzuca -> rytm 9 (trial_expiry) też odpytał bazę (zegar w jego oknie)', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T02:00:00Z'); // 4:00 Warszawa -> okno rytmu 9
    currentFakeSupabase = makeFakeSupabase({}, ({ tabela }) =>
      tabela === 'decision_recommendations' ? new Error('symulacja awarii rytmu 5') : null);
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.ok('contextual_insight_error' in out.body.results);
    const tabele = currentFakeSupabase._log.map((w) => w.tabela);
    assert.ok(tabele.includes('subscriptions'), 'rytm 9 (subscriptions) nie dotknął bazy po awarii rytmu 5');
  });

  await scenario('rytm 3 rzuca -> rytm 2 (wcześniejszy) NIE dostaje klucza _error', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', status: 'scheduled', scheduled_date: '2026-08-17', event_type: 'match' }],
    }, RZUC_W_RYTM_3);
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.strictEqual('post_training_error' in out.body.results, false,
      'atrapa miała trafić WYŁĄCZNIE w rytm 3 — jeśli tu jest błąd, rozróżnienie po kolumnach przestało działać');
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n3. Kształt odpowiedzi przy błędzie');

  await scenario('błąd rytmu -> 500, ok:false, rytmy_z_bledem wymienia klucz', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', status: 'scheduled', scheduled_date: '2026-08-17', event_type: 'match' }],
    }, RZUC_W_RYTM_3);
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.strictEqual(out.status, 500, '500 to jedyny sygnał widoczny w panelu Vercela bez otwierania treści');
    assert.strictEqual(out.body.ok, false);
    assert.deepStrictEqual(out.body.rytmy_z_bledem, ['pre_match']);
    assert.match(out.body.error, /1 z 15 rytmów/);
    assert.match(out.body.error, /pre_match/);
  });

  await scenario('odpowiedź HTTP NIE zawiera stack trace', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', status: 'scheduled', scheduled_date: '2026-08-17', event_type: 'match' }],
    }, RZUC_W_RYTM_3);
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    const cala = JSON.stringify(out.body);
    assert.ok(!/\bat\s+\S+\s+\(/.test(cala), 'w odpowiedzi jest coś, co wygląda jak ramka stosu');
    assert.ok(!cala.includes('.js:'), 'w odpowiedzi jest ścieżka do pliku źródłowego');
    assert.ok(!cala.includes('cron-send-notifications.js'), 'w odpowiedzi jest nazwa pliku');
  });

  await scenario('DWA rytmy rzucają -> oba mają własny _error, oba w rytmy_z_bledem, kolejka i tak dojechała', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', status: 'scheduled', scheduled_date: '2026-08-17', event_type: 'match' }],
    }, ({ tabela, kolumny }) => {
      if (tabela === 'calendar_events' && kolumny === 'id, user_id') return new Error('awaria rytmu 3');
      if (tabela === 'decision_recommendations') return new Error('awaria rytmu 5');
      return null;
    });
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.match(out.body.results.pre_match_error, /awaria rytmu 3/);
    assert.match(out.body.results.contextual_insight_error, /awaria rytmu 5/);
    assert.deepStrictEqual(out.body.rytmy_z_bledem.slice().sort(), ['contextual_insight', 'pre_match']);
    assert.match(out.body.error, /2 z 15 rytmów/);
    assert.strictEqual(wywolaniaLib.runParentReportsCheck, 1, 'dwa błędy też nie mogą zabrać rytmu 15');
  });

  await scenario('rytm 15 (ostatni) rzuca -> parent_reports_error, pięć liczników NIETKNIĘTYCH', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    rzucaLib.runParentReportsCheck = new Error('resend: 429 too many requests');
    currentFakeSupabase = makeFakeSupabase({});
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.match(out.body.results.parent_reports_error, /429/);
    assert.strictEqual(out.body.results.parent_reports, 0);
    assert.strictEqual(out.body.results.parent_reports_failed, 0);
    assert.strictEqual(out.body.results.parent_reports_skipped_no_report, 0);
    assert.strictEqual(out.body.results.parent_reports_missing_extras, 0);
    assert.strictEqual(out.body.results.parent_reports_snapshot_failed, 0);
    assert.deepStrictEqual(out.body.rytmy_z_bledem, ['parent_reports']);
  });

  await scenario('rytm 8 (pierwszy z lib/) rzuca -> rytmy 9–15 wykonane', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    rzucaLib.runFocusBlockAdaptation = new Error('brak kolumny last_adaptation_at');
    currentFakeSupabase = makeFakeSupabase({});
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.match(out.body.results.focus_block_adaptation_error, /last_adaptation_at/);
    assert.strictEqual(wywolaniaLib.runCoachDigestCheck, 1);
    assert.strictEqual(wywolaniaLib.runRetentionCheck, 1);
    assert.strictEqual(wywolaniaLib.runTrainingFocusRotation, 1);
    assert.strictEqual(wywolaniaLib.runCoachScheduledReportsCheck, 1);
    assert.strictEqual(wywolaniaLib.runParentReportsCheck, 1);
  });

  await scenario('rytm rzuca czymś, co NIE jest Error (string) -> komunikat czytelny, nie "undefined"', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    rzucaLib.runRetentionCheck = 'zerwane połączenie';
    currentFakeSupabase = makeFakeSupabase({});
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.strictEqual(out.body.results.retention_check_error, 'zerwane połączenie');
  });

  await scenario('ROZRÓŻNIENIE: dyspozytor nie wystartował (brak klienta) -> 500 BEZ żadnego klucza _error', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = null; // createClient rzuci
    const { res, out } = zrobRes();
    await handler(REQ_OK, res);
    assert.strictEqual(out.status, 500);
    const zErrorem = Object.keys(out.body.results).filter((k) => k.endsWith('_error'));
    assert.deepStrictEqual(zErrorem, [],
      '„nie udało się zbudować klienta" i „rytm padł" to dwa różne stany i odpowiedź MUSI je rozróżniać');
    assert.strictEqual('rytmy_z_bledem' in out.body, false);
    assert.strictEqual(wywolaniaLib.runParentReportsCheck, 0, 'bez klienta żaden rytm nie ma prawa ruszyć');
  });

  await scenario('zły CRON_SECRET -> 401, żaden rytm nie ruszył (bez zmian po tej rundzie)', async () => {
    zerujLiczniki();
    zamrozZegar('2026-08-16T17:00:00Z');
    currentFakeSupabase = makeFakeSupabase({});
    const { res, out } = zrobRes();
    await handler({ headers: { authorization: 'Bearer zly' } }, res);
    assert.strictEqual(out.status, 401);
    assert.strictEqual(wywolaniaLib.runParentReportsCheck, 0);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n4. Kolejność 1–15 nietknięta');

  await scenario('kolejność wywołań w źródle: 15 rytmów, raport rodzica ostatni', async () => {
    const fs = require('fs');
    const kod = fs.readFileSync(require.resolve('../api/cron-send-notifications.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const wywolania = [...kod.matchAll(/await (run[A-Za-z]+)\(supabase/g)].map((m) => m[1]);
    assert.deepStrictEqual(wywolania, [
      'runMorningReadiness', 'runPostTraining', 'runPreMatch', 'runWeeklySummary',
      'runContextualInsight', 'runFocusBlockCheckins', 'runFocusBlockMaintenance',
      'runFocusBlockAdaptation', 'runTrialExpiry', 'runParentalConsentExpiry',
      'runCoachDigestCheck', 'runRetentionCheck', 'runTrainingFocusRotation',
      'runCoachScheduledReportsCheck', 'runParentReportsCheck',
    ], 'kolejność 1–15 jest ustaleniem projektowym, nie przypadkiem');
  });

  await scenario('każdy z 15 rytmów ma WŁASNY catch z zapisem błędu — żaden nie został pominięty', async () => {
    const fs = require('fs');
    const kod = fs.readFileSync(require.resolve('../api/cron-send-notifications.js'), 'utf8');
    const zapisy = [...kod.matchAll(/zapiszBladRytmu\(results, '([a-z_]+)', '(run[A-Za-z]+)'/g)];
    assert.strictEqual(zapisy.length, 15, `oczekiwano 15 osobnych catchy, jest ${zapisy.length}`);
    assert.deepStrictEqual(zapisy.map((m) => m[1]), [
      'morning_readiness', 'post_training', 'pre_match', 'weekly_summary', 'contextual_insight',
      'focus_block_checkins', 'focus_block_maintenance', 'focus_block_adaptation',
      'trial_expiry', 'parental_consent_expiry', 'coach_digest', 'retention_check',
      'training_focus_rotation', 'coach_scheduled_reports', 'parent_reports',
    ]);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n5. Rytm 6 — push mówi o nowej porcji wiedzy (A28/M12)');

  const DOPISEK = ' · Jest nowa porcja wiedzy w Twoim Bloku.';
  function bazaBlokow() {
    return makeFakeSupabase({
      focus_blocks: [{ id: 'fb1', user_id: 'u1', status: 'active', started_at: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString() }],
      push_tokens: [{ user_id: 'u1', token: 'tok1', is_active: true }],
      focus_block_checkins: [],
    });
  }

  await scenario('BEZ dawki -> body pusha co do znaku równe pytaniu (bez zmian po tej rundzie)', async () => {
    zerujLiczniki();
    generateCheckinImpl = async () => ({ ok: true, question: 'Jak idzie z lądowaniem po wyskoku?', contentDose: false });
    const supabase = bazaBlokow();
    const results = { focus_block_checkins: 0 };
    await runFocusBlockCheckins(supabase, { hour: 10, minute: 0, day: 15, dateStr: '2026-08-15', weekday: 6 }, results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.strictEqual(sendPushCalls[0].opts.body, 'Jak idzie z lądowaniem po wyskoku?');
    assert.ok(!sendPushCalls[0].opts.body.includes('porcja wiedzy'));
    assert.strictEqual(results.focus_block_checkins, 1);
  });

  await scenario('Z dawką -> body pusha = pytanie + dopisek o nowej porcji wiedzy', async () => {
    zerujLiczniki();
    generateCheckinImpl = async () => ({ ok: true, question: 'Jak idzie z lądowaniem po wyskoku?', contentDose: true, stageAtDose: 2 });
    const supabase = bazaBlokow();
    const results = { focus_block_checkins: 0 };
    await runFocusBlockCheckins(supabase, { hour: 10, minute: 0, day: 15, dateStr: '2026-08-15', weekday: 6 }, results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.strictEqual(sendPushCalls[0].opts.body, `Jak idzie z lądowaniem po wyskoku?${DOPISEK}`);
  });

  await scenario('Z dawką -> ZEGAR KADENCJI nietknięty (last_content_dose_at + stage nadal zapisywane)', async () => {
    zerujLiczniki();
    generateCheckinImpl = async () => ({ ok: true, question: 'Pytanie', contentDose: true, stageAtDose: 3 });
    const supabase = bazaBlokow();
    await runFocusBlockCheckins(supabase, { hour: 10, minute: 0, day: 15, dateStr: '2026-08-15', weekday: 6 }, { focus_block_checkins: 0 });
    const blok = supabase._state.focus_blocks[0];
    assert.strictEqual(blok.last_content_dose_stage, 3, 'kontrakt pasa A: stage zapisywany razem z dawką');
    assert.ok(blok.last_content_dose_at, 'zegar kadencji przestał być ustawiany — to zepsułoby rytm dawkowania');
  });

  await scenario('BEZ dawki -> zegar kadencji NIE ruszony (dopisek nie może go włączyć ani wyłączyć)', async () => {
    zerujLiczniki();
    generateCheckinImpl = async () => ({ ok: true, question: 'Pytanie', contentDose: false });
    const supabase = bazaBlokow();
    await runFocusBlockCheckins(supabase, { hour: 10, minute: 0, day: 15, dateStr: '2026-08-15', weekday: 6 }, { focus_block_checkins: 0 });
    const blok = supabase._state.focus_blocks[0];
    assert.strictEqual(blok.last_content_dose_at, undefined);
    assert.strictEqual(blok.last_content_dose_stage, undefined);
  });

  await scenario('contentDose === undefined (starszy kształt odpowiedzi) -> body bez dopisku, nie "undefined"', async () => {
    zerujLiczniki();
    generateCheckinImpl = async () => ({ ok: true, question: 'Pytanie' });
    const supabase = bazaBlokow();
    await runFocusBlockCheckins(supabase, { hour: 10, minute: 0, day: 15, dateStr: '2026-08-15', weekday: 6 }, { focus_block_checkins: 0 });
    assert.strictEqual(sendPushCalls[0].opts.body, 'Pytanie');
  });

  await scenario('Z dawką, ale zawodnik BEZ tokenu push -> nic nie wysłane, zegar kadencji I TAK ustawiony', async () => {
    zerujLiczniki();
    generateCheckinImpl = async () => ({ ok: true, question: 'Pytanie', contentDose: true, stageAtDose: 1 });
    const supabase = makeFakeSupabase({
      focus_blocks: [{ id: 'fb1', user_id: 'u1', status: 'active', started_at: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString() }],
      push_tokens: [],
      focus_block_checkins: [],
    });
    const results = { focus_block_checkins: 0 };
    await runFocusBlockCheckins(supabase, { hour: 10, minute: 0, day: 15, dateStr: '2026-08-15', weekday: 6 }, results);
    assert.strictEqual(sendPushCalls.length, 0);
    assert.strictEqual(results.focus_block_checkins, 0);
    assert.ok(supabase._state.focus_blocks[0].last_content_dose_at,
      'dawka powstała i jest w bazie niezależnie od pusha — brak tokenu nie może cofnąć kadencji');
  });

  // DEEPLINK R8 08.08.2026 — kontrakt z sekcji 12 raportu C rundy 6 wykonany:
  // przy NOWEJ dawce data dostaje czwarte pole `contentDose: true` (czyta je
  // appka mobilna, lib/pushDeepLink.ts). Bez dawki data ma NADAL dokładnie
  // trzy klucze — to jest pilnowane osobno niżej.
  await scenario('Z dawką -> data pusha ma CZWARTE pole contentDose:true (deep-link pasa B)', async () => {
    zerujLiczniki();
    generateCheckinImpl = async () => ({ ok: true, question: 'Pytanie', contentDose: true, stageAtDose: 2 });
    const supabase = bazaBlokow();
    await runFocusBlockCheckins(supabase, { hour: 10, minute: 0, day: 15, dateStr: '2026-08-15', weekday: 6 }, { focus_block_checkins: 0 });
    assert.deepStrictEqual(Object.keys(sendPushCalls[0].opts.data).sort(), ['checkinId', 'contentDose', 'focusBlockId', 'type']);
    assert.strictEqual(sendPushCalls[0].opts.data.type, 'focus_block_checkin');
    assert.strictEqual(sendPushCalls[0].opts.data.contentDose, true);
    assert.strictEqual(sendPushCalls[0].opts.title, 'Gamechange');
  });

  await scenario('BEZ dawki -> data pusha bez zmian: trzy klucze, ZERO pola contentDose', async () => {
    zerujLiczniki();
    generateCheckinImpl = async () => ({ ok: true, question: 'Pytanie' });
    const supabase = bazaBlokow();
    await runFocusBlockCheckins(supabase, { hour: 10, minute: 0, day: 15, dateStr: '2026-08-15', weekday: 6 }, { focus_block_checkins: 0 });
    assert.deepStrictEqual(Object.keys(sendPushCalls[0].opts.data).sort(), ['checkinId', 'focusBlockId', 'type'],
      'bez nowej dawki kształt data ma być CO DO ZNAKU jak przed rundą 8 — starszy odbiorca nie może dostać pola-widma');
    assert.strictEqual(sendPushCalls[0].opts.data.type, 'focus_block_checkin');
  });

  await scenario('dopisek jest JEDNĄ stałą, nie wpisanym w dwóch miejscach napisem', async () => {
    const fs = require('fs');
    const kod = fs.readFileSync(require.resolve('../api/cron-send-notifications.js'), 'utf8');
    const wystapienia = kod.split('Jest nowa porcja wiedzy w Twoim Bloku.').length - 1;
    assert.strictEqual(wystapienia, 1, 'napis ma żyć w jednym miejscu — druga kopia to zaproszenie do rozjazdu');
    assert.match(kod, /const NOWA_DAWKA_DOPISEK = /);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n6. asystent_app.html — sugestia kalendarzowa wycięta (SUGGESTED_ACTIVITY_BY_SEGMENT)');

  // Ten plik nie ma i nie będzie miał pełnego środowiska przeglądarki (jsdom
  // nie jest zależnością tego repo). Wycinam WYŁĄCZNIE dwie funkcje i uruchamiam
  // je na atrapie DOM — ten sam wzorzec, co test-coach-source-hint.js.
  const fsHtml = require('fs');
  const zrodloHtml = fsHtml.readFileSync(path.join(__dirname, '..', 'asystent_app.html'), 'utf8');
  const skryptHtml = [...zrodloHtml.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const zywyHtml = skryptHtml.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  function wytnijFunkcje(kod, nazwa) {
    const start = kod.indexOf(`function ${nazwa}(`);
    assert.notStrictEqual(start, -1, `nie znalazłem funkcji ${nazwa}`);
    let i = kod.indexOf('{', start), glebokosc = 0;
    for (; i < kod.length; i++) {
      if (kod[i] === '{') glebokosc++;
      else if (kod[i] === '}') { glebokosc--; if (glebokosc === 0) return kod.slice(start, i + 1); }
    }
    throw new Error(`nie domknąłem funkcji ${nazwa}`);
  }

  function atrapaDom() {
    const wrap = {
      klasy: new Set(['gc-hidden']),
      innerHTML: 'STARA KARTA — nie powinno tego zostać',
      classList: {
        add(c) { wrap.klasy.add(c); },
        remove(c) { wrap.klasy.delete(c); },
        contains(c) { return wrap.klasy.has(c); },
      },
    };
    return { wrap, document: { getElementById: (id) => (id === 'calendar-suggestion-wrap' ? wrap : null) } };
  }

  const zrodlaFunkcji = wytnijFunkcje(zywyHtml, 'computeCalendarSuggestion') + '\n'
    + wytnijFunkcje(zywyHtml, 'renderCalendarSuggestion');

  await scenario('computeCalendarSuggestion() zwraca null', async () => {
    const { document } = atrapaDom();
    const f = new Function('document', 'console', `${zrodlaFunkcji}\nreturn { computeCalendarSuggestion, renderCalendarSuggestion };`);
    const api = f(document, { warn() {} });
    assert.strictEqual(api.computeCalendarSuggestion(), null);
  });

  await scenario('renderCalendarSuggestion() -> kontener UKRYTY i PUSTY (zawodnik nie widzi nic)', async () => {
    const { wrap, document } = atrapaDom();
    const f = new Function('document', 'console', `${zrodlaFunkcji}\nreturn { computeCalendarSuggestion, renderCalendarSuggestion };`);
    const api = f(document, { warn() {} });
    api.renderCalendarSuggestion();
    assert.strictEqual(wrap.innerHTML, '', 'kontener musi być wyczyszczony, nie tylko ukryty');
    assert.strictEqual(wrap.classList.contains('gc-hidden'), true);
  });

  await scenario('renderCalendarSuggestion() nie rzuca, gdy kontenera nie ma w DOM', async () => {
    const f = new Function('document', 'console', `${zrodlaFunkcji}\nreturn { computeCalendarSuggestion, renderCalendarSuggestion };`);
    const api = f({ getElementById: () => null }, { warn() {} });
    api.renderCalendarSuggestion(); // brak wyjątku = sukces
  });

  await scenario('ŻYWY kod nie ma już ani jednego odwołania do SUGGESTED_ACTIVITY_BY_SEGMENT', async () => {
    // Odwołanie = użycie tablicy w kodzie. Jedyne dopuszczone wystąpienie tego
    // napisu w żywym kodzie to treść console.warn odsyłająca do komentarza.
    const uzycia = [...zywyHtml.matchAll(/SUGGESTED_ACTIVITY_BY_SEGMENT\s*(\[|=)/g)];
    assert.strictEqual(uzycia.length, 0, 'tablica nadal jest indeksowana albo definiowana w żywym kodzie');
  });

  await scenario('tablica ZOSTAŁA w komentarzu razem z powodem wycięcia (historia decyzji w pliku)', async () => {
    assert.ok(zrodloHtml.includes('const SUGGESTED_ACTIVITY_BY_SEGMENT = {'), 'treść tablicy zniknęła z pliku');
    assert.ok(zrodloHtml.includes('wizualizacja trudnych sytuacji meczowych i planowanie reakcji — 10 minut'),
      'wpis mental, ten z niepoprawną po renamie treścią, ma zostać zapisany — to on uzasadnia wycięcie');
    assert.ok(zrodloHtml.includes('DYSPOZYTOR C6 08.08.2026 — SUGESTIA KALENDARZA USUNIĘTA'));
    for (const segment of ['percepcja', 'decyzja', 'koncentracja', 'mental', 'moc', 'wytrzymalosc',
      'fizycznosc', 'techFund', 'techSpec', 'regeneracja', 'odpornosc', 'odzywianie', 'tolerancja']) {
      assert.ok(new RegExp(`^\\s{5}${segment}: '`, 'm').test(zrodloHtml), `w komentarzu brakuje segmentu ${segment}`);
    }
  });

  await scenario('acceptCalendarSuggestion() usunięta z żywego kodu razem z przyciskiem „Dodaj"', async () => {
    assert.ok(!zywyHtml.includes('acceptCalendarSuggestion'), 'funkcja nadal żyje');
    assert.ok(!zywyHtml.includes('Sugerowane na ten tydzień'), 'nagłówek karty nadal jest w kodzie');
    assert.ok(!zywyHtml.includes('dodać tam mikro-sesję powiązaną z Twoim aktywnym celem'), 'tekst karty nadal jest w kodzie');
  });

  await scenario('NIETKNIĘTE: ręczne dodawanie mikro-sesji i powiązanie z celem zostaje', async () => {
    assert.ok(zrodloHtml.includes('<option value="micro_session">Mikro-sesja</option>'),
      'zawodnik musi nadal móc zaplanować mikro-sesję sam — wycięliśmy podpowiedź, nie funkcję');
    assert.ok(zywyHtml.includes('populateCalendarLinkSelect'), 'powiązanie wpisu dziennika z wydarzeniem nietknięte');
    assert.ok(zywyHtml.includes('function loadEvents'), 'ładowanie kalendarza nietknięte');
  });

  await scenario('NIETKNIĘTE: etykiety segmentów i stałe pilotażu (wzorzec liczenia wystąpień)', async () => {
    const ile = (s) => zrodloHtml.split(s).length - 1;
    assert.strictEqual(ile('PILOT_HIDE_PURCHASE'), 4);
    assert.strictEqual(ile('SEGMENTS_BY_PILLAR'), 5);
    assert.strictEqual(ile('SEG_PILLAR'), 2);
    assert.strictEqual(ile('Filar 4 — Mentalność'), 1);
    for (const etykieta of ['Technika fundamentalna', 'Technika specjalistyczna', 'Tolerancja obciążeń', 'Szybkość decyzji']) {
      assert.strictEqual(ile(`'${etykieta}'`), 1, `etykieta ${etykieta} (wyrównana w rundzie 5) musi zostać dokładnie raz`);
    }
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n7. BUDZET R8 — budżet czasu dyspozytora (M25, projekt C6-N3)');

  await scenario('straznik: przed budżetem NIC nie pomija i NIE tworzy pola pominiete', async () => {
    const { zbudujStraznikaBudzetu } = handler._internal;
    const results = {};
    let ms = 0;
    const czasWyczerpany = zbudujStraznikaBudzetu(0, 240000, results, () => ms);
    ms = 239999;
    assert.strictEqual(czasWyczerpany('morning_readiness'), false);
    assert.ok(!('pominiete' in results),
      'reguła R5 w drugą stronę: brak pominięć = BRAK pola, nie pusta lista — przebieg w budżecie ma odpowiedź co do znaku jak przed rundą 8');
  });

  await scenario('straznik: po budżecie pomija i zapisuje klucze W KOLEJNOŚCI wywołań', async () => {
    const { zbudujStraznikaBudzetu } = handler._internal;
    const results = {};
    let ms = 0;
    const czasWyczerpany = zbudujStraznikaBudzetu(0, 1000, results, () => ms);
    ms = 500;
    assert.strictEqual(czasWyczerpany('morning_readiness'), false, 'w budżecie — rytm ma się wykonać');
    ms = 1000;
    assert.strictEqual(czasWyczerpany('post_training'), true, 'równo na granicy budżet jest wyczerpany');
    assert.strictEqual(czasWyczerpany('pre_match'), true);
    assert.deepStrictEqual(results.pominiete, ['post_training', 'pre_match'],
      'pominięte mają być wymienione z klucza i w kolejności — inaczej nie wiadomo, co nadrobi następne wywołanie');
  });

  await scenario('każdy z 15 rytmów ma strażnika, w kolejności 1–15 (odczyt źródła)', async () => {
    const fs = require('fs');
    const kod = fs.readFileSync(require.resolve('../api/cron-send-notifications.js'), 'utf8');
    const guardy = [...kod.matchAll(/if \(!czasWyczerpany\('([a-z_]+)'\)\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(guardy, [
      'morning_readiness', 'post_training', 'pre_match', 'weekly_summary', 'contextual_insight',
      'focus_block_checkins', 'focus_block_maintenance', 'focus_block_adaptation',
      'trial_expiry', 'parental_consent_expiry', 'coach_digest',
      'retention_check', 'training_focus_rotation', 'coach_scheduled_reports', 'parent_reports',
    ], 'strażnik ma stać przy KAŻDYM rytmie i w tej samej kolejności co kolejka — rytm bez strażnika to dziura w budżecie');
  });

  await scenario('budżet domyślny = 240 000 ms (300 s Hobby minus 60 s bufora), nadpisywalny env-em', async () => {
    const fs = require('fs');
    const kod = fs.readFileSync(require.resolve('../api/cron-send-notifications.js'), 'utf8');
    assert.strictEqual(handler._internal.DOMYSLNY_BUDZET_MS, 240000);
    assert.match(kod, /process\.env\.CRON_BUDZET_MS/, 'zmiana budżetu ma nie wymagać deployu');
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
