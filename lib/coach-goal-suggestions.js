// ============================================================
// GAMECHANGE — lib/coach-goal-suggestions.js
// ============================================================
// Zbudowane 04.08.2026 — "Cele sugerowane przez trenera"
// (NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md, sekcja "Cele sugerowane przez
// trenera"; migracja: claude/INTEGRACJA_CELE_SUGEROWANE_TRENERA_SQL.md;
// opis pełny: claude/INTEGRACJA_CELE_SUGEROWANE_TRENERA.md).
//
// Nowe źródło celu na ISTNIEJĄCEJ tabeli public.goals (Domena 05) —
// origin='coach_suggested' + status='suggested' — ten sam wzorzec
// "source per event", co Kalendarz (Domena 07: system/coach/player).
// Sugestia NIGDY nie przerywa aktywnego celu zawodnika: to osobny wiersz,
// który czeka jako propozycja. Dopiero PRZYSZŁA akceptacja przez
// zawodnika (PATCH status: 'suggested' -> 'active' na WŁASNYM wierszu,
// ekran w asystent_app.html — plik zamrożony, poza zakresem tej sesji)
// wprowadza cel do już istniejącego mechanizmu doprecyzowania/dozowania/
// kalendarza/progresji — bez budowania go od nowa.
//
// ŚWIADOMIE bez zależności od Supabase/sieci — czyste funkcje decyzyjne/
// budujące payload, ten sam wzorzec co lib/coach-recommendation-loop.js:
// coach.html duplikuje tę samą logikę inline (plik statyczny, bez
// bundlera, nie może importować modułów Node) i sam wykonuje fetch()
// z wynikiem. UUID grupy i znacznik czasu są ZAWSZE wstrzykiwane z
// zewnątrz (parametry), nigdy generowane wewnątrz — funkcje pozostają
// deterministyczne i testowalne bez atrap.
//
// DLACZEGO NIE api/*.js: folder api/ jest dziś dokładnie na limicie
// 12/12 funkcji Vercel Hobby — trener zapisuje sugestię BEZPOŚREDNIO do
// Supabase przez REST + nową politykę RLS (goals_coach_insert_suggestion),
// dokładnie ten sam wzorzec co decision_recs_coach_insert_own_recommendation
// (Pętla rekomendacji trenera) — żadnego nowego pliku w api/ nie trzeba.
// ============================================================

const GOAL_SUGGESTION_ORIGIN = 'coach_suggested';
const GOAL_SUGGESTION_STATUS = 'suggested';

// ------------------------------------------------------------
// Walidacja wejścia formularza (pojedynczej i grupowej sugestii) —
// wywoływana PRZED buildGoalSuggestionRows, żeby UI mogło pokazać
// czytelny błąd zamiast surowego wyjątku z bazy.
// ------------------------------------------------------------
function validateGoalSuggestionInput({ segmentId, playerIds, note }) {
  const errors = [];
  if (!segmentId || typeof segmentId !== 'string') errors.push('Wybierz segment.');
  if (!Array.isArray(playerIds) || playerIds.length === 0) errors.push('Wybierz co najmniej jednego zawodnika.');
  if (note != null && typeof note === 'string' && note.trim().length > 500) {
    errors.push('Notatka jest za długa (maks. 500 znaków).');
  }
  return { valid: errors.length === 0, errors };
}

