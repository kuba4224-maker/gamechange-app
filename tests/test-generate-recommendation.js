// ============================================================
// GAMECHANGE — tests/test-generate-recommendation.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, siódma runda — kontynuacja "Pracuj dalej").
// generate-recommendation.js to RDZEŃ silnika AI Centrum Decyzji — 1288
// linii, największy plik w całym projekcie — a dotąd miał tylko WĄSKIE
// pokrycie: test-generate-recommendation-match-readiness.js (istniejący,
// nie mój) testuje WYŁĄCZNIE computeMatchReadinessSignal/
// buildMatchReadinessNarrative (wymiar meczowy Gotowości, dodany
// 03.08.2026). Wszystko inne w tym pliku — w tym CZTERY niezależne bramki
// kontroli kosztów (chroniące budżet na wywołania Anthropic) i licznik
// serii odrzuceń (steruje tonem AI) — było dotąd WYŁĄCZNIE stubowane w
// plikach, które go importują (submit-recommendation-feedback.js,
// cron-onboard-diagnosis.js), nigdy testowane pod kątem WŁASNEJ
// poprawności. Ten plik to domyka.
//
// ŚWIADOMIE NIE POWTARZAMY TUTAJ (już pokryte gdzie indziej, zero wartości
// z duplikowania):
//   - computeReadinessSignals/buildReadinessNarrative/fetchReadinessWindowLogs
//     — jawnie udokumentowana "kopiowana 1:1" duplikacja z
//     generate-focus-block-dosing.js, już 48 testów w
//     test-generate-focus-block-dosing.js pokrywa DOKŁADNIE tę samą logikę.
//   - fetchRecentMatchContextAnswers/computeMatchReadinessSignal/
//     buildMatchReadinessNarrative/MATCH_NEGATIVE_OUTCOME_CODES — już ma
//     własny, dedykowany plik (test-generate-recommendation-match-
//     readiness.js), działający na komputerze Kuby (w tej piaskownicy
//     pada wyłącznie z powodu braku node_modules, nie regresja).
//   - `generateRecommendation()` sama w sobie (orkiestrator) i
//     `callAnthropic` — wymagałyby atrapy globalnego `fetch` dla
//     odpowiedzi Anthropic, poza ustalonym w tym projekcie zakresem
//     testów (patrz reszta plików w tym folderze).
//
// Uruchomienie: node tests/test-generate-recommendation.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- Atrapa @supabase/supabase-js (pakiet niezainstalowany w tym środowisku) ---
const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_11__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath, filename: supabaseStubPath, loaded: true,
  exports: { createClient: () => null },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

const {
  computeRelativeDeficits, pickLowestScoringSegment,
  resolveSuggestedSpecialistCategory, SEGMENT_TO_SPECIALIST_CATEGORY, INJURY_MODE_OVERRIDE_CATEGORY,
  checkHardDailyCap, checkTrainingFocusCadence, checkPainPatternCooldown,
  checkFeedbackEscalationNotYetFired, computeRejectionStreak,
  fetchKnowledgeBase, resolveGoalSegment,
  buildSystemPrompt, SEG_NAMES,
} = require('../api/generate-recommendation.js')._internal;

Module._resolveFilename = originalResolveFilename;

