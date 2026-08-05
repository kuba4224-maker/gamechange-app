// ============================================================
// GAMECHANGE — lib/coach-session-bridge.js
// ============================================================
// Zbudowane 04.08.2026 (Sesja 2) — "Zamknięcie pętli: sesja trenera →
// dziennik zawodnika" (NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md,
// "ROZSZERZENIA — SESJA 29.07.2026, runda 2"). Pełny opis mechanizmu i
// schemat bazy: claude/INTEGRACJA_SESJA_DZIENNIK_SQL.md.
//
// ŚWIADOMIE bez zależności od Supabase/sieci — ten sam wzorzec co
// lib/coach-recommendation-loop.js: czyste funkcje walidacji/budowy
// payloadu + funkcje decyzyjne, testowalne w Node bez atrapowania
// niczego. coach.html woła bezpośrednio cztery funkcje SQL RPC
// (create_coach_planned_session/set_coach_session_question/
// cancel_coach_planned_session/get_coach_session_summary) — NIE poprzez
// api/*.js (folder api/ zostaje na 12/12, ta funkcja go nie potrzebuje,
// żadna z czterech operacji nie wymaga sekretu serwerowego) — logika
// walidacji wejścia jest tu powtórzona w czystym JS przeglądarki w
// coach.html, ten sam wzorzec co reszta tego pliku (brak kroku
// budowania/importu modułów Node w appce webowej).
// ============================================================

// Te same 4 wartości co istniejący selektor "Typ jednostki" (Podpowiedź V1
// przy planowaniu sesji) w coach.html — jeden wymiar Filaru A, reużyty tu
// jako opis TEJ konkretnej zaplanowanej sesji, nie duplikat innego pojęcia.
const COACH_SESSION_UNIT_TYPES = ['silowa', 'wytrzymalosciowa', 'techniczna', 'taktyczna'];

const DEFAULT_SESSION_TITLE_BY_UNIT_TYPE = {
  silowa: 'Sesja siłowa',
  wytrzymalosciowa: 'Sesja wytrzymałościowa',
  techniczna: 'Sesja techniczna',
  taktyczna: 'Sesja taktyczna',
};

// 300 znaków — ta sama granica co istniejący limit `refinement_note` w
// validate-goal-refinement.js, reużyta jako spójny standard długości
// krótkiego, opcjonalnego tekstu w tym projekcie (patrz też CHECK w SQL).
const MAX_COACH_QUESTION_LENGTH = 300;

// Próg minimalny do pokazania zbiorczej średniej na poziomie Rozszerzonym
// (get_coach_session_summary, tier 'aggregate') — poniżej progu nawet sama
// średnia z 1-2 wpisów w praktyce zdradza dane pojedynczej osoby pod
// przykrywką "zbiorczych". Świadomie NIŻSZA wartość niż
// TEAM_AGGREGATE_MIN_SIZE=8 (mapa cieplna drużyny w coach.html), bo to
// pojedyncza sesja w małym zespole, nie głęboka historia segmentowa całej
// drużyny — do dostrojenia przez Kubę. TRZYMAJ ZGODNIE z v_min_for_aggregate
// w claude/INTEGRACJA_SESJA_DZIENNIK_SQL.md (get_coach_session_summary).
const MIN_LOGGERS_FOR_AGGREGATE = 3;

function isValidUnitType(unitType) {
  return COACH_SESSION_UNIT_TYPES.includes(unitType);
}

// Format YYYY-MM-DD (ten sam co <input type="date"> / toLocalDateStr w
// reszcie appki) — sprawdza ZARÓWNO kształt stringa, JAK I że to realna
// data kalendarzowa (np. odrzuca "2026-02-30"), przez porównanie z
// wynikiem Date.toISOString() zamiast ufać samemu Date, które po cichu
// "przewija" niepoprawne daty (np. 30 lutego → 2 marca) bez błędu.
function isValidSessionDateStr(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return false;
  const [, y, mo, d] = m;
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === Number(y) &&
    parsed.getUTCMonth() + 1 === Number(mo) &&
    parsed.getUTCDate() === Number(d)
  );
}

function defaultSessionTitle(unitType) {
  return DEFAULT_SESSION_TITLE_BY_UNIT_TYPE[unitType] || null;
}

