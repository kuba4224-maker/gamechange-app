// ============================================================
// GAMECHANGE — lib/coach-thread-library.js
// ============================================================
// PAKIET 16 (04.08.2026) — DETEKCJA AUTOMATYCZNA wątków 1-8 z biblioteki
// wątków trenerskich (NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md, sekcja
// "Biblioteka wątków trenerskich"; kopia tabeli i pełne uzasadnienie
// architektury "sygnały -> warunek -> treść" żyją w
// api/generate-coach-tip.js, stała THREAD_LIBRARY).
//
// KONTEKST — dlaczego ten plik teraz istnieje: THREAD_LIBRARY (9 wątków,
// id+signals+situation) była już wpięta w oba kanały Filaru A jako TREŚĆ
// REFERENCYJNA wstrzykiwana do promptu AI (model sam rozpoznaje, czy wątek
// pasuje). Sekcja "CO ŚWIADOMIE NIE JEST TU ZROBIONE" w generate-coach-tip.js
// wprost odnotowywała, że automatyczna, DETERMINISTYCZNA detekcja wątków
// 1-8 (per zawodnik/drużyna, z prawdziwych danych, bez udziału AI) nie
// istnieje — dokładnie to buduje ten plik. Wątek 9 (skok wzrostowy) MA już
// własną automatyczną detekcję (resolveGrowthSpurtContext w
// generate-coach-tip.js) — ten plik go nie dubluje.
//
// ZASADA WSPÓLNA (z zaakceptowanej specyfikacji, nie do naruszenia): każdy
// wątek to WZORZEC do rozważenia, nie reguła diagnostyczna — ta sama
// sytuacja bywa dwoma różnymi, słusznymi wnioskami naraz. Ten plik
// WYŁĄCZNIE wykrywa, czy sygnały wejściowe danego wątku są dziś obecne
// (active: true/false) — NIE ocenia, NIE rankinguje, NIE decyduje co
// trener powinien zrobić. Treść "warto rozważyć" (nigdy "na pewno
// dlatego") budowana jest przez CALLERA (api/generate-coach-tip.js), który
// już ma w zasięgu ręki oryginalny tekst `situation` z THREAD_LIBRARY —
// świadomie NIE duplikowany tutaj (patrz "BRAK CYKLU REQUIRE" niżej).
//
// PROGI LICZBOWE — WAŻNE ZASTRZEŻENIE (ten sam status co progi Gotowości/
// Składu Meczowego gdzie indziej w projekcie): dokument źródłowy podaje
// WYŁĄCZNIE opisy jakościowe ("częsty trening własny", "wysoki odsetek",
// "seria odrzuceń") — ŻADNYCH konkretnych liczb. Każdy próg niżej to MOJA
// logicznie dobrana wartość startowa, nie zbadana/zatwierdzona przez Kubę
// liczba — do korekty bez migracji (wszystkie stałe wyeksportowane w
// _internal), jeśli intuicja trenerska mówi inaczej. Odnotowane osobno w
// DO_ZROBIENIA_PRZEZ_KUBE.md, Pakiet 16.
//
// SKĄD DANE (wszystkie tabele już istnieją, zero nowego SQL):
//   - "silnik gotowości" -> REUŻYWA computeReadinessSignals/
//     fetchReadinessWindowLogs z api/generate-recommendation.js (progi już
//     zaakceptowane przez Kubę 26.07.2026, PRZEGLAD_PROGOW_GOTOWOSCI_I_
//     HORIZON_WEEKS.md) — świadomie NIE duplikowane od zera, żeby nie
//     rozjechać dwóch niezależnych definicji "zmęczenia" w jednym systemie.
//   - "trening własny" / "trening klubowy" -> daily_logs (entry_type=
//     'post_training', session_type='own_training'/'club_training').
//   - "seria odrzuceń sugestii systemu (F23)" -> decision_recommendations
//     (recommendation_type='training_focus', feedback_response).
//   - "powtarzający się ból tej samej lokalizacji" -> pain_entries
//     (body_location, created_at). Uwaga uczciwości: generate-recommendation.js
//     wprost odnotowuje, że "wykrywanie wzorca bólu (pain_pattern_match)"
//     NIE było jeszcze zaprojektowane nigdzie w systemie — mimo że
//     specyfikacja tego wątku zakłada "istniejący mechanizm trendu", taki
//     mechanizm nie istniał przed tym plikiem. Zbudowany tu od zera, prosty
//     licznik powtórzeń per lokalizacja w oknie 30 dni — nie udawany
//     odczyt nieistniejącego mechanizmu.
//   - "mood_motivation w Dzienniku" -> daily_logs (entry_type='morning',
//     payload.mood_motivation).
//   - "zrealizowane zaplanowane treningi" -> calendar_events (status=
//     'scheduled', event_type) + daily_logs.calendar_event_id (ten sam
//     mechanizm "wykonano" co w mobile/docs/KONTRAKT_KALENDARZ.md).
//   - "segment kluczowy dla pozycji" -> player_profiles.position_primary
//     + POSITION_KEY_SEGMENTS niżej (podzbiór tier='key' z POSITION_
//     PROFILES.tiers w index.html — plik zamrożony, dane skopiowane 1:1,
//     ten sam status duplikacji co SEG_NAMES/POSITION_PROFILES gdzie
//     indziej w projekcie — zweryfikowane bezpośrednio w źródle, nie z
//     pamięci). Klucze to DOKŁADNE polskie etykiety z CTX_LABELS.pos w
//     index.html — to jest dokładnie to, co dziś zapisuje się w
//     player_profiles.position_primary (potwierdzone w ASYSTENT_SPORTOWCA_
//     ARCHITEKTURA_TECHNICZNA.md, Domena 13).
//   - "główny deficyt" -> diagnostics.scores + computeRelativeDeficits()
//     REUŻYWANA z api/generate-recommendation.js (ta sama definicja
//     "deficytu", nie druga, osobna heurystyka).
//   - "brak aktywnego celu w segmencie" -> goals (status='active',
//     segment_id).
//   - "mapa cieplna całej drużyny" -> team_memberships (status='active')
//     + diagnostics.scores, ten sam próg TEAM_AGGREGATE_MIN_SIZE=8 co
//     renderAggregate() w coach.html (duplikat udokumentowany niżej).
//
// BRAK CYKLU REQUIRE: ten plik NIE wymaga api/generate-coach-tip.js (mimo
// że to STAMTĄD wołane są funkcje tego pliku) — generate-coach-tip.js już
// ma THREAD_LIBRARY we własnym zasięgu, więc to ONO mapuje id wątku na
// tekst `situation`, nie ten plik. Ten plik wymaga WYŁĄCZNIE
// api/generate-recommendation.js (jednokierunkowo, zero cyklu) po
// computeReadinessSignals/fetchReadinessWindowLogs/computeRelativeDeficits.
//
// ARCHITEKTURA: wzorem już istniejącej sieci zależności segmentów
// (`from`/`to`/`weight`/`ai`) i THREAD_LIBRARY — dane/konfiguracja +
// czyste funkcje decyzyjne (evaluateThreadN, testowalne BEZ atrapy
// Supabase) rozdzielone od warstwy I/O (fetchPlayerThreadContext,
// testowalnej Z atrapą Supabase) — ten sam podział co
// computeReadinessSignals (czyste) vs fetchReadinessWindowLogs (I/O) w
// generate-recommendation.js.
// ============================================================

