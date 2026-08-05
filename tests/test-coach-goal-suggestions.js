// ============================================================
// test-coach-goal-suggestions.js — testy jednostkowe
// lib/coach-goal-suggestions.js
// ============================================================
// Uruchom: node tests/test-coach-goal-suggestions.js
// Czyste funkcje, bez sieci/DOM — nic tu nie wymaga atrapowania zależności.
// ============================================================
const assert = require('assert');
const {
  GOAL_SUGGESTION_ORIGIN,
  GOAL_SUGGESTION_STATUS,
  validateGoalSuggestionInput,
  buildGoalSuggestionRows,
  isPendingSuggestionConflict,
  canSuggestGoalForSegment,
  describeGoalStatusForCoach,
  summarizeGroupSuggestionResult,
} = require('../lib/coach-goal-suggestions');

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

const NOW_ISO = '2026-08-04T18:00:00.000Z';

console.log('1. validateGoalSuggestionInput — walidacja formularza przed wysyłką');

check('poprawne dane -> valid', () => {
  const r = validateGoalSuggestionInput({ segmentId: 'moc', playerIds: ['p1'], note: 'Warto popracować.' });
  assert.deepStrictEqual(r, { valid: true, errors: [] });
});
check('brak segmentId -> błąd', () => {
  const r = validateGoalSuggestionInput({ segmentId: '', playerIds: ['p1'] });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('segment')));
});
check('pusta lista zawodników -> błąd', () => {
  const r = validateGoalSuggestionInput({ segmentId: 'moc', playerIds: [] });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('zawodnika')));
});
check('brak playerIds (undefined) -> błąd', () => {
  const r = validateGoalSuggestionInput({ segmentId: 'moc' });
  assert.strictEqual(r.valid, false);
});
check('notatka za długa (>500) -> błąd', () => {
  const r = validateGoalSuggestionInput({ segmentId: 'moc', playerIds: ['p1'], note: 'x'.repeat(501) });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('długa')));
});
check('notatka dokładnie 500 znaków -> dopuszczalna', () => {
  const r = validateGoalSuggestionInput({ segmentId: 'moc', playerIds: ['p1'], note: 'x'.repeat(500) });
  assert.strictEqual(r.valid, true);
});
check('brak notatki (undefined) -> dopuszczalne, notatka opcjonalna', () => {
  const r = validateGoalSuggestionInput({ segmentId: 'moc', playerIds: ['p1'] });
  assert.strictEqual(r.valid, true);
});
check('wiele błędów naraz -> wszystkie zwrócone', () => {
  const r = validateGoalSuggestionInput({ segmentId: '', playerIds: [] });
  assert.strictEqual(r.errors.length, 2);
});

console.log('2. buildGoalSuggestionRows — payload POST do public.goals');

check('pojedynczy zawodnik -> jeden wiersz, suggestion_group_id=null', () => {
  const rows = buildGoalSuggestionRows({
    playerIds: ['player-1'], segmentId: 'moc', note: '  Warto popracować nad mocą.  ',
    coachUserId: 'coach-1', nowIso: NOW_ISO,
  });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    user_id: 'player-1',
    segment_id: 'moc',
    origin: GOAL_SUGGESTION_ORIGIN,
    status: GOAL_SUGGESTION_STATUS,
    is_priority: false,
    suggested_by_coach_user_id: 'coach-1',
    suggested_at: NOW_ISO,
    suggestion_note: 'Warto popracować nad mocą.',
    suggestion_group_id: null,
    created_at: NOW_ISO,
  });
});
check('pojedynczy zawodnik + przekazany suggestionGroupId -> mimo to null (grupa = >1 zawodnik)', () => {
  const rows = buildGoalSuggestionRows({
    playerIds: ['player-1'], segmentId: 'moc', coachUserId: 'coach-1', nowIso: NOW_ISO,
    suggestionGroupId: 'group-abc',
  });
  assert.strictEqual(rows[0].suggestion_group_id, null);
});
check('kilku zawodników -> wiele wierszy, wszystkie ze wspólnym suggestion_group_id', () => {
  const rows = buildGoalSuggestionRows({
    playerIds: ['player-1', 'player-2', 'player-3'], segmentId: 'wytrzymalosc',
    coachUserId: 'coach-1', nowIso: NOW_ISO, suggestionGroupId: 'group-xyz',
  });
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map(r => r.user_id), ['player-1', 'player-2', 'player-3']);
  rows.forEach(r => assert.strictEqual(r.suggestion_group_id, 'group-xyz'));
});
check('is_priority zawsze false (sugestia nigdy nie jest priorytetowa)', () => {
  const rows = buildGoalSuggestionRows({ playerIds: ['p1'], segmentId: 'moc', coachUserId: 'c1', nowIso: NOW_ISO });
  assert.strictEqual(rows[0].is_priority, false);
});
check('pusta/białoznakowa notatka -> null (nie pusty string)', () => {
  const rows = buildGoalSuggestionRows({ playerIds: ['p1'], segmentId: 'moc', note: '   ', coachUserId: 'c1', nowIso: NOW_ISO });
  assert.strictEqual(rows[0].suggestion_note, null);
});
check('brak playerIds -> rzuca błąd', () => {
  assert.throws(() => buildGoalSuggestionRows({ segmentId: 'moc', coachUserId: 'c1', nowIso: NOW_ISO }));
});
check('pusta tablica playerIds -> rzuca błąd', () => {
  assert.throws(() => buildGoalSuggestionRows({ playerIds: [], segmentId: 'moc', coachUserId: 'c1', nowIso: NOW_ISO }));
});
check('brak segmentId -> rzuca błąd', () => {
  assert.throws(() => buildGoalSuggestionRows({ playerIds: ['p1'], coachUserId: 'c1', nowIso: NOW_ISO }));
});
check('brak coachUserId -> rzuca błąd', () => {
  assert.throws(() => buildGoalSuggestionRows({ playerIds: ['p1'], segmentId: 'moc', nowIso: NOW_ISO }));
});
check('brak nowIso -> rzuca błąd', () => {
  assert.throws(() => buildGoalSuggestionRows({ playerIds: ['p1'], segmentId: 'moc', coachUserId: 'c1' }));
});

