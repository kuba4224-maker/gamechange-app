// ============================================================
// GAMECHANGE — tests/test-parent-reports.js
// ============================================================
// NOWY PLIK (ZRODLO C5, 08.08.2026).
//
// CO TEN PLIK PILNUJE — i czego NIE pilnuje żaden inny:
//
// `tests/test-cron-send-parent-reports.js` (16 scenariuszy, runda 4)
// testuje ENDPOINT — czyli ścieżkę, którą nikt nigdy nie wywołał, bo ten
// endpoint nigdy nie był w vercel.json (znalezisko C4-N4). Od tej rundy
// raport rodzica jedzie DRUGĄ ścieżką: przez dyspozytor
// api/cron-send-notifications.js. Tamten plik testowy o tej ścieżce nie
// wie i nie ma jak wiedzieć.
//
// Tu jest testowane dokładnie to, co endpointowi obojętne, a dyspozytorowi
// nie:
//  1. liczniki lądują w PŁASKIM obiekcie `results` dyspozytora — łącznie
//     z czterema licznikami niecichego braku z rundy 4, które przy
//     spłaszczeniu do jednego `parent_reports` zniknęłyby bez śladu;
//  2. funkcja NIGDY NIE RZUCA — w dyspozytorze jest jednym z czternastu
//     rytmów w jednym `try`, więc wyjątek stąd zabrałby ze sobą całą resztę
//     przebiegu (dwanaście rytmów powiadomień, digest trenera, retencję,
//     rotację, wygasanie triala);
//  3. dwanaście przebiegów dziennie NIE znaczy dwunastu maili — bramką
//     zostaje last_sent_at + PARENT_REPORT_INTERVAL_DAYS;
//  4. PARENT_REPORT_INTERVAL_DAYS nie zmieniło się przy przenoszeniu (30).
//     Skrócenie do 14 dni czeka na decyzję Kuby i jest zmianą zmiennej
//     środowiskowej — ten test istnieje po to, żeby nie weszło przez
//     przypadek razem z refaktorem.
//
// Atrapy tym samym, ustalonym wzorcem co test-cron-send-parent-reports.js:
// ../lib/email-sender przez require.cache. `@supabase/supabase-js` NIE jest
// tu potrzebne — lib/parent-reports.js świadomie nie tworzy klienta, tylko
// go PRZYJMUJE (to jest właśnie ta różnica, która pozwoliła wpiąć go do
// dyspozytora). ../lib/email-templates CELOWO nie stubowane — pure, już
// przetestowane w test-email-templates.js.
//
// Uruchomienie: node tests/test-parent-reports.js
// ============================================================

const assert = require('assert');

// --- Atrapa ../lib/email-sender ---
let sendEmailImpl = async () => {};
const sendEmailCalls = [];
const emailSenderPath = require.resolve('../lib/email-sender.js');
require.cache[emailSenderPath] = {
  id: emailSenderPath, filename: emailSenderPath, loaded: true,
  exports: { sendEmail: async (args) => { sendEmailCalls.push(args); return sendEmailImpl(args); } },
};

process.env.PARENT_REPORT_BASE_URL = 'https://test.gamechange.app/raport-rodzica.html';

const { runParentReportsCheck, parentReportCutoffIso, PARENT_REPORT_BASE_URL } = require('../lib/parent-reports');

const DZIEN = 24 * 60 * 60 * 1000;

