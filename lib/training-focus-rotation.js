// ============================================================
// GAMECHANGE — lib/training-focus-rotation.js
// ============================================================
// Pakiet z KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, sekcja 5.2: "Rotacja
// training_focus". Naprawia lukę opisaną wprost w api/generate-
// recommendation.js, sekcja "CO ŚWIADOMIE NIE JEST TU ZROBIONE":
//   - "Detekcja KIEDY wygenerować training_focus (rotacja celu
//     priorytetowego z Funkcji 2, 'priorytet rotuje dynamicznie')."
//   - "Cron/harmonogram wywołujący ten silnik okresowo dla zawodników z
//     JUŻ aktywnym celem (patrz jednak cron-onboard-diagnosis.js — to
//     jest cron, ale tylko dla PIERWSZEJ rekomendacji po ankiecie, nie
//     dla bieżącej rotacji)."
// Ten plik to właśnie ta brakująca detekcja + cron.
//
// ⚠️ UWAGA HISTORYCZNA (03.08.2026): ten plik (i test-training-focus-
// rotation.js) był już RAZ napisany i przetestowany (14/14 scenariuszy) w
// sesji 01.08.2026 — zgubiony tak samo jak reszta pakietów z sekcji 5, bo
// nigdy nie trafił do Project Knowledge ani na dysk. To ODTWORZENIE od
// zera z opisu w KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, nie odzyskanie
// oryginału — nowa implementacja, własne testy, do przejrzenia przez
// Kubę przed wdrożeniem.
//
// REGUŁA "KIEDY" — V1, PROSTA HEURYSTYKA (wprost oznaczona w KOLEJKA_
// DECYZJI jako "do korekty, jeśli intuicja trenerska mówi inaczej", to
// NIE jest zbadana/potwierdzona przez Kubę liczba, tylko robocza
// propozycja Claude'a):
//   (a) cadence 7 dni od OSTATNIEGO training_focus WYGENEROWANEGO DLA
//       TEGO KONKRETNEGO CELU (goal_id) — jeśli cel priorytetowy sam się
//       zmienił (rotacja z Funkcji 2), nowy cel nie ma jeszcze ŻADNEGO
//       training_focus dla siebie, więc rotacja jest natychmiastowa
//       (patrz reason: 'no_prior_training_focus_for_goal' niżej) — to
//       naturalnie obsługuje "rotację celu priorytetowego" bez osobnego
//       mechanizmu wykrywania zmiany celu.
//   (b) ALBO wcześniej, jeśli zbliża się mecz — sygnał gotowości: nowy
//       training_focus w oknie 2-6 dni PRZED zaplanowanym meczem
//       (event_type='match', status='scheduled'), żeby zawodnik miał
//       świeżą rekomendację przed ważnym wydarzeniem, nie w jego trakcie
//       ani bezpośrednio po (stąd dolna granica 2, nie 0/1).
//
// NIE duplikuje kontroli kosztów/24h-cadence/5-dziennie — te już
// egzekwuje generateRecommendation() samo w sobie (checkHardDailyCap,
// checkTrainingFocusCadence). Ten plik odpowiada WYŁĄCZNIE za "kogo i
// kiedy w ogóle rozważyć do rotacji w tym przebiegu crona" — jeśli mimo
// to generateRecommendation zwróci blocked, to oczekiwany, nie-błędny
// wynik (np. dwóch rytmów trafiło w ten sam dzień).
//
// DLACZEGO NIE JEST TO NOWY PLIK W api/ (Opcja B, nie Opcja A — patrz
// SESJA_03_08_2026_GITHUB_TOKEN_STATUS.md, Krok 1.1): api/ ma dziś
// dokładnie 12/12 plików (twardy limit Vercel Hobby), zero marginesu.
// Ten plik żyje w lib/ (nie liczy się do limitu) i jest wołany
// bezpośrednio z cron-send-notifications.js — dokładnie ten sam wzorzec
// co lib/focus-block-adaptation.js.
// ============================================================

const { generateRecommendation } = require('../api/generate-recommendation');

const DAY_MS = 24 * 60 * 60 * 1000;
const ROTATION_CADENCE_DAYS = Number(process.env.TRAINING_FOCUS_ROTATION_CADENCE_DAYS) || 7;
const MATCH_WINDOW_MIN_DAYS = Number(process.env.TRAINING_FOCUS_ROTATION_MATCH_WINDOW_MIN_DAYS) || 2;
const MATCH_WINDOW_MAX_DAYS = Number(process.env.TRAINING_FOCUS_ROTATION_MATCH_WINDOW_MAX_DAYS) || 6;
const MAX_PER_RUN = 20; // ten sam ochronny limit co MAX_PER_RUN w cron-onboard-diagnosis.js

function daysBetweenDateStrs(dateStrA, dateStrB) {
  return Math.round(
    (new Date(`${dateStrB}T00:00:00Z`).getTime() - new Date(`${dateStrA}T00:00:00Z`).getTime()) / DAY_MS
  );
}

