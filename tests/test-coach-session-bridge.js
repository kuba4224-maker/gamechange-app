// ============================================================
// test-coach-session-bridge.js — testy jednostkowe
// lib/coach-session-bridge.js
// ============================================================
// Uruchom: node tests/test-coach-session-bridge.js
// Czyste funkcje, bez sieci/DOM — nic tu nie wymaga atrapowania zależności.
// ============================================================
const assert = require('assert');
const {
  COACH_SESSION_UNIT_TYPES,
  MAX_COACH_QUESTION_LENGTH,
  MIN_LOGGERS_FOR_AGGREGATE,
  isValidUnitType,
  isValidSessionDateStr,
  defaultSessionTitle,
  buildCreateSessionPayload,
  buildSessionQuestionPayload,
  buildCancelSessionPayload,
  buildSessionSummaryPayload,
  visibilityTierForSummary,
  computeAggregateStats,
} = require('../lib/coach-session-bridge');

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

console.log('1. isValidUnitType — dokładnie 4 wartości, te same co selektor Filaru A');

check('wszystkie 4 wartości uznane za prawidłowe', () => {
  assert.strictEqual(COACH_SESSION_UNIT_TYPES.length, 4);
  COACH_SESSION_UNIT_TYPES.forEach(u => assert.strictEqual(isValidUnitType(u), true));
});
check('nieznana wartość -> nieprawidłowa', () => {
  assert.strictEqual(isValidUnitType('taktyczna_XX'), false);
});
check('pusta/undefined -> nieprawidłowa', () => {
  assert.strictEqual(isValidUnitType(''), false);
  assert.strictEqual(isValidUnitType(undefined), false);
});

console.log('2. isValidSessionDateStr — format RRRR-MM-DD, odrzuca nieistniejące daty');

check('poprawna data -> prawidłowa', () => {
  assert.strictEqual(isValidSessionDateStr('2026-08-15'), true);
});
check('zły format (DD-MM-RRRR) -> nieprawidłowa', () => {
  assert.strictEqual(isValidSessionDateStr('15-08-2026'), false);
});
check('brak zer wiodących -> nieprawidłowa (musi być dokładnie RRRR-MM-DD)', () => {
  assert.strictEqual(isValidSessionDateStr('2026-8-5'), false);
});
check('nieistniejąca data kalendarzowa (30 lutego) -> nieprawidłowa, mimo że Date() by ją "przewinęło"', () => {
  assert.strictEqual(isValidSessionDateStr('2026-02-30'), false);
});
check('29 lutego w roku przestępnym -> prawidłowa', () => {
  assert.strictEqual(isValidSessionDateStr('2028-02-29'), true);
});
check('29 lutego w roku NIEprzestępnym -> nieprawidłowa', () => {
  assert.strictEqual(isValidSessionDateStr('2026-02-29'), false);
});
check('pusty string / null / liczba -> nieprawidłowa', () => {
  assert.strictEqual(isValidSessionDateStr(''), false);
  assert.strictEqual(isValidSessionDateStr(null), false);
  assert.strictEqual(isValidSessionDateStr(20260815), false);
});

console.log('3. defaultSessionTitle — mapowanie 1:1 z unit_type');

check('każdy z 4 typów ma własny, sensowny tytuł domyślny', () => {
  assert.strictEqual(defaultSessionTitle('silowa'), 'Sesja siłowa');
  assert.strictEqual(defaultSessionTitle('wytrzymalosciowa'), 'Sesja wytrzymałościowa');
  assert.strictEqual(defaultSessionTitle('techniczna'), 'Sesja techniczna');
  assert.strictEqual(defaultSessionTitle('taktyczna'), 'Sesja taktyczna');
});
check('nieznany typ -> null (nie pusty string, nie wyjątek)', () => {
  assert.strictEqual(defaultSessionTitle('cos_innego'), null);
});

console.log('4. buildCreateSessionPayload — payload POST .../rpc/create_coach_planned_session');

