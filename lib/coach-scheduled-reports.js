// ============================================================
// GAMECHANGE — lib/coach-scheduled-reports.js
// ============================================================
// Orkiestrator "Raportów w wybranych momentach" (Pakiet 20, 04.08.2026).
// Pełne uzasadnienie i analiza: claude/INTEGRACJA_RAPORTY_KRYTYCZNE_MOMENTY.md
// (Project Knowledge). Migracja: claude/INTEGRACJA_RAPORTY_KRYTYCZNE_MOMENTY_SQL.md.
//
// ⚠️ ODTWORZONY 05.08.2026 — ten plik zniknął z dysku mimo że dokumentacja
// projektu (`claude/DO_ZROBIENIA_PRZEZ_KUBE.md`) twierdziła "Na dysku,
// 39/39 testów przechodzi". Sesja z 05.08.2026 (ZADANIE 3, weryfikacja
// Pakietu 20) potwierdziła jego brak niezależnie DWOMA metodami
// (device_stage_files -> "does not exist" ORAZ pełny device_list_dir na
// folderze lib/ -> plik nieobecny na liście 17 plików). Kuba potwierdził,
// że nic ręcznie nie zmieniał w tym folderze. Ten plik jest odtworzeniem
// na podstawie pełnej specyfikacji projektowej (dokument wyżej) i wzorców
// z siostrzanego, wciąż obecnego na dysku `lib/coach-digest.js`/
// `lib/coach-digest-signals.js` (Pakiet 19) — NIE jest bajt-w-bajt kopią
// oryginału (ten nigdy nie trafił do Project Knowledge jako pełny kod),
// więc traktuj to jako nowy kod do przejrzenia, nie gwarantowaną
// restaurację. Zweryfikowany lokalnie (ten sam sandbox co reszta testów
// projektu) przed zapisem na dysk Kuby — patrz tests/test-coach-scheduled-
// reports.js.
//
// MECHANIZM: w odróżnieniu od Digestu (Pakiet 19, zdarzeniowy — e-mail gdy
// coś się ZMIENI), to jest CZASOWY mechanizm — trener sam wybiera KONKRETNY
// MOMENT, w którym chce dostać snapshot stanu drużyny, niezależnie od tego,
// czy coś się zmieniło. Dwa raporty w V1:
//   1. pre_match_team_briefing — wieczorem, dzień przed najbliższym meczem
//      drużyny (przynajmniej jeden zawodnik z rosteru ma jutro
//      calendar_events.event_type='match'), zbiorczy snapshot
//      get_pre_match_signals(team_id) — ta sama funkcja SQL co widok
//      "Skład Meczowy" w coach.html.
//   2. weekly_team_pulse — raz w tygodniu, w dniu wybranym przez trenera —
//      ilu zawodników z rosteru było aktywnych w Dzienniku w ostatnich 7
//      dniach + ile aktywnych Bloków Skupienia ma dziś drużyna.
//
// OPT-IN, ODWROTNIE NIŻ DIGEST (coach_scheduled_report_preferences: brak
// wiersza = WYŁĄCZONE) — świadoma, uzasadniona różnica: to nowy typ
// e-maila, o który żaden trener jeszcze nie prosił, więc wysyłanie go
// wszystkim od razu ryzykowałoby wrażenie spamu. Pełne uzasadnienie w
// dokumencie projektowym, sekcja 5.
//
// PREFERENCJE PER TRENER, NIE PER DRUŻYNA — ten sam wzorzec co
// coach_digest_preferences (Pakiet 19): jeśli trener prowadzi więcej niż
// jedną drużynę, jego wybór obowiązuje jednakowo dla wszystkich jego
// drużyn.
//
// DRY, ZERO DUPLIKACJI: fetchTeamsWithCoach/fetchUsersByIds/fetchRoster
// reużyte z lib/coach-digest.js._internal, isoWeekKey reużyte z
// lib/coach-digest-signals.js — DOKŁADNIE zgodnie z decyzją projektową w
// dokumencie (sekcja 5). ŚWIADOMIE lazy require() (wewnątrz funkcji, nie
// na górze pliku) dla lib/coach-digest.js — ten plik transitywnie wymaga
// ../api/generate-recommendation.js -> @supabase/supabase-js, którego NIE
// MA w tym sandboxie (potwierdzone: `require.resolve('@supabase/supabase-js')`
// rzuca MODULE_NOT_FOUND) — dokładnie ten sam powód, dla którego test-coach-
// digest-signals.js celowo testuje WYŁĄCZNIE lib/coach-digest-signals.js
// (zero require), nie lib/coach-digest.js. Top-level require tutaj
// uniemożliwiłby uruchomienie testów warstwy czystej w tym samym sandboxie
// co reszta projektu — lazy require przesuwa koszt ładowania modułu na
// moment FAKTYCZNEGO wywołania runCoachScheduledReportsCheck (produkcja
// Vercel, gdzie @supabase/supabase-js jest zainstalowany), zero zmiany
// zachowania w runtime, zero zmiany DRY-reużycia z dokumentu projektowego.
//
// GATING WIDOCZNOŚCI: świadomie NIE powtórzony tutaj dla pre_match_team_
// briefing — get_pre_match_signals() sama już filtruje flagi wg
// team.visibility_level (Podstawowy/Rozszerzony/Pełny), więc e-mail
// pokazuje dokładnie to, co trener i tak widzi w UI na swoim poziomie
// zgody, bez duplikowania tej logiki po stronie klienta tego pliku.
//
// LIMIT OCHRONNY MAX_SCHEDULED_REPORT_EMAILS_PER_RUN=30 per przebieg
// crona — ten sam duch co analogiczny limit w lib/coach-digest-signals.js
// (MAX_DIGEST_EMAILS_PER_RUN), osobna, niezależna stała.
// ============================================================