// Payload dla POST .../goals (jeden wiersz na zawodnika — pojedyncza
// sugestia to playerIds z jednym elementem, sugestia grupowa to playerIds
// z wieloma elementami wysłanymi jednym zbiorczym INSERT-em).
//
// suggestion_group_id ustawiany TYLKO gdy sugerujemy więcej niż jednemu
// zawodnikowi naraz (grupowo) — dla pojedynczej sugestii zawsze NULL,
// niezależnie od tego, co ewentualnie przekazano w suggestionGroupId
// (funkcja sama pilnuje tej reguły, żeby wywołujący kod nie musiał).
function buildGoalSuggestionRows({ playerIds, segmentId, note, coachUserId, nowIso, suggestionGroupId }) {
  if (!Array.isArray(playerIds) || playerIds.length === 0) throw new Error('playerIds musi być niepustą tablicą.');
  if (!segmentId) throw new Error('segmentId jest wymagany.');
  if (!coachUserId) throw new Error('coachUserId jest wymagany.');
  if (!nowIso) throw new Error('nowIso jest wymagany.');

  const trimmedNote = typeof note === 'string' && note.trim() ? note.trim() : null;
  const groupId = playerIds.length > 1 ? (suggestionGroupId || null) : null;

  return playerIds.map(playerId => ({
    user_id: playerId,
    segment_id: segmentId,
    origin: GOAL_SUGGESTION_ORIGIN,
    status: GOAL_SUGGESTION_STATUS,
    is_priority: false,
    suggested_by_coach_user_id: coachUserId,
    suggested_at: nowIso,
    suggestion_note: trimmedNote,
    suggestion_group_id: groupId,
    created_at: nowIso,
  }));
}

// ------------------------------------------------------------
// Reguła "nie zasypuj duplikatami": czy zawodnik ma już OCZEKUJĄCĄ
// (status='suggested') sugestię na tym samym segmencie. Baza i tak
// wymusza to twardo (unique index częściowy
// idx_goals_one_pending_suggestion_per_segment, patrz plik SQL) — to tu
// pozwala UI pokazać czytelny komunikat PRZED wysłaniem żądania, zamiast
// czekać na 409 z PostgREST.
//
// Aktywny cel (status='active') na tym samym segmencie NIGDY nie blokuje
// nowej sugestii — zgodnie z wymogiem zlecenia ("nie przerywa aktywnego
// celu zawodnika"), sugestia i aktywny cel mogą współistnieć.
// ------------------------------------------------------------
function isPendingSuggestionConflict(existingGoalsForSegment) {
  if (!Array.isArray(existingGoalsForSegment)) return false;
  return existingGoalsForSegment.some(g => g && g.status === GOAL_SUGGESTION_STATUS);
}

function canSuggestGoalForSegment(existingGoalsForSegment) {
  return !isPendingSuggestionConflict(existingGoalsForSegment);
}

// Etykieta statusu celu do karty w widoku trenera — rozszerza etykiety już
// używane w loadPlayerGoalsSection (coach.html) o nowy status 'suggested'.
function describeGoalStatusForCoach(status, isPriority) {
  if (status === GOAL_SUGGESTION_STATUS) return 'Oczekuje na decyzję zawodnika';
  if (status === 'completed') return 'Ukończony';
  if (status === 'abandoned') return 'Porzucony';
  if (status === 'active' && isPriority) return 'Priorytetowy, aktywny';
  if (status === 'active') return 'Aktywny';
  return status || '—';
}

// ------------------------------------------------------------
// Sugestia grupowa: zbiorczy INSERT to JEDNA transakcja PostgREST — jeśli
// KTÓRYKOLWIEK wiersz trafi w idx_goals_one_pending_suggestion_per_segment,
// odrzucona zostaje CAŁA paczka, nie tylko konfliktujący wiersz. Dlatego
// coach.html najpierw odpytuje, którzy z zaznaczonych zawodników już mają
// oczekującą sugestię na tym segmencie (GET), i buduje INSERT tylko dla
// pozostałych — ta funkcja liczy ten podział z gotowej listy id.
// ------------------------------------------------------------
function summarizeGroupSuggestionResult({ requestedPlayerIds, alreadyPendingPlayerIds }) {
  const already = new Set(alreadyPendingPlayerIds || []);
  const toInsertPlayerIds = (requestedPlayerIds || []).filter(id => !already.has(id));
  return {
    toInsertPlayerIds,
    skippedPlayerIds: Array.from(already),
    allSkipped: toInsertPlayerIds.length === 0,
  };
}

module.exports = {
  GOAL_SUGGESTION_ORIGIN,
  GOAL_SUGGESTION_STATUS,
  validateGoalSuggestionInput,
  buildGoalSuggestionRows,
  isPendingSuggestionConflict,
  canSuggestGoalForSegment,
  describeGoalStatusForCoach,
  summarizeGroupSuggestionResult,
};
