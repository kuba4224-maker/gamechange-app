// ============================================================
// GAMECHANGE — tests/test-cron-send-parent-reports.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda, dalszy ciąg — kontynuacja
// "Pracuj dalej"). Cron wysyłający cykliczny raport rodzica (Domena 16) —
// dotąd bez ŻADNEGO testu, mimo że to plik z historią jednego już
// znalezionego błędu składni (brakujący cudzysłów, naprawiony
// 03.08.2026 — patrz nagłówek pliku). Kolejność operacji w tym pliku ma
// znaczenie: e-mail wysyłany PRZED aktualizacją last_sent_at (świadomie,
// żeby nieudana wysyłka nie "zgubiła" subskrypcji) — warte testu wprost,
// żeby ta kolejność nigdy się przypadkiem nie odwróciła.
//
// Zależności stubowane tym samym, ustalonym wzorcem: @supabase/supabase-js
// (Module._resolveFilename), ../lib/email-sender (require.cache, czyste
// I/O). ../lib/email-templates CELOWO NIE stubowane — pure, bez zależności,
// już przetestowane w test-email-templates.js.
//
// Uruchomienie: node tests/test-cron-send-parent-reports.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- 1. Atrapa @supabase/supabase-js ---
let currentFakeSupabase = null;
const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_9__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath, filename: supabaseStubPath, loaded: true,
  exports: { createClient: () => currentFakeSupabase },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

// --- 2. Atrapa ../lib/email-sender ---
let sendEmailImpl = async () => {};
const sendEmailCalls = [];
const emailSenderPath = require.resolve('../lib/email-sender.js');
require.cache[emailSenderPath] = {
  id: emailSenderPath, filename: emailSenderPath, loaded: true,
  exports: { sendEmail: async (args) => { sendEmailCalls.push(args); return sendEmailImpl(args); } },
};

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.PARENT_REPORT_BASE_URL = 'https://test.gamechange.app/raport-rodzica.html';

const handler = require('../api/cron-send-parent-reports.js');

Module._resolveFilename = originalResolveFilename;

