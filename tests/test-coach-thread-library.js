// ============================================================
// test-coach-thread-library.js — testy jednostkowe lib/coach-thread-library.js
// ============================================================
// Uruchom: node tests/test-coach-thread-library.js
//
// Zakres, zgodny z ustaloną konwencją tego projektu: warstwa CZYSTA
// (evaluateThreadN) testowana bezpośrednio, bez atrapy Supabase — jeden
// scenariusz "sygnały obecne" + jeden "sygnały nieobecne" na KAŻDY z 8
// wątków (żeby uniknąć fałszywych trafień), plus dodatkowe scenariusze
// graniczne tam, gdzie warto. Warstwa I/O (fetchPlayerThreadContext,
// detectPlayerThreadSignals, detectTeamThreadSignals) testowana osobno,
// z atrapą Supabase w pamięci (generyczny query-builder filtrujący tablice
// wg eq/gte/lt/in/not/order/limit — ten sam duch co atrapy w innych
// plikach testowych tego folderu, tylko bardziej ogólny, bo ten plik
// odpytuje więcej różnych tabel niż typowy plik w tym projekcie).
//
// callAnthropic/getAdminClient nie dotyczą tego pliku (ten moduł nie robi
// żadnego wywołania AI — wyłącznie deterministyczna detekcja sygnałów).
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// generate-recommendation.js (od którego zależy ten moduł, po
// computeReadinessSignals/fetchReadinessWindowLogs/computeRelativeDeficits)
// wymaga @supabase/supabase-js na górze pliku — ten sam, znany limit tej
// chmurowej piaskownicy (pakiet niezainstalowany w node_modules), ten sam
// wzorzec atrapy co we WSZYSTKICH innych plikach testowych tego folderu.
const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_threadlib__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath,
  filename: supabaseStubPath,
  loaded: true,
  exports: { createClient: () => ({}) },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

const { detectPlayerThreadSignals, detectTeamThreadSignals } = require('../lib/coach-thread-library.js');
const {
  OWN_TRAINING_FREQUENT_MIN_COUNT,
  REJECTION_STREAK_MIN,
  REGULAR_PRIOR_MIN_COUNT,
  SUDDEN_DROP_RECENT_MAX_COUNT,
  REPEAT_PAIN_MIN_COUNT,
  OWN_TRAINING_NOT_REDUCED_MIN_COUNT,
  HIGH_MOOD_THRESHOLD,
  LOW_COMPLETION_MAX_RATE,
  LOW_COMPLETION_MIN_EVENTS,
  GOAL_STALE_MIN_DIAGNOSIS_AGE_DAYS,
  LOW_NUTRITION_SCORE_THRESHOLD,
  TEAM_AGGREGATE_MIN_SIZE,
  POSITION_KEY_SEGMENTS,
  parseScores,
  isReadinessFatigueActive,
  evaluateThread1,
  evaluateThread2,
  evaluateThread3,
  evaluateThread4,
  evaluateThread5,
  evaluateThread6,
  evaluateThread7,
  evaluateThread8,
  fetchPlayerThreadContext,
  countSessionsByType,
  computeCalendarCompletionRate,
} = require('../lib/coach-thread-library.js')._internal;

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

// ------------------------------------------------------------
// Pomocnicze budowniczowie kontekstu (ctx) dla warstwy czystej —
// każdy zaczyna od "neutralnego" ctx (żadne wątki nie powinny się
// odpalić), testy nadpisują tylko pola istotne dla danego wątku.
// ------------------------------------------------------------
const NOW = new Date('2026-08-04T12:00:00Z');

function baseCtx(overrides) {
  return Object.assign({
    ownTrainingCountRecent14d: 0,
    ownTrainingCountPrior28d: 0,
    clubTrainingCountRecent14d: 2,
    clubTrainingCountPrior28d: 4,
    readinessSignals: { sleepFlag: { active: false }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: null, monotony: null, moodFlag: { active: false } },
    rejectionStreak: 0,
    repeatedPain: null,
    hasRecentExcludingPain: false,
    moodAvg14d: { active: false, avg: 5, n: 3 },
    calendarCompletion14d: { active: false, total: 4, completed: 3, rate: 0.75 },
    positionPrimary: null,
    diagnosisScores: null,
    diagnosisCreatedAt: null,
    activeGoalSegments: new Set(),
    now: NOW,
  }, overrides || {});
}

