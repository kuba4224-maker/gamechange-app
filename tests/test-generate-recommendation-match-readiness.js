// ============================================================
// GAMECHANGE — test_generate_recommendation_match_readiness.js
// ============================================================
// Ten sam wzorzec testowania co test_generate_recommendation_readiness.js:
// zwykły skrypt Node, bez frameworka. Testuje TYLKO czyste funkcje
// dodane 03.08.2026 do api_generate_recommendation.js (wymiar MECZOWY
// Gotowości + budowanie kontekstu match_context_answers dla promptu AI)
// -- computeMatchReadinessSignal()/buildMatchReadinessNarrative() nie
// robią żadnego I/O, dostają dane jako parametry.
//
// Uruchomienie: node test_generate_recommendation_match_readiness.js
// Wyjście: lista scenariuszy z PASS/FAIL, kod wyjścia 1 przy jakimkolwiek FAIL.
// ============================================================

const assert = require('assert');
const {
  computeMatchReadinessSignal,
  buildMatchReadinessNarrative,
  MATCH_NEGATIVE_OUTCOME_CODES,
} = require('../api/generate-recommendation.js')._internal;

let failures = 0;

function scenario(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.stack || e.message}`);
  }
}

function answer(matchId, segmentId, responseValue, createdAt, extra) {
  return {
    match_context_id: matchId,
    segment_id: segmentId,
    response_value: responseValue,
    followup_value: (extra && extra.followup_value) || null,
    selection_source: (extra && extra.selection_source) || 'rotation',
    was_goal_segment: !!(extra && extra.was_goal_segment),
    created_at: createdAt,
  };
}

// ============================================================
// 1. computeMatchReadinessSignal
// ============================================================

scenario('brak odpowiedzi w ogóle -> active=false, nie wybucha', () => {
  const signal = computeMatchReadinessSignal([]);
  assert.strictEqual(signal.active, false);
});

scenario('null/undefined -> active=false, nie wybucha', () => {
  assert.strictEqual(computeMatchReadinessSignal(null).active, false);
  assert.strictEqual(computeMatchReadinessSignal(undefined).active, false);
});

scenario('1 niekorzystny kod w najnowszym meczu -> active=false (próg to >=2)', () => {
  const answers = [
    answer(100, 'moc', 'lost_race', '2026-08-01T18:00:00Z'),
    answer(100, 'decyzja', 'decisive', '2026-08-01T18:00:00Z'),
  ];
  const signal = computeMatchReadinessSignal(answers);
  assert.strictEqual(signal.active, false);
  assert.strictEqual(signal.negativeCount, 1);
  assert.strictEqual(signal.totalAnswered, 2);
});

scenario('2 niekorzystne kody w najnowszym meczu -> active=true', () => {
  const answers = [
    answer(100, 'moc', 'lost_race', '2026-08-01T18:00:00Z'),
    answer(100, 'decyzja', 'hesitated', '2026-08-01T18:00:00Z'),
    answer(100, 'koncentracja', 'stayed_focused', '2026-08-01T18:00:00Z'),
  ];
  const signal = computeMatchReadinessSignal(answers);
  assert.strictEqual(signal.active, true);
  assert.strictEqual(signal.negativeCount, 2);
  assert.strictEqual(signal.totalAnswered, 3);
});

scenario('niekorzystne kody w STARSZYM meczu nie liczą się -- tylko najnowszy mecz', () => {
  const answers = [
    // najnowszy mecz (id=200) -- tylko 1 niekorzystny
    answer(200, 'moc', 'lost_race', '2026-08-02T18:00:00Z'),
    answer(200, 'decyzja', 'decisive', '2026-08-02T18:00:00Z'),
    // starszy mecz (id=100) -- 3 niekorzystne, ale NIE powinny wpływać
    answer(100, 'wytrzymalosc', 'significant_drop', '2026-08-01T18:00:00Z'),
    answer(100, 'fizycznosc', 'lost_duel', '2026-08-01T18:00:00Z'),
    answer(100, 'techFund', 'broke_down', '2026-08-01T18:00:00Z'),
  ];
  // Wejście MUSI być posortowane malejąco po created_at, tak jak
  // fetchRecentMatchContextAnswers() faktycznie zwraca (order ascending: false).
  const signal = computeMatchReadinessSignal(answers);
  assert.strictEqual(signal.active, false, 'sygnał nie powinien aktywować się na podstawie starszego meczu');
  assert.strictEqual(signal.negativeCount, 1);
  assert.strictEqual(signal.totalAnswered, 2);
});

scenario('no_occurrence / no_recall NIE liczą się jako niekorzystne', () => {
  const answers = [
    answer(100, 'moc', 'no_occurrence', '2026-08-01T18:00:00Z'),
    answer(100, 'decyzja', 'occurred_no_recall', '2026-08-01T18:00:00Z'),
    answer(100, 'percepcja', 'no_recall', '2026-08-01T18:00:00Z'),
  ];
  const signal = computeMatchReadinessSignal(answers);
  assert.strictEqual(signal.active, false);
  assert.strictEqual(signal.negativeCount, 0);
});

scenario('regeneracja (entered_fatigued) świadomie NIE jest na liście kodów niekorzystnych', () => {
  // Regeneracja żyje w osobnym mechanizmie (rdzeń karty meczowej) -- nie
  // powinna być liczona podwójnie tutaj, patrz komentarz przy
  // MATCH_NEGATIVE_OUTCOME_CODES w pliku źródłowym.
  assert.strictEqual(MATCH_NEGATIVE_OUTCOME_CODES.has('entered_fatigued'), false);
});

scenario('wszystkie 12 oczekiwanych kodów obecne na liście (jeden per segment, bez regeneracji)', () => {
  const expected = [
    'late_scan_cost', 'hesitated', 'became_cautious', 'drifted_slow_return',
    'lost_race', 'significant_drop', 'lost_duel', 'broke_down',
    'attempted_no_effect', 'above_normal_toll', 'symptoms_present', 'energy_crash',
  ];
  assert.strictEqual(MATCH_NEGATIVE_OUTCOME_CODES.size, expected.length);
  expected.forEach((code) => assert.ok(MATCH_NEGATIVE_OUTCOME_CODES.has(code), `brakuje kodu ${code}`));
});

// ============================================================
// 2. buildMatchReadinessNarrative
// ============================================================

scenario('narracja: sygnał nieaktywny -> zero linii', () => {
  const lines = buildMatchReadinessNarrative({ active: false });
  assert.strictEqual(lines.length, 0);
});

scenario('narracja: sygnał aktywny -> jedna linia, wspomina liczby i ton "nie alarm"', () => {
  const lines = buildMatchReadinessNarrative({ active: true, negativeCount: 3, totalAnswered: 3 });
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes('3'));
  assert.ok(lines[0].toLowerCase().includes('meczow'));
  assert.ok(lines[0].toLowerCase().includes('nigdy jako samodzielny alarm') || lines[0].toLowerCase().includes('alarm'));
});

scenario('narracja: null/undefined -> zero linii, nie wybucha', () => {
  assert.strictEqual(buildMatchReadinessNarrative(null).length, 0);
  assert.strictEqual(buildMatchReadinessNarrative(undefined).length, 0);
});

console.log('');
if (failures > 0) {
  console.log(`${failures} scenariusz(y) nieudane.`);
  process.exit(1);
} else {
  console.log('Wszystkie scenariusze zaliczone.');
}
