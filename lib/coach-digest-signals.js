// ============================================================
// GAMECHANGE — lib/coach-digest-signals.js
// ============================================================
// Digest sygnałów trenerskich (e-mail, zdarzeniowy, z deduplikacją) —
// zamówione bezpośrednio przez Kubę w rozmowie 04.08.2026: "jeżeli trener
// zaznaczy szczerze w czym chce przemywać podpowiedzi... to jeżeli tylko
// aplikacja coś zauważy, wyśle mu informację". Trzy grupy, 7 sygnałów:
//
//   Grupa 1 — Ryzyko/obciążenie (treść JUŻ ZATWIERDZONA przez Kubę,
//     `PLAN_SPOJNEJ_SCIEZKI.md`, sekcja "ŚCIEŻKA TRENERA" — użyta dosłownie
//     w lib/email-templates.js, NIE w tym pliku):
//       1. team_overload
//       2. player_risk_standout
//   Grupa 2 — Zaangażowanie/aktywność (nowość, zamówiona dziś):
//       3. player_went_quiet
//       4. player_never_started
//   Grupa 3 — Docenienie/postęp (nowość, PIERWSZY mechanizm czysto
//     pochwalny w projekcie — nie tylko "nigdy nie karze"):
//       5. player_high_consistency
//       6. focus_block_completed_strong
//       7. goal_achieved
//
// ARCHITEKTURA (wzorem lib/coach-thread-library.js): CZYSTE funkcje
// detekcji tutaj — przyjmują JUŻ POBRANE dane, zero zapytań SQL same,
// testowalne bez atrapy Supabase/sieci. Warstwa I/O (zapytania, wysyłka
// maila, log deduplikacji) żyje w lib/coach-digest.js, który te funkcje
// woła.
//
// PROGI LICZBOWE — ten sam status co progi w coach-thread-library.js:
// gdzie zlecenie/decyzje Kuby podają dokładną liczbę (14 dni cooldown
// standout, 21 dni okno/cooldown konsekwencji, 80%/40% jako "np.") —
// zaznaczone niżej. Gdzie zlecenie mówi tylko "zaproponuj" — to MOJA
// autonomiczna, logicznie dobrana wartość startowa, NIE zbadana/
// zatwierdzona przez Kubę liczba — każda jako osobna, nazwana stała,
// żeby korekta była zmianą jednej linii, nie polowaniem w logice.
// Pełna lista siedmiu progów: `claude/DO_ZROBIENIA_PRZEZ_KUBE.md`,
// pakiet "Digest sygnałów trenerskich".
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------
// GRUPA 1 — Ryzyko/obciążenie
// ------------------------------------------------------------

// Sygnał 1 (team_overload). Próg minimalnej liczby zawodników Z DANYMI —
// ten sam duch ostrożności co TEAM_AGGREGATE_MIN_SIZE=8 gdzie indziej w
// projekcie (heatmapa drużynowa/panel_trenera.html), ale świadomie NIŻSZY
// tutaj: to nie jest publiczna, zanonimizowana agregacja pokazywana w UI,
// to prywatny e-mail wyłącznie do trenera samej drużyny, a "istotna
// część zawodników" (zlecenie: "np. ≥5") musi być odczuwalna nawet w
// mniejszych, młodzieżowych drużynach pilotażu.
const TEAM_OVERLOAD_MIN_PLAYERS_WITH_DATA = 5;
// "≥40% z nich pokazuje podwyższone zmęczenie/sen/nastrój jednocześnie" —
// zlecenie: "np. ≥40%".
const TEAM_OVERLOAD_ELEVATED_RATIO = 0.4;

// Sygnał 2 (player_risk_standout). Dedup 14 dni — PODANE WPROST w
// zleceniu (nie moja autonomiczna liczba). Okno "niedawny ból wykluczający
// z treningu" — 7 dni, ten sam duch co RECENT_INJURY_WINDOW_DAYS w
// lib/coach-thread-library.js (mój wybór, spójny z resztą projektu).
const PLAYER_RISK_STANDOUT_DEDUP_COOLDOWN_DAYS = 14;
const PLAYER_RISK_STANDOUT_RECENT_PAIN_WINDOW_DAYS = 7;

// ------------------------------------------------------------
// GRUPA 2 — Zaangażowanie/aktywność
// ------------------------------------------------------------