// --- 3. Atrapa Supabase dla parent_report_subscriptions + rpc get_parent_report ---
// RODZIC C4 08.08.2026 — atrapa rozszerzona o dwie rzeczy, które doszły
// w tej rundzie: RPC `get_parent_report_extras` (warstwa materiałów dla
// rodzica + migawka poprzedniego raportu) oraz `insert` do
// `parent_report_snapshots`. `extrasByToken = null` udaje bazę SPRZED
// migracji — i to jest osobny, ważny przypadek testowy: cron ma wtedy
// nadal wysyłać, tylko policzyć brak.
function makeFakeSupabase({
  dueSubs = [], fetchError = null, reportsByToken = {}, updateErrorForIds = [],
  extrasByToken = null, snapshotError = null,
} = {}) {
  const state = { subs: dueSubs.map((s) => ({ ...s })), snapshots: [] };
  const orCalls = [];
  const rpcCalls = [];
  return {
    _state: state,
    _orCalls: orCalls,
    _rpcCalls: rpcCalls,
    from(table) {
      const filters = [];
      let mode = 'select';
      let updatePayload = null;
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        or(expr) { orCalls.push(expr); return builder; },
        update(payload) { mode = 'update'; updatePayload = payload; return builder; },
        insert(payload) {
          if (snapshotError) return Promise.resolve({ error: snapshotError });
          state.snapshots.push(Object.assign({ _table: table }, payload));
          return Promise.resolve({ error: null });
        },
        then(resolve, reject) {
          if (mode === 'update') {
            const rows = state.subs.filter((r) => filters.every((f) => f(r)));
            if (rows.some((r) => updateErrorForIds.includes(r.id))) {
              return Promise.resolve({ error: { message: 'update last_sent_at padł' } }).then(resolve, reject);
            }
            rows.forEach((r) => Object.assign(r, updatePayload));
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
          if (fetchError) return Promise.resolve({ data: null, error: fetchError }).then(resolve, reject);
          return Promise.resolve({ data: state.subs, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(fnName, params) {
      rpcCalls.push({ fnName, params });
      if (fnName === 'get_parent_report') {
        const entry = reportsByToken[params.p_token];
        if (!entry) return Promise.resolve({ data: null, error: null });
        if (entry.error) return Promise.resolve({ data: null, error: entry.error });
        return Promise.resolve({ data: entry.data, error: null });
      }
      // RODZIC C4 08.08.2026
      if (fnName === 'get_parent_report_extras') {
        if (extrasByToken === null) {
          // baza sprzed migracji z tej rundy — funkcja po prostu nie istnieje
          return Promise.resolve({ data: null, error: { message: 'function public.get_parent_report_extras does not exist' } });
        }
        const entry = extrasByToken[params.p_token];
        if (!entry) return Promise.resolve({ data: null, error: null });
        if (entry.error) return Promise.resolve({ data: null, error: entry.error });
        return Promise.resolve({ data: entry.data, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `nieznana funkcja rpc: ${fnName}` } });
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
  console.log('cron-send-parent-reports.js — testy jednostkowe (atrapa Supabase + email-sender)');

  await scenario('zły/brak CRON_SECRET -> 401, Supabase nietknięty', async () => {
    const { req, res, status } = makeReqRes({ auth: 'zly-sekret' });
    currentFakeSupabase = makeFakeSupabase({});
    await handler(req, res);
    assert.strictEqual(status(), 401);
    assert.strictEqual(currentFakeSupabase._orCalls.length, 0);
  });

  await scenario('błąd pobierania subskrypcji -> 500, ok:false', async () => {
    const { req, res, status, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({ fetchError: { message: 'timeout bazy' } });
    await handler(req, res);
    assert.strictEqual(status(), 500);
    assert.strictEqual(json().ok, false);
  });

  await scenario('brak subskrypcji "na czas" -> 200, sent=0, brak wysyłki', async () => {
    sendEmailCalls.length = 0;
    const { req, res, status, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({ dueSubs: [] });
    await handler(req, res);
    assert.strictEqual(status(), 200);
    assert.strictEqual(json().results.sent, 0);
    assert.strictEqual(sendEmailCalls.length, 0);
  });

  await scenario('get_parent_report zwraca błąd (token unieważniony w wyścigu z wypisaniem) -> skippedNoReport++, brak wysyłki', async () => {
    sendEmailCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's1', access_token: 'tok-uniewazniony', parent_email: 'r1@example.com' }],
      reportsByToken: { 'tok-uniewazniony': { error: { message: 'token nieaktywny' } } },
    });
    await handler(req, res);
    assert.strictEqual(json().results.skippedNoReport, 1);
    assert.strictEqual(sendEmailCalls.length, 0);
  });

  await scenario('get_parent_report zwraca null bez błędu -> też skippedNoReport (nie failed)', async () => {
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's2', access_token: 'tok-brak-raportu', parent_email: 'r2@example.com' }],
      reportsByToken: {},
    });
    await handler(req, res);
    assert.strictEqual(json().results.skippedNoReport, 1);
    assert.strictEqual(json().results.failed, 0);
  });

  await scenario('happy path -> e-mail wysłany z poprawnym adresatem i linkiem wypisania, last_sent_at zaktualizowany, sent++', async () => {
    sendEmailCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's3', access_token: 'tok-dobry', parent_email: 'rodzic@example.com', last_sent_at: null }],
      reportsByToken: { 'tok-dobry': { data: { player_name: 'Jaś Kowalski', priority_goal: null } } },
    });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.results.sent, 1);
    assert.strictEqual(sendEmailCalls.length, 1);
    assert.strictEqual(sendEmailCalls[0].to, 'rodzic@example.com');
    // "&" jest poprawnie uciekniony jako "&amp;" w HTML (ten sam escapeHtml
    // co testowany w test-email-templates.js) — to DOBRE zachowanie, nie błąd.
    assert.match(sendEmailCalls[0].html, /tok-dobry&amp;action=unsubscribe/);
    assert.ok(currentFakeSupabase._state.subs[0].last_sent_at, 'last_sent_at musi zostać ustawiony po udanej wysyłce');
  });

  await scenario('błąd aktualizacji last_sent_at PO udanej wysyłce -> mimo to liczy się jako sent (mail już poszedł, nie failed)', async () => {
    sendEmailCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's4', access_token: 'tok-update-padnie', parent_email: 'r4@example.com' }],
      reportsByToken: { 'tok-update-padnie': { data: { player_name: 'X', priority_goal: null } } },
      updateErrorForIds: ['s4'],
    });
    await handler(req, res);
    assert.strictEqual(json().results.sent, 1);
    assert.strictEqual(json().results.failed, 0);
    assert.strictEqual(sendEmailCalls.length, 1, 'mail i tak musiał wyjść przed próbą aktualizacji');
  });

  await scenario('sendEmail rzuca (dostawca padł) -> failed++, batch NIE przerwany, kolejna subskrypcja i tak przetworzona', async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async (args) => {
      if (args.to === 'padnie@example.com') throw new Error('dostawca e-mail niedostępny');
    };
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [
        { id: 's5', access_token: 'tok-padnie', parent_email: 'padnie@example.com' },
        { id: 's6', access_token: 'tok-ok', parent_email: 'ok@example.com' },
      ],
      reportsByToken: {
        'tok-padnie': { data: { player_name: 'A', priority_goal: null } },
        'tok-ok': { data: { player_name: 'B', priority_goal: null } },
      },
    });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.results.failed, 1);
    assert.strictEqual(r.results.sent, 1);
    assert.strictEqual(sendEmailCalls.length, 2, 'obie próby wysyłki wykonane mimo błędu pierwszej');
    sendEmailImpl = async () => {};
  });

  await scenario('cel priorytetowy obecny w raporcie -> treść maila zawiera nazwę segmentu (integracja z prawdziwym parentReportEmail)', async () => {
    const { req, res } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's7', access_token: 'tok-cel', parent_email: 'r7@example.com' }],
      reportsByToken: { 'tok-cel': { data: { player_name: 'Kasia', priority_goal: { segment_id: 'moc', horizon_weeks: 6 } } } },
    });
    sendEmailCalls.length = 0;
    await handler(req, res);
    assert.match(sendEmailCalls[0].html, /Priorytetowy cel/);
    assert.match(sendEmailCalls[0].subject, /Kasia/);
  });

  // ============================================================
  // RODZIC C4 08.08.2026 — warstwa materiałów + migawka raportu
  // ============================================================
  console.log('\nRODZIC C4 — warstwa materiałów dla rodzica i migawka raportu');

  const RAPORT = {
    player_name: 'Antek',
    priority_goal: { segment_id: 'regeneracja', horizon_weeks: 6 },
    active_goals_count: 2, recent_training_sessions_7d: 3, recent_matches_30d: 1,
  };
  const EXTRAS = {
    segment_id: 'regeneracja',
    hints_available: true,
    hints: [
      { hint: 'Dawka bazowa dla zawodnika ok. 70 kg: 200–400 mg magnezu elementarnego dziennie.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '5, 13', pozycja: 8 },
      { hint: 'Wyznacz stałą godzinę snu i trzymaj się jej codziennie.', odbiorca: 'oba', min_age: null, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '2', pozycja: 2 },
    ],
    previous_report: null, previous_report_at: null, last_log_at: '2026-08-06T18:00:00Z',
  };

  await scenario('extras dostępne -> podpowiedzi z dawkami realnie w wysłanym e-mailu (bramka A9, strona rodzica)', async () => {
    sendEmailCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's8', access_token: 'tok-extras', parent_email: 'r8@example.com' }],
      reportsByToken: { 'tok-extras': { data: RAPORT } },
      extrasByToken: { 'tok-extras': { data: EXTRAS } },
    });
    await handler(req, res);
    assert.strictEqual(json().results.missingExtras, 0);
    assert.match(sendEmailCalls[0].html, /200–400 mg magnezu elementarnego/);
    assert.match(sendEmailCalls[0].html, /Regeneracja — System Gamechange \(pełny\), s\. 5, 13/);
  });

  await scenario('extras wołane TYM SAMYM tokenem co get_parent_report i z segmentem z raportu (mechanizm tokenu nietknięty)', async () => {
    const { req, res } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's9', access_token: 'tok-segment', parent_email: 'r9@example.com' }],
      reportsByToken: { 'tok-segment': { data: RAPORT } },
      extrasByToken: { 'tok-segment': { data: EXTRAS } },
    });
    await handler(req, res);
    const wywolania = currentFakeSupabase._rpcCalls;
    assert.strictEqual(wywolania[0].fnName, 'get_parent_report');
    assert.strictEqual(wywolania[1].fnName, 'get_parent_report_extras');
    assert.strictEqual(wywolania[1].params.p_token, 'tok-segment');
    assert.strictEqual(wywolania[1].params.p_segment_id, 'regeneracja');
  });

  await scenario('MIGRACJA NIEWKLEJONA -> e-mail i tak wychodzi, a brak jest POLICZONY, nie cichy (R5)', async () => {
    sendEmailCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's10', access_token: 'tok-bez-migracji', parent_email: 'r10@example.com' }],
      reportsByToken: { 'tok-bez-migracji': { data: RAPORT } },
      extrasByToken: null, // funkcja nie istnieje
    });
    await handler(req, res);
    const r = json();
    assert.strictEqual(r.results.sent, 1, 'brak nowej warstwy NIE może wstrzymać raportu');
    assert.strictEqual(r.results.missingExtras, 1, 'ma być widoczne w wyniku, nie tylko w logu');
    assert.match(sendEmailCalls[0].html, /Biblioteka wskazówek dla rodzica nie jest jeszcze podłączona/);
  });

  await scenario('migawka wysłanego raportu zapisana PO udanej wysyłce, z tym samym ciałem raportu', async () => {
    sendEmailCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's11', access_token: 'tok-migawka', parent_email: 'r11@example.com' }],
      reportsByToken: { 'tok-migawka': { data: RAPORT } },
      extrasByToken: { 'tok-migawka': { data: EXTRAS } },
    });
    await handler(req, res);
    const migawki = currentFakeSupabase._state.snapshots;
    assert.strictEqual(migawki.length, 1);
    assert.strictEqual(migawki[0]._table, 'parent_report_snapshots');
    assert.strictEqual(migawki[0].subscription_id, 's11');
    assert.deepStrictEqual(migawki[0].sent_report, RAPORT);
    assert.strictEqual(json().results.snapshotFailed, 0);
  });

  await scenario('nieudana wysyłka -> ŻADNEJ migawki (migawka ma odpowiadać temu, co rodzic realnie zobaczył)', async () => {
    sendEmailImpl = async () => { throw new Error('dostawca padł'); };
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's12', access_token: 'tok-padnie-2', parent_email: 'r12@example.com' }],
      reportsByToken: { 'tok-padnie-2': { data: RAPORT } },
      extrasByToken: { 'tok-padnie-2': { data: EXTRAS } },
    });
    await handler(req, res);
    assert.strictEqual(currentFakeSupabase._state.snapshots.length, 0);
    assert.strictEqual(json().results.failed, 1);
    sendEmailImpl = async () => {};
  });

  await scenario('błąd zapisu migawki -> policzony, ale NIE psuje wysyłki', async () => {
    sendEmailCalls.length = 0;
    const { req, res, json } = makeReqRes();
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's13', access_token: 'tok-migawka-padnie', parent_email: 'r13@example.com' }],
      reportsByToken: { 'tok-migawka-padnie': { data: RAPORT } },
      extrasByToken: { 'tok-migawka-padnie': { data: EXTRAS } },
      snapshotError: { message: 'brak tabeli parent_report_snapshots' },
    });
    await handler(req, res);
    assert.strictEqual(json().results.sent, 1);
    assert.strictEqual(json().results.snapshotFailed, 1);
    assert.strictEqual(sendEmailCalls.length, 1);
  });

  await scenario('migawka poprzedniego raportu -> e-mail mówi, co się zmieniło, zamiast „pierwszy raport"', async () => {
    sendEmailCalls.length = 0;
    const { req, res } = makeReqRes();
    const extrasZMigawka = Object.assign({}, EXTRAS, {
      previous_report: Object.assign({}, RAPORT, { recent_training_sessions_7d: 1 }),
      previous_report_at: '2026-07-08T10:00:00Z',
    });
    currentFakeSupabase = makeFakeSupabase({
      dueSubs: [{ id: 's14', access_token: 'tok-delta', parent_email: 'r14@example.com' }],
      reportsByToken: { 'tok-delta': { data: RAPORT } },
      extrasByToken: { 'tok-delta': { data: extrasZMigawka } },
    });
    await handler(req, res);
    assert.match(sendEmailCalls[0].html, /Zapisanych sesji w ostatnich 7 dniach: 3 — poprzednio 1\./);
    assert.ok(!sendEmailCalls[0].html.includes('To pierwszy raport'));
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