const {
  fetchReadinessWindowLogs,
  computeReadinessSignals,
  computeRelativeDeficits,
} = require('../api/generate-recommendation.js')._internal;

const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------
// PROGI — patrz zastrzeżenie w nagłówku pliku (decyzje programistyczne,
// nie zbadane liczby).
// ------------------------------------------------------------
const OWN_TRAINING_FREQUENT_WINDOW_DAYS = 14;
const OWN_TRAINING_FREQUENT_MIN_COUNT = 4; // "częsty" -> >=4 sesji własnych/14 dni (~co 3-4 dni)
const REJECTION_STREAK_MIN = 2; // "seria odrzuceń" -> próg NIŻSZY niż eskalacja 3+ w generate-recommendation.js (to inny, wcześniejszy sygnał — nie wywołuje eskalacji, tylko nudge dla trenera)
const REGULAR_PRIOR_WINDOW_DAYS = 28; // okno "wcześniej" dla wątku 3 (dni [-42,-14) względem dziś)
const REGULAR_PRIOR_MIN_COUNT = 4; // "wcześniej regularny" -> >=4 sesji własnych/28 dni (~1/tydz.)
const SUDDEN_DROP_RECENT_MAX_COUNT = 1; // "nagły spadek" -> <=1 sesja własna w ostatnich 14 dniach
const CLUB_TRAINING_STABLE_RATIO = 0.5; // "bez zmiany w klubowym" -> klubowe nie spadło poniżej połowy wcześniejszego tempa
const REPEAT_PAIN_WINDOW_DAYS = 30;
const REPEAT_PAIN_MIN_COUNT = 3; // "powtarzający się" ból tej samej lokalizacji -> >=3 zgłoszenia/30 dni
const OWN_TRAINING_NOT_REDUCED_MIN_COUNT = 2; // "nieredukowany" -> nadal >=2 sesje własne/14 dni mimo bólu
const HIGH_MOOD_THRESHOLD = 7; // 0-10, symetryczne wobec progu "niskiego" nastroju (<=4) w generate-recommendation.js
const HIGH_MOOD_WINDOW_DAYS = 14;
const HIGH_MOOD_MIN_ENTRIES = 2; // minimalna próbka, żeby średnia nie była szumem jednego wpisu
const LOW_COMPLETION_WINDOW_DAYS = 14;
const LOW_COMPLETION_MAX_RATE = 0.5; // "niski odsetek" -> <=50% zrealizowanych
const LOW_COMPLETION_MIN_EVENTS = 3; // minimalna liczba zaplanowanych wydarzeń, żeby odsetek miał sens
const GOAL_STALE_MIN_DIAGNOSIS_AGE_DAYS = 21; // "od wielu tygodni" -> diagnoza (i brak celu) trwa >=21 dni
const LOW_NUTRITION_SCORE_THRESHOLD = 50; // ten sam próg "Do pracy"/"Wymaga uwagi" co heatColor() w index.html
const TEAM_AGGREGATE_MIN_SIZE = 8; // DUPLIKAT świadomy TEAM_AGGREGATE_MIN_SIZE z coach.html (plik statyczny, bez bundlera — nie może zaimportować tej stałej), ten sam status jak inne duplikacje w projekcie
const RECENT_INJURY_WINDOW_DAYS = 7; // "brak urazu" (wątek 7) -> brak zgłoszenia bólu wykluczającego z treningu w ostatnim tygodniu

