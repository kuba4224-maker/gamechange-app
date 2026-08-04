// ============================================================
// GAMECHANGE — tests/test-cron-send-notifications.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, szósta runda — kontynuacja "Pracuj dalej").
// Największy i najbardziej rozgałęziony plik w całym projekcie (823 linie,
// 9 niezależnych "rytmów" powiadomień) — dotąd bez ŻADNEGO testu. Świadomie
// odłożony na osobną rundę (patrz DO_ZROBIENIA_PRZEZ_KUBE.md, poprzednia
// runda) zamiast robiony "przy okazji", właśnie dlatego, że wymaga tylu
// niezależnych scenariuszy.
//
// KLUCZOWA DECYZJA TESTOWA: każda funkcja rytmu przyjmuje `warsawNow` (albo
// nic, dla dwóch rytmów zdarzeniowych bez okna godzinowego) jako PARAMETR —
// `getWarsawNow()` (jedyne miejsce z `new Date()` bez wstrzykiwanego zegara)
// wołane jest RAZ, w handlerze, i wynik przekazywany dalej. Testujemy więc
// KAŻDY rytm BEZPOŚREDNIO (przez `_internal`, dopisane dziś — patrz komentarz
// w api/cron-send-notifications.js), podając syntetyczny `warsawNow` zamiast
// czekać na realne okno godzinowe — w pełni deterministyczne, niezależne od
// tego, o której godzinie w Warszawie faktycznie uruchomi się ten test.
// Dla `runContextualInsight`/`runParentalConsentExpiry` (bez okna godzinowego,
// realne `Date.now()` w środku) fixture'y budowane są względem `Date.now()”
// w chwili testu — ten sam, ustalony wzorzec co w innych plikach tego folderu
// (np. test-generate-focus-block-dosing.js).
//
// STUBOWANE ZALEŻNOŚCI (ten sam, ustalony wzorzec):
//   - @supabase/supabase-js — pakiet niezainstalowany w tej piaskownicy.
//   - ./send-push — świadomie stubowane, ma WŁASNY plik testowy (13/13).
//   - ../lib/focus-block-adaptation — świadomie stubowane, ma WŁASNY plik
//     testowy (18/18, patrz runFocusBlockAdaptation).
//   - ../lib/stripe-client — świadomie stubowane, ma WŁASNY plik testowy
//     (9/9) — tu kontrolujemy WYNIK stripeRequest(), nie testujemy ponownie
//     budowy URL.
//   - ./generate-focus-block-content — świadomie stubowane (require LENIWY,
//     wewnątrz runFocusBlockCheckins — require.cache i tak działa, bo Node
//     sprawdza cache niezależnie od momentu wywołania require()). Ten plik
//     ma WŁASNY plik testowy (11/11) dla własnej, nietrywialnej logiki —
//     tu testujemy WYŁĄCZNIE orkiestrację cron-send-notifications.js.
//
// Uruchomienie: node tests/test-cron-send-notifications.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- 1. Atrapa @supabase/supabase-js ---
let currentFakeSupabase = null;
const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_10__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath, filename: supabaseStubPath, loaded: true,
  exports: { createClient: () => currentFakeSupabase },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

// --- 2. Atrapy lokalnych zależności (require.cache) ---
let sendPushImpl = async () => ({ successCount: 1, failureCount: 0, invalidTokens: [] });
const sendPushCalls = [];
let verifyFirebaseConfigImpl = () => true;
const sendPushStubPath = require.resolve('../api/send-push.js');
require.cache[sendPushStubPath] = {
  id: sendPushStubPath, filename: sendPushStubPath, loaded: true,
  exports: {
    sendPush: async (tokens, opts) => { sendPushCalls.push({ tokens, opts }); return sendPushImpl(tokens, opts); },
    verifyFirebaseConfig: () => verifyFirebaseConfigImpl(),
  },
};

let runFocusBlockAdaptationImpl = async () => {};
const runFocusBlockAdaptationCalls = [];
const focusAdaptStubPath = require.resolve('../lib/focus-block-adaptation.js');
require.cache[focusAdaptStubPath] = {
  id: focusAdaptStubPath, filename: focusAdaptStubPath, loaded: true,
  exports: { runFocusBlockAdaptation: async (supabase, results) => { runFocusBlockAdaptationCalls.push(results); return runFocusBlockAdaptationImpl(supabase, results); } },
};

let stripeRequestImpl = async () => ({});
const stripeRequestCalls = [];
const stripeClientStubPath = require.resolve('../lib/stripe-client.js');
require.cache[stripeClientStubPath] = {
  id: stripeClientStubPath, filename: stripeClientStubPath, loaded: true,
  exports: { stripeRequest: async (p, f, m) => { stripeRequestCalls.push({ path: p, fields: f, method: m }); return stripeRequestImpl(p, f, m); } },
};

let generateCheckinImpl = async () => ({ ok: true, question: 'Jak idzie?', contentDose: false });
const generateCheckinCalls = [];
const focusContentStubPath = require.resolve('../api/generate-focus-block-content.js');
require.cache[focusContentStubPath] = {
  id: focusContentStubPath, filename: focusContentStubPath, loaded: true,
  exports: { _internal: { generateCheckin: async (args) => { generateCheckinCalls.push(args); return generateCheckinImpl(args); } } },
};

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.CRON_SECRET = 'test-cron-secret';

const handler = require('../api/cron-send-notifications.js');
const {
  hourInWindow, toWarsawDateStr, hasLoggedMorningToday,
  runMorningReadiness, runPostTraining, runPreMatch, runWeeklySummary,
  runContextualInsight, runFocusBlockCheckins, runFocusBlockMaintenance,
  runTrialExpiry, runParentalConsentExpiry,
} = handler._internal;