// Payload dla POST .../rpc/create_coach_planned_session. Rzuca PRZED
// wysłaniem czegokolwiek do sieci — ten sam wzorzec co
// validateGoalRefinement() w api/validate-goal-refinement.js.
function buildCreateSessionPayload({ teamId, unitType, sessionDate, title, coachQuestion }) {
  if (!teamId) throw new Error('teamId jest wymagany.');
  if (!isValidUnitType(unitType)) throw new Error(`Nieprawidłowy typ jednostki: ${unitType}`);
  if (!isValidSessionDateStr(sessionDate)) throw new Error('Podaj prawidłową datę sesji (RRRR-MM-DD).');

  const trimmedTitle = (title || '').trim();
  const trimmedQuestion = (coachQuestion || '').trim();
  if (trimmedQuestion.length > MAX_COACH_QUESTION_LENGTH) {
    throw new Error(`Pytanie może mieć maksymalnie ${MAX_COACH_QUESTION_LENGTH} znaków.`);
  }

  return {
    p_team_id: teamId,
    p_unit_type: unitType,
    p_session_date: sessionDate,
    p_title: trimmedTitle || null,
    p_coach_question: trimmedQuestion || null,
  };
}

// Payload dla POST .../rpc/set_coach_session_question. Pusty string ->
// null (czyszczenie pytania), nie błąd — trener może świadomie usunąć
// wcześniej ustawione pytanie.
function buildSessionQuestionPayload({ sessionId, coachQuestion }) {
  if (!sessionId) throw new Error('sessionId jest wymagany.');
  const trimmed = (coachQuestion || '').trim();
  if (trimmed.length > MAX_COACH_QUESTION_LENGTH) {
    throw new Error(`Pytanie może mieć maksymalnie ${MAX_COACH_QUESTION_LENGTH} znaków.`);
  }
  return {
    p_session_id: sessionId,
    p_coach_question: trimmed || null,
  };
}

function buildCancelSessionPayload({ sessionId }) {
  if (!sessionId) throw new Error('sessionId jest wymagany.');
  return { p_session_id: sessionId };
}

function buildSessionSummaryPayload({ sessionId }) {
  if (!sessionId) throw new Error('sessionId jest wymagany.');
  return { p_session_id: sessionId };
}

// Mapowanie teams.visibility_level -> który "strumień" jakości sesji
// pokazać (Funkcja 9: Podstawowy/Rozszerzony/Pełny). Ta sama decyzja co
// get_coach_session_summary() w SQL wykonuje po stronie bazy — trzymana
// tu też jako czysta, testowalna funkcja referencyjna/dokumentacyjna, i
// jako to, czym coach.html kieruje RENDEROWANIEM już otrzymanego wyniku
// (summary.tier), a nie osobną bramką dostępu (dostęp pilnuje wyłącznie
// backend — frontend nigdy nie decyduje, jakie dane dostać, tylko jak
// pokazać to, co backend już zwrócił).
function visibilityTierForSummary(visibilityLevel) {
  if (visibilityLevel === 'full') return 'named';
  if (visibilityLevel === 'extended') return 'aggregate';
  return 'count_only'; // 'basic', brak wartości, albo cokolwiek nieznanego -> najbardziej ostrożny wariant
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Czysta funkcja referencyjna dla logiki agregacji w get_coach_session_summary
// (tier 'aggregate') — dokumentuje i testuje DOKŁADNIE tę samą regułę progu,
// którą SQL wykonuje osobno (COUNT/AVG w Postgresie). loggedEntries: tablica
// obiektów { rpe, postFatigue } (już po deduplikacji "jeden log per
// calendar_event", ten sam krok co LATERAL...LIMIT 1 w SQL).
function computeAggregateStats(loggedEntries) {
  const entries = Array.isArray(loggedEntries) ? loggedEntries : [];
  const loggedCount = entries.length;
  const insufficientForAggregate = loggedCount < MIN_LOGGERS_FOR_AGGREGATE;

  if (insufficientForAggregate) {
    return { loggedCount, insufficientForAggregate: true, avgRpe: null, avgPostFatigue: null };
  }

  const rpeValues = entries.filter(e => typeof e.rpe === 'number' && !isNaN(e.rpe)).map(e => e.rpe);
  const fatigueValues = entries
    .filter(e => typeof e.postFatigue === 'number' && !isNaN(e.postFatigue))
    .map(e => e.postFatigue);

  return {
    loggedCount,
    insufficientForAggregate: false,
    avgRpe: rpeValues.length ? round1(rpeValues.reduce((a, b) => a + b, 0) / rpeValues.length) : null,
    avgPostFatigue: fatigueValues.length
      ? round1(fatigueValues.reduce((a, b) => a + b, 0) / fatigueValues.length)
      : null,
  };
}

module.exports = {
  COACH_SESSION_UNIT_TYPES,
  DEFAULT_SESSION_TITLE_BY_UNIT_TYPE,
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
};
