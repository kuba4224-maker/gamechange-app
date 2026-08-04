// ============================================================
// test-training-focus-rotation.js — testy jednostkowe lib/training-focus-rotation.js
// ============================================================
// Uruchom: node tests/test-training-focus-rotation.js
//
// generate-recommendation.js (require('../api/generate-recommendation'))
// wymaga @supabase/supabase-js, którego nie instalujemy tylko po to, żeby
// przetestować logikę "kiedy rotować" — więc PRZED require('../lib/
// training-focus-rotation') podmieniamy require.cache dla tej ścieżki na
// lekką atrapę (ten sam wzorzec co w test-push-rate-limiter.js).
// ============================================================
const assert = require('assert');

const generateRecommendationCalls = [];
const genRecStubPath = require.resolve('../api/generate-recommendation.js');
require.cache[genRecStubPath] = {
  id: genRecStubPath,
  filename: genRecStubPath,
  loaded: true,
  exports: {
    generateRecommendation: async (params, supabase) => {
      generateRecommendationCalls.push(params);
      return { ok: true, blocked: false, recommendation: { id: 'fake-rec', ...params } };
    },
  },
};

const {
  shouldRotateTrainingFocus,
  daysBetweenDateStrs,
  fetchActivePriorityGoalsByUser,
  runTrainingFocusRotation,
  ROTATION_CADENCE_DAYS,
  MATCH_WINDOW_MIN_DAYS,
  MATCH_WINDOW_MAX_DAYS,
} = require('../lib/training-focus-rotation');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${label}`);
  } catch (e) {
    console.error(`  FAIL — ${label}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

const NOW = new Date('2026-08-10T12:00:00.000Z');
const NOW_DATE_STR = '2026-08-10';

console.log('1. shouldRotateTrainingFocus — czysta funkcja decyzyjna');

check('brak lastGeneratedAt -> rotacja natychmiastowa (nowy cel priorytetowy)', () => {
  const r = shouldRotateTrainingFocus({ lastGeneratedAt: null, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'no_prior_training_focus_for_goal');
});

check(`dokładnie ${ROTATION_CADENCE_DAYS} dni od ostatniego -> rotacja (cadence)`, () => {
  const lastGeneratedAt = new Date(NOW.getTime() - ROTATION_CADENCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'cadence_due');
});

check('1 dzień od ostatniego, brak meczu -> brak rotacji', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null });
  assert.strictEqual(r.rotate, false);
  assert.strictEqual(r.reason, 'not_due');
});

check('3 dni od ostatniego, mecz za 2 dni (dolna granica okna) -> rotacja (sygnał meczowy)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const matchDate = '2026-08-12'; // +2 dni
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: matchDate });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'match_window_readiness_signal');
});

check('3 dni od ostatniego, mecz za 6 dni (górna granica okna) -> rotacja', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const matchDate = '2026-08-16'; // +6 dni
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: matchDate });
  assert.strictEqual(r.rotate, true);
});

check('3 dni od ostatniego, mecz za 1 dzień (POZA oknem, za blisko) -> brak rotacji', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const matchDate = '2026-08-11'; // +1 dzień
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: matchDate });
  assert.strictEqual(r.rotate, false);
});

check('3 dni od ostatniego, mecz za 7 dni (POZA oknem, za daleko) -> brak rotacji', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const matchDate = '2026-08-17'; // +7 dni
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: matchDate });
  assert.strictEqual(r.rotate, false);
});

check('mecz DZIŚ (0 dni) -> brak rotacji (poniżej dolnej granicy)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: NOW_DATE_STR });
  assert.strictEqual(r.rotate, false);
});

check('mecz W PRZESZŁOŚCI (ujemne dni) -> brak rotacji przez sygnał meczowy', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: '2026-08-05' });
  assert.strictEqual(r.rotate, false);
});

check('cadence PRZEBIJA okno meczowe, jeśli oba by pasowały (cadence sprawdzane pierwsze)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - ROTATION_CADENCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: '2026-08-13' });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'cadence_due');
});

check('niestandardowe cadenceDays respektowane (parametr nadpisujący domyślny)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null, cadenceDays: 4 });
  assert.strictEqual(r.rotate, true);
});

check('daysBetweenDateStrs liczy poprawnie w obie strony', () => {
  assert.strictEqual(daysBetweenDateStrs('2026-08-10', '2026-08-13'), 3);
  assert.strictEqual(daysBetweenDateStrs('2026-08-13', '2026-08-10'), -3);
  assert.strictEqual(daysBetweenDateStrs('2026-08-10', '2026-08-10'), 0);
});