// Sygnał 3 (player_went_quiet). Próg DŁUŻSZY niż RETENTION_INACTIVITY_
// THRESHOLD_DAYS (6, dla zawodnika) — zlecenie: "zaproponuj np. 10 dni
// jako sensowny domyślny próg". Osobna stała, NIE dzielona z retention-
// check.js (inny odbiorca, inny rytm — patrz nagłówek lib/retention-check.js).
const COACH_DIGEST_QUIET_THRESHOLD_DAYS = 10;

// Sygnał 4 (player_never_started). Zlecenie: "zaproponuj np. 5 dni".
const PLAYER_NEVER_STARTED_MIN_DAYS_SINCE_JOIN = 5;

// ------------------------------------------------------------
// GRUPA 3 — Docenienie/postęp
// ------------------------------------------------------------

// Sygnał 5 (player_high_consistency). Okno 21 dni i dedup "co najwyżej
// raz na 21 dni" — PODANE WPROST w zleceniu. Próg odsetka — zlecenie:
// "zaproponuj próg, np. ≥85%".
const HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS = 21;
const HIGH_CONSISTENCY_JOURNAL_RATIO_THRESHOLD = 0.85;
const HIGH_CONSISTENCY_DEDUP_COOLDOWN_DAYS = 21;
// Kryterium OR (calendar_events) — minimalna próbka, żeby odsetek nie był
// szumem 1-2 wydarzeń (ten sam duch co LOW_COMPLETION_MIN_EVENTS w
// lib/coach-thread-library.js). Mój wybór, nie z zlecenia wprost.
const HIGH_CONSISTENCY_MIN_CALENDAR_EVENTS = 5;
// Ten sam próg 85% reużyty dla obu kryteriów (dziennik ORAZ kalendarz) —
// świadomie jeden numer do skorygowania, nie dwa niezależne, niewyjaśnione.
const HIGH_CONSISTENCY_CALENDAR_RATIO_THRESHOLD = HIGH_CONSISTENCY_JOURNAL_RATIO_THRESHOLD;

// Sygnał 6 (focus_block_completed_strong). Zlecenie: "np. ≥80%". Minimalna
// liczba sesji zaplanowanych w bloku, żeby "80%" nie był artefaktem
// bloku 1-2 sesyjnego (mój wybór, defensywny, nie z zlecenia).
const FOCUS_BLOCK_STRONG_COMPLETION_RATIO = 0.8;
const FOCUS_BLOCK_STRONG_MIN_TOTAL_SESSIONS = 6;

// Ochronny limit liczby e-maili wysyłanych w JEDNYM przebiegu crona —
// ten sam duch co MAX_PER_RUN w lib/retention-check.js/lib/training-focus-
// rotation.js, tu jako osobna, jawna stała (mój autonomiczny wybór, w
// praktyce nieistotny przy skali pilotażu, ale warto mieć twardy sufit
// od pierwszego dnia zamiast dopisywać go dopiero po incydencie).
const MAX_DIGEST_EMAILS_PER_RUN = 30;

