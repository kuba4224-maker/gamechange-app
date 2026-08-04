// ============================================================
// test-coach-recommendation-loop.js — testy jednostkowe
// lib/coach-recommendation-loop.js
// ============================================================
// Uruchom: node tests/test-coach-recommendation-loop.js
// Czyste funkcje, bez sieci/DOM — nic tu nie wymaga atrapowania zależności.
// ============================================================
const assert = require('assert');
const {
  isValidCoachAssessmentLabel,
  coachAssessmentRequiresComment,
  decideCoachRecommendationAction,
  buildReinforcementPatch,
  buildCoachRecommendationInsert,
  buildPlayerInsightUpsert,
} = require('../lib/coach-recommendation-loop');

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

const NOW_ISO = '2026-08-10T12:00:00.000Z';

console.log('1. decideCoachRecommendationAction — reguła łączenia (Warstwa 4)');

check('istnieje najnowszy training_focus na tym segmencie -> reinforce, z jego id', () => {
  const r = decideCoachRecommendationAction({ latestTrainingFocusForSegment: { id: 42 } });
  assert.deepStrictEqual(r, { action: 'reinforce', targetRecommendationId: 42 });
});
check('brak training_focus na tym segmencie -> insert_new', () => {
  const r = decideCoachRecommendationAction({ latestTrainingFocusForSegment: null });
  assert.deepStrictEqual(r, { action: 'insert_new' });
});
check('undefined zamiast null -> również insert_new (brak nie musi być jawnym null)', () => {
  const r = decideCoachRecommendationAction({});
  assert.deepStrictEqual(r, { action: 'insert_new' });
});
check('id=0 traktowane jako prawidłowe id (falsy, ale != null) -> reinforce', () => {
  const r = decideCoachRecommendationAction({ latestTrainingFocusForSegment: { id: 0 } });
  assert.deepStrictEqual(r, { action: 'reinforce', targetRecommendationId: 0 });
});

console.log('2. buildReinforcementPatch — payload PATCH (tylko 2 kolumny)');

check('komentarz przycinany, puste pole -> null (nie pusty string)', () => {
  const p = buildReinforcementPatch({ comment: '   ', nowIso: NOW_ISO });
  assert.deepStrictEqual(p, { reinforced_by_coach_at: NOW_ISO, reinforced_by_coach_comment: null });
});
check('komentarz z treścią zachowany, przycięty', () => {
  const p = buildReinforcementPatch({ comment: '  Dobra robota  ', nowIso: NOW_ISO });
  assert.strictEqual(p.reinforced_by_coach_comment, 'Dobra robota');
  assert.strictEqual(p.reinforced_by_coach_at, NOW_ISO);
});
check('payload ma DOKŁADNIE 2 klucze (nie da się przypadkiem wysłać więcej)', () => {
  const p = buildReinforcementPatch({ comment: 'x', nowIso: NOW_ISO });
  assert.deepStrictEqual(Object.keys(p).sort(), ['reinforced_by_coach_at', 'reinforced_by_coach_comment']);
});

console.log('3. buildCoachRecommendationInsert — payload POST (nowy wiersz)');

check('poprawne dane -> poprawny payload', () => {
  const p = buildCoachRecommendationInsert({
    playerUserId: 'user-1', segmentId: 'moc', recommendationText: '  Pracuj nad mocą.  ', nowIso: NOW_ISO,
  });
  assert.deepStrictEqual(p, {
    user_id: 'user-1',
    recommendation_type: 'coach_recommendation',
    content_source: 'coach',
    segment_id: 'moc',
    recommendation_text: 'Pracuj nad mocą.',
    created_at: NOW_ISO,
  });
});
check('brak playerUserId -> rzuca błąd', () => {
  assert.throws(() => buildCoachRecommendationInsert({ segmentId: 'moc', recommendationText: 'x', nowIso: NOW_ISO }));
});
check('brak segmentId -> rzuca błąd', () => {
  assert.throws(() => buildCoachRecommendationInsert({ playerUserId: 'u', recommendationText: 'x', nowIso: NOW_ISO }));
});
check('pusta/białoznakowa treść -> rzuca błąd (nie zapisujemy pustej rekomendacji)', () => {
  assert.throws(() => buildCoachRecommendationInsert({ playerUserId: 'u', segmentId: 'moc', recommendationText: '   ', nowIso: NOW_ISO }));
});

