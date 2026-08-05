// ============================================================
// test-coach-feedback-round.js — testy jednostkowe lib/coach-feedback-round.js
// ============================================================
// Uruchom: node tests/test-coach-feedback-round.js
//
// W odróżnieniu od coach-development.js, ten plik NIE woła Anthropic —
// cała logika to DB + czyste funkcje, więc orkiestratory (startFeedbackRound/
// submitFeedbackResponse/getFeedbackRoundResults) SĄ tu testowane w pełni,
// z atrapą Supabase (ten sam wzorzec `makeFakeSupabaseForGrowth` co
// tests/test-generate-coach-tip.js, uogólniony na więcej kształtów
// zapytań: select/insert/update, z terminalami maybeSingle/single albo
// bezpośrednim await bez terminala — patrz makeFakeSupabase() niżej).
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_feedback__.js');
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

const {
  RESULT_UNLOCK_THRESHOLD,
  FEEDBACK_ROUND_QUESTIONS,
  isValidFeedbackAnswers,
  computeResponderHash,
  computeQuestionAggregate,
  buildRoundAggregate,
  buildTrend,
  startFeedbackRound,
  submitFeedbackResponse,
  getFeedbackRoundResults,
  _internal,
} = require('../lib/coach-feedback-round.js');
const { fetchAndAuthorizeTeam } = _internal;

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
// Atrapa Supabase generyczna dla całego pliku. `handlers[table]` to
// funkcja(state) -> {data, error} (albo Promise tego kształtu), gdzie
// `state` opisuje DOKŁADNIE co zbudował łańcuch zapytania (type, filters,
// payload, orderBy, limitN) — pozwala rozróżnić np. SELECT od INSERT na
// tej samej tabeli w tym samym teście. Obsługuje zarówno zapytania
// kończone jawnym terminalem (.maybeSingle()/.single()) jak i zapytania
// await-owane bezpośrednio bez terminala (przez then()).
// ------------------------------------------------------------
function makeFakeSupabase(handlers) {
  return {
    from(table) {
      const state = { table, filters: {}, type: null, payload: undefined, orderBy: null, limitN: null };
      const builder = {
        select(cols) { if (!state.type) state.type = 'select'; state.selectCols = cols; return builder; },
        insert(payload) { state.type = 'insert'; state.payload = payload; return builder; },
        update(payload) { state.type = 'update'; state.payload = payload; return builder; },
        eq(col, val) { state.filters[col] = val; return builder; },
        order(col, opts) { state.orderBy = { col, opts }; return builder; },
        limit(n) { state.limitN = n; return builder; },
        maybeSingle() { return Promise.resolve(handlers[table](state)); },
        single() { return Promise.resolve(handlers[table](state)); },
        then(resolve, reject) { Promise.resolve(handlers[table](state)).then(resolve, reject); },
      };
      return builder;
    },
  };
}