const { sendEmail } = require('./email-sender');
const { preMatchTeamBriefingEmail, weeklyTeamPulseEmail } = require('./email-templates');
const { isoWeekKey } = require('./coach-digest-signals');

const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------
// Stałe — patrz nagłówek pliku i dokument projektowy (sekcja 4/5) dla
// pełnego uzasadnienia każdej.
// ------------------------------------------------------------
const REPORT_TYPES = ['pre_match_team_briefing', 'weekly_team_pulse'];

// Ta sama pora doby co istniejące przypomnienie push dla zawodnika
// (PRE_MATCH_EVENING_WINDOW_HOUR w api/cron-send-notifications.js) —
// świadomie ta sama godzina, nie osobno wymyślona liczba.
const PRE_MATCH_TEAM_BRIEFING_WINDOW_HOUR = 19;
// Ten sam rytm dobowy co reszta wieczornych rytmów systemu.
const WEEKLY_TEAM_PULSE_WINDOW_HOUR = 19;

// Świadomie próg = 1: mecze są dziś logowane PER ZAWODNIK (nie ma jeszcze
// pojęcia "meczu drużynowego" jako jednego obiektu), więc wyższy próg
// zaniżałby skuteczność dokładnie tam, gdzie adopcja logowania meczów
// jest jeszcze niska.
const PRE_MATCH_BRIEFING_MIN_PLAYERS_WITH_MATCH_LOGGED = 1;

// Ochronny limit liczby e-maili wysyłanych w JEDNYM przebiegu crona.
const MAX_SCHEDULED_REPORT_EMAILS_PER_RUN = 30;

const WEEKDAY_STRING_TO_INDEX = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

// ------------------------------------------------------------
// Pomocnicze — czyste, bez I/O
// ------------------------------------------------------------

// Kopia hourInWindow z api/cron-send-notifications.js — świadomie NIE
// importowana stamtąd (odwróciłoby kierunek zależności lib/ -> api/,
// którego ten projekt nigdzie indziej nie ma) — zero realnego ryzyka
// rozjazdu, to jedna linia arytmetyki, ten sam duch co
// signalsComputeLastActivityAt w lib/coach-digest.js.
function hourInWindow(currentHour, targetHour) {
  const diff = (targetHour - currentHour + 24) % 24;
  return diff < 2;
}

// Data jutrzejsza (lokalny dzień kalendarzowy Warszawy) na podstawie
// dateStr ('YYYY-MM-DD') z getWarsawNow() — ten sam wzorzec co
// sendPreMatchForDate/runPreMatch w api/cron-send-notifications.js.
function addOneDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// dateStr ('YYYY-MM-DD', lokalny dzień Warszawy) -> Date o północy UTC
// tego dnia — wejście do isoWeekKey, żeby numer tygodnia liczyć z
// WARSZAWSKIEGO dnia raportu, nie z surowego `new Date()` w chwili
// uruchomienia crona (subtelna różnica blisko północy UTC).
function dateStrToUtcDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