// ------------------------------------------------------------
// Czysta funkcja decyzyjna — testowalna bez bazy (patrz tests/test-
// training-focus-rotation.js). `now` to Date (moment bieżący), `nowDateStr`
// to data lokalna Warszawy (YYYY-MM-DD, ten sam kształt co
// warsawNow.dateStr w cron-send-notifications.js) — osobno, bo cadence w
// dniach potrzebuje precyzyjnego upływu czasu, a okno meczowe potrzebuje
// porównania KALENDARZOWYCH dat, nie godzin.
// ------------------------------------------------------------
function shouldRotateTrainingFocus({
  lastGeneratedAt,
  now,
  nowDateStr,
  upcomingMatchDate,
  cadenceDays = ROTATION_CADENCE_DAYS,
  matchWindowMinDays = MATCH_WINDOW_MIN_DAYS,
  matchWindowMaxDays = MATCH_WINDOW_MAX_DAYS,
}) {
  if (!lastGeneratedAt) {
    return { rotate: true, reason: 'no_prior_training_focus_for_goal' };
  }

  const daysSinceGenerated = (now.getTime() - new Date(lastGeneratedAt).getTime()) / DAY_MS;
  if (daysSinceGenerated >= cadenceDays) {
    return { rotate: true, reason: 'cadence_due' };
  }

  if (upcomingMatchDate && nowDateStr) {
    const daysToMatch = daysBetweenDateStrs(nowDateStr, upcomingMatchDate);
    if (daysToMatch >= matchWindowMinDays && daysToMatch <= matchWindowMaxDays) {
      return { rotate: true, reason: 'match_window_readiness_signal' };
    }
  }

  return { rotate: false, reason: 'not_due' };
}

// ------------------------------------------------------------
// Aktywne cele priorytetowe, jeden na użytkownika (jeśli więcej niż jeden
// istnieje wbrew intencji schematu — bierzemy najnowszy, ten sam wzorzec
// obronny co runWeeklySummary w cron-send-notifications.js).
// ------------------------------------------------------------
async function fetchActivePriorityGoalsByUser(supabase) {
  const { data, error } = await supabase
    .from('goals')
    .select('id, user_id, segment_id, created_at')
    .eq('status', 'active')
    .eq('is_priority', true)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('training-focus-rotation: fetchActivePriorityGoalsByUser error:', error);
    return new Map();
  }
  const byUser = new Map();
  for (const goal of data || []) {
    if (!byUser.has(goal.user_id)) byUser.set(goal.user_id, goal); // pierwszy trafiony = najnowszy (malejące sortowanie)
  }
  return byUser;
}

async function fetchLastTrainingFocusForGoal(supabase, goalId) {
  const { data, error } = await supabase
    .from('decision_recommendations')
    .select('created_at')
    .eq('goal_id', goalId)
    .eq('recommendation_type', 'training_focus')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`training-focus-rotation: fetchLastTrainingFocusForGoal error (goal ${goalId}):`, error);
    return null;
  }
  return data ? data.created_at : null;
}

async function fetchUpcomingMatchDate(supabase, userId, nowDateStr) {
  const { data, error } = await supabase
    .from('calendar_events')
    .select('scheduled_date')
    .eq('user_id', userId)
    .eq('event_type', 'match')
    .eq('status', 'scheduled')
    .gte('scheduled_date', nowDateStr)
    .order('scheduled_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`training-focus-rotation: fetchUpcomingMatchDate error (user ${userId}):`, error);
    return null;
  }
  return data ? data.scheduled_date : null;
}

// ------------------------------------------------------------
// Główna funkcja wołana przez cron. `warsawNow` — ten sam kształt co
// zwraca getWarsawNow() w cron-send-notifications.js ({ hour, minute,
// day, dateStr, weekday }). `results`, jeśli podany, dostaje przyrost
// results.training_focus_rotation (ten sam wzorzec co reszta rytmów).
// ------------------------------------------------------------
async function runTrainingFocusRotation(supabase, warsawNow, results) {
  const goalsByUser = await fetchActivePriorityGoalsByUser(supabase);
  if (goalsByUser.size === 0) return;

  const now = new Date();
  const entries = [...goalsByUser.entries()].slice(0, MAX_PER_RUN);
  if (goalsByUser.size > MAX_PER_RUN) {
    console.warn(`training-focus-rotation: ${goalsByUser.size} kandydatów, przetwarzam tylko pierwszych ${MAX_PER_RUN} w tym przebiegu.`);
  }

  for (const [userId, goal] of entries) {
    try {
      const [lastGeneratedAt, upcomingMatchDate] = await Promise.all([
        fetchLastTrainingFocusForGoal(supabase, goal.id),
        fetchUpcomingMatchDate(supabase, userId, warsawNow.dateStr),
      ]);

      const decision = shouldRotateTrainingFocus({
        lastGeneratedAt,
        now,
        nowDateStr: warsawNow.dateStr,
        upcomingMatchDate,
      });
      if (!decision.rotate) continue;

      const recResult = await generateRecommendation(
        { userId, recommendationType: 'training_focus', goalId: goal.id },
        supabase
      );

      if (!recResult.ok) {
        // Zablokowane przez wewnętrzną kontrolę kosztów generateRecommendation
        // (np. 24h cadence albo twardy limit dobowy) — oczekiwany wynik, nie błąd.
        console.warn(`training-focus-rotation: rotacja odłożona dla usera ${userId} (${decision.reason}): ${recResult.reason}`);
        continue;
      }

      if (results) results.training_focus_rotation = (results.training_focus_rotation || 0) + 1;
      // Uwaga: nie wysyła tu żadnego push'a — nowy wiersz decision_recommendations
      // z notified_at=null zostanie automatycznie podniesiony przez istniejący
      // rytm contextual_insight (patrz runContextualInsight), z tym samym
      // globalnym limitem/kolejnością priorytetu co reszta systemu.
    } catch (e) {
      console.error(`training-focus-rotation: błąd dla usera ${userId} (cel ${goal.id}):`, e);
    }
  }
}

module.exports = {
  ROTATION_CADENCE_DAYS,
  MATCH_WINDOW_MIN_DAYS,
  MATCH_WINDOW_MAX_DAYS,
  daysBetweenDateStrs,
  shouldRotateTrainingFocus,
  fetchActivePriorityGoalsByUser,
  fetchLastTrainingFocusForGoal,
  fetchUpcomingMatchDate,
  runTrainingFocusRotation,
};