// --- Generyczna atrapa Supabase (wystarcza dla wszystkich zapytań testowanych tu) ---
function makeFakeSupabase(tables = {}, errors = {}) {
  const state = {};
  for (const [k, v] of Object.entries(tables)) state[k] = v.map((r) => ({ ...r }));
  return {
    _state: state,
    from(table) {
      if (!state[table]) state[table] = [];
      const filters = [];
      let countMode = false;
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
        select(cols, opts) { if (opts && opts.count) countMode = true; return builder; },
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        gte(col, val) { filters.push((r) => r[col] >= val); return builder; },
        gt(col, val) { filters.push((r) => r[col] > val); return builder; },
        is(col, val) { if (val === null) filters.push((r) => r[col] == null); return builder; },
        order(col, opts) { orderSpecs.push({ col, ascending: !opts || opts.ascending !== false }); return builder; },
        limit(n) { limitN = n; return builder; },
        maybeSingle() {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
          const rows = applyFilters();
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve, reject) {
          if (errors[table]) return Promise.resolve({ data: null, count: null, error: errors[table] }).then(resolve, reject);
          const rows = applyFilters();
          if (countMode) return Promise.resolve({ data: null, count: rows.length, error: null }).then(resolve, reject);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function hoursAgoIso(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
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
  console.log('generate-recommendation.js — testy jednostkowe (rdzeń silnika AI Centrum Decyzji)');

  console.log('\n1. computeRelativeDeficits — wykrywanie deficytu (mediana ± 0.5×stdDev, min. gap 9 pkt)');

  await scenario('jeden segment WYRAŹNIE poniżej reszty -> wykryty jako deficyt', () => {
    const scores = { moc: 75, wytrzymalosc: 75, fizycznosc: 75, techFund: 75, techSpec: 75, tolerancja: 75, regeneracja: 75, odpornosc: 75, odzywianie: 75, koncentracja: 75, mental: 75, percepcja: 75, decyzja: 40 };
    const deficits = computeRelativeDeficits(scores, 4);
    assert.strictEqual(deficits.length, 1);
    assert.strictEqual(deficits[0][0], 'decyzja');
    assert.strictEqual(deficits[0][1], 40);
  });

  await scenario('profil całkowicie wyrównany (wszystkie równe) -> brak deficytu', () => {
    const scores = { moc: 70, wytrzymalosc: 70, fizycznosc: 70 };
    assert.deepStrictEqual(computeRelativeDeficits(scores), []);
  });

  await scenario('różnica poniżej progu MIN_ABS_GAP=9 -> NIE liczy się jako deficyt mimo niższego wyniku', () => {
    // Rozrzut mały, gap < 9 -> nie powinno przejść progu "meaningfulGap".
    const scores = { a: 70, b: 71, c: 69, d: 68, e: 72 };
    assert.deepStrictEqual(computeRelativeDeficits(scores), []);
  });

  await scenario('limit parametru respektowany (więcej niż limit deficytów -> obcięte)', () => {
    // 9 segmentów w normie (75) + 4 wyraźnie poniżej -> wszystkie 4 powinny przejść próg,
    // limit=2 obcina do dwóch najgorszych.
    const scores = { s1: 20, s2: 22, s3: 24, s4: 26, n1: 75, n2: 75, n3: 75, n4: 75, n5: 75, n6: 75, n7: 75, n8: 75, n9: 75 };
    const deficits = computeRelativeDeficits(scores, 2);
    assert.strictEqual(deficits.length, 2);
    assert.strictEqual(deficits[0][0], 's1');
    assert.strictEqual(deficits[1][0], 's2');
  });

  await scenario('wyniki posortowane rosnąco (najgorszy segment pierwszy)', () => {
    const scores = { a: 90, b: 20, c: 30, d: 90, e: 90 };
    const deficits = computeRelativeDeficits(scores, 4);
    assert.strictEqual(deficits[0][0], 'b', 'segment "b" (20 pkt, najgorszy) musi być pierwszy');
    assert.ok(deficits[0][1] <= deficits[deficits.length - 1][1], 'kolejność musi być rosnąca wg wyniku');
  });

  await scenario('pusty obiekt scores -> []', () => {
    assert.deepStrictEqual(computeRelativeDeficits({}), []);
  });

  await scenario('scores=null -> [] (nie wybucha)', () => {
    assert.deepStrictEqual(computeRelativeDeficits(null), []);
  });

  console.log('\n2. pickLowestScoringSegment — fallback gdy profil wyrównany');

  await scenario('zwraca segment o najniższym wyniku', () => {
    assert.strictEqual(pickLowestScoringSegment({ a: 80, b: 30, c: 90 }), 'b');
  });

  await scenario('remis na najniższym wyniku -> zwraca pierwszy w kolejności wejściowej', () => {
    assert.strictEqual(pickLowestScoringSegment({ x: 50, y: 20, z: 20 }), 'y');
  });

  await scenario('pusty obiekt -> null', () => {
    assert.strictEqual(pickLowestScoringSegment({}), null);
  });

  await scenario('null -> null (nie wybucha)', () => {
    assert.strictEqual(pickLowestScoringSegment(null), null);
  });

  console.log('\n3. resolveSuggestedSpecialistCategory — mapowanie segment→kategoria Marketplace');

  await scenario('segment fizyczny -> strength_conditioning', () => {
    assert.strictEqual(resolveSuggestedSpecialistCategory('moc', false), 'strength_conditioning');
  });

  await scenario('regeneracja/odpornosc -> nutrition (POPRAWIONE względem starszej wersji physiotherapy)', () => {
    assert.strictEqual(resolveSuggestedSpecialistCategory('regeneracja', false), 'nutrition');
    assert.strictEqual(resolveSuggestedSpecialistCategory('odpornosc', false), 'nutrition');
  });

  await scenario('tryb kontuzji AKTYWNY, segment ma override -> orthopedics (NADPISUJE normalne mapowanie)', () => {
    assert.strictEqual(resolveSuggestedSpecialistCategory('moc', true), 'orthopedics');
  });

  await scenario('tryb kontuzji AKTYWNY, ale segment BEZ override (np. koncentracja) -> normalne mapowanie', () => {
    assert.strictEqual(resolveSuggestedSpecialistCategory('koncentracja', true), 'sports_psychology');
  });

  await scenario('brak segmentId -> null', () => {
    assert.strictEqual(resolveSuggestedSpecialistCategory(null, false), null);
  });

  await scenario('segment nieznany -> null (nie rzuca)', () => {
    assert.strictEqual(resolveSuggestedSpecialistCategory('segment-obcy', false), null);
  });

  await scenario('SEGMENT_TO_SPECIALIST_CATEGORY pokrywa wszystkie 13 segmentów', () => {
    assert.strictEqual(Object.keys(SEGMENT_TO_SPECIALIST_CATEGORY).length, 13);
  });

  console.log('\n4. Kontrola kosztów — checkHardDailyCap (twardy limit 5 wywołań/dobę)');

  await scenario('poniżej limitu (4 w ciągu 24h) -> allowed', async () => {
    const supabase = makeFakeSupabase({ decision_recommendations: Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, user_id: 'u1', created_at: hoursAgoIso(1) })) });
    const r = await checkHardDailyCap(supabase, 'u1');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('dokładnie 5 w ciągu 24h -> blocked (próg to >=5)', async () => {
    const supabase = makeFakeSupabase({ decision_recommendations: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, user_id: 'u1', created_at: hoursAgoIso(1) })) });
    const r = await checkHardDailyCap(supabase, 'u1');
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /Twardy limit/);
  });

  await scenario('wywołania SPRZED 24h nie liczą się do limitu', async () => {
    const supabase = makeFakeSupabase({ decision_recommendations: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, user_id: 'u1', created_at: hoursAgoIso(30) })) });
    const r = await checkHardDailyCap(supabase, 'u1');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('błąd zapytania -> rzuca (nie połyka cicho)', async () => {
    const supabase = makeFakeSupabase({}, { decision_recommendations: { message: 'timeout' } });
    await assert.rejects(() => checkHardDailyCap(supabase, 'u1'), /checkHardDailyCap: timeout/);
  });

  console.log('\n5. checkTrainingFocusCadence (limit 24h na training_focus)');

  await scenario('brak training_focus w ostatnich 24h -> allowed', async () => {
    const supabase = makeFakeSupabase({ decision_recommendations: [] });
    const r = await checkTrainingFocusCadence(supabase, 'u1');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('training_focus już wygenerowany w ostatnich 24h -> blocked', async () => {
    const supabase = makeFakeSupabase({ decision_recommendations: [{ id: 'r1', user_id: 'u1', recommendation_type: 'training_focus', created_at: hoursAgoIso(2) }] });
    const r = await checkTrainingFocusCadence(supabase, 'u1');
    assert.strictEqual(r.allowed, false);
  });

  await scenario('inny typ rekomendacji (specialist_referral) w ostatnich 24h -> NIE blokuje training_focus', async () => {
    const supabase = makeFakeSupabase({ decision_recommendations: [{ id: 'r1', user_id: 'u1', recommendation_type: 'specialist_referral', created_at: hoursAgoIso(2) }] });
    const r = await checkTrainingFocusCadence(supabase, 'u1');
    assert.strictEqual(r.allowed, true);
  });

  console.log('\n6. checkPainPatternCooldown (14 dni, tylko OTWARTE skierowania bez feedbacku)');

  await scenario('brak bodyLocation -> rzuca', async () => {
    const supabase = makeFakeSupabase({});
    await assert.rejects(() => checkPainPatternCooldown(supabase, 'u1', null), /brak relatedBodyLocation/);
  });

  await scenario('otwarte skierowanie (bez feedbacku) z ostatnich 14 dni -> blocked', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [{ id: 'r1', user_id: 'u1', recommendation_type: 'specialist_referral', referral_reason: 'pain_pattern_match', related_body_location: 'kolano', feedback_response: null, created_at: daysAgoIso(3) }],
    });
    const r = await checkPainPatternCooldown(supabase, 'u1', 'kolano');
    assert.strictEqual(r.allowed, false);
  });

  await scenario('skierowanie MA już feedback -> nie blokuje (uznane za zamknięte)', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [{ id: 'r1', user_id: 'u1', recommendation_type: 'specialist_referral', referral_reason: 'pain_pattern_match', related_body_location: 'kolano', feedback_response: 'done', created_at: daysAgoIso(3) }],
    });
    const r = await checkPainPatternCooldown(supabase, 'u1', 'kolano');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('skierowanie starsze niż 14 dni -> nie blokuje', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [{ id: 'r1', user_id: 'u1', recommendation_type: 'specialist_referral', referral_reason: 'pain_pattern_match', related_body_location: 'kolano', feedback_response: null, created_at: daysAgoIso(20) }],
    });
    const r = await checkPainPatternCooldown(supabase, 'u1', 'kolano');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('skierowanie dla INNEJ lokalizacji bólu -> nie blokuje', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [{ id: 'r1', user_id: 'u1', recommendation_type: 'specialist_referral', referral_reason: 'pain_pattern_match', related_body_location: 'lokiec', feedback_response: null, created_at: daysAgoIso(3) }],
    });
    const r = await checkPainPatternCooldown(supabase, 'u1', 'kolano');
    assert.strictEqual(r.allowed, true);
  });

  console.log('\n7. checkFeedbackEscalationNotYetFired (chroni przed powtórną eskalacją bez resetu)');

  await scenario('brak segmentId -> rzuca', async () => {
    const supabase = makeFakeSupabase({});
    await assert.rejects(() => checkFeedbackEscalationNotYetFired(supabase, 'u1', null), /brak segmentId/);
  });

  await scenario('nigdy nie eskalowano dla tego segmentu -> allowed', async () => {
    const supabase = makeFakeSupabase({ decision_recommendations: [] });
    const r = await checkFeedbackEscalationNotYetFired(supabase, 'u1', 'moc');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('eskalacja już wystrzelona, BRAK resetu (żaden "done" po niej) -> blocked', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { id: 'e1', user_id: 'u1', recommendation_type: 'specialist_referral', referral_reason: 'feedback_escalation', segment_id: 'moc', created_at: daysAgoIso(5) },
      ],
    });
    const r = await checkFeedbackEscalationNotYetFired(supabase, 'u1', 'moc');
    assert.strictEqual(r.allowed, false);
  });

  await scenario('eskalacja wystrzelona, ALE potem zawodnik dostał "done" na tym segmencie -> reset, allowed', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { id: 'e1', user_id: 'u1', recommendation_type: 'specialist_referral', referral_reason: 'feedback_escalation', segment_id: 'moc', created_at: daysAgoIso(5) },
        { id: 'r2', user_id: 'u1', segment_id: 'moc', feedback_response: 'done', created_at: daysAgoIso(2) },
      ],
    });
    const r = await checkFeedbackEscalationNotYetFired(supabase, 'u1', 'moc');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('"done" PRZED eskalacją (nie po) -> NIE liczy się jako reset, wciąż blocked', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { id: 'r0', user_id: 'u1', segment_id: 'moc', feedback_response: 'done', created_at: daysAgoIso(10) },
        { id: 'e1', user_id: 'u1', recommendation_type: 'specialist_referral', referral_reason: 'feedback_escalation', segment_id: 'moc', created_at: daysAgoIso(5) },
      ],
    });
    const r = await checkFeedbackEscalationNotYetFired(supabase, 'u1', 'moc');
    assert.strictEqual(r.allowed, false);
  });

  console.log('\n8. computeRejectionStreak (steruje tonem AI: 1x bez zmian, 2x pytający, 3+ eskalacja gdzie indziej)');

  await scenario('brak historii -> streak=0', async () => {
    const supabase = makeFakeSupabase({ decision_recommendations: [] });
    const streak = await computeRejectionStreak(supabase, 'u1', 'moc');
    assert.strictEqual(streak, 0);
  });

  await scenario('3 odrzucenia z rzędu (najnowsze pierwsze) -> streak=3', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'did_not_make_sense', created_at: daysAgoIso(1) },
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'did_not_make_sense', created_at: daysAgoIso(2) },
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'did_not_make_sense', created_at: daysAgoIso(3) },
      ],
    });
    const streak = await computeRejectionStreak(supabase, 'u1', 'moc');
    assert.strictEqual(streak, 3);
  });

  await scenario('seria przerwana przez inny feedback -> liczy TYLKO od góry do przerwy', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'did_not_make_sense', created_at: daysAgoIso(1) },
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'did_not_make_sense', created_at: daysAgoIso(2) },
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'done', created_at: daysAgoIso(3) }, // przerywa serię
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'did_not_make_sense', created_at: daysAgoIso(4) }, // nie powinno się już liczyć
      ],
    });
    const streak = await computeRejectionStreak(supabase, 'u1', 'moc');
    assert.strictEqual(streak, 2);
  });

  await scenario('najnowszy feedback NIE jest odrzuceniem -> streak=0 nawet jeśli starsze były odrzuceniami', async () => {
    const supabase = makeFakeSupabase({
      decision_recommendations: [
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'done', created_at: daysAgoIso(1) },
        { user_id: 'u1', recommendation_type: 'training_focus', segment_id: 'moc', feedback_response: 'did_not_make_sense', created_at: daysAgoIso(2) },
      ],
    });
    const streak = await computeRejectionStreak(supabase, 'u1', 'moc');
    assert.strictEqual(streak, 0);
  });

  console.log('\n9. fetchKnowledgeBase / resolveGoalSegment (proste odczyty z atrapą Supabase)');

  await scenario('fetchKnowledgeBase: brak segmentId -> null, BEZ zapytania do bazy', async () => {
    const supabase = makeFakeSupabase({ knowledge_base_entries: [{ segment_id: 'moc', content: 'X' }] });
    const r = await fetchKnowledgeBase(supabase, null);
    assert.strictEqual(r, null);
  });

  await scenario('fetchKnowledgeBase: segment istnieje -> zwraca content', async () => {
    const supabase = makeFakeSupabase({ knowledge_base_entries: [{ segment_id: 'moc', content: 'Baza wiedzy o mocy' }] });
    const r = await fetchKnowledgeBase(supabase, 'moc');
    assert.strictEqual(r, 'Baza wiedzy o mocy');
  });

  await scenario('fetchKnowledgeBase: segment nie istnieje -> null', async () => {
    const supabase = makeFakeSupabase({ knowledge_base_entries: [] });
    const r = await fetchKnowledgeBase(supabase, 'moc');
    assert.strictEqual(r, null);
  });

  await scenario('resolveGoalSegment: brak goalId -> null', async () => {
    const supabase = makeFakeSupabase({});
    const r = await resolveGoalSegment(supabase, null);
    assert.strictEqual(r, null);
  });

  await scenario('resolveGoalSegment: cel nie istnieje -> rzuca', async () => {
    const supabase = makeFakeSupabase({ goals: [] });
    await assert.rejects(() => resolveGoalSegment(supabase, 'brak-takiego'), /nie istnieje/);
  });

  await scenario('resolveGoalSegment: cel istnieje, ale status != active -> rzuca (naprawiony bug z audytu)', async () => {
    const supabase = makeFakeSupabase({ goals: [{ id: 'g1', segment_id: 'moc', status: 'abandoned' }] });
    await assert.rejects(() => resolveGoalSegment(supabase, 'g1'), /nie jest aktywny \(status=abandoned\)/);
  });

  await scenario('resolveGoalSegment: cel aktywny -> zwraca segment_id', async () => {
    const supabase = makeFakeSupabase({ goals: [{ id: 'g1', segment_id: 'wytrzymalosc', status: 'active' }] });
    const r = await resolveGoalSegment(supabase, 'g1');
    assert.strictEqual(r, 'wytrzymalosc');
  });

  console.log('\n10. buildSystemPrompt — filozofia, ton, format JSON per typ rekomendacji');

  await scenario('ton domyślny (assertive) używany, gdy confidenceTone != "questioning"', () => {
    const p = buildSystemPrompt({ recommendationType: 'training_focus', knowledgeBaseContent: null, confidenceTone: null });
    assert.match(p, /Formułuj rekomendację asertywnie i wprost/);
  });

  await scenario('ton "questioning" -> instrukcja złagodzenia tonu (po 2 odrzuceniach z rzędu)', () => {
    const p = buildSystemPrompt({ recommendationType: 'training_focus', knowledgeBaseContent: null, confidenceTone: 'questioning' });
    assert.match(p, /Złagodź ton/);
  });

  await scenario('knowledgeBaseContent podany -> wstrzyknięty jako "źródło prawdy"', () => {
    const p = buildSystemPrompt({ recommendationType: 'training_focus', knowledgeBaseContent: 'TREŚĆ BAZY WIEDZY XYZ', confidenceTone: null });
    assert.match(p, /TREŚĆ BAZY WIEDZY XYZ/);
    assert.match(p, /źródło prawdy/);
  });

  await scenario('knowledgeBaseContent brak -> BEZ bloku bazy wiedzy', () => {
    const p = buildSystemPrompt({ recommendationType: 'training_focus', knowledgeBaseContent: null, confidenceTone: null });
    assert.doesNotMatch(p, /źródło prawdy/);
  });

  await scenario('recommendationType="training_focus" -> format JSON z weekly_focus_text', () => {
    const p = buildSystemPrompt({ recommendationType: 'training_focus', knowledgeBaseContent: null, confidenceTone: null });
    assert.match(p, /weekly_focus_text/);
  });

  await scenario('recommendationType="specialist_referral" -> format BEZ weekly_focus_text, PLUS ostrzeżenie "ostrożna sugestia, nie alarm"', () => {
    const p = buildSystemPrompt({ recommendationType: 'specialist_referral', knowledgeBaseContent: null, confidenceTone: null });
    assert.doesNotMatch(p, /weekly_focus_text/);
    assert.match(p, /OSTROŻNA sugestia, nie alarm/);
    // Fraza "prawdopodobnie masz nawrót kontuzji" CELOWO występuje w promptcie —
    // ale wyłącznie jako część instrukcji "nigdy tak nie pisz" dla AI, nie jako
    // treść, którą prompt sam sugeruje. Sprawdzamy więc kontekst "nigdy", a nie
    // brak samej frazy.
    assert.match(p, /nigdy ["']prawdopodobnie masz nawrót kontuzji["']/);
  });

  await scenario('filozofia "NAWIGATOREM, nie planistą" zawsze obecna (nienaruszalna)', () => {
    const p = buildSystemPrompt({ recommendationType: 'training_focus', knowledgeBaseContent: null, confidenceTone: null });
    assert.match(p, /NAWIGATOREM, nie planistą/);
  });

  await scenario('kontekst snu (próg B1, "7-8h to NIE optymalny wynik") zawsze obecny, niezależnie od typu', () => {
    const p1 = buildSystemPrompt({ recommendationType: 'training_focus', knowledgeBaseContent: null, confidenceTone: null });
    const p2 = buildSystemPrompt({ recommendationType: 'specialist_referral', knowledgeBaseContent: null, confidenceTone: null });
    assert.match(p1, /7-8h snu/);
    assert.match(p2, /7-8h snu/);
  });

  console.log('\n11. SEG_NAMES — kompletność (13 segmentów, wielkie litery — inna konwencja niż inne pliki, sprawdzone celowo)');

  await scenario('zawiera dokładnie 13 segmentów z niepustymi etykietami', () => {
    assert.strictEqual(Object.keys(SEG_NAMES).length, 13);
    Object.values(SEG_NAMES).forEach((label) => assert.ok(label && label.length > 0));
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