function playerLabel(userInfo) {
  if (!userInfo) return 'Zawodnik';
  return userInfo.full_name || userInfo.email || 'Zawodnik';
}

// Defensywny odczyt odpowiedzi RPC get_pre_match_signals — SETOF record
// wraca jako SUROWA TABLICA przez PostgREST (potwierdzone live,
// claude/SESJA_01_08_2026_SKLAD_MECZOWY_KROK1_2_3_STATUS.md:
// proretset=true, prorettype='record'), NIE jako obiekt z kluczem
// `results`. To DOKŁADNIE ten sam podejrzany błąd znaleziony w
// panel_trenera.html/coach.html (loadPreMatchSignals(), `data.results`,
// zgłoszony w claude/DO_ZROBIENIA_PRZEZ_KUBE.md, Pakiet 20 i naprawiany
// osobno w ZADANIU 2 tej samej sesji, 05.08.2026) — ten kod obsługuje OBA
// możliwe kształty, żeby e-mail nie ucierpiał na tej samej niejasności
// niezależnie od tego, jak dokładnie dana wersja supabase-js/fetch
// zserializuje wynik w praktyce.
function unwrapRpcRows(data) {
  return Array.isArray(data) ? data : ((data && data.results) || []);
}

// ------------------------------------------------------------
// DETEKCJA — czyste funkcje, testowalne bez atrapy Supabase.
// ------------------------------------------------------------

function detectPreMatchTeamBriefingDue({ warsawNow, matchTomorrowCount, enabled } = {}) {
  const count = matchTomorrowCount || 0;
  const windowActive = !!warsawNow && hourInWindow(warsawNow.hour, PRE_MATCH_TEAM_BRIEFING_WINDOW_HOUR);
  const reportKey = warsawNow ? addOneDay(warsawNow.dateStr) : null;
  const thresholdMet = count >= PRE_MATCH_BRIEFING_MIN_PLAYERS_WITH_MATCH_LOGGED;
  const active = !!enabled && windowActive && thresholdMet;
  return {
    reportType: 'pre_match_team_briefing',
    active,
    reportKey,
    detail: { matchTomorrowCount: count, windowActive, thresholdMet, enabled: !!enabled },
  };
}

function detectWeeklyTeamPulseDue({ warsawNow, weeklyDayOfWeek, enabled } = {}) {
  const windowActive = !!warsawNow && hourInWindow(warsawNow.hour, WEEKLY_TEAM_PULSE_WINDOW_HOUR);
  const dayMatches = !!warsawNow && !!weeklyDayOfWeek && WEEKDAY_STRING_TO_INDEX[weeklyDayOfWeek] === warsawNow.weekday;
  const reportKey = warsawNow ? isoWeekKey(dateStrToUtcDate(warsawNow.dateStr)) : null;
  const active = !!enabled && windowActive && dayMatches;
  return {
    reportType: 'weekly_team_pulse',
    active,
    reportKey,
    detail: { windowActive, dayMatches, enabled: !!enabled, weeklyDayOfWeek: weeklyDayOfWeek || null },
  };
}

// ------------------------------------------------------------
// AGREGACJA TREŚCI — czyste funkcje.
// ------------------------------------------------------------

// rows: wynik unwrapRpcRows() na odpowiedzi get_pre_match_signals — każdy
// wiersz { player_user_id, flags: {...} }. "Aktywny sygnał ryzyka" = co
// najmniej jedna flaga true (gating widoczności już wykonany WEWNĄTRZ
// funkcji SQL, patrz nagłówek pliku — świadomie NIE powtórzony tutaj).
function summarizePreMatchSignals({ rows, userInfoById } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const atRisk = safeRows.filter((r) => r && r.flags && Object.values(r.flags).some(Boolean));
  const riskPlayerNames = atRisk.map((r) => playerLabel((userInfoById && userInfoById.get(r.player_user_id)) || null));
  return {
    checkedCount: safeRows.length,
    riskCount: atRisk.length,
    riskPlayerNames,
  };
}