console.log('2. runTrainingFocusRotation — orkiestracja z atrapą Supabase');

function makeFakeSupabase({ goals = [], recommendations = [], events = [] } = {}) {
  return {
    from(table) {
      const filters = [];
      let orderCol = null, orderAsc = true, limitN = null;
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push((row) => row[col] === val); return builder; },
        gte(col, val) { filters.push((row) => row[col] >= val); return builder; },
        order(col, opts) { orderCol = col; orderAsc = !(opts && opts.ascending === false); return builder; },
        limit(n) { limitN = n; return builder; },
        maybeSingle() {
          return applyAndReturn().then((r) => ({ data: r.data[0] || null, error: null }));
        },
        then(resolve) {
          applyAndReturn().then(resolve);
        },
      };
      function applyAndReturn() {
        let rows = (table === 'goals' ? goals : table === 'decision_recommendations' ? recommendations : events)
          .filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          rows = [...rows].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : -1) * (orderAsc ? 1 : -1));
        }
        if (limitN) rows = rows.slice(0, limitN);
        return Promise.resolve({ data: rows, error: null });
      }
      return builder;
    },
  };
}

(async () => {
  await (async () => {
    generateRecommendationCalls.length = 0;
    const supabase = makeFakeSupabase({
      goals: [{ id: 'goal-1', user_id: 'user-1', segment_id: 'moc', status: 'active', is_priority: true, created_at: '2026-07-01T00:00:00Z' }],
      recommendations: [], // brak wcześniejszego training_focus dla tego celu
      events: [],
    });
    const warsawNow = { hour: 9, dateStr: '2026-08-10' };
    const results = {};
    await runTrainingFocusRotation(supabase, warsawNow, results);
    check('nowy cel bez wcześniejszego training_focus -> generuje natychmiast', () => {
      assert.strictEqual(generateRecommendationCalls.length, 1);
      assert.strictEqual(generateRecommendationCalls[0].goalId, 'goal-1');
      assert.strictEqual(results.training_focus_rotation, 1);
    });
  })();

  await (async () => {
    generateRecommendationCalls.length = 0;
    const supabase = makeFakeSupabase({
      goals: [{ id: 'goal-2', user_id: 'user-2', segment_id: 'wytrzymalosc', status: 'active', is_priority: true, created_at: '2026-07-01T00:00:00Z' }],
      recommendations: [{ goal_id: 'goal-2', recommendation_type: 'training_focus', created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() }],
      events: [],
    });
    const warsawNow = { hour: 9, dateStr: new Date().toISOString().slice(0, 10) };
    const results = {};
    await runTrainingFocusRotation(supabase, warsawNow, results);
    check('training_focus wygenerowany wczoraj, brak meczu -> NIE generuje', () => {
      assert.strictEqual(generateRecommendationCalls.length, 0);
      assert.strictEqual(results.training_focus_rotation || 0, 0);
    });
  })();

  await (async () => {
    generateRecommendationCalls.length = 0;
    const nowDateStr = new Date().toISOString().slice(0, 10);
    const matchDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const supabase = makeFakeSupabase({
      goals: [{ id: 'goal-3', user_id: 'user-3', segment_id: 'percepcja', status: 'active', is_priority: true, created_at: '2026-07-01T00:00:00Z' }],
      recommendations: [{ goal_id: 'goal-3', recommendation_type: 'training_focus', created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() }],
      events: [{ user_id: 'user-3', event_type: 'match', status: 'scheduled', scheduled_date: matchDate }],
    });
    const warsawNow = { hour: 9, dateStr: nowDateStr };
    const results = {};
    await runTrainingFocusRotation(supabase, warsawNow, results);
    check('training_focus wygenerowany wczoraj, ALE mecz za 3 dni -> generuje wcześniej (sygnał meczowy)', () => {
      assert.strictEqual(generateRecommendationCalls.length, 1);
    });
  })();

  await (async () => {
    const supabase = makeFakeSupabase({ goals: [], recommendations: [], events: [] });
    const results = {};
    await runTrainingFocusRotation(supabase, { hour: 9, dateStr: '2026-08-10' }, results);
    check('brak aktywnych celów priorytetowych -> nic się nie dzieje, brak błędu', () => {
      assert.strictEqual(Object.keys(results).length, 0);
    });
  })();

  if (process.exitCode) {
    console.error('\nNIEKTÓRE TESTY NIE PRZESZŁY.');
  } else {
    console.log(`\nWSZYSTKIE TESTY PRZESZŁY (${passed}).`);
  }
})();