// POSITION_KEY_SEGMENTS — podzbiór (WYŁĄCZNIE tier='key') POSITION_PROFILES.tiers
// z index.html (plik zamrożony — dane skopiowane, plik nietknięty), kluczowany
// DOKŁADNYMI polskimi etykietami z CTX_LABELS.pos (to samo źródło, zweryfikowane
// wprost) — to jest forma, w jakiej player_profiles.position_primary jest dziś
// zapisywana (potwierdzone w ASYSTENT_SPORTOWCA_ARCHITEKTURA_TECHNICZNA.md,
// Domena 13). "Nie dotyczy" świadomie bez wpisu -> wątek 6 nie ma jak ustalić
// segmentów kluczowych, więc po prostu nie zadziała dla takiego zawodnika
// (fail-safe, nie fail-dangerous).
const POSITION_KEY_SEGMENTS = {
  'Bramkarz': ['mental', 'koncentracja', 'decyzja', 'moc'],
  'Środkowy obrońca': ['percepcja', 'decyzja', 'fizycznosc', 'mental'],
  'Boczny obrońca': ['wytrzymalosc', 'moc', 'decyzja'],
  'Defensywny pomocnik': ['percepcja', 'decyzja', 'koncentracja'],
  'Środkowy pomocnik': ['wytrzymalosc', 'decyzja', 'techFund'],
  'Ofensywny pomocnik': ['techSpec', 'decyzja', 'percepcja', 'mental'],
  'Skrzydłowy': ['moc', 'techSpec', 'decyzja'],
  'Napastnik': ['decyzja', 'techSpec', 'fizycznosc', 'mental'],
};