check('poprawne dane, wszystkie pola -> poprawny payload', () => {
  const p = buildCreateSessionPayload({
    teamId: 'team-1', unitType: 'techniczna', sessionDate: '2026-08-20',
    title: '  Trening przed sobotą  ', coachQuestion: '  Jak minął tydzień?  ',
  });
  assert.deepStrictEqual(p, {
    p_team_id: 'team-1',
    p_unit_type: 'techniczna',
    p_session_date: '2026-08-20',
    p_title: 'Trening przed sobotą',
    p_coach_question: 'Jak minął tydzień?',
  });
});
check('tytuł i pytanie pominięte -> oba null w payloadzie (default tytuł liczy backend/SQL, nie ten builder)', () => {
  const p = buildCreateSessionPayload({ teamId: 'team-1', unitType: 'silowa', sessionDate: '2026-08-20' });
  assert.strictEqual(p.p_title, null);
  assert.strictEqual(p.p_coach_question, null);
});
check('brak teamId -> rzuca błąd', () => {
  assert.throws(() => buildCreateSessionPayload({ unitType: 'silowa', sessionDate: '2026-08-20' }));
});
check('nieprawidłowy unitType -> rzuca błąd', () => {
  assert.throws(() => buildCreateSessionPayload({ teamId: 't', unitType: 'x', sessionDate: '2026-08-20' }));
});
check('nieprawidłowa data -> rzuca błąd', () => {
  assert.throws(() => buildCreateSessionPayload({ teamId: 't', unitType: 'silowa', sessionDate: '20-08-2026' }));
});
check('pytanie dokładnie na granicy 300 znaków -> przechodzi', () => {
  const q = 'x'.repeat(MAX_COACH_QUESTION_LENGTH);
  const p = buildCreateSessionPayload({ teamId: 't', unitType: 'silowa', sessionDate: '2026-08-20', coachQuestion: q });
  assert.strictEqual(p.p_coach_question.length, MAX_COACH_QUESTION_LENGTH);
});
check('pytanie powyżej 300 znaków -> rzuca błąd', () => {
  const q = 'x'.repeat(MAX_COACH_QUESTION_LENGTH + 1);
  assert.throws(() => buildCreateSessionPayload({ teamId: 't', unitType: 'silowa', sessionDate: '2026-08-20', coachQuestion: q }));
});

console.log('5. buildSessionQuestionPayload — payload POST .../rpc/set_coach_session_question');

check('poprawne dane -> przycięty tekst', () => {
  const p = buildSessionQuestionPayload({ sessionId: 's-1', coachQuestion: '  Co poszło dobrze?  ' });
  assert.deepStrictEqual(p, { p_session_id: 's-1', p_coach_question: 'Co poszło dobrze?' });
});
check('pusty/białoznakowy tekst -> null (czyszczenie pytania, NIE błąd)', () => {
  const p = buildSessionQuestionPayload({ sessionId: 's-1', coachQuestion: '   ' });
  assert.strictEqual(p.p_coach_question, null);
});
check('brak sessionId -> rzuca błąd', () => {
  assert.throws(() => buildSessionQuestionPayload({ coachQuestion: 'x' }));
});
check('tekst powyżej limitu -> rzuca błąd', () => {
  assert.throws(() => buildSessionQuestionPayload({ sessionId: 's-1', coachQuestion: 'x'.repeat(MAX_COACH_QUESTION_LENGTH + 1) }));
});

console.log('6. buildCancelSessionPayload / buildSessionSummaryPayload — trywialne payloady jednopolowe');

check('buildCancelSessionPayload — poprawny payload', () => {
  assert.deepStrictEqual(buildCancelSessionPayload({ sessionId: 's-1' }), { p_session_id: 's-1' });
});
check('buildCancelSessionPayload — brak sessionId rzuca błąd', () => {
  assert.throws(() => buildCancelSessionPayload({}));
});
check('buildSessionSummaryPayload — poprawny payload', () => {
  assert.deepStrictEqual(buildSessionSummaryPayload({ sessionId: 's-1' }), { p_session_id: 's-1' });
});
check('buildSessionSummaryPayload — brak sessionId rzuca błąd', () => {
  assert.throws(() => buildSessionSummaryPayload({}));
});

console.log('7. visibilityTierForSummary — mapowanie poziomu wglądu na strumień jakości sesji (Funkcja 9)');

