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
// ⚠️ AKTUALIZACJA (06.08.2026, zatwierdzona przez Kubę): pierwotna reguła
// (b) niżej używała ROLLING WINDOW 2-6 dni przed meczem. Przy typowym
// rytmie mecz-mecz sobota-sobota to okno jest prawdziwe przez 5 z 7 dni
// tygodnia (niedziela-czwartek) — w praktyce generowało nową rekomendację
// niemal codziennie zamiast rzadziej. Zastąpione dwoma STAŁYMI momentami:
// dzień po meczu (refleksja/podsumowanie) i 2 dni przed kolejnym meczem
// (gotowość przedmeczowa). Cadence 7-dniowy (a) bez zmian, nadal
// niezależny fallback. Patrz zmieniona REGUŁA "KIEDY" niżej.
//
// REGUŁA "KIEDY" — V2 (06.08.2026), DWA STAŁE MOMENTY:
//   (a) cadence 7 dni od OSTATNIEGO training_focus WYGENEROWANEGO DLA
//       TEGO KONKRETNEGO CELU (goal_id) — jeśli cel priorytetowy sam się
//       zmienił (rotacja z Funkcji 2), nowy cel nie ma jeszcze ŻADNEGO
//       training_focus dla siebie, więc rotacja jest natychmiastowa
//       (patrz reason: 'no_prior_training_focus_for_goal' niżej) — to
//       naturalnie obsługuje "rotację celu priorytetowego" bez osobnego
//       mechanizmu wykrywania zmiany celu. Niezależny fallback: obowiązuje
//       też dla zawodników bez żadnych danych meczowych w kalendarzu
//       (offseason, brak skonfigurowanego kalendarza) i jako ostateczna
//       siatka bezpieczeństwa, gdyby któryś stały moment niżej został
//       przegapiony (np. cron nie odpalił się akurat tego dnia).
//   (b) ALBO wcześniej, w dwóch precyzyjnych, STAŁYCH momentach (nie
//       oknie) związanych z najbliższym/ostatnim meczem
//       (event_type='match'):
//         - dzień po ostatnim rozegranym meczu (POST_MATCH_FIXED_OFFSET_
//           DAYS, domyślnie 1) — świeże podsumowanie tygodnia/refleksja
//           po występie.
//         - 2 dni przed najbliższym zaplanowanym meczem
//           (PRE_MATCH_FIXED_OFFSET_DAYS, domyślnie 2) — gotowość
//           przedmeczowa.
//       Świadomy kompromis: to `=== offsetDays`, nie okno — jeśli cron
//       nie odpali się akurat tego jednego dnia, zawodnik przegapia ten
//       konkretny moment (fallback (a) i tak go w końcu dogoni). NIE
//       dodawaj logiki "doganiania" bez wyraźnej nowej prośby Kuby.
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
const POST_MATCH_FIXED_OFFSET_DAYS = Number(process.env.TRAINING_FOCUS_ROTATION_POST_MATCH_OFFSET_DAYS) || 1;
const PRE_MATCH_FIXED_OFFSET_DAYS = Number(process.env.TRAINING_FOCUS_ROTATION_PRE_MATCH_OFFSET_DAYS) || 2;
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
// dniach potrzebuje precyzyjnego upływu czasu, a stałe momenty meczowe
// (post-match/pre-match) potrzebują porównania KALENDARZOWYCH dat, nie
// godzin.
// ------------------------------------------------------------
function shouldRotateTrainingFocus({
  lastGeneratedAt,
  now,
  nowDateStr,
  upcomingMatchDate,
  lastMatchDate,
  cadenceDays = ROTATION_CADENCE_DAYS,
  postMatchOffsetDays = POST_MATCH_FIXED_OFFSET_DAYS,
  preMatchOffsetDays = PRE_MATCH_FIXED_OFFSET_DAYS,
}) {
  if (!lastGeneratedAt) {
    return { rotate: true, reason: 'no_prior_training_focus_for_goal' };
  }

  const daysSinceGenerated = (now.getTime() - new Date(lastGeneratedAt).getTime()) / DAY_MS;
  if (daysSinceGenerated >= cadenceDays) {
    return { rotate: true, reason: 'cadence_due' };
  }

  if (lastMatchDate && nowDateStr) {
    const daysSinceMatch = daysBetweenDateStrs(lastMatchDate, nowDateStr);
    if (daysSinceMatch === postMatchOffsetDays) {
      return { rotate: true, reason: 'post_match_fixed_moment' };
    }
  }

  if (upcomingMatchDate && nowDateStr) {
    const daysToMatch = daysBetweenDateStrs(nowDateStr, upcomingMatchDate);
    if (daysToMatch === preMatchOffsetDays) {
      return { rotate: true, reason: 'pre_match_fixed_moment' };
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
// Ostatni ROZEGRANY mecz (odwrócone w czasie fetchUpcomingMatchDate).
// ⚠️ NIEZWERYFIKOWANE (06.08.2026): świadomie NIE filtruje po
// status='scheduled', w odróżnieniu od fetchUpcomingMatchDate — założenie
// jest takie, że mecz w przeszłości mógł nigdy nie dostać zmiany statusu
// na "rozegrany" (brak potwierdzonego mechanizmu takiej zmiany w
// projekcie — patrz podsumowanie sesji dla Kuby). Kuba: sprawdź
// `select distinct status from calendar_events where event_type='match'`
// w Supabase. Jeśli status faktycznie zawsze zostaje 'scheduled' nawet
// dla przeszłych meczów, ten kod jest poprawny. Jeśli istnieje inny
// status dla przeszłych meczów, dodaj analogiczny .eq('status', ...)
// filtr tutaj.
// ------------------------------------------------------------
async function fetchLastMatchDate(supabase, userId, nowDateStr) {
  const { data, error } = await supabase
    .from('calendar_events')
    .select('scheduled_date')
    .eq('user_id', userId)
    .eq('event_type', 'match')
    .lt('scheduled_date', nowDateStr)
    .order('scheduled_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`training-focus-rotation: fetchLastMatchDate error (user ${userId}):`, error);
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
      const [lastGeneratedAt, upcomingMatchDate, lastMatchDate] = await Promise.all([
        fetchLastTrainingFocusForGoal(supabase, goal.id),
        fetchUpcomingMatchDate(supabase, userId, warsawNow.dateStr),
        fetchLastMatchDate(supabase, userId, warsawNow.dateStr),
      ]);

      const decision = shouldRotateTrainingFocus({
        lastGeneratedAt,
        now,
        nowDateStr: warsawNow.dateStr,
        upcomingMatchDate,
        lastMatchDate,
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
  POST_MATCH_FIXED_OFFSET_DAYS,
  PRE_MATCH_FIXED_OFFSET_DAYS,
  daysBetweenDateStrs,
  shouldRotateTrainingFocus,
  fetchActivePriorityGoalsByUser,
  fetchLastTrainingFocusForGoal,
  fetchUpcomingMatchDate,
  fetchLastMatchDate,
  runTrainingFocusRotation,
};
