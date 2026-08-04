// ============================================================
// GAMECHANGE — lib/coach-recommendation-loop.js
// ============================================================
// Zbudowane 03.08.2026 — Pętla rekomendacji trenera (KOLEJKA_DECYZJI_
// I_PROJEKTOWANIA.md, sekcja 3.2), Warstwa 3 (ocena trafności) i Warstwa 4
// (własna rekomendacja trenera + reguła łączenia).
//
// ŚWIADOMIE bez zależności od Supabase/sieci — to same czyste funkcje
// decyzyjne/budujące payload, wywoływane z coach.html (bezpośrednie
// REST + RLS, ten sam wzorzec co coach_notes, patrz komentarz w
// coach.html przy addCoachNote()). Ten plik istnieje wyłącznie po to,
// żeby logika decyzyjna miała testy jednostkowe niezależne od DOM/fetch —
// coach.html woła te funkcje i sam wykonuje fetch() z wynikiem.
//
// DLACZEGO NIE api/*.js: folder api/ jest dziś dokładnie na limicie
// 12/12 funkcji Vercel Hobby (sprawdzone przy poprzednich trzech
// pakietach tej samej sesji) — ten sam powód, dla którego retencja/
// rotacja/limit push też weszły przez lib/, nie nowy plik w api/.
// ============================================================

// ------------------------------------------------------------
// Warstwa 4 — reguła łączenia (KOLEJKA_DECYZJI 3.2, Warstwa 4):
// jeśli zawodnik ma NAJNOWSZY training_focus na TYM SAMYM segmencie,
// trener "wzmacnia" ten wiersz (UPDATE reinforced_by_coach_at/comment) —
// zawodnik widzi dopisek "Twój trener też to potwierdza", ta sama
// rekomendacja. W przeciwnym razie (inny segment albo brak
// training_focus) — nowy, osobny wiersz recommendation_type=
// 'coach_recommendation', jawnie oznaczony jako "Od trenera".
//
// "Najnowszy training_focus na segmencie" = po prostu ostatni wiersz wg
// created_at dla (user_id, segment_id) — rotacja (lib/training-focus-
// rotation.js) zawsze WSTAWIA nowy wiersz zamiast zamykać stary, więc nie
// ma osobnego pola "aktywny"/"wygasły" do sprawdzenia — najnowszy wiersz
// JEST tym aktywnym z definicji.
// ------------------------------------------------------------
function decideCoachRecommendationAction({ latestTrainingFocusForSegment }) {
  if (latestTrainingFocusForSegment && latestTrainingFocusForSegment.id != null) {
    return { action: 'reinforce', targetRecommendationId: latestTrainingFocusForSegment.id };
  }
  return { action: 'insert_new' };
}

// Payload dla PATCH .../decision_recommendations?id=eq.<targetRecommendationId>
// Tylko te dwie kolumny — trigger protect_decision_recs_ai_content (patrz
// INTEGRACJA_PETLA_TRENERA_SQL.md) i tak odrzuci próbę zmiany czegokolwiek
// innego, ale nie ma sensu nawet próbować wysłać więcej.
function buildReinforcementPatch({ comment, nowIso }) {
  const trimmed = (comment || '').trim();
  return {
    reinforced_by_coach_at: nowIso,
    reinforced_by_coach_comment: trimmed || null,
  };
}

// Payload dla POST .../decision_recommendations (nowy wiersz coach_recommendation).
// confidence_tone celowo pominięte w payloadzie — kolumna ma DEFAULT
// 'assertive', nie ma powodu go nadpisywać dla treści trenera.
function buildCoachRecommendationInsert({ playerUserId, segmentId, recommendationText, nowIso }) {
  const text = (recommendationText || '').trim();
  if (!playerUserId) throw new Error('playerUserId jest wymagany.');
  if (!segmentId) throw new Error('segmentId jest wymagany.');
  if (!text) throw new Error('Treść rekomendacji nie może być pusta.');
  return {
    user_id: playerUserId,
    recommendation_type: 'coach_recommendation',
    content_source: 'coach',
    segment_id: segmentId,
    recommendation_text: text,
    created_at: nowIso,
  };
}

// ------------------------------------------------------------
// Warstwa 3 — ocena trafności rekomendacji przez trenera, ZAPIS do
// player_insights (UPSERT — tabela ma unique index na (player_email,
// source, segment_id), sprawdzone na żywo w Table Editor 03.08.2026,
// więc druga ocena tego samego segmentu NADPISUJE pierwszą, nie tworzy
// duplikatu — spójne z tym, jak już działa stary index.html).
//
// Cztery etykiety — DOKŁADNIE te same cztery, których zawodnik już zna
// z narzędzia diagnostycznego (potwierdzone przez Kubę w KOLEJKA_DECYZJI
// 3.2, Warstwa 3). Komentarz wymagany tylko dla dwóch niższych ocen —
// ta sama zasada UI co przy ocenach diagnozy.
// ------------------------------------------------------------
const COACH_ASSESSMENT_LABELS = ['w_punkt', 'blisko', 'czesciowo', 'nie_do_konca'];
const COACH_ASSESSMENT_REQUIRES_COMMENT = new Set(['czesciowo', 'nie_do_konca']);

function isValidCoachAssessmentLabel(label) {
  return COACH_ASSESSMENT_LABELS.includes(label);
}

function coachAssessmentRequiresComment(label) {
  return COACH_ASSESSMENT_REQUIRES_COMMENT.has(label);
}

// Payload dla POST .../player_insights z nagłówkiem
// `Prefer: resolution=merge-duplicates,return=minimal` (UPSERT po
// (player_email, source, segment_id)).
function buildPlayerInsightUpsert({ playerEmail, playerUserId, segmentId, responseValue, responseComment, nowIso }) {
  if (!playerEmail) throw new Error('playerEmail jest wymagany (brak adresu e-mail zawodnika).');
  if (!segmentId) throw new Error('segmentId jest wymagany.');
  if (!isValidCoachAssessmentLabel(responseValue)) {
    throw new Error(`Nieprawidłowa ocena: ${responseValue}`);
  }
  if (coachAssessmentRequiresComment(responseValue) && !(responseComment || '').trim()) {
    throw new Error('Ta ocena wymaga krótkiego komentarza.');
  }
  return {
    player_email: playerEmail,
    user_id: playerUserId || null,
    source: 'coach',
    segment_id: segmentId,
    response_value: responseValue,
    response_comment: (responseComment || '').trim() || null,
    created_at: nowIso,
  };
}

module.exports = {
  COACH_ASSESSMENT_LABELS,
  isValidCoachAssessmentLabel,
  coachAssessmentRequiresComment,
  decideCoachRecommendationAction,
  buildReinforcementPatch,
  buildCoachRecommendationInsert,
  buildPlayerInsightUpsert,
};