function computeWeeklyTeamPulseSummary({ rosterCount, activePlayersCount, activeFocusBlocksCount } = {}) {
  const roster = rosterCount || 0;
  const active = activePlayersCount || 0;
  const activeRatio = roster > 0 ? active / roster : 0;
  return {
    rosterCount: roster,
    activePlayersCount: active,
    activeRatio,
    activeFocusBlocksCount: activeFocusBlocksCount || 0,
  };
}

// ------------------------------------------------------------
// DEDUPLIKACJA — oba typy raportu, tryb "exact" (dokładnie ten sam klucz
// = ten sam mecz/tydzień = nie wysyłaj drugi raz), ten sam wzorzec co
// isDedupedByExactKey w lib/coach-digest-signals.js. Filtrowanie logów po
// (coach_user_id, team_id, report_type) leży po stronie wywołującego
// (fetchScheduledReportLog + filter niżej), ta funkcja patrzy tylko na
// już przefiltrowane `logs`.
// ------------------------------------------------------------
function isReportDeduped({ logs, reportKey } = {}) {
  if (reportKey == null) return false;
  const key = String(reportKey);
  return (logs || []).some((l) => String(l.report_key) === key);
}

// ------------------------------------------------------------
// I/O — WARSTWA POBIERANIA/ZAPISU DANYCH
// ------------------------------------------------------------

async function fetchScheduledReportPreferences(supabase, coachUserIds) {
  if (!coachUserIds.length) return new Map();
  const { data, error } = await supabase
    .from('coach_scheduled_report_preferences')
    .select('coach_user_id, report_type, enabled, weekly_day_of_week')
    .in('coach_user_id', coachUserIds);
  if (error) { console.error('coach-scheduled-reports: fetchScheduledReportPreferences error:', error); return new Map(); }
  const map = new Map();
  (data || []).forEach((r) => map.set(`${r.coach_user_id}:${r.report_type}`, r));
  return map;
}

async function fetchScheduledReportLog(supabase, coachUserId) {
  const { data, error } = await supabase
    .from('coach_scheduled_report_log')
    .select('team_id, report_type, report_key, sent_at')
    .eq('coach_user_id', coachUserId)
    .limit(1000); // ochronny limit, ten sam duch co fetchDigestSignalLog
  if (error) { console.error('coach-scheduled-reports: fetchScheduledReportLog error:', error); return []; }
  return data || [];
}

async function recordScheduledReportSent(supabase, { coachUserId, teamId, reportType, reportKey, now }) {
  const { error } = await supabase.from('coach_scheduled_report_log').insert({
    coach_user_id: coachUserId,
    team_id: teamId,
    report_type: reportType,
    report_key: String(reportKey),
    sent_at: (now || new Date()).toISOString(),
  });
  if (error) console.error(`coach-scheduled-reports: nie udało się zapisać coach_scheduled_report_log (${reportType}):`, error);
}

// Liczba zawodników z rosteru z zalogowanym meczem drużyny na dany dzień
// — ten sam wzorzec zapytania co sendPreMatchForDate w
// api/cron-send-notifications.js, zawężony do konkretnego rosteru.
async function fetchMatchCountForDate(supabase, userIds, dateStr) {
  if (!userIds.length) return 0;
  const { data, error } = await supabase
    .from('calendar_events')
    .select('id, user_id')
    .eq('status', 'scheduled')
    .eq('event_type', 'match')
    .eq('scheduled_date', dateStr)
    .in('user_id', userIds);
  if (error) { console.error('coach-scheduled-reports: fetchMatchCountForDate error:', error); return 0; }
  return (data || []).length;
}

async function fetchPreMatchSignalsForTeam(supabase, teamId) {
  const { data, error } = await supabase.rpc('get_pre_match_signals', { p_team_id: teamId });
  if (error) { console.error(`coach-scheduled-reports: fetchPreMatchSignalsForTeam(${teamId}) error:`, error); return []; }
  return unwrapRpcRows(data);
}

async function fetchActiveDailyLogUserIds(supabase, userIds, sinceIso) {
  if (!userIds.length) return new Set();
  const { data, error } = await supabase
    .from('daily_logs')
    .select('user_id')
    .in('user_id', userIds)
    .gte('created_at', sinceIso)
    .limit(5000);
  if (error) { console.error('coach-scheduled-reports: fetchActiveDailyLogUserIds error:', error); return new Set(); }
  return new Set((data || []).map((r) => r.user_id));
}