(async () => {
  console.log('coach-feedback-round.js — testy jednostkowe');

  console.log('\n1. FEEDBACK_ROUND_QUESTIONS / isValidFeedbackAnswers');

  await scenario('5 pytań (zakres 4-6 ze zlecenia), każde z >=2 opcjami, żadne nie brzmi jak ocena wprost ("oceń")', () => {
    assert.strictEqual(FEEDBACK_ROUND_QUESTIONS.length, 5);
    FEEDBACK_ROUND_QUESTIONS.forEach((q) => {
      assert.ok(q.options.length >= 2);
      assert.ok(!q.text.toLowerCase().includes('oceń'), `pytanie brzmi jak ocena wprost: "${q.text}"`);
    });
  });

  const VALID_ANSWERS = {
    po_meczu_wiem_co_poprawic: 'tak_konkretnie',
    trener_zauwaza_moj_postep: 'tak_czesto',
    rozumiem_decyzje_o_mojej_roli: 'tak_rozumiem',
    czuje_ze_sie_rozwijam: 'tak_wyraznie',
    latwo_podejsc_z_pytaniem: 'tak_latwo',
  };

  await scenario('pełny, poprawny zestaw odpowiedzi -> valid', () => {
    assert.strictEqual(isValidFeedbackAnswers(VALID_ANSWERS), true);
  });

  await scenario('brakujące pytanie -> invalid', () => {
    const { po_meczu_wiem_co_poprawic, ...rest } = VALID_ANSWERS;
    assert.strictEqual(isValidFeedbackAnswers(rest), false);
  });

  await scenario('nieprawidłowa wartość opcji -> invalid', () => {
    assert.strictEqual(isValidFeedbackAnswers({ ...VALID_ANSWERS, po_meczu_wiem_co_poprawic: 'cos_innego' }), false);
  });

  await scenario('null/undefined/string zamiast obiektu -> invalid, nie wywala się', () => {
    assert.strictEqual(isValidFeedbackAnswers(null), false);
    assert.strictEqual(isValidFeedbackAnswers(undefined), false);
    assert.strictEqual(isValidFeedbackAnswers('x'), false);
  });

  console.log('\n2. computeResponderHash — anonimizacja zawodnika');

  await scenario('deterministyczny: te same round_id+playerUserId -> ten sam hash', () => {
    const h1 = computeResponderHash('round-1', 'player-1');
    const h2 = computeResponderHash('round-1', 'player-1');
    assert.strictEqual(h1, h2);
  });

  await scenario('inny playerUserId -> inny hash', () => {
    const h1 = computeResponderHash('round-1', 'player-1');
    const h2 = computeResponderHash('round-1', 'player-2');
    assert.notStrictEqual(h1, h2);
  });

  await scenario('inny round_id -> inny hash (ten sam zawodnik, inna runda)', () => {
    const h1 = computeResponderHash('round-1', 'player-1');
    const h2 = computeResponderHash('round-2', 'player-1');
    assert.notStrictEqual(h1, h2);
  });

  await scenario('wynik to hex sha256 (64 znaki), nie surowe ID', () => {
    const h = computeResponderHash('round-1', 'player-1');
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!h.includes('player-1'), 'hash nie może zawierać surowego player_user_id');
  });

  await scenario('brak roundId/playerUserId -> rzuca błąd', () => {
    assert.throws(() => computeResponderHash(null, 'player-1'));
    assert.throws(() => computeResponderHash('round-1', null));
  });

  console.log('\n3. computeQuestionAggregate / buildRoundAggregate');

  const Q1 = FEEDBACK_ROUND_QUESTIONS[0];

  await scenario('4 odpowiedzi, 3x najlepsza opcja -> positiveRate=75', () => {
    const responses = [
      { answers: { [Q1.key]: Q1.options[0].value } },
      { answers: { [Q1.key]: Q1.options[0].value } },
      { answers: { [Q1.key]: Q1.options[0].value } },
      { answers: { [Q1.key]: Q1.options[1].value } },
    ];
    const agg = computeQuestionAggregate(Q1, responses);
    assert.strictEqual(agg.total, 4);
    assert.strictEqual(agg.positiveRate, 75);
    assert.strictEqual(agg.counts[Q1.options[0].value], 3);
  });

  await scenario('brak odpowiedzi -> total=0, positiveRate=null (nie NaN)', () => {
    const agg = computeQuestionAggregate(Q1, []);
    assert.strictEqual(agg.total, 0);
    assert.strictEqual(agg.positiveRate, null);
  });

  await scenario('odpowiedź z brakującym/nieznanym kluczem pytania -> ignorowana, nie wywala liczenia', () => {
    const responses = [{ answers: {} }, { answers: { [Q1.key]: 'nieznana_wartosc' } }, { answers: { [Q1.key]: Q1.options[0].value } }];
    const agg = computeQuestionAggregate(Q1, responses);
    assert.strictEqual(agg.total, 3);
    assert.strictEqual(agg.counts[Q1.options[0].value], 1);
  });

  await scenario('buildRoundAggregate zwraca jeden wpis per pytanie (5), w tej samej kolejności co FEEDBACK_ROUND_QUESTIONS', () => {
    const agg = buildRoundAggregate([{ answers: VALID_ANSWERS }]);
    assert.strictEqual(agg.length, 5);
    assert.deepStrictEqual(agg.map((a) => a.questionKey), FEEDBACK_ROUND_QUESTIONS.map((q) => q.key));
  });

  console.log('\n4. buildTrend — trend względem WŁASNEJ historii, nigdy ranking między trenerami');

  await scenario('brak poprzedniej agregacji -> trend=null', () => {
    const current = buildRoundAggregate([{ answers: VALID_ANSWERS }]);
    assert.strictEqual(buildTrend(current, null), null);
  });

  await scenario('poprawa o 20 pkt proc. na pierwszym pytaniu -> delta=+20', () => {
    const responsesGood = Array(5).fill({ answers: VALID_ANSWERS });
    const responsesWorse = [
      ...Array(3).fill({ answers: { ...VALID_ANSWERS, [Q1.key]: Q1.options[1].value } }),
      ...Array(2).fill({ answers: VALID_ANSWERS }),
    ];
    const current = buildRoundAggregate(responsesGood); // 100% na Q1
    const previous = buildRoundAggregate(responsesWorse); // 40% na Q1
    const trend = buildTrend(current, previous);
    const q1Trend = trend.find((t) => t.questionKey === Q1.key);
    assert.strictEqual(q1Trend.delta, 60);
  });

  console.log('\n5. fetchAndAuthorizeTeam');

  await scenario('team.coach_user_id zgadza się z coachUserId -> authorized=true', async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1', code: 'ABC123' }, error: null }),
    });
    const r = await fetchAndAuthorizeTeam(supabase, 'team-1', 'coach-1');
    assert.strictEqual(r.authorized, true);
  });

  await scenario('inny coach_user_id -> authorized=false, team=null', async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-INNY', code: 'ABC123' }, error: null }),
    });
    const r = await fetchAndAuthorizeTeam(supabase, 'team-1', 'coach-1');
    assert.strictEqual(r.authorized, false);
    assert.strictEqual(r.team, null);
  });

  await scenario('drużyna nie istnieje -> authorized=false', async () => {
    const supabase = makeFakeSupabase({ teams: () => ({ data: null, error: null }) });
    const r = await fetchAndAuthorizeTeam(supabase, 'team-1', 'coach-1');
    assert.strictEqual(r.authorized, false);
  });

  await scenario('brak teamId/coachUserId -> rzuca błąd', async () => {
    const supabase = makeFakeSupabase({});
    await assert.rejects(() => fetchAndAuthorizeTeam(supabase, null, 'coach-1'));
    await assert.rejects(() => fetchAndAuthorizeTeam(supabase, 'team-1', null));
  });

  console.log('\n6. startFeedbackRound — "trener inicjuje NA ŻĄDANIE", reużycie vs nowa runda');

  await scenario('drużyna nie należy do trenera -> blocked, żadnego zapisu', async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'kTOS-INNY', code: 'ABC123' }, error: null }),
    });
    const r = await startFeedbackRound({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, true);
  });

  await scenario('brak aktywnej rundy -> tworzy nową, reused=false', async () => {
    let insertCalled = false;
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1', code: 'ABC123' }, error: null }),
      coach_feedback_rounds: (state) => {
        if (state.type === 'select') return { data: null, error: null }; // brak aktywnej
        if (state.type === 'insert') {
          insertCalled = true;
          return { data: { id: 'round-new', team_id: 'team-1', status: 'active' }, error: null };
        }
        throw new Error(`nieoczekiwany typ zapytania: ${state.type}`);
      },
    });
    const r = await startFeedbackRound({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reused, false);
    assert.strictEqual(r.teamCode, 'ABC123');
    assert.strictEqual(insertCalled, true);
  });

  await scenario('aktywna runda już jest, forceNew=false (domyślne) -> REUŻYWA, zero insertu/update', async () => {
    let insertCalled = false;
    let updateCalled = false;
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1', code: 'ABC123' }, error: null }),
      coach_feedback_rounds: (state) => {
        if (state.type === 'select') return { data: { id: 'round-existing', team_id: 'team-1', status: 'active' }, error: null };
        if (state.type === 'insert') { insertCalled = true; return { data: {}, error: null }; }
        if (state.type === 'update') { updateCalled = true; return { data: null, error: null }; }
        throw new Error(`nieoczekiwany typ: ${state.type}`);
      },
    });
    const r = await startFeedbackRound({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.reused, true);
    assert.strictEqual(r.round.id, 'round-existing');
    assert.strictEqual(insertCalled, false);
    assert.strictEqual(updateCalled, false);
  });

  await scenario('aktywna runda już jest, forceNew=true -> ZAMYKA starą (update) i tworzy nową', async () => {
    let updateCalled = false;
    let insertCalled = false;
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1', code: 'ABC123' }, error: null }),
      coach_feedback_rounds: (state) => {
        if (state.type === 'select') return { data: { id: 'round-old', team_id: 'team-1', status: 'active' }, error: null };
        if (state.type === 'update') {
          updateCalled = true;
          assert.strictEqual(state.filters.id, 'round-old');
          assert.strictEqual(state.payload.status, 'closed');
          return { data: null, error: null };
        }
        if (state.type === 'insert') { insertCalled = true; return { data: { id: 'round-new2', status: 'active' }, error: null }; }
        throw new Error(`nieoczekiwany typ: ${state.type}`);
      },
    });
    const r = await startFeedbackRound({ coachUserId: 'coach-1', teamId: 'team-1', forceNew: true }, supabase);
    assert.strictEqual(updateCalled, true);
    assert.strictEqual(insertCalled, true);
    assert.strictEqual(r.reused, false);
    assert.strictEqual(r.round.id, 'round-new2');
  });

  console.log('\n7. submitFeedbackResponse — kanał kodu drużyny, dedup, anonimowość');

  await scenario('nieprawidłowe odpowiedzi -> blocked PRZED jakimkolwiek zapytaniem do bazy', async () => {
    const supabase = makeFakeSupabase({}); // brak handlerów — jeśli cokolwiek zapyta, test się wywali
    const r = await submitFeedbackResponse({ teamCode: 'ABC123', playerUserId: 'player-1', answers: { zla: 'wartosc' } }, supabase);
    assert.strictEqual(r.blocked, true);
  });

  await scenario('nieznany kod drużyny -> blocked', async () => {
    const supabase = makeFakeSupabase({ teams: () => ({ data: null, error: null }) });
    const r = await submitFeedbackResponse({ teamCode: 'NIEISTNIEJE', playerUserId: 'player-1', answers: VALID_ANSWERS }, supabase);
    assert.strictEqual(r.blocked, true);
    assert.match(r.reason, /Nie znaleziono drużyny/);
  });

  await scenario('drużyna istnieje, brak aktywnej rundy -> blocked', async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1' }, error: null }),
      coach_feedback_rounds: () => ({ data: null, error: null }),
    });
    const r = await submitFeedbackResponse({ teamCode: 'ABC123', playerUserId: 'player-1', answers: VALID_ANSWERS }, supabase);
    assert.strictEqual(r.blocked, true);
    assert.match(r.reason, /aktywnej Rundy Opinii/);
  });

  await scenario('happy path -> insert z responder_hash (NIE playerUserId) do coach_feedback_responses', async () => {
    let insertedPayload = null;
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1' }, error: null }),
      coach_feedback_rounds: () => ({ data: { id: 'round-1' }, error: null }),
      coach_feedback_responses: (state) => {
        if (state.type === 'select') return { data: null, error: null }; // brak dedup
        if (state.type === 'insert') { insertedPayload = state.payload; return { data: null, error: null }; }
        throw new Error(`nieoczekiwany typ: ${state.type}`);
      },
    });
    const r = await submitFeedbackResponse({ teamCode: 'ABC123', playerUserId: 'player-1', answers: VALID_ANSWERS }, supabase);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(insertedPayload.round_id, 'round-1');
    assert.strictEqual(insertedPayload.responder_hash, computeResponderHash('round-1', 'player-1'));
    assert.strictEqual(insertedPayload.player_user_id, undefined, 'player_user_id NIGDY nie powinien trafić do payloadu tej tabeli');
    assert.deepStrictEqual(insertedPayload.answers, VALID_ANSWERS);
  });

  await scenario('zawodnik już odpowiedział w tej rundzie (dedup po hashu) -> blocked, brak drugiego insertu', async () => {
    let insertCalled = false;
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1' }, error: null }),
      coach_feedback_rounds: () => ({ data: { id: 'round-1' }, error: null }),
      coach_feedback_responses: (state) => {
        if (state.type === 'select') return { data: { id: 'existing-response' }, error: null };
        if (state.type === 'insert') { insertCalled = true; return { data: null, error: null }; }
        throw new Error(`nieoczekiwany typ: ${state.type}`);
      },
    });
    const r = await submitFeedbackResponse({ teamCode: 'ABC123', playerUserId: 'player-1', answers: VALID_ANSWERS }, supabase);
    assert.strictEqual(r.blocked, true);
    assert.match(r.reason, /Już odpowiedziałeś/);
    assert.strictEqual(insertCalled, false);
  });

  console.log('\n8. getFeedbackRoundResults — gating 5+ odpowiedzi, trend');

  await scenario('drużyna nieautoryzowana -> blocked', async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'ktos-inny' }, error: null }),
    });
    const r = await getFeedbackRoundResults({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.blocked, true);
  });

  await scenario('brak jakiejkolwiek rundy -> hasRound=false', async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1' }, error: null }),
      coach_feedback_rounds: () => ({ data: [], error: null }),
    });
    const r = await getFeedbackRoundResults({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hasRound, false);
  });

  await scenario(`mniej niż ${RESULT_UNLOCK_THRESHOLD} odpowiedzi -> unlocked=false, pokazuje responseCount/threshold`, async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1' }, error: null }),
      coach_feedback_rounds: () => ({ data: [{ id: 'round-1', started_at: '2026-08-01' }], error: null }),
      coach_feedback_responses: () => ({ data: Array(RESULT_UNLOCK_THRESHOLD - 1).fill({ answers: VALID_ANSWERS }), error: null }),
    });
    const r = await getFeedbackRoundResults({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.unlocked, false);
    assert.strictEqual(r.responseCount, RESULT_UNLOCK_THRESHOLD - 1);
    assert.strictEqual(r.threshold, RESULT_UNLOCK_THRESHOLD);
    assert.strictEqual(r.perQuestion, undefined, 'wyniki NIE powinny wyciekać przed progiem');
  });

  await scenario(`dokładnie ${RESULT_UNLOCK_THRESHOLD} odpowiedzi, brak poprzedniej rundy -> unlocked=true, trend=null`, async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1' }, error: null }),
      coach_feedback_rounds: () => ({ data: [{ id: 'round-1', started_at: '2026-08-01' }], error: null }),
      coach_feedback_responses: () => ({ data: Array(RESULT_UNLOCK_THRESHOLD).fill({ answers: VALID_ANSWERS }), error: null }),
    });
    const r = await getFeedbackRoundResults({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.unlocked, true);
    assert.strictEqual(r.responseCount, RESULT_UNLOCK_THRESHOLD);
    assert.strictEqual(r.perQuestion.length, 5);
    assert.strictEqual(r.trend, null);
  });

  await scenario('runda odblokowana + poprzednia runda TEŻ odblokowana -> trend policzony', async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1' }, error: null }),
      coach_feedback_rounds: () => ({
        data: [
          { id: 'round-current', started_at: '2026-08-10' },
          { id: 'round-previous', started_at: '2026-08-01' },
        ],
        error: null,
      }),
      coach_feedback_responses: (state) => {
        if (state.filters.round_id === 'round-current') {
          return { data: Array(RESULT_UNLOCK_THRESHOLD).fill({ answers: VALID_ANSWERS }), error: null };
        }
        if (state.filters.round_id === 'round-previous') {
          const worse = { ...VALID_ANSWERS, [Q1.key]: Q1.options[3].value };
          return { data: Array(RESULT_UNLOCK_THRESHOLD).fill({ answers: worse }), error: null };
        }
        throw new Error('nieoczekiwany round_id filter');
      },
    });
    const r = await getFeedbackRoundResults({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.unlocked, true);
    assert.ok(r.trend, 'trend powinien być policzony (obie rundy odblokowane)');
    const q1Trend = r.trend.find((t) => t.questionKey === Q1.key);
    assert.strictEqual(q1Trend.delta, 100); // current 100% na options[0], previous 0%
  });

  await scenario(`runda odblokowana, poprzednia PONIŻEJ progu -> trend=null (nie porównujemy do niepełnej rundy)`, async () => {
    const supabase = makeFakeSupabase({
      teams: () => ({ data: { id: 'team-1', coach_user_id: 'coach-1' }, error: null }),
      coach_feedback_rounds: () => ({
        data: [
          { id: 'round-current', started_at: '2026-08-10' },
          { id: 'round-previous', started_at: '2026-08-01' },
        ],
        error: null,
      }),
      coach_feedback_responses: (state) => {
        if (state.filters.round_id === 'round-current') {
          return { data: Array(RESULT_UNLOCK_THRESHOLD).fill({ answers: VALID_ANSWERS }), error: null };
        }
        return { data: Array(RESULT_UNLOCK_THRESHOLD - 1).fill({ answers: VALID_ANSWERS }), error: null };
      },
    });
    const r = await getFeedbackRoundResults({ coachUserId: 'coach-1', teamId: 'team-1' }, supabase);
    assert.strictEqual(r.trend, null);
  });

  console.log(failed ? `\n${failed} TEST(Y) NIE PRZESZŁY (${passed} ok).` : `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).`);
  if (failed) process.exitCode = 1;
})();