// --- Atrapa Supabase: ten sam kształt co w test-cron-send-parent-reports.js ---
function makeFakeSupabase({
  dueSubs = [], fetchError = null, reportsByToken = {}, updateErrorForIds = [],
  extrasByToken = null, snapshotError = null, rzucNaFrom = false, rzucNaRpc = false,
} = {}) {
  const state = { subs: dueSubs.map((s) => ({ ...s })), snapshots: [] };
  const orCalls = [];
  const rpcCalls = [];
  return {
    _state: state, _orCalls: orCalls, _rpcCalls: rpcCalls,
    from(table) {
      if (rzucNaFrom) throw new Error('baza padła w najgorszym momencie');
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
      if (rzucNaRpc) throw new Error('rpc wybuchło');
      rpcCalls.push({ fnName, params });
      if (fnName === 'get_parent_report') {
        const entry = reportsByToken[params.p_token];
        if (!entry) return Promise.resolve({ data: null, error: null });
        if (entry.error) return Promise.resolve({ data: null, error: entry.error });
        return Promise.resolve({ data: entry.data, error: null });
      }
      if (fnName === 'get_parent_report_extras') {
        if (extrasByToken === null) {
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

const RAPORT = {
  player_name: 'Antek',
  priority_goal: { segment_id: 'regeneracja', horizon_weeks: 6 },
  active_goals_count: 2, recent_training_sessions_7d: 3, recent_matches_30d: 1,
  growth_spurt_typical_age_range: false, height_growth_rate_elevated: false,
};

// Obiekt `results` w kształcie, w jakim buduje go dyspozytor.
function makeDispatcherResults() {
  return {
    morning_readiness: 0, post_training: 0, pre_match: 0, weekly_summary: 0, contextual_insight: 0,
    focus_block_checkins: 0, focus_block_maintenance: 0, focus_block_adaptation: 0,
    trial_expiry: 0, parental_consent_expiry: 0, coach_digest: 0,
    retention_check: 0, training_focus_rotation: 0, coach_scheduled_reports: 0,
    parent_reports: 0, parent_reports_failed: 0, parent_reports_skipped_no_report: 0,
    parent_reports_missing_extras: 0, parent_reports_snapshot_failed: 0,
  };
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
  console.log('lib/parent-reports.js — wpięcie raportu rodzica do dyspozytora crona');

  // ==========================================================
  console.log('\n1. Liczniki lądują w płaskim `results` dyspozytora');

  await scenario('udana wysyłka -> results.parent_reports = 1, pozostałe cztery zerowe', async () => {
    sendEmailCalls.length = 0;
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 's1', access_token: 'tok-1', parent_email: 'rodzic@example.com' }],
      reportsByToken: { 'tok-1': { data: RAPORT } },
      extrasByToken: {},
    });
    const out = await runParentReportsCheck(sb, results);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(results.parent_reports, 1);
    assert.strictEqual(results.parent_reports_failed, 0);
    assert.strictEqual(results.parent_reports_skipped_no_report, 0);
    assert.strictEqual(sendEmailCalls.length, 1);
    assert.strictEqual(sendEmailCalls[0].to, 'rodzic@example.com');
  });

  await scenario('R5: brak migracji z rundy 4 -> parent_reports_missing_extras WIDOCZNE w results', async () => {
    sendEmailCalls.length = 0;
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 's2', access_token: 'tok-2', parent_email: 'r2@example.com' }],
      reportsByToken: { 'tok-2': { data: RAPORT } },
      extrasByToken: null, // baza sprzed migracji
    });
    await runParentReportsCheck(sb, results);
    assert.strictEqual(results.parent_reports, 1, 'brak nowej warstwy NIE może wstrzymać raportu');
    assert.strictEqual(results.parent_reports_missing_extras, 1,
      'to jest CAŁE zabezpieczenie przed cichym brakiem z rundy 4 — musi przeżyć spłaszczenie do dyspozytora');
  });

  await scenario('R5: nieudany zapis migawki -> parent_reports_snapshot_failed, mail i tak poszedł', async () => {
    sendEmailCalls.length = 0;
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 's3', access_token: 'tok-3', parent_email: 'r3@example.com' }],
      reportsByToken: { 'tok-3': { data: RAPORT } },
      extrasByToken: {},
      snapshotError: { message: 'brak tabeli parent_report_snapshots' },
    });
    await runParentReportsCheck(sb, results);
    assert.strictEqual(results.parent_reports, 1);
    assert.strictEqual(results.parent_reports_snapshot_failed, 1);
    assert.strictEqual(sendEmailCalls.length, 1);
  });

  await scenario('token unieważniony -> parent_reports_skipped_no_report, nie _failed', async () => {
    sendEmailCalls.length = 0;
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 's4', access_token: 'tok-martwy', parent_email: 'r4@example.com' }],
      reportsByToken: { 'tok-martwy': { error: { message: 'token nieaktywny' } } },
    });
    await runParentReportsCheck(sb, results);
    assert.strictEqual(results.parent_reports_skipped_no_report, 1);
    assert.strictEqual(results.parent_reports_failed, 0, 'wyścig z wypisaniem się to nie awaria wysyłki');
    assert.strictEqual(sendEmailCalls.length, 0);
  });

  await scenario('błąd wysyłki jednej subskrypcji nie zatrzymuje drugiej', async () => {
    sendEmailCalls.length = 0;
    let pierwsza = true;
    sendEmailImpl = async () => { if (pierwsza) { pierwsza = false; throw new Error('provider padł'); } };
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({
      dueSubs: [
        { id: 'a', access_token: 'tok-a', parent_email: 'a@example.com' },
        { id: 'b', access_token: 'tok-b', parent_email: 'b@example.com' },
      ],
      reportsByToken: { 'tok-a': { data: RAPORT }, 'tok-b': { data: RAPORT } },
      extrasByToken: {},
    });
    await runParentReportsCheck(sb, results);
    sendEmailImpl = async () => {};
    assert.strictEqual(results.parent_reports_failed, 1);
    assert.strictEqual(results.parent_reports, 1);
    assert.strictEqual(sendEmailCalls.length, 2, 'obie próby wykonane mimo błędu pierwszej');
  });

  await scenario('`results` pominięte (ścieżka endpointu) -> liczniki tylko w zwrocie, zero wyjątku', async () => {
    sendEmailCalls.length = 0;
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 's5', access_token: 'tok-5', parent_email: 'r5@example.com' }],
      reportsByToken: { 'tok-5': { data: RAPORT } }, extrasByToken: {},
    });
    const out = await runParentReportsCheck(sb);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.results.sent, 1);
  });

  await scenario('dwa przebiegi tego samego dnia SUMUJĄ się w `results`, nie nadpisują', async () => {
    sendEmailCalls.length = 0;
    const results = makeDispatcherResults();
    for (const id of ['x1', 'x2']) {
      const sb = makeFakeSupabase({
        dueSubs: [{ id, access_token: `tok-${id}`, parent_email: `${id}@example.com` }],
        reportsByToken: { [`tok-${id}`]: { data: RAPORT } }, extrasByToken: {},
      });
      await runParentReportsCheck(sb, results);
    }
    assert.strictEqual(results.parent_reports, 2);
  });

  // ==========================================================
  console.log('\n2. NIGDY NIE RZUCA — bo w dyspozytorze jest jednym z czternastu rytmów');

  await scenario('błąd pobierania subskrypcji -> ok:false, ZERO wyjątku', async () => {
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({ fetchError: { message: 'timeout bazy' } });
    const out = await runParentReportsCheck(sb, results);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(results.parent_reports, 0);
  });

  await scenario('klient Supabase rzuca na `from` -> ok:false, ZERO wyjątku na zewnątrz', async () => {
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({ rzucNaFrom: true });
    const out = await runParentReportsCheck(sb, results);
    assert.strictEqual(out.ok, false, 'wyjątek stąd zabrałby ze sobą trzynaście pozostałych rytmów');
  });

  await scenario('klient Supabase rzuca na `rpc` -> policzone jako failed, przebieg kończy się ok', async () => {
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 'z', access_token: 'tok-z', parent_email: 'z@example.com' }],
      rzucNaRpc: true,
    });
    const out = await runParentReportsCheck(sb, results);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(results.parent_reports_failed, 1);
  });

  await scenario('supabase = null -> ok:false, ZERO wyjątku (najgorszy możliwy wariant)', async () => {
    const out = await runParentReportsCheck(null, makeDispatcherResults());
    assert.strictEqual(out.ok, false);
  });

  // ==========================================================
  console.log('\n3. Dwanaście przebiegów dziennie ≠ dwanaście maili');

  await scenario('interwał NIE zmienił się przy przenoszeniu do lib/ — domyślnie 30 dni', async () => {
    delete process.env.PARENT_REPORT_INTERVAL_DAYS;
    const teraz = new Date('2026-08-08T12:00:00Z');
    const cutoff = parentReportCutoffIso(Number(process.env.PARENT_REPORT_INTERVAL_DAYS) || 30, teraz);
    const roznicaDni = Math.round((teraz.getTime() - new Date(cutoff).getTime()) / DZIEN);
    assert.strictEqual(roznicaDni, 30,
      'PARENT_REPORT_INTERVAL_DAYS ma zostać 30 — skrócenie do 14 to decyzja Kuby i zmienna środowiskowa, nie refaktor');
  });

  await scenario('zapytanie o „czas nadszedł" nadal filtruje po last_sent_at (bramka wysyłki żyje)', async () => {
    const sb = makeFakeSupabase({ dueSubs: [] });
    await runParentReportsCheck(sb, makeDispatcherResults());
    assert.strictEqual(sb._orCalls.length, 1, 'jedno zapytanie z filtrem, nie zero');
    assert.match(sb._orCalls[0], /last_sent_at\.is\.null/);
    assert.match(sb._orCalls[0], /last_sent_at\.lt\./);
  });

  await scenario('zero subskrypcji na czas -> zero maili, wszystkie pięć liczników na zerze', async () => {
    sendEmailCalls.length = 0;
    const results = makeDispatcherResults();
    const out = await runParentReportsCheck(makeFakeSupabase({ dueSubs: [] }), results);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(sendEmailCalls.length, 0);
    for (const k of ['parent_reports', 'parent_reports_failed', 'parent_reports_skipped_no_report',
      'parent_reports_missing_extras', 'parent_reports_snapshot_failed']) {
      assert.strictEqual(results[k], 0, `${k} ma być 0, nie undefined — brak pola nie odróżnia „nikt nie był na czas" od „rytm się nie wykonał"`);
    }
  });

  await scenario('last_sent_at ustawiany PO udanej wysyłce (kolejność się nie odwróciła)', async () => {
    sendEmailCalls.length = 0;
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 'k', access_token: 'tok-k', parent_email: 'k@example.com' }],
      reportsByToken: { 'tok-k': { data: RAPORT } }, extrasByToken: {},
    });
    await runParentReportsCheck(sb, makeDispatcherResults());
    assert.ok(sb._state.subs[0].last_sent_at, 'bez tego następny przebieg wyśle duplikat za dwie godziny');
  });

  await scenario('nieudany update last_sent_at nie cofa wysyłki (mail już wyszedł)', async () => {
    sendEmailCalls.length = 0;
    const results = makeDispatcherResults();
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 'u', access_token: 'tok-u', parent_email: 'u@example.com' }],
      reportsByToken: { 'tok-u': { data: RAPORT } }, extrasByToken: {}, updateErrorForIds: ['u'],
    });
    await runParentReportsCheck(sb, results);
    assert.strictEqual(results.parent_reports, 1);
    assert.strictEqual(results.parent_reports_failed, 0);
    assert.strictEqual(sendEmailCalls.length, 1);
  });

  // ==========================================================
  console.log('\n4. Treść i adresy — przeniesienie nic nie zgubiło');

  await scenario('link wypisania się nadal składany z PARENT_REPORT_BASE_URL + token', async () => {
    sendEmailCalls.length = 0;
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 'l', access_token: 'tok-link', parent_email: 'l@example.com' }],
      reportsByToken: { 'tok-link': { data: RAPORT } }, extrasByToken: {},
    });
    await runParentReportsCheck(sb, makeDispatcherResults());
    assert.match(sendEmailCalls[0].html, /tok-link&amp;action=unsubscribe/);
    assert.ok(PARENT_REPORT_BASE_URL.includes('raport-rodzica.html'));
  });

  await scenario('segment celu przekazywany do get_parent_report_extras, w tej samej kolejności RPC', async () => {
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 'sg', access_token: 'tok-sg', parent_email: 'sg@example.com' }],
      reportsByToken: { 'tok-sg': { data: RAPORT } }, extrasByToken: {},
    });
    await runParentReportsCheck(sb, makeDispatcherResults());
    assert.strictEqual(sb._rpcCalls[0].fnName, 'get_parent_report');
    assert.strictEqual(sb._rpcCalls[1].fnName, 'get_parent_report_extras');
    assert.strictEqual(sb._rpcCalls[1].params.p_segment_id, 'regeneracja');
  });

  await scenario('raport bez celu -> p_segment_id = null, nie wyjątek', async () => {
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 'nc', access_token: 'tok-nc', parent_email: 'nc@example.com' }],
      reportsByToken: { 'tok-nc': { data: { ...RAPORT, priority_goal: null } } }, extrasByToken: {},
    });
    const out = await runParentReportsCheck(sb, makeDispatcherResults());
    assert.strictEqual(out.ok, true);
    assert.strictEqual(sb._rpcCalls[1].params.p_segment_id, null);
  });

  await scenario('migawka zapisuje DOKŁADNIE to, co rodzic dostał, do parent_report_snapshots', async () => {
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 'mg', access_token: 'tok-mg', parent_email: 'mg@example.com' }],
      reportsByToken: { 'tok-mg': { data: RAPORT } }, extrasByToken: {},
    });
    await runParentReportsCheck(sb, makeDispatcherResults());
    assert.strictEqual(sb._state.snapshots.length, 1);
    assert.strictEqual(sb._state.snapshots[0]._table, 'parent_report_snapshots');
    assert.strictEqual(sb._state.snapshots[0].subscription_id, 'mg');
    assert.deepStrictEqual(sb._state.snapshots[0].sent_report, RAPORT);
  });

  await scenario('nieudana wysyłka NIE zapisuje migawki (migawka = co rodzic zobaczył)', async () => {
    sendEmailImpl = async () => { throw new Error('provider padł'); };
    const sb = makeFakeSupabase({
      dueSubs: [{ id: 'nm', access_token: 'tok-nm', parent_email: 'nm@example.com' }],
      reportsByToken: { 'tok-nm': { data: RAPORT } }, extrasByToken: {},
    });
    await runParentReportsCheck(sb, makeDispatcherResults());
    sendEmailImpl = async () => {};
    assert.strictEqual(sb._state.snapshots.length, 0);
  });

  // ==========================================================
  console.log('\n5. Dyspozytor faktycznie to woła — na żywym pliku, nie na założeniu');

  await scenario('api/cron-send-notifications.js importuje i WOŁA runParentReportsCheck', async () => {
    const fs = require('fs');
    const p = require.resolve('../api/cron-send-notifications.js');
    const kod = fs.readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(kod, /require\('\.\.\/lib\/parent-reports'\)/, 'brak importu');
    assert.match(kod, /await runParentReportsCheck\(supabase, results\)/, 'import jest, wywołania nie ma — dokładnie ten defekt, który ta runda naprawia');
  });

  await scenario('raport rodzica jest OSTATNI w kolejce dyspozytora', async () => {
    const fs = require('fs');
    const kod = fs.readFileSync(require.resolve('../api/cron-send-notifications.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const wywolania = [...kod.matchAll(/await (run[A-Za-z]+)\(supabase/g)].map((m) => m[1]);
    assert.strictEqual(wywolania[wywolania.length - 1], 'runParentReportsCheck',
      'jedyny rytm wysyłający pocztę poza system ma iść po tym, jak reszta zrobiła swoje');
    for (const rytm of ['runCoachDigestCheck', 'runRetentionCheck', 'runTrainingFocusRotation', 'runCoachScheduledReportsCheck']) {
      assert.ok(wywolania.includes(rytm), `zniknął rytm z dyspozytora: ${rytm}`);
    }
  });

  await scenario('vercel.json NIE urósł — nadal 13 zadań, bez wpisu dla raportu rodzica', async () => {
    const fs = require('fs');
    const v = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'vercel.json'), 'utf8'));
    assert.strictEqual(v.crons.length, 13, 'czternasty wpis to dokładnie to, czego polecenie zabraniało');
    assert.ok(!v.crons.some((c) => /parent-reports/.test(c.path)), 'raport rodzica ma wchodzić przez dyspozytor, nie przez własny wpis');
  });

  await scenario('api/ ma nadal 12 plików — ograniczenie O1 zachowane', async () => {
    const fs = require('fs');
    const pliki = fs.readdirSync(require('path').join(__dirname, '..', 'api')).filter((f) => f.endsWith('.js'));
    assert.ok(pliki.length <= 12, `api/ ma ${pliki.length} plików — trzynasty zablokuje deploy całego repo`);
  });

  console.log(`\n${failed === 0 ? `WSZYSTKIE TESTY PRZESZŁY (${passed}).` : `PRZESZŁO ${passed}, PADŁO ${failed}.`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