async function fetchActiveFocusBlockCount(supabase, userIds) {
  if (!userIds.length) return 0;
  const { data, error } = await supabase
    .from('focus_blocks')
    .select('id, user_id, status')
    .in('user_id', userIds)
    .eq('status', 'active')
    .limit(5000);
  if (error) { console.error('coach-scheduled-reports: fetchActiveFocusBlockCount error:', error); return 0; }
  return (data || []).length;
}

// ------------------------------------------------------------
// GŁÓWNA FUNKCJA — wołana przez cron (api/cron-send-notifications.js).
// `results`, jeśli podany, dostaje przyrost results.coach_scheduled_reports.
// ------------------------------------------------------------
async function runCoachScheduledReportsCheck(supabase, warsawNow, results) {
  // Lazy require — patrz wyjaśnienie w nagłówku pliku (unika
  // transytywnego require('@supabase/supabase-js') przy samym ładowaniu
  // tego modułu, żeby warstwa czysta była testowalna bez atrapy sieci).
  const { fetchTeamsWithCoach, fetchUsersByIds, fetchRoster } = require('./coach-digest')._internal;

  const now = new Date();
  const preWindowActive = hourInWindow(warsawNow.hour, PRE_MATCH_TEAM_BRIEFING_WINDOW_HOUR);
  const weeklyWindowActive = hourInWindow(warsawNow.hour, WEEKLY_TEAM_PULSE_WINDOW_HOUR);
  if (!preWindowActive && !weeklyWindowActive) return; // żadne z dwóch okien dziś nieaktywne — nic do sprawdzania

  const teams = await fetchTeamsWithCoach(supabase);
  if (!teams.length) return;

  const coachIds = [...new Set(teams.map((t) => t.coach_user_id))];
  const [coachUsers, prefMap] = await Promise.all([
    fetchUsersByIds(supabase, coachIds),
    fetchScheduledReportPreferences(supabase, coachIds),
  ]);

  const MAX = MAX_SCHEDULED_REPORT_EMAILS_PER_RUN;
  let sentThisRun = 0;

  const tomorrowStr = addOneDay(warsawNow.dateStr);
  const weekKey = isoWeekKey(dateStrToUtcDate(warsawNow.dateStr));
  const sinceSevenDaysIso = new Date(now.getTime() - 7 * DAY_MS).toISOString();

  for (const team of teams) {
    if (sentThisRun >= MAX) break;
    const coach = coachUsers.get(team.coach_user_id);
    if (!coach || !coach.email) continue;

    const preMatchPref = prefMap.get(`${team.coach_user_id}:pre_match_team_briefing`);
    const weeklyPref = prefMap.get(`${team.coach_user_id}:weekly_team_pulse`);
    // Brak wiersza = WYŁĄCZONE (opt-in, odwrotnie niż Digest — patrz nagłówek pliku).
    const preMatchEnabled = preWindowActive && !!(preMatchPref && preMatchPref.enabled);
    const weeklyEnabled = weeklyWindowActive && !!(weeklyPref && weeklyPref.enabled);
    if (!preMatchEnabled && !weeklyEnabled) continue; // trener nie włączył żadnego z dwóch raportów w tym oknie

    let roster;
    try {
      roster = await fetchRoster(supabase, team.id);
    } catch (e) {
      console.error(`coach-scheduled-reports: fetchRoster(${team.id}) error:`, e);
      continue;
    }
    if (!roster.length) continue;

    const rosterIds = roster.map((r) => r.player_user_id);
    const userInfoById = new Map(roster.map((r) => [r.player_user_id, r.users || {}]));

    const log = await fetchScheduledReportLog(supabase, team.coach_user_id);

    // ---- pre_match_team_briefing ----
    if (preMatchEnabled && sentThisRun < MAX) {
      const matchCount = await fetchMatchCountForDate(supabase, rosterIds, tomorrowStr);
      const detection = detectPreMatchTeamBriefingDue({ warsawNow, matchTomorrowCount: matchCount, enabled: true });
      if (detection.active) {
        const relevantLogs = log.filter((l) => l.report_type === 'pre_match_team_briefing' && l.team_id === team.id);
        if (!isReportDeduped({ logs: relevantLogs, reportKey: detection.reportKey })) {
          try {
            const rows = await fetchPreMatchSignalsForTeam(supabase, team.id);
            const summary = summarizePreMatchSignals({ rows, userInfoById });
            const { subject, html, text } = preMatchTeamBriefingEmail({ teamName: team.club_name, ...summary });
            await sendEmail({ to: coach.email, subject, html, text });
            await recordScheduledReportSent(supabase, {
              coachUserId: team.coach_user_id, teamId: team.id,
              reportType: 'pre_match_team_briefing', reportKey: detection.reportKey, now,
            });
            sentThisRun++;
            if (results) results.coach_scheduled_reports = (results.coach_scheduled_reports || 0) + 1;
          } catch (e) {
            console.error(`coach-scheduled-reports: błąd wysyłki pre_match_team_briefing (coach=${team.coach_user_id}):`, e);
          }
        }
      }
    }

    // ---- weekly_team_pulse ----
    if (weeklyEnabled && sentThisRun < MAX) {
      const detection = detectWeeklyTeamPulseDue({
        warsawNow, weeklyDayOfWeek: weeklyPref ? weeklyPref.weekly_day_of_week : null, enabled: true,
      });
      if (detection.active) {
        const relevantLogs = log.filter((l) => l.report_type === 'weekly_team_pulse' && l.team_id === team.id);
        if (!isReportDeduped({ logs: relevantLogs, reportKey: detection.reportKey })) {
          try {
            const [activeUserIds, activeFocusBlocksCount] = await Promise.all([
              fetchActiveDailyLogUserIds(supabase, rosterIds, sinceSevenDaysIso),
              fetchActiveFocusBlockCount(supabase, rosterIds),
            ]);
            const activePlayersCount = rosterIds.filter((id) => activeUserIds.has(id)).length;
            const summary = computeWeeklyTeamPulseSummary({ rosterCount: rosterIds.length, activePlayersCount, activeFocusBlocksCount });
            const { subject, html, text } = weeklyTeamPulseEmail({ teamName: team.club_name, ...summary });
            await sendEmail({ to: coach.email, subject, html, text });
            await recordScheduledReportSent(supabase, {
              coachUserId: team.coach_user_id, teamId: team.id,
              reportType: 'weekly_team_pulse', reportKey: detection.reportKey, now,
            });
            sentThisRun++;
            if (results) results.coach_scheduled_reports = (results.coach_scheduled_reports || 0) + 1;
          } catch (e) {
            console.error(`coach-scheduled-reports: błąd wysyłki weekly_team_pulse (coach=${team.coach_user_id}):`, e);
          }
        }
      }
    }
  }
  // weekKey obliczony wyżej dla ewentualnego logowania diagnostycznego —
  // świadomie NIE użyty bezpośrednio poza detectWeeklyTeamPulseDue (który
  // liczy go sam z warsawNow, żeby pozostać czystą, samodzielną funkcją
  // testowalną bez zależności od zmiennej z zewnątrz).
  void weekKey;
}

module.exports = {
  REPORT_TYPES,
  PRE_MATCH_TEAM_BRIEFING_WINDOW_HOUR,
  WEEKLY_TEAM_PULSE_WINDOW_HOUR,
  PRE_MATCH_BRIEFING_MIN_PLAYERS_WITH_MATCH_LOGGED,
  MAX_SCHEDULED_REPORT_EMAILS_PER_RUN,
  runCoachScheduledReportsCheck,
  _internal: {
    hourInWindow,
    addOneDay,
    dateStrToUtcDate,
    playerLabel,
    unwrapRpcRows,
    detectPreMatchTeamBriefingDue,
    detectWeeklyTeamPulseDue,
    summarizePreMatchSignals,
    computeWeeklyTeamPulseSummary,
    isReportDeduped,
    fetchScheduledReportPreferences,
    fetchScheduledReportLog,
    recordScheduledReportSent,
    fetchMatchCountForDate,
    fetchPreMatchSignalsForTeam,
    fetchActiveDailyLogUserIds,
    fetchActiveFocusBlockCount,
    WEEKDAY_STRING_TO_INDEX,
  },
};