// diagnostics.scores bywa zapisywany jako string JSON albo jako obiekt,
// zależnie od ścieżki zapisu — DOKŁADNIE ten sam duplikat obrony co
// parseScores() w coach.html (komentarz tam cytuje api_cron_onboard_diagnosis.js).
function parseScores(raw) {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function dateStrUTC(d) {
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// I/O — WARSTWA POBIERANIA DANYCH (testowana z atrapą Supabase)
// ------------------------------------------------------------

async function countSessionsByType(supabase, userId, sessionType, sinceIso, untilIso) {
  let q = supabase.from('daily_logs').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('entry_type', 'post_training').eq('session_type', sessionType)
    .gte('created_at', sinceIso);
  if (untilIso) q = q.lt('created_at', untilIso);
  const { count, error } = await q;
  if (error) throw new Error(`countSessionsByType(${sessionType}): ${error.message}`);
  return count || 0;
}

async function computeRejectionStreakAnySegment(supabase, userId) {
  const { data, error } = await supabase
    .from('decision_recommendations')
    .select('feedback_response')
    .eq('user_id', userId)
    .eq('recommendation_type', 'training_focus')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`computeRejectionStreakAnySegment: ${error.message}`);
  let streak = 0;
  for (const row of data || []) {
    if (row.feedback_response === 'did_not_make_sense') streak++;
    else break;
  }
  return streak;
}

async function fetchRepeatedPainLocation(supabase, userId, sinceIso) {
  const { data, error } = await supabase
    .from('pain_entries')
    .select('body_location, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`fetchRepeatedPainLocation: ${error.message}`);
  const counts = {};
  (data || []).forEach((r) => {
    if (!r.body_location) return;
    counts[r.body_location] = (counts[r.body_location] || 0) + 1;
  });
  let top = null;
  Object.entries(counts).forEach(([loc, n]) => {
    if (n >= REPEAT_PAIN_MIN_COUNT && (!top || n > top.count)) top = { location: loc, count: n };
  });
  return top;
}

async function fetchHasRecentExcludingPain(supabase, userId, sinceIso) {
  const { data, error } = await supabase
    .from('pain_entries')
    .select('id')
    .eq('user_id', userId)
    .eq('excludes_from_training', true)
    .gte('created_at', sinceIso)
    .limit(1);
  if (error) throw new Error(`fetchHasRecentExcludingPain: ${error.message}`);
  return !!(data && data.length);
}

async function fetchRecentMorningAvgMood(supabase, userId, sinceIso) {
  const { data, error } = await supabase
    .from('daily_logs')
    .select('payload')
    .eq('user_id', userId)
    .eq('entry_type', 'morning')
    .gte('created_at', sinceIso);
  if (error) throw new Error(`fetchRecentMorningAvgMood: ${error.message}`);
  const vals = (data || [])
    .map((r) => r.payload && r.payload.mood_motivation)
    .filter((v) => typeof v === 'number');
  if (vals.length < HIGH_MOOD_MIN_ENTRIES) return { active: false, avg: null, n: vals.length };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { active: avg >= HIGH_MOOD_THRESHOLD, avg, n: vals.length };
}

async function computeCalendarCompletionRate(supabase, userId, sinceDateStr, todayDateStr) {
  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'scheduled')
    .in('event_type', ['club_training', 'own_training', 'micro_session'])
    .gte('scheduled_date', sinceDateStr)
    .lt('scheduled_date', todayDateStr);
  if (error) throw new Error(`computeCalendarCompletionRate(events): ${error.message}`);
  const total = (events || []).length;
  if (!total) return { active: false, total: 0, completed: 0, rate: null };
  const ids = events.map((e) => e.id);
  const { data: logged, error: logErr } = await supabase
    .from('daily_logs')
    .select('calendar_event_id')
    .in('calendar_event_id', ids);
  if (logErr) throw new Error(`computeCalendarCompletionRate(logs): ${logErr.message}`);
  const completedIds = new Set((logged || []).map((r) => r.calendar_event_id));
  const completed = ids.filter((id) => completedIds.has(id)).length;
  const rate = completed / total;
  return {
    active: total >= LOW_COMPLETION_MIN_EVENTS && rate <= LOW_COMPLETION_MAX_RATE,
    total, completed, rate,
  };
}

async function fetchTeamRosterUserIds(supabase, teamId) {
  const { data, error } = await supabase
    .from('team_memberships')
    .select('player_user_id')
    .eq('team_id', teamId)
    .eq('status', 'active');
  if (error) throw new Error(`fetchTeamRosterUserIds: ${error.message}`);
  return (data || []).map((r) => r.player_user_id);
}

async function fetchLatestDiagnosisScoresByUser(supabase, userIds) {
  if (!userIds.length) return new Map();
  const { data, error } = await supabase
    .from('diagnostics')
    .select('user_id, scores, created_at')
    .in('user_id', userIds)
    .not('scores', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`fetchLatestDiagnosisScoresByUser: ${error.message}`);
  const byUser = new Map();
  (data || []).forEach((d) => {
    if (!byUser.has(d.user_id)) byUser.set(d.user_id, parseScores(d.scores));
  });
  return byUser;
}

// Zbiera WSZYSTKIE surowe dane potrzebne wątkom 1-7 dla jednego zawodnika,
// jednym zestawem równoległych zapytań — potem czyste funkcje evaluateThreadN
// niżej same nie robią żadnego I/O (łatwe do testowania bez atrapy Supabase).
async function fetchPlayerThreadContext(supabase, userId, now) {
  const nowMs = (now || new Date()).getTime();
  const recentSinceIso = new Date(nowMs - OWN_TRAINING_FREQUENT_WINDOW_DAYS * DAY_MS).toISOString();
  const boundaryIso = recentSinceIso; // granica 14 dni temu, wspólna dla okna "ostatnie" i "wcześniejsze"
  const priorSinceIso = new Date(nowMs - (OWN_TRAINING_FREQUENT_WINDOW_DAYS + REGULAR_PRIOR_WINDOW_DAYS) * DAY_MS).toISOString();
  const painSinceIso = new Date(nowMs - REPEAT_PAIN_WINDOW_DAYS * DAY_MS).toISOString();
  const injurySinceIso = new Date(nowMs - RECENT_INJURY_WINDOW_DAYS * DAY_MS).toISOString();
  const moodSinceIso = new Date(nowMs - HIGH_MOOD_WINDOW_DAYS * DAY_MS).toISOString();
  const todayStr = dateStrUTC(new Date(nowMs));
  const completionSinceStr = dateStrUTC(new Date(nowMs - LOW_COMPLETION_WINDOW_DAYS * DAY_MS));

  const [
    ownTrainingCountRecent14d,
    ownTrainingCountPrior28d,
    clubTrainingCountRecent14d,
    clubTrainingCountPrior28d,
    readinessLogs,
    rejectionStreak,
    repeatedPain,
    hasRecentExcludingPain,
    moodAvg14d,
    calendarCompletion14d,
    profileRes,
    diagRes,
    goalsRes,
  ] = await Promise.all([
    countSessionsByType(supabase, userId, 'own_training', recentSinceIso),
    countSessionsByType(supabase, userId, 'own_training', priorSinceIso, boundaryIso),
    countSessionsByType(supabase, userId, 'club_training', recentSinceIso),
    countSessionsByType(supabase, userId, 'club_training', priorSinceIso, boundaryIso),
    fetchReadinessWindowLogs(supabase, userId),
    computeRejectionStreakAnySegment(supabase, userId),
    fetchRepeatedPainLocation(supabase, userId, painSinceIso),
    fetchHasRecentExcludingPain(supabase, userId, injurySinceIso),
    fetchRecentMorningAvgMood(supabase, userId, moodSinceIso),
    computeCalendarCompletionRate(supabase, userId, completionSinceStr, todayStr),
    supabase.from('player_profiles').select('position_primary').eq('user_id', userId).maybeSingle(),
    supabase.from('diagnostics').select('scores, created_at').eq('user_id', userId)
      .not('scores', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('goals').select('segment_id').eq('user_id', userId).eq('status', 'active'),
  ]);

  if (profileRes.error) throw new Error(`fetchPlayerThreadContext(profile): ${profileRes.error.message}`);
  if (diagRes.error) throw new Error(`fetchPlayerThreadContext(diagnosis): ${diagRes.error.message}`);
  if (goalsRes.error) throw new Error(`fetchPlayerThreadContext(goals): ${goalsRes.error.message}`);

  const readinessSignals = computeReadinessSignals(readinessLogs, new Date(nowMs));
  const diagnosis = diagRes.data;

  return {
    ownTrainingCountRecent14d,
    ownTrainingCountPrior28d,
    clubTrainingCountRecent14d,
    clubTrainingCountPrior28d,
    readinessSignals,
    rejectionStreak,
    repeatedPain,
    hasRecentExcludingPain,
    moodAvg14d,
    calendarCompletion14d,
    positionPrimary: profileRes.data ? profileRes.data.position_primary : null,
    diagnosisScores: diagnosis ? parseScores(diagnosis.scores) : null,
    diagnosisCreatedAt: diagnosis ? diagnosis.created_at : null,
    activeGoalSegments: new Set((goalsRes.data || []).map((g) => g.segment_id)),
    now: new Date(nowMs),
  };
}

// ------------------------------------------------------------
// LOGIKA CZYSTA — WARSTWA DECYZYJNA (testowana BEZ atrapy Supabase, tylko
// z ręcznie skonstruowanym ctx). Każda funkcja zwraca { id, active, detail }.
// ------------------------------------------------------------

function isReadinessFatigueActive(signals) {
  if (!signals) return false;
  return !!(
    (signals.sleepFlag && signals.sleepFlag.active) ||
    (signals.coldStartOrBaseline && signals.coldStartOrBaseline.tired) ||
    (signals.weeklyLoadSpike && signals.weeklyLoadSpike.active)
  );
}

// Wątek 1: częsty trening własny + podwyższone zmęczenie (silnik gotowości).
function evaluateThread1(ctx) {
  const frequentOwnTraining = ctx.ownTrainingCountRecent14d >= OWN_TRAINING_FREQUENT_MIN_COUNT;
  const fatigueActive = isReadinessFatigueActive(ctx.readinessSignals);
  return {
    id: 1,
    active: frequentOwnTraining && fatigueActive,
    detail: { ownTrainingCountRecent14d: ctx.ownTrainingCountRecent14d, fatigueActive },
  };
}

// Wątek 2: częsty trening własny + seria odrzuceń sugestii systemu (F23).
function evaluateThread2(ctx) {
  const frequentOwnTraining = ctx.ownTrainingCountRecent14d >= OWN_TRAINING_FREQUENT_MIN_COUNT;
  const rejectionSeries = ctx.rejectionStreak >= REJECTION_STREAK_MIN;
  return {
    id: 2,
    active: frequentOwnTraining && rejectionSeries,
    detail: { ownTrainingCountRecent14d: ctx.ownTrainingCountRecent14d, rejectionStreak: ctx.rejectionStreak },
  };
}

// Wątek 3: wcześniej regularny trening własny, nagły spadek częstotliwości
// (bez zmiany w klubowym).
function evaluateThread3(ctx) {
  const wasRegular = ctx.ownTrainingCountPrior28d >= REGULAR_PRIOR_MIN_COUNT;
  const droppedOwn = ctx.ownTrainingCountRecent14d <= SUDDEN_DROP_RECENT_MAX_COUNT;
  // Okno "wcześniej" to 28 dni (2x okno "ostatnie" 14-dniowe) -> normalizacja
  // do porównywalnej 14-dniowej stawki przed sprawdzeniem stabilności klubowego.
  const priorClubRate14d = ctx.clubTrainingCountPrior28d / 2;
  const clubStable = priorClubRate14d === 0
    ? true
    : ctx.clubTrainingCountRecent14d >= priorClubRate14d * CLUB_TRAINING_STABLE_RATIO;
  return {
    id: 3,
    active: wasRegular && droppedOwn && clubStable,
    detail: {
      ownTrainingCountPrior28d: ctx.ownTrainingCountPrior28d,
      ownTrainingCountRecent14d: ctx.ownTrainingCountRecent14d,
      clubTrainingCountPrior28d: ctx.clubTrainingCountPrior28d,
      clubTrainingCountRecent14d: ctx.clubTrainingCountRecent14d,
      clubStable,
    },
  };
}

// Wątek 4: powtarzający się ból tej samej lokalizacji + trening własny
// nieredukowany.
function evaluateThread4(ctx) {
  const active = !!ctx.repeatedPain && ctx.ownTrainingCountRecent14d >= OWN_TRAINING_NOT_REDUCED_MIN_COUNT;
  return {
    id: 4,
    active,
    detail: { repeatedPain: ctx.repeatedPain, ownTrainingCountRecent14d: ctx.ownTrainingCountRecent14d },
  };
}

// Wątek 5: wysoka mood_motivation w Dzienniku + niski odsetek zrealizowanych
// zaplanowanych treningów.
function evaluateThread5(ctx) {
  const moodActive = !!(ctx.moodAvg14d && ctx.moodAvg14d.active);
  const completionActive = !!(ctx.calendarCompletion14d && ctx.calendarCompletion14d.active);
  return {
    id: 5,
    active: moodActive && completionActive,
    detail: { mood: ctx.moodAvg14d, completion: ctx.calendarCompletion14d },
  };
}

// Wątek 6: segment kluczowy dla pozycji = główny deficyt + brak aktywnego
// celu w tym segmencie od wielu tygodni.
function evaluateThread6(ctx) {
  const keySegs = ctx.positionPrimary ? POSITION_KEY_SEGMENTS[ctx.positionPrimary] : null;
  if (!keySegs || !ctx.diagnosisScores || !ctx.diagnosisCreatedAt) {
    return { id: 6, active: false, detail: { reason: 'brak pozycji z mapowaniem lub brak diagnozy' } };
  }
  const nowMs = (ctx.now || new Date()).getTime();
  const diagnosisAgeDays = (nowMs - new Date(ctx.diagnosisCreatedAt).getTime()) / DAY_MS;
  if (diagnosisAgeDays < GOAL_STALE_MIN_DIAGNOSIS_AGE_DAYS) {
    return { id: 6, active: false, detail: { reason: 'diagnoza zbyt świeża', diagnosisAgeDays } };
  }
  const deficits = computeRelativeDeficits(ctx.diagnosisScores, 1);
  if (!deficits.length) {
    return { id: 6, active: false, detail: { reason: 'brak wyraźnego deficytu względnego' } };
  }
  const topDeficitSegment = deficits[0][0];
  if (!keySegs.includes(topDeficitSegment)) {
    return { id: 6, active: false, detail: { topDeficitSegment, reason: 'deficyt nie jest kluczowy dla tej pozycji' } };
  }
  const hasActiveGoal = ctx.activeGoalSegments && ctx.activeGoalSegments.has(topDeficitSegment);
  return { id: 6, active: !hasActiveGoal, detail: { topDeficitSegment, hasActiveGoal } };
}

// Wątek 7: podwyższone zmęczenie bez wytłumaczenia treningowego (brak
// nadmiernej objętości, brak urazu) + niski wynik segmentu odżywianie.
function evaluateThread7(ctx) {
  const s = ctx.readinessSignals || {};
  const physicalFatigue = !!((s.sleepFlag && s.sleepFlag.active) || (s.coldStartOrBaseline && s.coldStartOrBaseline.tired));
  const loadSpikeActive = !!(s.weeklyLoadSpike && s.weeklyLoadSpike.active);
  const unexplainedFatigue = physicalFatigue && !loadSpikeActive && !ctx.hasRecentExcludingPain;
  const nutritionScore = ctx.diagnosisScores ? ctx.diagnosisScores.odzywianie : null;
  const lowNutrition = typeof nutritionScore === 'number' && nutritionScore < LOW_NUTRITION_SCORE_THRESHOLD;
  return {
    id: 7,
    active: unexplainedFatigue && lowNutrition,
    detail: { unexplainedFatigue, loadSpikeActive, hasRecentExcludingPain: ctx.hasRecentExcludingPain, nutritionScore },
  };
}

// Wątek 8 (poziom drużyny): odżywianie jako częsty wspólny deficyt na
// mapie cieplnej całej drużyny.
function evaluateThread8(rosterSize, scoresByUser) {
  if (rosterSize < TEAM_AGGREGATE_MIN_SIZE) {
    return { id: 8, active: false, detail: { reason: 'drużyna za mała na agregat (próg prywatności)', rosterSize } };
  }
  let sum = 0;
  let n = 0;
  scoresByUser.forEach((scores) => {
    const v = scores && scores.odzywianie;
    if (typeof v === 'number') { sum += v; n++; }
  });
  if (n < TEAM_AGGREGATE_MIN_SIZE) {
    return { id: 8, active: false, detail: { reason: 'za mało wyników segmentu odżywianie w drużynie', n } };
  }
  const avgNutritionScore = sum / n;
  return {
    id: 8,
    active: avgNutritionScore < LOW_NUTRITION_SCORE_THRESHOLD,
    detail: { avgNutritionScore, contributingPlayers: n },
  };
}

// ------------------------------------------------------------
// ORKIESTRATORY PUBLICZNE
// ------------------------------------------------------------

async function detectPlayerThreadSignals(supabase, playerUserId, now) {
  const ctx = await fetchPlayerThreadContext(supabase, playerUserId, now);
  return [
    evaluateThread1(ctx),
    evaluateThread2(ctx),
    evaluateThread3(ctx),
    evaluateThread4(ctx),
    evaluateThread5(ctx),
    evaluateThread6(ctx),
    evaluateThread7(ctx),
  ];
}

async function detectTeamThreadSignals(supabase, teamId) {
  const rosterIds = await fetchTeamRosterUserIds(supabase, teamId);
  const scoresByUser = await fetchLatestDiagnosisScoresByUser(supabase, rosterIds);
  return [evaluateThread8(rosterIds.length, scoresByUser)];
}

module.exports = {
  detectPlayerThreadSignals,
  detectTeamThreadSignals,
  _internal: {
    DAY_MS,
    OWN_TRAINING_FREQUENT_WINDOW_DAYS,
    OWN_TRAINING_FREQUENT_MIN_COUNT,
    REJECTION_STREAK_MIN,
    REGULAR_PRIOR_WINDOW_DAYS,
    REGULAR_PRIOR_MIN_COUNT,
    SUDDEN_DROP_RECENT_MAX_COUNT,
    CLUB_TRAINING_STABLE_RATIO,
    REPEAT_PAIN_WINDOW_DAYS,
    REPEAT_PAIN_MIN_COUNT,
    OWN_TRAINING_NOT_REDUCED_MIN_COUNT,
    HIGH_MOOD_THRESHOLD,
    HIGH_MOOD_WINDOW_DAYS,
    HIGH_MOOD_MIN_ENTRIES,
    LOW_COMPLETION_WINDOW_DAYS,
    LOW_COMPLETION_MAX_RATE,
    LOW_COMPLETION_MIN_EVENTS,
    GOAL_STALE_MIN_DIAGNOSIS_AGE_DAYS,
    LOW_NUTRITION_SCORE_THRESHOLD,
    TEAM_AGGREGATE_MIN_SIZE,
    RECENT_INJURY_WINDOW_DAYS,
    POSITION_KEY_SEGMENTS,
    parseScores,
    dateStrUTC,
    isReadinessFatigueActive,
    evaluateThread1,
    evaluateThread2,
    evaluateThread3,
    evaluateThread4,
    evaluateThread5,
    evaluateThread6,
    evaluateThread7,
    evaluateThread8,
    fetchPlayerThreadContext,
    countSessionsByType,
    computeRejectionStreakAnySegment,
    fetchRepeatedPainLocation,
    fetchHasRecentExcludingPain,
    fetchRecentMorningAvgMood,
    computeCalendarCompletionRate,
    fetchTeamRosterUserIds,
    fetchLatestDiagnosisScoresByUser,
  },
};

// ============================================================
// CO ŚWIADOMIE NIE JEST TU ZROBIONE
//
// 1. Progi liczbowe (patrz zastrzeżenie w nagłówku) — logicznie dobrane
//    wartości startowe, nie zbadane/zatwierdzone przez Kubę liczby. Do
//    korekty bez migracji (wszystkie w _internal).
// 2. Wątek 9 (skok wzrostowy) — ma już WŁASNĄ automatyczną detekcję
//    (resolveGrowthSpurtContext w api/generate-coach-tip.js), świadomie
//    nie duplikowana tutaj.
// 3. Wywołanie/wpięcie do dispatchera i UI — celowo POZA tym plikiem
//    (czysta warstwa detekcji + I/O), patrz api/generate-coach-tip.js
//    (akcja 'detect_coach_threads' + sygnał wątku 8 w notatce żywieniowej
//    generateCoachTip), api/coach-chat.js (kontekst wątków 1-7 dla pytań
//    o konkretnego zawodnika) i coach.html (sekcja "Warto rozważyć" w
//    widoku szczegółów zawodnika).
// 4. Log wyświetleń wątku (do przyszłej analizy skuteczności biblioteki)
//    — świadomie POZA zakresem, żadna dzisiejsza specyfikacja tego nie
//    wymaga, nowa tabela byłaby budowana "na zapas".
// ============================================================