Module._resolveFilename = originalResolveFilename;

// --- 3. Generyczna atrapa Supabase — wystarcza dla wszystkich zapytań w tym pliku ---
function makeFakeSupabase(tables = {}, errors = {}) {
  const state = {};
  for (const [k, v] of Object.entries(tables)) state[k] = v.map((r) => ({ ...r }));
  return {
    _state: state,
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
        select() { return builder; },
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
        maybeSingle() {
          if (errors[table] && errors[table].select) return Promise.resolve({ data: null, error: errors[table].select });
          const rows = applyFilters();
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        single() {
          if (mode === 'insert') {
            if (errors[table] && errors[table].insert) return Promise.resolve({ data: null, error: errors[table].insert });
            const row = { id: `id_${table}_${state[table].length + 1}`, ...payload };
            state[table].push(row);
            return Promise.resolve({ data: row, error: null });
          }
          const rows = applyFilters();
          return rows[0] ? Promise.resolve({ data: rows[0], error: null }) : Promise.resolve({ data: null, error: { message: 'not found' } });
        },
        then(resolve, reject) {
          if (mode === 'update') {
            if (errors[table] && errors[table].update) return Promise.resolve({ data: null, error: errors[table].update }).then(resolve, reject);
            const rows = applyFilters();
            rows.forEach((r) => Object.assign(r, payload));
            return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
          }
          if (mode === 'insert') {
            if (errors[table] && errors[table].insert) return Promise.resolve({ data: null, error: errors[table].insert }).then(resolve, reject);
            const row = { id: `id_${table}_${state[table].length + 1}`, ...payload };
            state[table].push(row);
            return Promise.resolve({ data: [row], error: null }).then(resolve, reject);
          }
          if (errors[table] && errors[table].select) return Promise.resolve({ data: null, error: errors[table].select }).then(resolve, reject);
          return Promise.resolve({ data: applyFilters(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

function makeResults() {
  return {
    morning_readiness: 0, post_training: 0, pre_match: 0, weekly_summary: 0, contextual_insight: 0,
    focus_block_checkins: 0, focus_block_maintenance: 0, focus_block_adaptation: 0,
    trial_expiry: 0, parental_consent_expiry: 0,
  };
}

function warsawNowAt({ hour, minute = 0, day = 15, dateStr = '2026-08-15', weekday = 6 }) {
  return { hour, minute, day, dateStr, weekday };
}

function daysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
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
  console.log('cron-send-notifications.js — testy jednostkowe (9 rytmów, atrapy Supabase + lib/*)');

  console.log('\n1. hourInWindow / toWarsawDateStr — czyste funkcje pomocnicze');

  await scenario('hourInWindow: godzina docelowa dokładnie na starcie okna -> true', () => {
    assert.strictEqual(hourInWindow(19, 19), true);
  });
  await scenario('hourInWindow: godzina docelowa +1 w oknie 2h -> true', () => {
    assert.strictEqual(hourInWindow(19, 20), true);
  });
  await scenario('hourInWindow: godzina docelowa +2 (poza oknem) -> false', () => {
    assert.strictEqual(hourInWindow(19, 21), false);
  });
  await scenario('hourInWindow: zawijanie przez północ (23 -> 0) -> true', () => {
    assert.strictEqual(hourInWindow(23, 0), true);
  });
  await scenario('toWarsawDateStr: zwraca YYYY-MM-DD w strefie Europe/Warsaw', () => {
    const d = new Date('2026-06-15T22:30:00Z'); // late UTC, could roll to next day in Warsaw (CEST +2)
    assert.strictEqual(toWarsawDateStr(d), '2026-06-16');
  });

  console.log('\n2. hasLoggedMorningToday');

  await scenario('wpis "morning" z dzisiejszą datą (Warszawa) -> true', async () => {
    const supabase = makeFakeSupabase({ daily_logs: [{ user_id: 'u1', entry_type: 'morning', created_at: '2026-08-15T05:00:00Z' }] });
    const r = await hasLoggedMorningToday(supabase, 'u1', warsawNowAt({ hour: 8, dateStr: '2026-08-15' }));
    assert.strictEqual(r, true);
  });
  await scenario('wpis "morning" ze WCZORAJSZĄ datą -> false', async () => {
    const supabase = makeFakeSupabase({ daily_logs: [{ user_id: 'u1', entry_type: 'morning', created_at: '2026-08-14T05:00:00Z' }] });
    const r = await hasLoggedMorningToday(supabase, 'u1', warsawNowAt({ hour: 8, dateStr: '2026-08-15' }));
    assert.strictEqual(r, false);
  });
  await scenario('brak żadnego wpisu "morning" -> false', async () => {
    const supabase = makeFakeSupabase({ daily_logs: [] });
    const r = await hasLoggedMorningToday(supabase, 'u1', warsawNowAt({ hour: 8 }));
    assert.strictEqual(r, false);
  });

  console.log('\n3. runMorningReadiness (Rytm 1)');

  await scenario('poza oknem godzinowym -> brak push', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({ users: [{ id: 'u1' }], notification_preferences: [], daily_logs: [], push_tokens: [{ user_id: 'u1', token: 't1' }] });
    const results = makeResults();
    await runMorningReadiness(supabase, warsawNowAt({ hour: 12 }), results); // domyślna 07:30, okno [7,9)
    assert.strictEqual(sendPushCalls.length, 0);
    assert.strictEqual(results.morning_readiness, 0);
  });

  await scenario('w oknie, jeszcze nie zalogowany, ma token -> push wysłany, licznik++', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({ users: [{ id: 'u1' }], notification_preferences: [], daily_logs: [], push_tokens: [{ user_id: 'u1', token: 't1' }] });
    const results = makeResults();
    await runMorningReadiness(supabase, warsawNowAt({ hour: 7 }), results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.strictEqual(results.morning_readiness, 1);
  });

  await scenario('już zalogowany dziś -> BRAK push (nie nagabuj)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      users: [{ id: 'u1' }], notification_preferences: [],
      daily_logs: [{ user_id: 'u1', entry_type: 'morning', created_at: '2026-08-15T04:00:00Z' }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runMorningReadiness(supabase, warsawNowAt({ hour: 7, dateStr: '2026-08-15' }), results);
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('preferencja jawnie wyłączona (enabled=false) -> pominięty', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      users: [{ id: 'u1' }],
      notification_preferences: [{ user_id: 'u1', notification_type: 'morning_readiness', enabled: false, preferred_time: '07:00' }],
      daily_logs: [], push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runMorningReadiness(supabase, warsawNowAt({ hour: 7 }), results);
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('własna preferred_time (spoza domyślnego okna) respektowana', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      users: [{ id: 'u1' }],
      notification_preferences: [{ user_id: 'u1', notification_type: 'morning_readiness', enabled: true, preferred_time: '15:00' }],
      daily_logs: [], push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runMorningReadiness(supabase, warsawNowAt({ hour: 15 }), results); // domyślne 07:30 by NIE trafiło w to okno
    assert.strictEqual(sendPushCalls.length, 1);
  });

  await scenario('brak tokenów push -> pominięty (nie liczy się jako wysłany)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({ users: [{ id: 'u1' }], notification_preferences: [], daily_logs: [], push_tokens: [] });
    const results = makeResults();
    await runMorningReadiness(supabase, warsawNowAt({ hour: 7 }), results);
    assert.strictEqual(sendPushCalls.length, 0);
    assert.strictEqual(results.morning_readiness, 0);
  });

  await scenario('treść rotuje wg parzystości dnia miesiąca (dzień parzysty vs nieparzysty)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({ users: [{ id: 'u1' }], notification_preferences: [], daily_logs: [], push_tokens: [{ user_id: 'u1', token: 't1' }] });
    await runMorningReadiness(supabase, warsawNowAt({ hour: 7, day: 14 }), makeResults());
    const evenBody = sendPushCalls[0].opts.body;
    sendPushCalls.length = 0;
    await runMorningReadiness(supabase, warsawNowAt({ hour: 7, day: 15 }), makeResults());
    const oddBody = sendPushCalls[0].opts.body;
    assert.notStrictEqual(evenBody, oddBody);
  });

  console.log('\n4. runPostTraining (Rytm 2)');

  await scenario('poza oknem (19:00) -> brak push', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', event_type: 'club_training', status: 'scheduled', scheduled_date: '2026-08-15' }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runPostTraining(supabase, warsawNowAt({ hour: 10, dateStr: '2026-08-15' }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('w oknie, trening dziś, NIE zalogowany -> push wysłany', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', event_type: 'club_training', status: 'scheduled', scheduled_date: '2026-08-15' }],
      daily_logs: [],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runPostTraining(supabase, warsawNowAt({ hour: 19, dateStr: '2026-08-15' }), results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.strictEqual(results.post_training, 1);
  });

  await scenario('już zalogowany (daily_logs.calendar_event_id wskazuje na to wydarzenie) -> pominięty', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev1', user_id: 'u1', event_type: 'club_training', status: 'scheduled', scheduled_date: '2026-08-15' }],
      daily_logs: [{ calendar_event_id: 'ev1' }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runPostTraining(supabase, warsawNowAt({ hour: 19, dateStr: '2026-08-15' }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('event_type="task" -> ignorowany (nie trening)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev2', user_id: 'u1', event_type: 'task', status: 'scheduled', scheduled_date: '2026-08-15' }],
      daily_logs: [], push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runPostTraining(supabase, warsawNowAt({ hour: 19, dateStr: '2026-08-15' }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('event_type="match" -> ignorowany (osobny rytm pre_match)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev3', user_id: 'u1', event_type: 'match', status: 'scheduled', scheduled_date: '2026-08-15' }],
      daily_logs: [], push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runPostTraining(supabase, warsawNowAt({ hour: 19, dateStr: '2026-08-15' }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('preferencja wyłączona -> pominięty', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'ev4', user_id: 'u1', event_type: 'own_training', status: 'scheduled', scheduled_date: '2026-08-15' }],
      daily_logs: [],
      notification_preferences: [{ user_id: 'u1', notification_type: 'post_training', enabled: false }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runPostTraining(supabase, warsawNowAt({ hour: 19, dateStr: '2026-08-15' }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  console.log('\n5. runPreMatch (Rytm 3, dwa niezależne wysłania)');

  await scenario('okno wieczorne -> wysyła dla JUTRZEJSZEGO meczu', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'm1', user_id: 'u1', event_type: 'match', status: 'scheduled', scheduled_date: '2026-08-16' }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runPreMatch(supabase, warsawNowAt({ hour: 19, dateStr: '2026-08-15' }), results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.strictEqual(results.pre_match, 1);
  });

  await scenario('okno poranne -> wysyła dla DZISIEJSZEGO meczu (drugie, niezależne wysłanie)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'm2', user_id: 'u1', event_type: 'match', status: 'scheduled', scheduled_date: '2026-08-15' }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runPreMatch(supabase, warsawNowAt({ hour: 7, dateStr: '2026-08-15' }), results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.strictEqual(results.pre_match, 1);
  });

  await scenario('poza oboma oknami -> brak push', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [
        { id: 'm3', user_id: 'u1', event_type: 'match', status: 'scheduled', scheduled_date: '2026-08-16' },
        { id: 'm4', user_id: 'u1', event_type: 'match', status: 'scheduled', scheduled_date: '2026-08-15' },
      ],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runPreMatch(supabase, warsawNowAt({ hour: 12, dateStr: '2026-08-15' }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('wielu zawodników z meczem jutro w tym samym oknie -> push do KAŻDEGO z osobna', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [
        { id: 'm6', user_id: 'u1', event_type: 'match', status: 'scheduled', scheduled_date: '2026-08-16' },
        { id: 'm7', user_id: 'u2', event_type: 'match', status: 'scheduled', scheduled_date: '2026-08-16' },
      ],
      push_tokens: [{ user_id: 'u1', token: 't1' }, { user_id: 'u2', token: 't2' }],
    });
    const results = makeResults();
    await runPreMatch(supabase, warsawNowAt({ hour: 19, dateStr: '2026-08-15' }), results);
    assert.strictEqual(sendPushCalls.length, 2);
    assert.strictEqual(results.pre_match, 2);
  });

  await scenario('preferencja wyłączona -> brak push mimo trafionego okna', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      calendar_events: [{ id: 'm5', user_id: 'u1', event_type: 'match', status: 'scheduled', scheduled_date: '2026-08-16' }],
      notification_preferences: [{ user_id: 'u1', notification_type: 'pre_match', enabled: false }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runPreMatch(supabase, warsawNowAt({ hour: 19, dateStr: '2026-08-15' }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  console.log('\n6. runWeeklySummary (Rytm 4)');

  await scenario('zły dzień tygodnia (nie niedziela) -> brak push', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      users: [{ id: 'u1' }],
      goals: [{ user_id: 'u1', segment_id: 'moc', status: 'active', is_priority: true, created_at: '2026-08-01' }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runWeeklySummary(supabase, warsawNowAt({ hour: 18, weekday: 3 }), makeResults()); // środa
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('niedziela, w oknie, BRAK aktywnego celu -> pominięty (podsumowanie byłoby puste)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({ users: [{ id: 'u1' }], goals: [], push_tokens: [{ user_id: 'u1', token: 't1' }] });
    await runWeeklySummary(supabase, warsawNowAt({ hour: 18, weekday: 0 }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('niedziela, aktywny cel priorytetowy istnieje -> push z nazwą segmentu w treści', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      users: [{ id: 'u1' }],
      goals: [
        { user_id: 'u1', segment_id: 'wytrzymalosc', status: 'active', is_priority: false, created_at: '2026-08-10' },
        { user_id: 'u1', segment_id: 'moc', status: 'active', is_priority: true, created_at: '2026-08-01' },
      ],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runWeeklySummary(supabase, warsawNowAt({ hour: 18, weekday: 0 }), results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.match(sendPushCalls[0].opts.body, /Moc/, 'cel PRIORYTETOWY (moc) musi wygrać mimo starszej daty utworzenia');
    assert.strictEqual(results.weekly_summary, 1);
  });

  await scenario('brak celu priorytetowego, dwa zwykłe cele -> wybiera NAJNOWSZY', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      users: [{ id: 'u1' }],
      goals: [
        { user_id: 'u1', segment_id: 'wytrzymalosc', status: 'active', is_priority: false, created_at: '2026-08-01' },
        { user_id: 'u1', segment_id: 'regeneracja', status: 'active', is_priority: false, created_at: '2026-08-10' },
      ],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runWeeklySummary(supabase, warsawNowAt({ hour: 18, weekday: 0 }), makeResults());
    assert.match(sendPushCalls[0].opts.body, /Regeneracja/);
  });

  console.log('\n7. runContextualInsight (Rytm 5, bez okna godzinowego, dedup w bazie)');

  await scenario('happy path -> push z pierwszymi ~60 znakami treści rekomendacji, notified_at ustawiony', async () => {
    sendPushCalls.length = 0;
    const longText = 'x'.repeat(80);
    const supabase = makeFakeSupabase({
      decision_recommendations: [{ id: 'r1', user_id: 'u1', recommendation_text: longText, notified_at: null, created_at: daysAgoIso(0) }],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runContextualInsight(supabase, results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.ok(sendPushCalls[0].opts.body.startsWith('x'.repeat(60) + '…'), 'tekst dłuższy niż 60 znaków musi być obcięty z wielokropkiem');
    assert.strictEqual(supabase._state.decision_recommendations[0].notified_at !== null, true);
    assert.strictEqual(results.contextual_insight, 1);
  });

  await scenario('tekst DOKŁADNIE 60 znaków -> BEZ wielokropka', async () => {
    sendPushCalls.length = 0;
    const text60 = 'y'.repeat(60);
    const supabase = makeFakeSupabase({
      decision_recommendations: [{ id: 'r2', user_id: 'u2', recommendation_text: text60, notified_at: null, created_at: daysAgoIso(0) }],
      push_tokens: [{ user_id: 'u2', token: 't2' }],
    });
    await runContextualInsight(supabase, makeResults());
    assert.strictEqual(sendPushCalls[0].opts.body, `${text60} — sprawdź rekomendację`);
  });

  await scenario('użytkownik powiadomiony w ciągu ostatnich 3 dni -> pominięty (limit częstotliwości)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { id: 'r-stara', user_id: 'u3', recommendation_text: 'stara', notified_at: daysAgoIso(1) },
        { id: 'r-nowa', user_id: 'u3', recommendation_text: 'nowa', notified_at: null, created_at: daysAgoIso(0) },
      ],
      push_tokens: [{ user_id: 'u3', token: 't3' }],
    });
    await runContextualInsight(supabase, makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('powiadomienie sprzed 4 dni (poza progiem 3) -> NIE blokuje nowego', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { id: 'r-stara2', user_id: 'u4', recommendation_text: 'stara', notified_at: daysAgoIso(4) },
        { id: 'r-nowa2', user_id: 'u4', recommendation_text: 'nowa', notified_at: null, created_at: daysAgoIso(0) },
      ],
      push_tokens: [{ user_id: 'u4', token: 't4' }],
    });
    await runContextualInsight(supabase, makeResults());
    assert.strictEqual(sendPushCalls.length, 1);
  });

  await scenario('DWIE niepowiadomione rekomendacje TEGO SAMEGO usera w jednym przebiegu -> tylko PIERWSZA wysłana (lokalny licznik przebiegu)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { id: 'r-a', user_id: 'u5', recommendation_text: 'pierwsza', notified_at: null, created_at: daysAgoIso(2) },
        { id: 'r-b', user_id: 'u5', recommendation_text: 'druga', notified_at: null, created_at: daysAgoIso(1) },
      ],
      push_tokens: [{ user_id: 'u5', token: 't5' }],
    });
    const results = makeResults();
    await runContextualInsight(supabase, results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.strictEqual(results.contextual_insight, 1);
  });

  await scenario('brak tokenów -> pominięty, notified_at NIE ustawiony (spróbuje ponownie następnym razem)', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      decision_recommendations: [{ id: 'r6', user_id: 'u6', recommendation_text: 'coś', notified_at: null, created_at: daysAgoIso(0) }],
      push_tokens: [],
    });
    await runContextualInsight(supabase, makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
    assert.strictEqual(supabase._state.decision_recommendations[0].notified_at, null);
  });

  await scenario('preferencja wyłączona -> pominięty', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      decision_recommendations: [{ id: 'r7', user_id: 'u7', recommendation_text: 'coś', notified_at: null, created_at: daysAgoIso(0) }],
      notification_preferences: [{ user_id: 'u7', notification_type: 'contextual_insight', enabled: false }],
      push_tokens: [{ user_id: 'u7', token: 't7' }],
    });
    await runContextualInsight(supabase, makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  console.log('\n8. runFocusBlockCheckins (Rytm 6)');

  await scenario('poza oknem godzinowym (10:00) -> brak akcji', async () => {
    generateCheckinCalls.length = 0;
    const supabase = makeFakeSupabase({ focus_blocks: [{ id: 'fb1', user_id: 'u1', started_at: daysAgoIso(20), status: 'active' }] });
    await runFocusBlockCheckins(supabase, warsawNowAt({ hour: 14 }), makeResults());
    assert.strictEqual(generateCheckinCalls.length, 0);
  });

  await scenario('w oknie, interwał 14 dni NIE minął od started_at -> pominięty', async () => {
    generateCheckinCalls.length = 0;
    const supabase = makeFakeSupabase({ focus_blocks: [{ id: 'fb2', user_id: 'u1', started_at: daysAgoIso(5), status: 'active' }] });
    await runFocusBlockCheckins(supabase, warsawNowAt({ hour: 10 }), makeResults());
    assert.strictEqual(generateCheckinCalls.length, 0);
  });

  await scenario('interwał minął od started_at (brak wcześniejszego checkinu) -> generuje, zapisuje, wysyła push', async () => {
    generateCheckinCalls.length = 0; sendPushCalls.length = 0;
    generateCheckinImpl = async () => ({ ok: true, question: 'Jak się czujesz po 14 dniach?', contentDose: false });
    const supabase = makeFakeSupabase({
      focus_blocks: [{ id: 'fb3', user_id: 'u1', started_at: daysAgoIso(20), status: 'active' }],
      focus_block_checkins: [],
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runFocusBlockCheckins(supabase, warsawNowAt({ hour: 10 }), results);
    assert.strictEqual(generateCheckinCalls.length, 1);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.strictEqual(sendPushCalls[0].opts.body, 'Jak się czujesz po 14 dniach?');
    assert.strictEqual(results.focus_block_checkins, 1);
    assert.strictEqual(supabase._state.focus_block_checkins.length, 1);
    assert.strictEqual(supabase._state.focus_block_checkins[0].checkin_type, 'progress');
  });

  await scenario('interwał liczony od OSTATNIEGO checkinu, nie od started_at, gdy checkin już istniał', async () => {
    generateCheckinCalls.length = 0; sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      focus_blocks: [{ id: 'fb4', user_id: 'u1', started_at: daysAgoIso(100), status: 'active' }],
      focus_block_checkins: [{ focus_block_id: 'fb4', checkin_type: 'progress', asked_at: daysAgoIso(3) }], // niedawno, mimo że blok stary
      push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runFocusBlockCheckins(supabase, warsawNowAt({ hour: 10 }), makeResults());
    assert.strictEqual(generateCheckinCalls.length, 0, 'ostatni checkin był 3 dni temu, za wcześnie na kolejny (próg 14 dni)');
  });

  await scenario('generateCheckin zwraca ok:false -> pominięty, brak insertu/push', async () => {
    generateCheckinCalls.length = 0; sendPushCalls.length = 0;
    generateCheckinImpl = async () => ({ ok: false });
    const supabase = makeFakeSupabase({
      focus_blocks: [{ id: 'fb5', user_id: 'u1', started_at: daysAgoIso(20), status: 'active' }],
      focus_block_checkins: [], push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runFocusBlockCheckins(supabase, warsawNowAt({ hour: 10 }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
    assert.strictEqual(supabase._state.focus_block_checkins.length, 0);
    generateCheckinImpl = async () => ({ ok: true, question: 'Jak idzie?', contentDose: false });
  });

  await scenario('generateCheckin zwraca contentDose -> aktualizuje last_content_dose_stage/at na focus_blocks', async () => {
    generateCheckinCalls.length = 0; sendPushCalls.length = 0;
    generateCheckinImpl = async () => ({ ok: true, question: 'Pytanie z dawką treści', contentDose: true, stageAtDose: 2 });
    const supabase = makeFakeSupabase({
      focus_blocks: [{ id: 'fb6', user_id: 'u1', started_at: daysAgoIso(20), status: 'active' }],
      focus_block_checkins: [], push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    await runFocusBlockCheckins(supabase, warsawNowAt({ hour: 10 }), makeResults());
    assert.strictEqual(supabase._state.focus_blocks[0].last_content_dose_stage, 2);
    assert.ok(supabase._state.focus_blocks[0].last_content_dose_at);
    generateCheckinImpl = async () => ({ ok: true, question: 'Jak idzie?', contentDose: false });
  });

  await scenario('błąd dla JEDNEGO bloku (generateCheckin rzuca) NIE przerywa pozostałych', async () => {
    generateCheckinCalls.length = 0; sendPushCalls.length = 0;
    let call = 0;
    generateCheckinImpl = async () => {
      call++;
      if (call === 1) throw new Error('Anthropic padło');
      return { ok: true, question: 'Drugi blok OK', contentDose: false };
    };
    const supabase = makeFakeSupabase({
      focus_blocks: [
        { id: 'fb7', user_id: 'u1', started_at: daysAgoIso(20), status: 'active' },
        { id: 'fb8', user_id: 'u2', started_at: daysAgoIso(20), status: 'active' },
      ],
      focus_block_checkins: [],
      push_tokens: [{ user_id: 'u1', token: 't1' }, { user_id: 'u2', token: 't2' }],
    });
    const results = makeResults();
    await runFocusBlockCheckins(supabase, warsawNowAt({ hour: 10 }), results);
    assert.strictEqual(results.focus_block_checkins, 1, 'drugi blok mimo błędu pierwszego nadal przetworzony');
    generateCheckinImpl = async () => ({ ok: true, question: 'Jak idzie?', contentDose: false });
  });

  console.log('\n9. runFocusBlockMaintenance (Rytm 7)');

  await scenario('blok bez closed_at (nie powinien się zdarzyć dla status=completed, ale obronnie) -> pominięty', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({ focus_blocks: [{ id: 'fbm1', user_id: 'u1', status: 'completed', closed_at: null, segment_id: 'moc' }] });
    await runFocusBlockMaintenance(supabase, warsawNowAt({ hour: 10 }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('interwał 45 dni NIE minął od closed_at -> pominięty', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({ focus_blocks: [{ id: 'fbm2', user_id: 'u1', status: 'completed', closed_at: daysAgoIso(10), segment_id: 'moc' }] });
    await runFocusBlockMaintenance(supabase, warsawNowAt({ hour: 10 }), makeResults());
    assert.strictEqual(sendPushCalls.length, 0);
  });

  await scenario('interwał minął -> pytanie stałe (bez AI), zawiera nazwę segmentu, push wysłany', async () => {
    sendPushCalls.length = 0;
    const supabase = makeFakeSupabase({
      focus_blocks: [{ id: 'fbm3', user_id: 'u1', status: 'completed', closed_at: daysAgoIso(50), segment_id: 'techFund' }],
      focus_block_checkins: [], push_tokens: [{ user_id: 'u1', token: 't1' }],
    });
    const results = makeResults();
    await runFocusBlockMaintenance(supabase, warsawNowAt({ hour: 10 }), results);
    assert.strictEqual(sendPushCalls.length, 1);
    assert.match(sendPushCalls[0].opts.body, /Technika fundamentalna/);
    assert.strictEqual(results.focus_block_maintenance, 1);
    assert.strictEqual(supabase._state.focus_block_checkins[0].checkin_type, 'maintenance');
  });

  console.log('\n10. runTrialExpiry (Rytm 8, wygasanie triala)');

  await scenario('poza oknem godzinowym (4:00) -> brak zmian, results.trial_expiry pozostaje 0', async () => {
    const supabase = makeFakeSupabase({ subscriptions: [{ id: 's1', status: 'trialing', current_period_end: daysAgoIso(1) }] });
    const results = makeResults();
    await runTrialExpiry(supabase, warsawNowAt({ hour: 12 }), results);
    assert.strictEqual(results.trial_expiry, 0);
    assert.strictEqual(supabase._state.subscriptions[0].status, 'trialing', 'poza oknem nic nie powinno się zmienić');
  });

  await scenario('w oknie, trial z minionym current_period_end -> status="expired", policzony', async () => {
    const supabase = makeFakeSupabase({
      subscriptions: [
        { id: 's2', status: 'trialing', current_period_end: daysAgoIso(1) },
        { id: 's3', status: 'trialing', current_period_end: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() }, // wciąż aktywny trial
        { id: 's4', status: 'active', current_period_end: daysAgoIso(1) }, // nie trial, nietknięty
      ],
    });
    const results = makeResults();
    await runTrialExpiry(supabase, warsawNowAt({ hour: 4 }), results);
    assert.strictEqual(results.trial_expiry, 1);
    assert.strictEqual(supabase._state.subscriptions[0].status, 'expired');
    assert.strictEqual(supabase._state.subscriptions[1].status, 'trialing', 'trial jeszcze nie wygasł, nie powinien być tknięty');
    assert.strictEqual(supabase._state.subscriptions[2].status, 'active', 'status inny niż trialing nigdy nie dotknięty przez ten rytm');
  });

  console.log('\n11. runParentalConsentExpiry (Rytm 9 — realne pieniądze, anulowanie + zwrot)');

  await scenario('pending z minionym expires_at -> oznaczony expired, subskrypcja wygaszona, Stripe anulowany', async () => {
    stripeRequestCalls.length = 0;
    stripeRequestImpl = async (p) => {
      if (p.startsWith('subscriptions/')) return {};
      if (p === 'charges') return { data: [] }; // brak opłat do zwrotu w tym scenariuszu
      return {};
    };
    const supabase = makeFakeSupabase({
      payment_parental_consents: [{ id: 'c1', user_id: 'u1', stripe_subscription_id: 'sub_1', status: 'pending', expires_at: daysAgoIso(1), stripe_action_completed_at: null }],
      subscriptions: [{ id: 's1', subscriber_user_id: 'u1', status: 'active', stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1' }],
    });
    const results = makeResults();
    await runParentalConsentExpiry(supabase, results);
    assert.strictEqual(supabase._state.payment_parental_consents[0].status, 'expired');
    assert.strictEqual(supabase._state.subscriptions[0].status, 'expired');
    assert.ok(stripeRequestCalls.some((c) => c.path === 'subscriptions/sub_1' && c.method === 'DELETE'));
    assert.ok(supabase._state.payment_parental_consents[0].stripe_action_completed_at);
    assert.strictEqual(results.parental_consent_expiry, 1);
  });

  await scenario('declined -> Stripe sprzątanie wykonane, status NIE zmieniany na "expired" ponownie (RPC SQL już to zrobił)', async () => {
    stripeRequestCalls.length = 0;
    stripeRequestImpl = async (p) => (p === 'charges' ? { data: [] } : {});
    const supabase = makeFakeSupabase({
      payment_parental_consents: [{ id: 'c2', user_id: 'u2', stripe_subscription_id: 'sub_2', status: 'declined', stripe_action_completed_at: null }],
      subscriptions: [{ id: 's2', subscriber_user_id: 'u2', status: 'expired', stripe_subscription_id: 'sub_2', stripe_customer_id: 'cus_2' }],
    });
    await runParentalConsentExpiry(supabase, makeResults());
    assert.strictEqual(supabase._state.payment_parental_consents[0].status, 'declined', 'status ustawiony już wcześniej przez RPC SQL, ten rytm go nie rusza dla declined');
    assert.ok(supabase._state.payment_parental_consents[0].stripe_action_completed_at);
  });

  await scenario('znaleziona nierefundowana opłata -> zwrot wykonany, refund_note to potwierdza', async () => {
    stripeRequestCalls.length = 0;
    stripeRequestImpl = async (p) => {
      if (p.startsWith('subscriptions/')) return {};
      if (p === 'charges') return { data: [{ id: 'ch_123', refunded: false }] };
      if (p === 'refunds') return { id: 're_123' };
      return {};
    };
    const supabase = makeFakeSupabase({
      payment_parental_consents: [{ id: 'c3', user_id: 'u3', stripe_subscription_id: 'sub_3', status: 'pending', expires_at: daysAgoIso(1), stripe_action_completed_at: null }],
      subscriptions: [{ id: 's3', subscriber_user_id: 'u3', status: 'active', stripe_subscription_id: 'sub_3', stripe_customer_id: 'cus_3' }],
    });
    await runParentalConsentExpiry(supabase, makeResults());
    assert.ok(stripeRequestCalls.some((c) => c.path === 'refunds' && c.fields.charge === 'ch_123'));
    assert.match(supabase._state.payment_parental_consents[0].refund_note, /Zwrot wykonany automatycznie dla charge ch_123/);
  });

  await scenario('opłata JUŻ zwrócona wcześniej -> NIE próbuje zwrócić ponownie, refund_note to odnotowuje', async () => {
    stripeRequestCalls.length = 0;
    stripeRequestImpl = async (p) => {
      if (p === 'charges') return { data: [{ id: 'ch_already', refunded: true }] };
      return {};
    };
    const supabase = makeFakeSupabase({
      payment_parental_consents: [{ id: 'c4', user_id: 'u4', stripe_subscription_id: 'sub_4', status: 'pending', expires_at: daysAgoIso(1), stripe_action_completed_at: null }],
      subscriptions: [{ id: 's4', subscriber_user_id: 'u4', status: 'active', stripe_subscription_id: 'sub_4', stripe_customer_id: 'cus_4' }],
    });
    await runParentalConsentExpiry(supabase, makeResults());
    assert.strictEqual(stripeRequestCalls.some((c) => c.path === 'refunds'), false);
    assert.match(supabase._state.payment_parental_consents[0].refund_note, /już wcześniej zwrócona/);
  });

  await scenario('brak stripe_customer_id na subskrypcji -> zwrot NIE próbowany, refund_note ostrzega o ręcznym sprawdzeniu', async () => {
    stripeRequestCalls.length = 0;
    stripeRequestImpl = async () => ({});
    const supabase = makeFakeSupabase({
      payment_parental_consents: [{ id: 'c5', user_id: 'u5', stripe_subscription_id: 'sub_5', status: 'pending', expires_at: daysAgoIso(1), stripe_action_completed_at: null }],
      subscriptions: [{ id: 's5', subscriber_user_id: 'u5', status: 'active', stripe_subscription_id: 'sub_5', stripe_customer_id: null }],
    });
    await runParentalConsentExpiry(supabase, makeResults());
    assert.strictEqual(stripeRequestCalls.some((c) => c.path === 'charges'), false);
    assert.match(supabase._state.payment_parental_consents[0].refund_note, /sprawdź ręcznie w Stripe Dashboard/);
  });

  await scenario('brak stripe_subscription_id na wierszu -> BRAK jakiegokolwiek wywołania Stripe, jasny refund_note', async () => {
    stripeRequestCalls.length = 0;
    const supabase = makeFakeSupabase({
      payment_parental_consents: [{ id: 'c6', user_id: 'u6', stripe_subscription_id: null, status: 'pending', expires_at: daysAgoIso(1), stripe_action_completed_at: null }],
      subscriptions: [],
    });
    await runParentalConsentExpiry(supabase, makeResults());
    assert.strictEqual(stripeRequestCalls.length, 0);
    assert.match(supabase._state.payment_parental_consents[0].refund_note, /nic nie było do anulowania/);
  });

  await scenario('anulowanie subskrypcji w Stripe RZUCA -> mimo to PRÓBUJE zwrotu, refund_note odnotowuje obie części (nigdy nie przerywa w połowie)', async () => {
    stripeRequestCalls.length = 0;
    stripeRequestImpl = async (p) => {
      if (p.startsWith('subscriptions/')) throw new Error('Stripe API: subskrypcja już nie istnieje');
      if (p === 'charges') return { data: [{ id: 'ch_mimo_to', refunded: false }] };
      if (p === 'refunds') return { id: 're_mimo_to' };
      return {};
    };
    const supabase = makeFakeSupabase({
      payment_parental_consents: [{ id: 'c7', user_id: 'u7', stripe_subscription_id: 'sub_7', status: 'pending', expires_at: daysAgoIso(1), stripe_action_completed_at: null }],
      subscriptions: [{ id: 's7', subscriber_user_id: 'u7', status: 'active', stripe_subscription_id: 'sub_7', stripe_customer_id: 'cus_7' }],
    });
    await runParentalConsentExpiry(supabase, makeResults());
    const note = supabase._state.payment_parental_consents[0].refund_note;
    assert.match(note, /Anulowanie subskrypcji nieudane/);
    assert.match(note, /Zwrot wykonany automatycznie/, 'mimo nieudanego anulowania, zwrot MUSI być mimo to spróbowany');
  });

  await scenario('błąd dla JEDNEGO wiersza NIE przerywa przetwarzania pozostałych', async () => {
    stripeRequestCalls.length = 0;
    let call = 0;
    stripeRequestImpl = async (p) => {
      if (p.startsWith('subscriptions/')) {
        call++;
        if (call === 1) throw new Error('błąd tylko dla pierwszego');
      }
      if (p === 'charges') throw new Error('też błąd — cały pierwszy wiersz ma się nie udać na poziomie update');
      return {};
    };
    // Dla czytelności: pierwszy wiersz ma stripe_subscription_id (próbuje Stripe, częściowo się nie
    // udaje, ale i tak dochodzi do UPDATE poniżej — sprawdzamy TYLKO że drugi wiersz jest przetworzony
    // niezależnie od tego, co się stało z pierwszym).
    const supabase = makeFakeSupabase({
      payment_parental_consents: [
        { id: 'c8', user_id: 'u8', stripe_subscription_id: 'sub_8', status: 'pending', expires_at: daysAgoIso(1), stripe_action_completed_at: null },
        { id: 'c9', user_id: 'u9', stripe_subscription_id: null, status: 'pending', expires_at: daysAgoIso(1), stripe_action_completed_at: null },
      ],
      subscriptions: [{ id: 's8', subscriber_user_id: 'u8', status: 'active', stripe_subscription_id: 'sub_8', stripe_customer_id: 'cus_8' }],
    });
    const results = makeResults();
    await runParentalConsentExpiry(supabase, results);
    assert.ok(supabase._state.payment_parental_consents[1].stripe_action_completed_at, 'drugi wiersz (bez subskrypcji Stripe) musi zostać przetworzony niezależnie');
    assert.strictEqual(results.parental_consent_expiry, 2, 'oba wiersze kończą się aktualizacją stripe_action_completed_at, więc oba liczą się jako przetworzone');
  });

  console.log('\n12. handler (moduł.exports) — autoryzacja i przekazanie firebaseConfigOk');

  await scenario('zły CRON_SECRET -> 401', async () => {
    const req = { headers: { authorization: 'Bearer zly' } };
    let statusCode, jsonBody;
    const res = { status(c) { statusCode = c; return res; }, json(o) { jsonBody = o; return res; } };
    currentFakeSupabase = makeFakeSupabase({});
    await handler(req, res);
    assert.strictEqual(statusCode, 401);
  });

  await scenario('poprawny sekret, wszystkie tabele puste -> 200, wszystkie liczniki 0, firebaseConfigOk propagowany', async () => {
    verifyFirebaseConfigImpl = () => true;
    runFocusBlockAdaptationCalls.length = 0;
    const req = { headers: { authorization: 'Bearer test-cron-secret' } };
    let statusCode, jsonBody;
    const res = { status(c) { statusCode = c; return res; }, json(o) { jsonBody = o; return res; } };
    currentFakeSupabase = makeFakeSupabase({}); // wszystkie tabele puste — deterministyczne niezależnie od realnej godziny
    await handler(req, res);
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(jsonBody.ok, true);
    assert.strictEqual(jsonBody.firebaseConfigOk, true);
    assert.strictEqual(jsonBody.results.morning_readiness, 0);
    assert.strictEqual(runFocusBlockAdaptationCalls.length, 1, 'runFocusBlockAdaptation musi być wołany na każdym przebiegu');
  });

  await scenario('Firebase selftest nieudany -> firebaseConfigOk=false, firebaseConfigError ustawiony, ale reszta crona i tak biegnie (200)', async () => {
    verifyFirebaseConfigImpl = () => { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON nie skonfigurowany'); };
    const req = { headers: { authorization: 'Bearer test-cron-secret' } };
    let statusCode, jsonBody;
    const res = { status(c) { statusCode = c; return res; }, json(o) { jsonBody = o; return res; } };
    currentFakeSupabase = makeFakeSupabase({});
    await handler(req, res);
    assert.strictEqual(statusCode, 200, 'brak konfiguracji Firebase nie powinien zatrzymać reszty crona (np. runTrialExpiry)');
    assert.strictEqual(jsonBody.firebaseConfigOk, false);
    assert.match(jsonBody.firebaseConfigError, /FIREBASE_SERVICE_ACCOUNT_JSON/);
    verifyFirebaseConfigImpl = () => true;
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
