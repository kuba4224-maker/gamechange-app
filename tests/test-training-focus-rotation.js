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
  POST_MATCH_FIXED_OFFSET_DAYS,
  PRE_MATCH_FIXED_OFFSET_DAYS,
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

check('brak lastGeneratedAt -> rotacja natychmiastowa (nowy cel priorytetowy), priorytet nad resztą', () => {
  const r = shouldRotateTrainingFocus({
    lastGeneratedAt: null,
    now: NOW,
    nowDateStr: NOW_DATE_STR,
    upcomingMatchDate: null,
    lastMatchDate: null,
  });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'no_prior_training_focus_for_goal');
});

check(`dokładnie ${ROTATION_CADENCE_DAYS} dni od ostatniego -> rotacja (cadence)`, () => {
  const lastGeneratedAt = new Date(NOW.getTime() - ROTATION_CADENCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null, lastMatchDate: null });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'cadence_due');
});

check('brak lastMatchDate i brak upcomingMatchDate jednocześnie, cadence nie due -> brak rotacji (tylko cadence decyduje)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null, lastMatchDate: null });
  assert.strictEqual(r.rotate, false);
  assert.strictEqual(r.reason, 'not_due');
});

console.log('1a. Stały moment POST-MATCH (dzień po meczu)');

check(`daysSinceMatch === ${POST_MATCH_FIXED_OFFSET_DAYS} (dzień po meczu) -> rotacja (post_match_fixed_moment)`, () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const lastMatchDate = '2026-08-09'; // wczoraj -> daysSinceMatch = 1
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null, lastMatchDate });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'post_match_fixed_moment');
});

check('daysSinceMatch === 0 (dziś jest dzień meczu) -> brak rotacji (nie ten moment)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const lastMatchDate = NOW_DATE_STR; // mecz dziś -> daysSinceMatch = 0
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null, lastMatchDate });
  assert.strictEqual(r.rotate, false);
  assert.strictEqual(r.reason, 'not_due');
});

check('daysSinceMatch === 2 -> brak rotacji (już minął stały moment)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const lastMatchDate = '2026-08-08'; // 2 dni temu
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null, lastMatchDate });
  assert.strictEqual(r.rotate, false);
  assert.strictEqual(r.reason, 'not_due');
});

console.log('1b. Stały moment PRE-MATCH (2 dni przed meczem)');

check(`daysToMatch === ${PRE_MATCH_FIXED_OFFSET_DAYS} -> rotacja (pre_match_fixed_moment)`, () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const upcomingMatchDate = '2026-08-12'; // +2 dni
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate, lastMatchDate: null });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'pre_match_fixed_moment');
});

check('daysToMatch === 1 -> brak rotacji (za blisko, nie ten moment)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const upcomingMatchDate = '2026-08-11'; // +1 dzień
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate, lastMatchDate: null });
  assert.strictEqual(r.rotate, false);
  assert.strictEqual(r.reason, 'not_due');
});

check('daysToMatch === 3 -> brak rotacji (za daleko, nie ten moment)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const upcomingMatchDate = '2026-08-13'; // +3 dni
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate, lastMatchDate: null });
  assert.strictEqual(r.rotate, false);
  assert.strictEqual(r.reason, 'not_due');
});

check('mecz W PRZESZŁOŚCI jako upcomingMatchDate (ujemne daysToMatch, dane niespójne) -> brak rotacji przez sygnał pre-match', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: '2026-08-05', lastMatchDate: null });
  assert.strictEqual(r.rotate, false);
});

console.log('1c. Cadence vs stałe momenty meczowe');

check('cadence PRZEBIJA stały moment meczowy, jeśli oba by pasowały (cadence sprawdzane pierwsze)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - ROTATION_CADENCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: '2026-08-12', lastMatchDate: '2026-08-09' });
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.reason, 'cadence_due');
});

check('niestandardowe cadenceDays respektowane (parametr nadpisujący domyślny)', () => {
  const lastGeneratedAt = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const r = shouldRotateTrainingFocus({ lastGeneratedAt, now: NOW, nowDateStr: NOW_DATE_STR, upcomingMatchDate: null, lastMatchDate: null, cadenceDays: 4 });
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
        lt(col, val) { filters.push((row) => row[col] < val); return builder; },
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
    const matchDate = new Date(Date.now() + PRE_MATCH_FIXED_OFFSET_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const supabase = makeFakeSupabase({
      goals: [{ id: 'goal-3', user_id: 'user-3', segment_id: 'percepcja', status: 'active', is_priority: true, created_at: '2026-07-01T00:00:00Z' }],
      recommendations: [{ goal_id: 'goal-3', recommendation_type: 'training_focus', created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() }],
      events: [{ user_id: 'user-3', event_type: 'match', status: 'scheduled', scheduled_date: matchDate }],
    });
    const warsawNow = { hour: 9, dateStr: nowDateStr };
    const results = {};
    await runTrainingFocusRotation(supabase, warsawNow, results);
    check(`training_focus wygenerowany wczoraj, mecz za dokładnie ${PRE_MATCH_FIXED_OFFSET_DAYS} dni -> generuje (pre-match fixed moment)`, () => {
      assert.strictEqual(generateRecommendationCalls.length, 1);
    });
  })();

  await (async () => {
    generateRecommendationCalls.length = 0;
    const nowDateStr = new Date().toISOString().slice(0, 10);
    const lastMatchDate = new Date(Date.now() - POST_MATCH_FIXED_OFFSET_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const supabase = makeFakeSupabase({
      goals: [{ id: 'goal-4', user_id: 'user-4', segment_id: 'technika', status: 'active', is_priority: true, created_at: '2026-07-01T00:00:00Z' }],
      recommendations: [{ goal_id: 'goal-4', recommendation_type: 'training_focus', created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() }],
      events: [{ user_id: 'user-4', event_type: 'match', status: 'scheduled', scheduled_date: lastMatchDate }],
    });
    const warsawNow = { hour: 9, dateStr: nowDateStr };
    const results = {};
    await runTrainingFocusRotation(supabase, warsawNow, results);
    check(`training_focus wygenerowany wczoraj, ostatni mecz dokładnie ${POST_MATCH_FIXED_OFFSET_DAYS} dni temu -> generuje (post-match fixed moment)`, () => {
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