// ------------------------------------------------------------
// Fałszywy Supabase w pamięci — generyczny query-builder. Filtruje
// tablicę wierszy w pamięci wg wszystkich zarejestrowanych warunków
// (eq/gte/lt/gt/in/not), respektuje order/limit/maybeSingle/single,
// i dla select({count,head:true}) zwraca {count} zamiast {data}.
// ------------------------------------------------------------
function makeFakeSupabase(tables) {
  return {
    from(table) {
      const rows = tables[table] || [];
      let filtered = rows.slice();
      let countMode = false;
      let singleMode = false;
      let limitN = null;
      let orderCol = null;
      let orderAsc = true;
      const builder = {
        select(cols, opts) {
          if (opts && opts.count) countMode = true;
          return builder;
        },
        eq(col, val) { filtered = filtered.filter((r) => r[col] === val); return builder; },
        gte(col, val) { filtered = filtered.filter((r) => r[col] >= val); return builder; },
        lt(col, val) { filtered = filtered.filter((r) => r[col] < val); return builder; },
        gt(col, val) { filtered = filtered.filter((r) => r[col] > val); return builder; },
        lte(col, val) { filtered = filtered.filter((r) => r[col] <= val); return builder; },
        in(col, vals) { filtered = filtered.filter((r) => vals.includes(r[col])); return builder; },
        not(col, op, val) {
          if (op === 'is' && val === null) filtered = filtered.filter((r) => r[col] !== null && r[col] !== undefined);
          return builder;
        },
        order(col, opts) { orderCol = col; orderAsc = !opts || opts.ascending !== false; return builder; },
        limit(n) { limitN = n; return builder; },
        maybeSingle() { singleMode = true; return builder; },
        single() { singleMode = true; return builder; },
        then(resolve, reject) {
          try {
            let result = filtered.slice();
            if (orderCol) {
              result.sort((a, b) => {
                if (a[orderCol] === b[orderCol]) return 0;
                const dir = orderAsc ? 1 : -1;
                return a[orderCol] < b[orderCol] ? -1 * dir : 1 * dir;
              });
            }
            if (limitN != null) result = result.slice(0, limitN);
            if (countMode) resolve({ data: null, count: filtered.length, error: null });
            else if (singleMode) resolve({ data: result[0] || null, error: null });
            else resolve({ data: result, error: null });
          } catch (e) { reject(e); }
        },
      };
      return builder;
    },
  };
}