console.log('3. isPendingSuggestionConflict / canSuggestGoalForSegment — reguła "nie duplikuj sugestii"');

check('brak wierszy na segmencie -> brak konfliktu, można sugerować', () => {
  assert.strictEqual(isPendingSuggestionConflict([]), false);
  assert.strictEqual(canSuggestGoalForSegment([]), true);
});
check('tylko aktywny cel (status=active) -> BRAK konfliktu (sugestia nie przerywa aktywnego celu)', () => {
  const goals = [{ status: 'active', is_priority: true }];
  assert.strictEqual(isPendingSuggestionConflict(goals), false);
  assert.strictEqual(canSuggestGoalForSegment(goals), true);
});
check('istnieje już oczekująca sugestia (status=suggested) -> konflikt, nie można sugerować ponownie', () => {
  const goals = [{ status: 'suggested' }];
  assert.strictEqual(isPendingSuggestionConflict(goals), true);
  assert.strictEqual(canSuggestGoalForSegment(goals), false);
});
check('historia (completed/abandoned) + brak oczekującej -> brak konfliktu', () => {
  const goals = [{ status: 'completed' }, { status: 'abandoned' }];
  assert.strictEqual(canSuggestGoalForSegment(goals), true);
});
check('mieszana historia z jedną oczekującą sugestią -> konflikt', () => {
  const goals = [{ status: 'completed' }, { status: 'active' }, { status: 'suggested' }];
  assert.strictEqual(canSuggestGoalForSegment(goals), false);
});
check('niepoprawny typ wejścia (nie tablica) -> traktowane jako brak konfliktu', () => {
  assert.strictEqual(isPendingSuggestionConflict(null), false);
  assert.strictEqual(isPendingSuggestionConflict(undefined), false);
});

console.log('4. describeGoalStatusForCoach — etykiety statusu na karcie celu');

check('suggested -> "Oczekuje na decyzję zawodnika"', () => {
  assert.strictEqual(describeGoalStatusForCoach('suggested', false), 'Oczekuje na decyzję zawodnika');
});
check('completed -> "Ukończony"', () => {
  assert.strictEqual(describeGoalStatusForCoach('completed', false), 'Ukończony');
});
check('abandoned -> "Porzucony"', () => {
  assert.strictEqual(describeGoalStatusForCoach('abandoned', false), 'Porzucony');
});
check('active + is_priority -> "Priorytetowy, aktywny"', () => {
  assert.strictEqual(describeGoalStatusForCoach('active', true), 'Priorytetowy, aktywny');
});
check('active bez priorytetu -> "Aktywny"', () => {
  assert.strictEqual(describeGoalStatusForCoach('active', false), 'Aktywny');
});
check('nieznany status -> zwraca surową wartość (fallback)', () => {
  assert.strictEqual(describeGoalStatusForCoach('cos_nowego', false), 'cos_nowego');
});

console.log('5. summarizeGroupSuggestionResult — podział zaznaczonych zawodników przed zbiorczym INSERT-em');

check('nikt nie ma jeszcze oczekującej sugestii -> wszyscy do wstawienia', () => {
  const r = summarizeGroupSuggestionResult({ requestedPlayerIds: ['p1', 'p2', 'p3'], alreadyPendingPlayerIds: [] });
  assert.deepStrictEqual(r, { toInsertPlayerIds: ['p1', 'p2', 'p3'], skippedPlayerIds: [], allSkipped: false });
});
check('część zawodników ma już oczekującą sugestię -> pominięci, reszta do wstawienia', () => {
  const r = summarizeGroupSuggestionResult({ requestedPlayerIds: ['p1', 'p2', 'p3'], alreadyPendingPlayerIds: ['p2'] });
  assert.deepStrictEqual(r.toInsertPlayerIds, ['p1', 'p3']);
  assert.deepStrictEqual(r.skippedPlayerIds, ['p2']);
  assert.strictEqual(r.allSkipped, false);
});
check('wszyscy zaznaczeni mają już oczekującą sugestię -> allSkipped=true, pusta lista do wstawienia', () => {
  const r = summarizeGroupSuggestionResult({ requestedPlayerIds: ['p1', 'p2'], alreadyPendingPlayerIds: ['p1', 'p2'] });
  assert.strictEqual(r.allSkipped, true);
  assert.deepStrictEqual(r.toInsertPlayerIds, []);
});
check('brak alreadyPendingPlayerIds (undefined) -> traktowane jako pusta lista', () => {
  const r = summarizeGroupSuggestionResult({ requestedPlayerIds: ['p1'] });
  assert.deepStrictEqual(r.toInsertPlayerIds, ['p1']);
});

if (process.exitCode) {
  console.error('\nNIEKTÓRE TESTY NIE PRZESZŁY.');
} else {
  console.log(`\nWSZYSTKIE TESTY PRZESZŁY (${passed}).`);
}