check('full -> named (imienny)', () => {
  assert.strictEqual(visibilityTierForSummary('full'), 'named');
});
check('extended -> aggregate (zbiorczy, trend)', () => {
  assert.strictEqual(visibilityTierForSummary('extended'), 'aggregate');
});
check('basic -> count_only (wyłącznie frekwencja)', () => {
  assert.strictEqual(visibilityTierForSummary('basic'), 'count_only');
});
check('nieznana wartość / null / undefined -> najbardziej ostrożny wariant (count_only)', () => {
  assert.strictEqual(visibilityTierForSummary('cos_innego'), 'count_only');
  assert.strictEqual(visibilityTierForSummary(null), 'count_only');
  assert.strictEqual(visibilityTierForSummary(undefined), 'count_only');
});

console.log('8. computeAggregateStats — próg minimalny + średnie (referencja dla logiki SQL)');

check('pusta tablica -> loggedCount 0, insufficientForAggregate true, averages null', () => {
  const r = computeAggregateStats([]);
  assert.deepStrictEqual(r, { loggedCount: 0, insufficientForAggregate: true, avgRpe: null, avgPostFatigue: null });
});
check(`poniżej progu (${MIN_LOGGERS_FOR_AGGREGATE - 1} wpisy) -> insufficientForAggregate true, averages null mimo że dane istnieją`, () => {
  const entries = Array.from({ length: MIN_LOGGERS_FOR_AGGREGATE - 1 }, () => ({ rpe: 8, postFatigue: 7 }));
  const r = computeAggregateStats(entries);
  assert.strictEqual(r.insufficientForAggregate, true);
  assert.strictEqual(r.avgRpe, null);
  assert.strictEqual(r.avgPostFatigue, null);
});
check(`dokładnie na progu (${MIN_LOGGERS_FOR_AGGREGATE} wpisy) -> insufficientForAggregate false, liczy średnie`, () => {
  const entries = [{ rpe: 6, postFatigue: 5 }, { rpe: 8, postFatigue: 7 }, { rpe: 7, postFatigue: 6 }];
  const r = computeAggregateStats(entries);
  assert.strictEqual(r.insufficientForAggregate, false);
  assert.strictEqual(r.loggedCount, 3);
  assert.strictEqual(r.avgRpe, 7);
  assert.strictEqual(r.avgPostFatigue, 6);
});
check('powyżej progu, średnia z niedokładnym wynikiem -> zaokrąglona do 1 miejsca po przecinku', () => {
  const entries = [{ rpe: 7, postFatigue: 5 }, { rpe: 8, postFatigue: 6 }, { rpe: 6, postFatigue: 4 }, { rpe: 9, postFatigue: 8 }];
  const r = computeAggregateStats(entries);
  // (7+8+6+9)/4 = 7.5 dokładnie; postFatigue (5+6+4+8)/4 = 5.75 -> 5.8
  assert.strictEqual(r.avgRpe, 7.5);
  assert.strictEqual(r.avgPostFatigue, 5.8);
});
check('brakujące pojedyncze wartości rpe/postFatigue w części wpisów -> liczone tylko z obecnych, nie NaN', () => {
  const entries = [{ rpe: 6 }, { rpe: 8, postFatigue: 7 }, { postFatigue: 5 }];
  const r = computeAggregateStats(entries);
  assert.strictEqual(r.insufficientForAggregate, false);
  assert.strictEqual(r.avgRpe, 7); // (6+8)/2
  assert.strictEqual(r.avgPostFatigue, 6); // (7+5)/2
});
check('brak argumentu / nie-tablica -> traktowane jak pusta lista, bez wyjątku', () => {
  assert.deepStrictEqual(computeAggregateStats(undefined), { loggedCount: 0, insufficientForAggregate: true, avgRpe: null, avgPostFatigue: null });
  assert.deepStrictEqual(computeAggregateStats(null), { loggedCount: 0, insufficientForAggregate: true, avgRpe: null, avgPostFatigue: null });
});

if (process.exitCode) {
  console.error('\nNIEKTÓRE TESTY NIE PRZESZŁY.');
} else {
  console.log(`\nWSZYSTKIE TESTY PRZESZŁY (${passed}).`);
}