console.log('4. Etykiety oceny trenera — te same 4, co zna zawodnik z diagnozy');

check('wszystkie 4 etykiety uznane za prawidłowe', () => {
  ['w_punkt', 'blisko', 'czesciowo', 'nie_do_konca'].forEach(l => assert.strictEqual(isValidCoachAssessmentLabel(l), true));
});
check('nieznana etykieta -> nieprawidłowa', () => {
  assert.strictEqual(isValidCoachAssessmentLabel('cos_innego'), false);
});
check('tylko 2 niższe oceny wymagają komentarza', () => {
  assert.strictEqual(coachAssessmentRequiresComment('w_punkt'), false);
  assert.strictEqual(coachAssessmentRequiresComment('blisko'), false);
  assert.strictEqual(coachAssessmentRequiresComment('czesciowo'), true);
  assert.strictEqual(coachAssessmentRequiresComment('nie_do_konca'), true);
});

console.log('5. buildPlayerInsightUpsert — payload UPSERT do player_insights');

check('poprawne dane, ocena wysoka bez komentarza -> poprawny payload', () => {
  const p = buildPlayerInsightUpsert({
    playerEmail: 'gracz@example.com', playerUserId: 'user-1', segmentId: 'moc',
    responseValue: 'w_punkt', responseComment: '', nowIso: NOW_ISO,
  });
  assert.deepStrictEqual(p, {
    player_email: 'gracz@example.com',
    user_id: 'user-1',
    source: 'coach',
    segment_id: 'moc',
    response_value: 'w_punkt',
    response_comment: null,
    created_at: NOW_ISO,
  });
});
check('brak playerEmail -> rzuca błąd (kolumna NOT NULL w bazie)', () => {
  assert.throws(() => buildPlayerInsightUpsert({
    segmentId: 'moc', responseValue: 'w_punkt', nowIso: NOW_ISO,
  }));
});
check('ocena "czesciowo" bez komentarza -> rzuca błąd', () => {
  assert.throws(() => buildPlayerInsightUpsert({
    playerEmail: 'g@example.com', segmentId: 'moc', responseValue: 'czesciowo', responseComment: '  ', nowIso: NOW_ISO,
  }));
});
check('ocena "czesciowo" z komentarzem -> przechodzi', () => {
  const p = buildPlayerInsightUpsert({
    playerEmail: 'g@example.com', segmentId: 'moc', responseValue: 'czesciowo', responseComment: 'Wciąż niepewny w defensywie.', nowIso: NOW_ISO,
  });
  assert.strictEqual(p.response_comment, 'Wciąż niepewny w defensywie.');
});
check('nieprawidłowa etykieta oceny -> rzuca błąd', () => {
  assert.throws(() => buildPlayerInsightUpsert({
    playerEmail: 'g@example.com', segmentId: 'moc', responseValue: 'cos_innego', nowIso: NOW_ISO,
  }));
});
check('brak playerUserId -> user_id: null w payloadzie (dopuszczalne, kolumna nullable)', () => {
  const p = buildPlayerInsightUpsert({
    playerEmail: 'g@example.com', segmentId: 'moc', responseValue: 'w_punkt', nowIso: NOW_ISO,
  });
  assert.strictEqual(p.user_id, null);
});

if (process.exitCode) {
  console.error('\nNIEKTÓRE TESTY NIE PRZESZŁY.');
} else {
  console.log(`\nWSZYSTKIE TESTY PRZESZŁY (${passed}).`);
}