// ------------------------------------------------------------
// Pomocnicze — data/tydzień ISO (dedup team_overload: "co najwyżej raz na
// tydzień", signal_key = numer tygodnia ISO, np. "2026-W32").
// ------------------------------------------------------------
function isoWeekKey(date) {
  const src = date || new Date();
  const d = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Pon=0..Ndz=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // najbliższy czwartek tego tygodnia
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNum = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function dateKeyUTC(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

// Liczy dni kalendarzowe (UTC) z co najmniej jednym wpisem, na podstawie
// listy created_at (dowolny typ wpisu Dziennika liczy się jako "wpis
// tego dnia" — zlecenie mówi o "dniach z wpisem", nie tylko porannych).
function countDistinctDaysWithEntries(createdAtList) {
  const days = new Set((createdAtList || []).map(dateKeyUTC));
  return days.size;
}

// ------------------------------------------------------------
// LOGIKA CZYSTA — SYGNAŁ 1: team_overload
// ------------------------------------------------------------
function isReadinessElevated(signals) {
  if (!signals) return false;
  return !!(
    (signals.sleepFlag && signals.sleepFlag.active) ||
    (signals.coldStartOrBaseline && signals.coldStartOrBaseline.tired) ||
    (signals.weeklyLoadSpike && signals.weeklyLoadSpike.active) ||
    (signals.moodFlag && signals.moodFlag.active)
  );
}

function detectTeamOverload({ eligiblePlayersCount, elevatedCount, now } = {}) {
  const n = eligiblePlayersCount || 0;
  const elevated = elevatedCount || 0;
  const ratio = n > 0 ? elevated / n : 0;
  const active = n >= TEAM_OVERLOAD_MIN_PLAYERS_WITH_DATA && ratio >= TEAM_OVERLOAD_ELEVATED_RATIO;
  return {
    signalType: 'team_overload',
    active,
    signalKey: isoWeekKey(now),
    detail: { eligiblePlayersCount: n, elevatedCount: elevated, ratio },
  };
}

// ------------------------------------------------------------
// LOGIKA CZYSTA — SYGNAŁ 2: player_risk_standout
// ------------------------------------------------------------
// NIGDY diagnoza medyczna — tylko "warto sprawdzić", zgodnie z granicą
// "narzędzie jest nawigatorem, nie trenerem" już ustaloną w projekcie.
// injuryModeActive: tryb kontuzji AKTYWNY DZIŚ (player_profiles.
// injury_mode_active) — "nowo aktywny" w sensie ścisłym (moment aktywacji)
// nie jest dziś rejestrowany w schemacie (brak kolumny start/timestamp na
// player_profiles dla tego pola — sprawdzone, świadomie NIE zgadywane) —
// uproszczone do "aktywny", z ochroną przed spamem przez sam cooldown
// dedup 14-dniowy (patrz DO_ZROBIENIA_PRZEZ_KUBE.md, uczciwie opisane).
function detectPlayerRiskStandout({ readinessSignals, injuryModeActive, recentExcludingPain } = {}) {
  const fatigueActive = isReadinessElevated(readinessSignals);
  const active = !!(fatigueActive || injuryModeActive || recentExcludingPain);
  return {
    signalType: 'player_risk_standout',
    active,
    detail: { fatigueActive, injuryModeActive: !!injuryModeActive, recentExcludingPain: !!recentExcludingPain },
  };
}

// ------------------------------------------------------------
// LOGIKA CZYSTA — SYGNAŁ 3: player_went_quiet
// ------------------------------------------------------------
// Reużywa DOKŁADNIE logikę lib/retention-check.js (lastActivityAt =
// MAX(daily_logs.created_at, match_contexts.created_at), obliczone przez
// warstwę I/O w lib/coach-digest.js przez tę samą computeLastActivityAt()).
// signalKey = lastActivityAt -- ten sam wzorzec "epizodu" co retention-
// check.js: reset gdy zawodnik znów zaloguje aktywność (nowy lastActivityAt
// = nowy epizod = wysyłka wraca).
function detectPlayerWentQuiet({ lastActivityAt, now, thresholdDays } = {}) {
  const threshold = thresholdDays == null ? COACH_DIGEST_QUIET_THRESHOLD_DAYS : thresholdDays;
  if (!lastActivityAt) {
    return { signalType: 'player_went_quiet', active: false, signalKey: null, detail: { reason: 'no_activity_ever' } };
  }
  const nowMs = (now || new Date()).getTime();
  const daysSince = (nowMs - new Date(lastActivityAt).getTime()) / DAY_MS;
  return {
    signalType: 'player_went_quiet',
    active: daysSince >= threshold,
    signalKey: lastActivityAt,
    detail: { daysSince, lastActivityAt, thresholdDays: threshold },
  };
}

// ------------------------------------------------------------
// LOGIKA CZYSTA — SYGNAŁ 4: player_never_started
// ------------------------------------------------------------
// Inny przypadek niż sygnał 3 (nigdy nie zaczął, nie "przestał"). Dedup
// jednorazowy per (zawodnik, drużyna) — signalKey stały, log sam w sobie
// (obecność wiersza) jest dedupem "na zawsze".
function detectPlayerNeverStarted({ joinedAt, hasAnyDailyLog, now, thresholdDays } = {}) {
  const threshold = thresholdDays == null ? PLAYER_NEVER_STARTED_MIN_DAYS_SINCE_JOIN : thresholdDays;
  if (hasAnyDailyLog) {
    return { signalType: 'player_never_started', active: false, signalKey: 'never_started', detail: { reason: 'has_logs' } };
  }
  const nowMs = (now || new Date()).getTime();
  const daysSinceJoin = (nowMs - new Date(joinedAt).getTime()) / DAY_MS;
  return {
    signalType: 'player_never_started',
    active: daysSinceJoin >= threshold,
    signalKey: 'never_started',
    detail: { daysSinceJoin, thresholdDays: threshold },
  };
}

// ------------------------------------------------------------
// LOGIKA CZYSTA — SYGNAŁ 5: player_high_consistency
// ------------------------------------------------------------
// journalDaysWithEntry: liczba DNI (nie wpisów) z >=1 wpisem Dziennika w
// oknie HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS. calendarCompletedCount/
// calendarTotalCount: opcjonalne, kryterium OR — "wykonano" liczone TYM
// SAMYM mechanizmem co mobile/docs/KONTRAKT_KALENDARZ.md ("Wykonano" =
// istnieje daily_logs.calendar_event_id wskazujący na dane wydarzenie),
// nie surową kolumną calendar_events.status (jej dokładna semantyka poza
// "scheduled"/"cancelled" nie jest w 100% pewna — patrz komentarz w
// lib/coach-digest.js).
function detectPlayerHighConsistency({
  journalDaysWithEntry,
  journalWindowDays,
  calendarCompletedCount = null,
  calendarTotalCount = null,
} = {}) {
  const windowDays = journalWindowDays || HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS;
  const journalRatio = windowDays > 0 ? (journalDaysWithEntry || 0) / windowDays : 0;
  const journalStrong = journalRatio >= HIGH_CONSISTENCY_JOURNAL_RATIO_THRESHOLD;

  let calendarStrong = false;
  let calendarRatio = null;
  if (typeof calendarTotalCount === 'number' && calendarTotalCount >= HIGH_CONSISTENCY_MIN_CALENDAR_EVENTS) {
    calendarRatio = (calendarCompletedCount || 0) / calendarTotalCount;
    calendarStrong = calendarRatio >= HIGH_CONSISTENCY_CALENDAR_RATIO_THRESHOLD;
  }

  return {
    signalType: 'player_high_consistency',
    active: journalStrong || calendarStrong,
    detail: {
      journalDaysWithEntry: journalDaysWithEntry || 0,
      journalWindowDays: windowDays,
      journalRatio,
      journalStrong,
      calendarCompletedCount,
      calendarTotalCount,
      calendarRatio,
      calendarStrong,
    },
  };
}

// ------------------------------------------------------------
// LOGIKA CZYSTA — SYGNAŁ 6: focus_block_completed_strong
// ------------------------------------------------------------
// "Ukończył" -- wymagamy, żeby blok NIE był już dziś status='active'
// (musiał dojść do jakiegoś zamknięcia/przejścia), NIE polegamy na
// dokładnej nazwie stanu terminalnego (nie w 100% potwierdzona w tej
// sesji — patrz komentarz w lib/coach-digest.js) — `status !== 'active'`
// jest bezpieczniejszym, defensywnym testem niż zgadywanie 'closed' vs
// 'completed'.
function detectFocusBlockCompletedStrong({ status, completedCount, totalCount } = {}) {
  const total = totalCount || 0;
  const completed = completedCount || 0;
  const ratio = total > 0 ? completed / total : 0;
  const isConcluded = !!status && status !== 'active';
  const active = isConcluded && total >= FOCUS_BLOCK_STRONG_MIN_TOTAL_SESSIONS && ratio >= FOCUS_BLOCK_STRONG_COMPLETION_RATIO;
  return {
    signalType: 'focus_block_completed_strong',
    active,
    detail: { status, completedCount: completed, totalCount: total, ratio, isConcluded },
  };
}

// ------------------------------------------------------------
// LOGIKA CZYSTA — SYGNAŁ 7: goal_achieved
// ------------------------------------------------------------
function detectGoalAchieved({ status } = {}) {
  return { signalType: 'goal_achieved', active: status === 'completed', detail: { status } };
}

// ------------------------------------------------------------
// DEDUPLIKACJA — czyste funkcje, przyjmują JUŻ POBRANE wiersze logu
// (coach_digest_signal_log), filtrowane przez wywołującego po właściwych
// kolumnach identyfikujących (coach_user_id + team_id/player_user_id +
// signal_type) — ta warstwa tylko decyduje, patrząc na `logs`.
// ------------------------------------------------------------
const SIGNAL_TYPES = [
  'team_overload',
  'player_risk_standout',
  'player_went_quiet',
  'player_never_started',
  'player_high_consistency',
  'focus_block_completed_strong',
  'goal_achieved',
];

// 'exact' -- nie wysyłaj drugi raz z DOKŁADNIE tym samym signal_key
//   (team_overload: ten sam tydzień ISO; player_went_quiet: ten sam
//   epizod nieaktywności; player_never_started/focus_block_completed_
//   strong/goal_achieved: jednorazowo na zawsze, stały/naturalny klucz).
// 'cooldown' -- nie wysyłaj, jeśli OSTATNI log dla tego (celu, typu)
//   sygnału jest młodszy niż N dni, niezależnie od tego czy warunek wciąż
//   trwa (player_risk_standout: 14 dni; player_high_consistency: 21 dni).
const DEDUP_MODE = {
  team_overload: 'exact',
  player_risk_standout: 'cooldown',
  player_went_quiet: 'exact',
  player_never_started: 'exact',
  player_high_consistency: 'cooldown',
  focus_block_completed_strong: 'exact',
  goal_achieved: 'exact',
};

const COOLDOWN_DAYS_BY_SIGNAL = {
  player_risk_standout: PLAYER_RISK_STANDOUT_DEDUP_COOLDOWN_DAYS,
  player_high_consistency: HIGH_CONSISTENCY_DEDUP_COOLDOWN_DAYS,
};

function isDedupedByExactKey({ logs, signalKey }) {
  if (signalKey == null) return false;
  // Porównanie po String() celowo, nie ===: signal_key wraca z Postgresu/
  // logu ZAWSZE jako string (kolumna text), ale wywołujący może przekazać
  // signalKey pochodzący z bigint/numeric id (np. goals.id) jako liczbę JS
  // -- bez koercji `101 === '101'` byłoby fałszywie false i deduplikacja
  // cicho by nie działała dla takich sygnałów (znalezione i naprawione
  // przy budowie lib/coach-digest.js, scenariusz goal_achieved).
  const key = String(signalKey);
  return (logs || []).some((l) => String(l.signal_key) === key);
}

function isDedupedByCooldown({ logs, now, cooldownDays }) {
  if (!logs || !logs.length) return false;
  const nowMs = (now || new Date()).getTime();
  return logs.some((l) => (nowMs - new Date(l.sent_at).getTime()) < cooldownDays * DAY_MS);
}

// Wspólny punkt wejścia — `logs` już przefiltrowane przez wywołującego po
// (coach_user_id, team_id/player_user_id, signal_type).
function isSignalDeduped({ signalType, logs, signalKey, now }) {
  const mode = DEDUP_MODE[signalType];
  if (mode === 'cooldown') {
    return isDedupedByCooldown({ logs, now, cooldownDays: COOLDOWN_DAYS_BY_SIGNAL[signalType] });
  }
  return isDedupedByExactKey({ logs, signalKey });
}

module.exports = {
  // stałe/progi (patrz nagłówek dla pełnego wyjaśnienia statusu każdej)
  TEAM_OVERLOAD_MIN_PLAYERS_WITH_DATA,
  TEAM_OVERLOAD_ELEVATED_RATIO,
  PLAYER_RISK_STANDOUT_DEDUP_COOLDOWN_DAYS,
  PLAYER_RISK_STANDOUT_RECENT_PAIN_WINDOW_DAYS,
  COACH_DIGEST_QUIET_THRESHOLD_DAYS,
  PLAYER_NEVER_STARTED_MIN_DAYS_SINCE_JOIN,
  HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS,
  HIGH_CONSISTENCY_JOURNAL_RATIO_THRESHOLD,
  HIGH_CONSISTENCY_DEDUP_COOLDOWN_DAYS,
  HIGH_CONSISTENCY_MIN_CALENDAR_EVENTS,
  HIGH_CONSISTENCY_CALENDAR_RATIO_THRESHOLD,
  FOCUS_BLOCK_STRONG_COMPLETION_RATIO,
  FOCUS_BLOCK_STRONG_MIN_TOTAL_SESSIONS,
  MAX_DIGEST_EMAILS_PER_RUN,
  SIGNAL_TYPES,
  DEDUP_MODE,
  COOLDOWN_DAYS_BY_SIGNAL,
  // pomocnicze
  isoWeekKey,
  dateKeyUTC,
  countDistinctDaysWithEntries,
  isReadinessElevated,
  // detekcja (7 sygnałów)
  detectTeamOverload,
  detectPlayerRiskStandout,
  detectPlayerWentQuiet,
  detectPlayerNeverStarted,
  detectPlayerHighConsistency,
  detectFocusBlockCompletedStrong,
  detectGoalAchieved,
  // deduplikacja
  isDedupedByExactKey,
  isDedupedByCooldown,
  isSignalDeduped,
};