(async () => {
  console.log('coach-thread-library.js — testy jednostkowe');

  // ============================================================
  console.log('\n1. Wątek 1 — częsty trening własny + podwyższone zmęczenie (silnik gotowości)');

  await scenario('sygnały OBECNE: >=4 sesji własnych/14d + zmęczenie aktywne -> active=true', () => {
    const ctx = baseCtx({
      ownTrainingCountRecent14d: OWN_TRAINING_FREQUENT_MIN_COUNT,
      readinessSignals: { sleepFlag: { active: true }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: null },
    });
    const r = evaluateThread1(ctx);
    assert.strictEqual(r.active, true);
  });

  await scenario('sygnały NIEOBECNE: częsty trening własny, ale BEZ zmęczenia -> active=false', () => {
    const ctx = baseCtx({
      ownTrainingCountRecent14d: OWN_TRAINING_FREQUENT_MIN_COUNT + 3,
      readinessSignals: { sleepFlag: { active: false }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: null },
    });
    assert.strictEqual(evaluateThread1(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: zmęczenie aktywne, ale trening własny RZADKI -> active=false', () => {
    const ctx = baseCtx({
      ownTrainingCountRecent14d: OWN_TRAINING_FREQUENT_MIN_COUNT - 1,
      readinessSignals: { sleepFlag: { active: true }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: null },
    });
    assert.strictEqual(evaluateThread1(ctx).active, false);
  });

  // ============================================================
  console.log('\n2. Wątek 2 — częsty trening własny + seria odrzuceń sugestii systemu (F23)');

  await scenario('sygnały OBECNE: częsty trening własny + streak odrzuceń >= progu -> active=true', () => {
    const ctx = baseCtx({ ownTrainingCountRecent14d: OWN_TRAINING_FREQUENT_MIN_COUNT, rejectionStreak: REJECTION_STREAK_MIN });
    assert.strictEqual(evaluateThread2(ctx).active, true);
  });

  await scenario('sygnały NIEOBECNE: częsty trening własny, ale ZERO odrzuceń -> active=false', () => {
    const ctx = baseCtx({ ownTrainingCountRecent14d: OWN_TRAINING_FREQUENT_MIN_COUNT, rejectionStreak: 0 });
    assert.strictEqual(evaluateThread2(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: streak odrzuceń wysoki, ale trening własny RZADKI -> active=false', () => {
    const ctx = baseCtx({ ownTrainingCountRecent14d: 1, rejectionStreak: REJECTION_STREAK_MIN + 2 });
    assert.strictEqual(evaluateThread2(ctx).active, false);
  });

  // ============================================================
  console.log('\n3. Wątek 3 — wcześniej regularny trening własny, nagły spadek (bez zmiany w klubowym)');

  await scenario('sygnały OBECNE: był regularny (28d), teraz prawie zero (14d), klub stabilny -> active=true', () => {
    const ctx = baseCtx({
      ownTrainingCountPrior28d: REGULAR_PRIOR_MIN_COUNT + 2,
      ownTrainingCountRecent14d: 0,
      clubTrainingCountPrior28d: 6,
      clubTrainingCountRecent14d: 3, // 6/2=3 -> recent 3 >= 3*0.5=1.5, stabilny
    });
    assert.strictEqual(evaluateThread3(ctx).active, true);
  });

  await scenario('sygnały NIEOBECNE: nigdy nie był regularny -> active=false (mimo że dziś zero)', () => {
    const ctx = baseCtx({ ownTrainingCountPrior28d: REGULAR_PRIOR_MIN_COUNT - 2, ownTrainingCountRecent14d: 0 });
    assert.strictEqual(evaluateThread3(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: był regularny, ale WCIĄŻ regularny dziś (brak spadku) -> active=false', () => {
    const ctx = baseCtx({ ownTrainingCountPrior28d: REGULAR_PRIOR_MIN_COUNT + 2, ownTrainingCountRecent14d: SUDDEN_DROP_RECENT_MAX_COUNT + 3 });
    assert.strictEqual(evaluateThread3(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: spadek własnego ORAZ klubowego razem (nie "bez zmiany w klubowym") -> active=false', () => {
    const ctx = baseCtx({
      ownTrainingCountPrior28d: REGULAR_PRIOR_MIN_COUNT + 2,
      ownTrainingCountRecent14d: 0,
      clubTrainingCountPrior28d: 8, // rate 14d = 4
      clubTrainingCountRecent14d: 0, // spadło drastycznie razem z własnym -> nie klubowe stabilne
    });
    assert.strictEqual(evaluateThread3(ctx).active, false);
  });

  // ============================================================
  console.log('\n4. Wątek 4 — powtarzający się ból tej samej lokalizacji + trening własny nieredukowany');

  await scenario('sygnały OBECNE: ból powtórzony >=3x ta sama lokalizacja + trening własny wciąż >=2/14d -> active=true', () => {
    const ctx = baseCtx({
      repeatedPain: { location: 'kolano', count: REPEAT_PAIN_MIN_COUNT },
      ownTrainingCountRecent14d: OWN_TRAINING_NOT_REDUCED_MIN_COUNT,
    });
    assert.strictEqual(evaluateThread4(ctx).active, true);
  });

  await scenario('sygnały NIEOBECNE: brak powtarzającego się bólu -> active=false', () => {
    const ctx = baseCtx({ repeatedPain: null, ownTrainingCountRecent14d: 5 });
    assert.strictEqual(evaluateThread4(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: powtarzający się ból, ale zawodnik REALNIE zredukował trening własny -> active=false', () => {
    const ctx = baseCtx({
      repeatedPain: { location: 'kostka', count: REPEAT_PAIN_MIN_COUNT + 1 },
      ownTrainingCountRecent14d: OWN_TRAINING_NOT_REDUCED_MIN_COUNT - 1,
    });
    assert.strictEqual(evaluateThread4(ctx).active, false);
  });

  // ============================================================
  console.log('\n5. Wątek 5 — wysoka mood_motivation + niski odsetek zrealizowanych zaplanowanych treningów');

  await scenario('sygnały OBECNE: wysoki nastrój + niska realizacja planu -> active=true', () => {
    const ctx = baseCtx({
      moodAvg14d: { active: true, avg: HIGH_MOOD_THRESHOLD, n: 4 },
      calendarCompletion14d: { active: true, total: LOW_COMPLETION_MIN_EVENTS, completed: 1, rate: LOW_COMPLETION_MAX_RATE - 0.1 },
    });
    assert.strictEqual(evaluateThread5(ctx).active, true);
  });

  await scenario('sygnały NIEOBECNE: wysoki nastrój, ale WYSOKA realizacja planu -> active=false', () => {
    const ctx = baseCtx({
      moodAvg14d: { active: true, avg: HIGH_MOOD_THRESHOLD, n: 4 },
      calendarCompletion14d: { active: false, total: 4, completed: 4, rate: 1 },
    });
    assert.strictEqual(evaluateThread5(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: niska realizacja planu, ale nastrój NIE wysoki -> active=false', () => {
    const ctx = baseCtx({
      moodAvg14d: { active: false, avg: 5, n: 4 },
      calendarCompletion14d: { active: true, total: 4, completed: 1, rate: 0.25 },
    });
    assert.strictEqual(evaluateThread5(ctx).active, false);
  });

  // ============================================================
  console.log('\n6. Wątek 6 — segment kluczowy dla pozycji = główny deficyt + brak aktywnego celu od wielu tygodni');

  const OLD_DIAGNOSIS_ISO = new Date(NOW.getTime() - (GOAL_STALE_MIN_DIAGNOSIS_AGE_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
  const FRESH_DIAGNOSIS_ISO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

  await scenario('sygnały OBECNE: deficyt względny w segmencie "key" dla pozycji, diagnoza stara, brak aktywnego celu -> active=true', () => {
    // Napastnik: key = decyzja, techSpec, fizycznosc, mental. "decyzja" wyraźnie
    // poniżej reszty -> deficyt względny statystycznie istotny.
    const ctx = baseCtx({
      positionPrimary: 'Napastnik',
      diagnosisScores: { decyzja: 20, techSpec: 70, fizycznosc: 72, mental: 71, moc: 70, percepcja: 71, techFund: 70, wytrzymalosc: 70, tolerancja: 70, regeneracja: 70, odpornosc: 70, odzywianie: 70, koncentracja: 70 },
      diagnosisCreatedAt: OLD_DIAGNOSIS_ISO,
      activeGoalSegments: new Set(['moc']), // aktywny cel gdzie indziej, NIE w segmencie deficytu
    });
    const r = evaluateThread6(ctx);
    assert.strictEqual(r.active, true);
    assert.strictEqual(r.detail.topDeficitSegment, 'decyzja');
  });

  await scenario('sygnały NIEOBECNE: ten sam deficyt, ale JEST już aktywny cel w tym segmencie -> active=false', () => {
    const ctx = baseCtx({
      positionPrimary: 'Napastnik',
      diagnosisScores: { decyzja: 20, techSpec: 70, fizycznosc: 72, mental: 71, moc: 70, percepcja: 71, techFund: 70, wytrzymalosc: 70, tolerancja: 70, regeneracja: 70, odpornosc: 70, odzywianie: 70, koncentracja: 70 },
      diagnosisCreatedAt: OLD_DIAGNOSIS_ISO,
      activeGoalSegments: new Set(['decyzja']),
    });
    assert.strictEqual(evaluateThread6(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: deficyt w segmencie NIE kluczowym dla tej pozycji -> active=false', () => {
    // Napastnik: key = decyzja/techSpec/fizycznosc/mental. "odzywianie" nie jest key.
    const ctx = baseCtx({
      positionPrimary: 'Napastnik',
      diagnosisScores: { odzywianie: 20, techSpec: 70, fizycznosc: 72, mental: 71, moc: 70, percepcja: 71, techFund: 70, wytrzymalosc: 70, tolerancja: 70, regeneracja: 70, odpornosc: 70, decyzja: 70, koncentracja: 70 },
      diagnosisCreatedAt: OLD_DIAGNOSIS_ISO,
      activeGoalSegments: new Set(),
    });
    assert.strictEqual(evaluateThread6(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: diagnoza zbyt świeża (< progu tygodni) -> active=false mimo reszty spełnionej', () => {
    const ctx = baseCtx({
      positionPrimary: 'Napastnik',
      diagnosisScores: { decyzja: 20, techSpec: 70, fizycznosc: 72, mental: 71, moc: 70, percepcja: 71, techFund: 70, wytrzymalosc: 70, tolerancja: 70, regeneracja: 70, odpornosc: 70, odzywianie: 70, koncentracja: 70 },
      diagnosisCreatedAt: FRESH_DIAGNOSIS_ISO,
      activeGoalSegments: new Set(),
    });
    assert.strictEqual(evaluateThread6(ctx).active, false);
  });

  await scenario('brak pozycji zawodnika ("Nie dotyczy"/null) -> active=false, nie zgaduje', () => {
    const ctx = baseCtx({ positionPrimary: null, diagnosisScores: { decyzja: 20 }, diagnosisCreatedAt: OLD_DIAGNOSIS_ISO });
    assert.strictEqual(evaluateThread6(ctx).active, false);
  });

  // ============================================================
  console.log('\n7. Wątek 7 — podwyższone zmęczenie bez wytłumaczenia treningowego + niski wynik segmentu odżywianie');

  await scenario('sygnały OBECNE: zmęczenie (sen) BEZ skoku obciążenia i BEZ urazu + niska odżywianie -> active=true', () => {
    const ctx = baseCtx({
      readinessSignals: { sleepFlag: { active: true }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: { active: false } },
      hasRecentExcludingPain: false,
      diagnosisScores: { odzywianie: LOW_NUTRITION_SCORE_THRESHOLD - 5 },
    });
    assert.strictEqual(evaluateThread7(ctx).active, true);
  });

  await scenario('sygnały NIEOBECNE: zmęczenie WYTŁUMACZONE skokiem obciążenia -> active=false', () => {
    const ctx = baseCtx({
      readinessSignals: { sleepFlag: { active: true }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: { active: true } },
      hasRecentExcludingPain: false,
      diagnosisScores: { odzywianie: LOW_NUTRITION_SCORE_THRESHOLD - 5 },
    });
    assert.strictEqual(evaluateThread7(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: zmęczenie WYTŁUMACZONE urazem (ból wykluczający) -> active=false', () => {
    const ctx = baseCtx({
      readinessSignals: { sleepFlag: { active: true }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: { active: false } },
      hasRecentExcludingPain: true,
      diagnosisScores: { odzywianie: LOW_NUTRITION_SCORE_THRESHOLD - 5 },
    });
    assert.strictEqual(evaluateThread7(ctx).active, false);
  });

  await scenario('sygnały NIEOBECNE: zmęczenie niewytłumaczone, ale wynik odżywiania W NORMIE -> active=false', () => {
    const ctx = baseCtx({
      readinessSignals: { sleepFlag: { active: true }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: { active: false } },
      hasRecentExcludingPain: false,
      diagnosisScores: { odzywianie: LOW_NUTRITION_SCORE_THRESHOLD + 20 },
    });
    assert.strictEqual(evaluateThread7(ctx).active, false);
  });

  // ============================================================
  console.log('\n8. Wątek 8 (drużynowy) — odżywianie jako częsty wspólny deficyt na mapie cieplnej drużyny');

  function makeScoresByUser(nutritionScores) {
    const m = new Map();
    nutritionScores.forEach((v, i) => m.set(`p${i}`, { odzywianie: v, moc: 70 }));
    return m;
  }

  await scenario('sygnały OBECNE: drużyna >= progu, średnia odżywiania NISKA -> active=true', () => {
    const scores = makeScoresByUser(Array(TEAM_AGGREGATE_MIN_SIZE).fill(LOW_NUTRITION_SCORE_THRESHOLD - 10));
    const r = evaluateThread8(TEAM_AGGREGATE_MIN_SIZE, scores);
    assert.strictEqual(r.active, true);
  });

  await scenario('sygnały NIEOBECNE: drużyna >= progu, ale średnia odżywiania W NORMIE -> active=false', () => {
    const scores = makeScoresByUser(Array(TEAM_AGGREGATE_MIN_SIZE).fill(LOW_NUTRITION_SCORE_THRESHOLD + 10));
    assert.strictEqual(evaluateThread8(TEAM_AGGREGATE_MIN_SIZE, scores).active, false);
  });

  await scenario('sygnały NIEOBECNE: drużyna ZA MAŁA (< progu prywatności) -> active=false, mimo niskiej średniej', () => {
    const scores = makeScoresByUser(Array(TEAM_AGGREGATE_MIN_SIZE - 1).fill(10));
    const r = evaluateThread8(TEAM_AGGREGATE_MIN_SIZE - 1, scores);
    assert.strictEqual(r.active, false);
    assert.match(r.detail.reason, /za mała/);
  });

  await scenario('sygnały NIEOBECNE: drużyna wystarczająco duża, ale za mało WYNIKÓW SEGMENTU odżywianie -> active=false', () => {
    const scores = makeScoresByUser(Array(3).fill(10)); // tylko 3 wyniki segmentu, mimo że roster=8
    assert.strictEqual(evaluateThread8(TEAM_AGGREGATE_MIN_SIZE, scores).active, false);
  });

  // ============================================================
  console.log('\n9. isReadinessFatigueActive / parseScores — pomocnicze funkcje czyste');

  await scenario('isReadinessFatigueActive: żaden sygnał aktywny -> false', () => {
    assert.strictEqual(isReadinessFatigueActive({ sleepFlag: { active: false }, coldStartOrBaseline: { tired: false }, weeklyLoadSpike: null }), false);
  });

  await scenario('isReadinessFatigueActive: brak obiektu signals -> false (nie wywala się)', () => {
    assert.strictEqual(isReadinessFatigueActive(null), false);
  });

  await scenario('parseScores: string JSON -> obiekt; obiekt -> bez zmian; niepoprawny string -> null', () => {
    assert.deepStrictEqual(parseScores('{"moc":50}'), { moc: 50 });
    assert.deepStrictEqual(parseScores({ moc: 50 }), { moc: 50 });
    assert.strictEqual(parseScores('{niepoprawny'), null);
    assert.strictEqual(parseScores(null), null);
  });

  // ============================================================
  console.log('\n10. Warstwa I/O — countSessionsByType / computeCalendarCompletionRate (atrapa Supabase)');

  await scenario('countSessionsByType: liczy WYŁĄCZNIE post_training own_training w oknie czasowym', async () => {
    const supabase = makeFakeSupabase({
      daily_logs: [
        { id: 1, user_id: 'u1', entry_type: 'post_training', session_type: 'own_training', created_at: '2026-08-01T00:00:00Z' },
        { id: 2, user_id: 'u1', entry_type: 'post_training', session_type: 'own_training', created_at: '2026-08-02T00:00:00Z' },
        { id: 3, user_id: 'u1', entry_type: 'post_training', session_type: 'club_training', created_at: '2026-08-02T00:00:00Z' }, // inny typ
        { id: 4, user_id: 'u2', entry_type: 'post_training', session_type: 'own_training', created_at: '2026-08-02T00:00:00Z' }, // inny user
        { id: 5, user_id: 'u1', entry_type: 'morning', session_type: null, created_at: '2026-08-02T00:00:00Z' }, // inny entry_type
      ],
    });
    const n = await countSessionsByType(supabase, 'u1', 'own_training', '2026-07-01T00:00:00Z');
    assert.strictEqual(n, 2);
  });

  await scenario('computeCalendarCompletionRate: total<LOW_COMPLETION_MIN_EVENTS -> active=false mimo niskiej realizacji', async () => {
    const supabase = makeFakeSupabase({
      calendar_events: [
        { id: 'e1', user_id: 'u1', status: 'scheduled', event_type: 'own_training', scheduled_date: '2026-07-30' },
        { id: 'e2', user_id: 'u1', status: 'scheduled', event_type: 'own_training', scheduled_date: '2026-07-31' },
      ],
      daily_logs: [],
    });
    const r = await computeCalendarCompletionRate(supabase, 'u1', '2026-07-25', '2026-08-04');
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.active, false);
  });

  await scenario('computeCalendarCompletionRate: >=próg wydarzeń, tylko część "wykonana" (ma powiązany daily_logs) -> liczy poprawnie', async () => {
    const supabase = makeFakeSupabase({
      calendar_events: [
        { id: 'e1', user_id: 'u1', status: 'scheduled', event_type: 'own_training', scheduled_date: '2026-07-28' },
        { id: 'e2', user_id: 'u1', status: 'scheduled', event_type: 'club_training', scheduled_date: '2026-07-29' },
        { id: 'e3', user_id: 'u1', status: 'scheduled', event_type: 'micro_session', scheduled_date: '2026-07-30' },
        { id: 'e4', user_id: 'u1', status: 'cancelled', event_type: 'own_training', scheduled_date: '2026-07-30' }, // anulowane -> pomijane
      ],
      daily_logs: [
        { id: 1, calendar_event_id: 'e1' },
      ],
    });
    const r = await computeCalendarCompletionRate(supabase, 'u1', '2026-07-25', '2026-08-04');
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.completed, 1);
    assert.strictEqual(r.active, true); // 1/3 <= 0.5
  });

  // ============================================================
  console.log('\n11. fetchPlayerThreadContext / detectPlayerThreadSignals / detectTeamThreadSignals — integracja end-to-end (atrapa Supabase)');

  await scenario('detectPlayerThreadSignals: zwraca dokładnie 7 wątków (id 1-7), zawodnik bez żadnych sygnałów -> wszystkie active=false', async () => {
    const supabase = makeFakeSupabase({
      daily_logs: [],
      decision_recommendations: [],
      pain_entries: [],
      player_profiles: [{ user_id: 'u1', position_primary: null }],
      diagnostics: [],
      goals: [],
    });
    const threads = await detectPlayerThreadSignals(supabase, 'u1', NOW);
    assert.strictEqual(threads.length, 7);
    assert.deepStrictEqual(threads.map((t) => t.id), [1, 2, 3, 4, 5, 6, 7]);
    threads.forEach((t) => assert.strictEqual(t.active, false, `wątek ${t.id} nie powinien być aktywny na pustych danych`));
  });

  await scenario('detectPlayerThreadSignals: dane skonstruowane pod wątek 4 (powtarzający się ból) -> TYLKO wątek 4 aktywny', async () => {
    const supabase = makeFakeSupabase({
      daily_logs: [
        { id: 1, user_id: 'u1', entry_type: 'post_training', session_type: 'own_training', created_at: '2026-08-01T00:00:00Z' },
        { id: 2, user_id: 'u1', entry_type: 'post_training', session_type: 'own_training', created_at: '2026-08-02T00:00:00Z' },
      ],
      decision_recommendations: [],
      pain_entries: [
        { user_id: 'u1', body_location: 'kolano', created_at: '2026-07-20T00:00:00Z', excludes_from_training: false },
        { user_id: 'u1', body_location: 'kolano', created_at: '2026-07-25T00:00:00Z', excludes_from_training: false },
        { user_id: 'u1', body_location: 'kolano', created_at: '2026-08-01T00:00:00Z', excludes_from_training: false },
      ],
      player_profiles: [{ user_id: 'u1', position_primary: null }],
      diagnostics: [],
      goals: [],
    });
    const threads = await detectPlayerThreadSignals(supabase, 'u1', NOW);
    const byId = Object.fromEntries(threads.map((t) => [t.id, t.active]));
    assert.strictEqual(byId[4], true, 'wątek 4 powinien być aktywny (powtarzający się ból + trening własny nieredukowany)');
    assert.strictEqual(byId[1], false);
    assert.strictEqual(byId[7], false); // brak diagnozy -> brak wyniku odżywiania -> nie może być active
  });

  await scenario('detectTeamThreadSignals: zwraca dokładnie 1 wynik (id 8)', async () => {
    const supabase = makeFakeSupabase({ team_memberships: [], diagnostics: [] });
    const threads = await detectTeamThreadSignals(supabase, 'team-1');
    assert.strictEqual(threads.length, 1);
    assert.strictEqual(threads[0].id, 8);
    assert.strictEqual(threads[0].active, false); // drużyna pusta -> za mała
  });

  await scenario('detectTeamThreadSignals: drużyna >= progu z niskim odżywianiem -> wątek 8 aktywny', async () => {
    const roster = Array.from({ length: TEAM_AGGREGATE_MIN_SIZE }, (_, i) => ({ team_id: 'team-1', player_user_id: `p${i}`, status: 'active' }));
    const diag = roster.map((r, i) => ({ user_id: r.player_user_id, scores: JSON.stringify({ odzywianie: 30, moc: 70 }), created_at: `2026-08-0${(i % 4) + 1}T00:00:00Z` }));
    const supabase = makeFakeSupabase({ team_memberships: roster, diagnostics: diag });
    const threads = await detectTeamThreadSignals(supabase, 'team-1');
    assert.strictEqual(threads[0].active, true);
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
