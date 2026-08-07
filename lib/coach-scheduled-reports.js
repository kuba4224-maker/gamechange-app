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
// ⇒ PANEL C3 08.08.2026 — TEN AKAPIT JEST JUŻ NIEAKTUALNY, zostaje jako
// zapis historyczny. Decyzja B10 (DECYZJE_PRODUKTOWE_07_08_2026.md):
// WSZYSTKIE powiadomienia e-mail dla trenera są domyślnie WŁĄCZONE.
// coach_scheduled_report_preferences czyta od teraz BRAK WIERSZA = WŁĄCZONE,
// dokładnie tak samo jak coach_digest_preferences (isSignalEnabled()
// w lib/coach-digest.js) — patrz isReportEnabled() niżej.
//
// Uzasadnienie Kuby, wprost przeciwne do argumentu wyżej i nowsze od niego:
// trener, który nie chce maila, wyłączy go po pierwszym; trener, który nie
// wie, że coś istnieje, nigdy tego nie włączy. Ryzyko „wrażenia spamu" jest
// odwracalne jednym kliknięciem, ryzyko „funkcja nigdy nie zostaje odkryta"
// nie jest odwracalne wcale.
//
// CO TA ZMIANA ROBI ISTNIEJĄCYM TRENEROM: nic, jeśli mają wiersz.
// isReportEnabled() czyta WARTOŚĆ `enabled`, nie obecność wiersza — więc
// trener z wierszem enabled=false nadal nie dostanie nic. Zmienia się
// wyłącznie los trenerów BEZ wiersza (do dziś: cisza, od teraz: dostają).
//
// ─── PANEL C3 08.08.2026 — „COTYGODNIOWY PULS DRUŻYNY" WYŁĄCZONY (B11) ───
// Wysyłka weekly_team_pulse jest zgaszona jedną stałą (WEEKLY_TEAM_PULSE_
// ENABLED niżej). CAŁY MECHANIZM ZOSTAJE: detectWeeklyTeamPulseDue,
// computeWeeklyTeamPulseSummary, liczniki rozwojowe z redesignu 06.08.2026,
// szablon weeklyTeamPulseEmail, tabela preferencji, wiersze trenerów,
// tabela logu wysyłek. Nic nie jest kasowane, nic nie jest migrowane.
// Powód: mail przychodzący niezależnie od tego, czy jest co powiedzieć, uczy
// trenera ignorowania maili — a potem ignoruje też te, które coś znaczą.
// Zdarzeniowy team_overload z Digestu #19 niesie tę samą treść, tylko wtedy,
// gdy ma sens (i oba liczniki i tak REUŻYWAJĄ tej samej detekcji — patrz
// redesign 06.08.2026 niżej, więc nic się nie traci merytorycznie).
// POWRÓT: WEEKLY_TEAM_PULSE_ENABLED = true tutaj + dwa wpisy w coach.html
// (blok HTML grupy „Stały przegląd" i 'weekly_team_pulse' w
// SCHEDULED_REPORT_TYPES_IN_UI). Zero pisania logiki od nowa.
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
//
// REDESIGN 06.08.2026 (zatwierdzony przez Kubę, patrz claude/BRIEF_
// DELEGACJA_PULS_TYGODNIOWY.md) — weekly_team_pulse rozszerzony o TREŚĆ
// ROZWOJOWĄ (nie tylko wskaźniki UŻYCIA appki jak dotąd): liczba celów
// osiągniętych w drużynie w tym tygodniu + zbiorcza liczba aktywnych
// sygnałów ryzyka/przeciążenia w tym tygodniu. KLUCZOWE: oba liczniki
// REUŻYWAJĄ dokładnie tej samej detekcji co Digest #19
// (signals.detectGoalAchieved/detectTeamOverload/detectPlayerRiskStandout,
// signals = lib/coach-digest-signals.js) — import, nie reimplementacja —
// żeby Digest i Puls tygodniowy NIGDY nie pokazały różnych liczb dla tego
// samego tygodnia/drużyny (patrz countGoalsAchievedThisWeek/
// computeTeamOverloadActive/countPlayersWithActiveRiskStandout niżej).
// Świadomie BEZ osobnych przełączników per metryka i BEZ mechanizmu
// "tygodniowego promptu konwersacyjnego" — jeden istniejący checkbox
// opt-in (coach_scheduled_report_preferences) uruchamia cały rozszerzony
// raport, zero zmian w mechanizmie dostawy.
// ============================================================

const { sendEmail } = require('./email-sender');
const { preMatchTeamBriefingEmail, weeklyTeamPulseEmail } = require('./email-templates');
const signals = require('./coach-digest-signals');
const { isoWeekKey } = signals;

const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------
// Stałe — patrz nagłówek pliku i dokument projektowy (sekcja 4/5) dla
// pełnego uzasadnienia każdej.
// ------------------------------------------------------------
const REPORT_TYPES = ['pre_match_team_briefing', 'weekly_team_pulse'];

// PANEL C3 08.08.2026 (B11) — kurek wysyłki „Cotygodniowego pulsu drużyny".
// JEDNA LINIA do przestawienia, gdy trenerzy o niego poproszą. Świadomie
// stała, a nie usunięcie typu z REPORT_TYPES: REPORT_TYPES opisuje kontrakt
// tabeli (jakie report_type mogą w niej leżeć) i musi zostać kompletny,
// żeby istniejące wiersze i wpisy w logu wysyłek nie stały się sierotami.
const WEEKLY_TEAM_PULSE_ENABLED = false;

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

// Zakres dat (UTC, poniedziałek 00:00 -> następny poniedziałek 00:00) ISO
// tygodnia zawierającego `date` — NOWE (redesign 06.08.2026), używane do
// policzenia zdarzeń "w tym tygodniu" (cele osiągnięte) w weekly_team_pulse.
// Ten sam sposób ustalania poniedziałku co isoWeekKey (lib/coach-digest-
// signals.js: `dayNum = (d.getUTCDay() + 6) % 7`), więc numer tygodnia ISO
// i zakres dat liczenia ZAWSZE się zgadzają. Wejście = zawsze
// dateStrToUtcDate(warsawNow.dateStr), ten sam punkt w czasie co reportKey
// tego raportu (nie surowy `new Date()` w chwili uruchomienia crona).
function isoWeekRange(date) {
  const src = date || new Date();
  const d = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Pon=0..Ndz=6
  d.setUTCDate(d.getUTCDate() - dayNum); // cofnij do poniedziałku tego tygodnia
  const startIso = d.toISOString();
  const endIso = new Date(d.getTime() + 7 * DAY_MS).toISOString();
  return { startIso, endIso };
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

// goalsAchievedCount/teamOverloadActive/riskyPlayersCount: NOWE (redesign
// 06.08.2026) — już POLICZONE przez wywołującego (countGoalsAchievedThisWeek/
// computeTeamOverloadActive/countPlayersWithActiveRiskStandout niżej, które
// same reużywają signals.detect*). Ta funkcja tylko SKŁADA gotowe liczby w
// jeden obiekt podsumowania (activeRatio + riskSignalsCount = suma obu
// typów ryzyka, zgodnie z decyzją redakcyjną z briefu: "Zsumuj oba typy w
// jedną liczbę") — świadomie zero własnej logiki detekcji tutaj.
function computeWeeklyTeamPulseSummary({
  rosterCount, activePlayersCount, activeFocusBlocksCount,
  goalsAchievedCount, teamOverloadActive, riskyPlayersCount,
} = {}) {
  const roster = rosterCount || 0;
  const active = activePlayersCount || 0;
  const activeRatio = roster > 0 ? active / roster : 0;
  const risky = riskyPlayersCount || 0;
  const overloadActive = !!teamOverloadActive;
  return {
    rosterCount: roster,
    activePlayersCount: active,
    activeRatio,
    activeFocusBlocksCount: activeFocusBlocksCount || 0,
    goalsAchievedCount: goalsAchievedCount || 0,
    teamOverloadActive: overloadActive,
    riskyPlayersCount: risky,
    riskSignalsCount: (overloadActive ? 1 : 0) + risky,
  };
}

// ------------------------------------------------------------
// NOWE (redesign 06.08.2026) — liczniki rozwojowe weekly_team_pulse. DRY z
// Digestem #19 jest tu kluczowe (patrz nagłówek pliku): każda z tych
// funkcji reużywa DOKŁADNIE tej samej detekcji z lib/coach-digest-
// signals.js co lib/coach-digest.js — zero osobnej, równoległej definicji
// "osiągnięty cel"/"przeciążenie"/"zawodnik do sprawdzenia".
// ------------------------------------------------------------

// `goals`: wiersze już zawężone przez wywołującego zapytaniem SQL do
// bieżącego tygodnia (status='completed' AND ended_at w [start, end) —
// patrz fetchGoalsCompletedInRange niżej) — dodatkowe przejście przez
// signals.detectGoalAchieved to świadoma redundancja: to WŁAŚNIE jest
// punkt DRY z Digestem (ta sama, jedna definicja "osiągnięty cel"), nie
// samo zapytanie SQL (które z natury różni się od Digestu górną granicą
// daty — Digest liczy "niedawno", nie "w tym konkretnym tygodniu").
function countGoalsAchievedThisWeek(goals) {
  return (goals || []).filter((g) => signals.detectGoalAchieved({ status: g && g.status }).active).length;
}

// eligiblePlayersCount/elevatedCount -> DOKŁADNIE ten sam kształt wejścia
// co lib/coach-digest.js przy sygnale team_overload.
function computeTeamOverloadActive({ eligiblePlayersCount, elevatedCount, now } = {}) {
  return signals.detectTeamOverload({ eligiblePlayersCount, elevatedCount, now }).active;
}

// perPlayerRiskInputs: tablica { readinessSignals, injuryModeActive,
// recentExcludingPain } per zawodnik z rosteru — DOKŁADNIE ten sam kształt
// wejścia co lib/coach-digest.js przy sygnale player_risk_standout (gating
// widoczności injury_mode_active/recentExcludingPain już wykonany PRZED
// wywołaniem tej funkcji przez wołającego, ten sam wzorzec co Digest).
function countPlayersWithActiveRiskStandout(perPlayerRiskInputs) {
  return (perPlayerRiskInputs || []).filter((input) => signals.detectPlayerRiskStandout(input).active).length;
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

// PANEL C3 08.08.2026 (B10) — JEDNO miejsce, które odpowiada na pytanie „czy
// ten trener ma dostawać ten raport". Bliźniak isSignalEnabled() z
// lib/coach-digest.js (`prefMap.has(key) ? prefMap.get(key) !== false : true`)
// — celowo ta sama reguła, wyrażona tak samo, żeby nie dało się ich znowu
// rozjechać.
//
// BRAK WIERSZA (pref === undefined/null) → WŁĄCZONE. To jest cała zmiana
// domyślnej. Do 08.08.2026 było tu `!!(pref && pref.enabled)`, czyli brak
// wiersza znaczył WYŁĄCZONE.
//
// WIERSZ Z enabled=false → WYŁĄCZONE, bez wyjątków. To jest ta gwarancja,
// o którą pytało polecenie: zmiana domyślnej NIE może nagle wysłać maila
// trenerowi, który świadomie odznaczył checkbox. Czytamy WARTOŚĆ, nigdy
// obecność wiersza.
// enabled=true / null / cokolwiek innego niż false → WŁĄCZONE (`!== false`,
// tak samo jak Digest — null w tej kolumnie nie może po cichu wyciszyć
// trenera).
function isReportEnabled(pref) {
  if (!pref) return true;
  return pref.enabled !== false;
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

// NOWE (redesign 06.08.2026) — cele ukończone w konkretnym oknie dat
// (ended_at w [sinceIso, untilIso)). Ten sam wzorzec zapytania (tabela,
// kolumny, status='completed', not-null ended_at jako filtr "naprawdę
// niedawno zakończony") co fetchRecentlyCompletedGoals w lib/coach-
// digest.js (Digest #19) — ale z GÓRNĄ granicą, tam niepotrzebną (Digest
// liczy "niedawno", nie "w tym konkretnym tygodniu ISO"). Świadomie NOWA
// funkcja I/O tutaj (nie import z coach-digest.js) — patrz nagłówek pliku:
// właściwy punkt DRY z Digestem to sama DETEKCJA (signals.detectGoalAchieved,
// wołane w countGoalsAchievedThisWeek), nie ten konkretny fetch, którego
// kształt (potrzebna górna granica) i tak różni się od Digestu.
async function fetchGoalsCompletedInRange(supabase, userIds, sinceIso, untilIso) {
  if (!userIds.length) return [];
  const { data, error } = await supabase
    .from('goals')
    .select('id, user_id, segment_id, status, ended_at')
    .in('user_id', userIds)
    .eq('status', 'completed')
    .not('ended_at', 'is', null)
    .gte('ended_at', sinceIso)
    .lt('ended_at', untilIso)
    .limit(2000);
  if (error) { console.error('coach-scheduled-reports: fetchGoalsCompletedInRange error:', error); return []; }
  return data || [];
}

// ------------------------------------------------------------
// GŁÓWNA FUNKCJA — wołana przez cron (api/cron-send-notifications.js).
// `results`, jeśli podany, dostaje przyrost results.coach_scheduled_reports.
// ------------------------------------------------------------
async function runCoachScheduledReportsCheck(supabase, warsawNow, results) {
  // Lazy require — patrz wyjaśnienie w nagłówku pliku (unika
  // transytywnego require('@supabase/supabase-js') przy samym ładowaniu
  // tego modułu, żeby warstwa czysta była testowalna bez atrapy sieci).
  // REDESIGN 06.08.2026: dopisane fetchReadinessSignalsByUser/
  // fetchInjuryModeActiveUserIds/fetchRecentExcludingPainUserIds/
  // visibilityAtLeast — reużyte 1:1 z lib/coach-digest.js (Digest #19),
  // dokładnie ten sam I/O co przy sygnałach team_overload/
  // player_risk_standout tam, żeby liczby w obu raportach nigdy się nie
  // rozjechały (patrz nagłówek pliku).
  const {
    fetchTeamsWithCoach, fetchUsersByIds, fetchRoster,
    fetchReadinessSignalsByUser, fetchInjuryModeActiveUserIds, fetchRecentExcludingPainUserIds,
    visibilityAtLeast,
  } = require('./coach-digest')._internal;

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
  const warsawDateUtc = dateStrToUtcDate(warsawNow.dateStr);
  const weekKey = isoWeekKey(warsawDateUtc);
  // NOWE (redesign 06.08.2026) — zakres bieżącego tygodnia ISO, do
  // policzenia celów osiągniętych "w tym tygodniu" (patrz isoWeekRange).
  const weekRange = isoWeekRange(warsawDateUtc);
  const sinceSevenDaysIso = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  // Okno "niedawny ból wykluczający z treningu" dla player_risk_standout —
  // TA SAMA stała co Digest (signals.PLAYER_RISK_STANDOUT_RECENT_PAIN_WINDOW_DAYS),
  // nie osobno wymyślona liczba.
  const sinceRiskPainWindowIso = new Date(now.getTime() - signals.PLAYER_RISK_STANDOUT_RECENT_PAIN_WINDOW_DAYS * DAY_MS).toISOString();

  for (const team of teams) {
    if (sentThisRun >= MAX) break;
    const coach = coachUsers.get(team.coach_user_id);
    if (!coach || !coach.email) continue;

    const preMatchPref = prefMap.get(`${team.coach_user_id}:pre_match_team_briefing`);
    const weeklyPref = prefMap.get(`${team.coach_user_id}:weekly_team_pulse`);
    // PANEL C3 08.08.2026 (B10) — brak wiersza = WŁĄCZONE, tak samo jak
    // Digest. Wiersz z enabled=false nadal wycisza. Patrz isReportEnabled().
    const preMatchEnabled = preWindowActive && isReportEnabled(preMatchPref);
    // PANEL C3 08.08.2026 (B11) — kurek wysyłki pulsu. Preferencja trenera
    // jest nadal czytana (i nadal respektowana), ale kurek ją przykrywa —
    // dzięki temu przestawienie WEEKLY_TEAM_PULSE_ENABLED na true przywraca
    // dokładnie ten stan, który trenerzy mieli przed wycięciem, zamiast
    // wysyłać puls wszystkim naraz.
    const weeklyEnabled = WEEKLY_TEAM_PULSE_ENABLED && weeklyWindowActive && isReportEnabled(weeklyPref);
    if (!preMatchEnabled && !weeklyEnabled) continue; // żaden z dwóch raportów nie jest dziś do wysłania

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
            const [activeUserIds, activeFocusBlocksCount, readinessByUser, injuryModeUserIds, recentPainUserIds, goalsCompletedThisWeek] = await Promise.all([
              fetchActiveDailyLogUserIds(supabase, rosterIds, sinceSevenDaysIso),
              fetchActiveFocusBlockCount(supabase, rosterIds),
              // Reużyte z Digestem #19 (fetchReadinessSignalsByUser) — bez
              // gatingu widoczności, ten sam duch co tam ("zmęczenie/sen/
              // nastrój" widoczne od poziomu Podstawowego).
              fetchReadinessSignalsByUser(supabase, rosterIds, now),
              visibilityAtLeast(team.visibility_level, 'extended')
                ? fetchInjuryModeActiveUserIds(supabase, rosterIds) : Promise.resolve(new Set()),
              visibilityAtLeast(team.visibility_level, 'full')
                ? fetchRecentExcludingPainUserIds(supabase, rosterIds, sinceRiskPainWindowIso) : Promise.resolve(new Set()),
              fetchGoalsCompletedInRange(supabase, rosterIds, weekRange.startIso, weekRange.endIso),
            ]);
            const activePlayersCount = rosterIds.filter((id) => activeUserIds.has(id)).length;

            // team_overload: "eligiblePlayersCount" = zawodnicy z danymi z
            // ostatnich 7 dni — reużywamy JUŻ POBRANY activeUserIds (ta sama
            // definicja/okno co fetchPlayersWithRecentData w Digescie, więc
            // zero dodatkowego zapytania).
            const eligibleForOverload = rosterIds.filter((id) => activeUserIds.has(id));
            const elevatedCount = eligibleForOverload.filter((id) => signals.isReadinessElevated(readinessByUser.get(id))).length;
            const teamOverloadActive = computeTeamOverloadActive({ eligiblePlayersCount: eligibleForOverload.length, elevatedCount, now });

            const riskyPlayersCount = countPlayersWithActiveRiskStandout(rosterIds.map((id) => ({
              readinessSignals: readinessByUser.get(id),
              injuryModeActive: injuryModeUserIds.has(id),
              recentExcludingPain: recentPainUserIds.has(id),
            })));

            const goalsAchievedCount = countGoalsAchievedThisWeek(goalsCompletedThisWeek);

            const summary = computeWeeklyTeamPulseSummary({
              rosterCount: rosterIds.length, activePlayersCount, activeFocusBlocksCount,
              goalsAchievedCount, teamOverloadActive, riskyPlayersCount,
            });
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
  WEEKLY_TEAM_PULSE_ENABLED, // PANEL C3 08.08.2026 (B11) — kurek wysyłki pulsu
  PRE_MATCH_TEAM_BRIEFING_WINDOW_HOUR,
  WEEKLY_TEAM_PULSE_WINDOW_HOUR,
  PRE_MATCH_BRIEFING_MIN_PLAYERS_WITH_MATCH_LOGGED,
  MAX_SCHEDULED_REPORT_EMAILS_PER_RUN,
  runCoachScheduledReportsCheck,
  _internal: {
    hourInWindow,
    addOneDay,
    dateStrToUtcDate,
    isoWeekRange,
    playerLabel,
    unwrapRpcRows,
    detectPreMatchTeamBriefingDue,
    detectWeeklyTeamPulseDue,
    summarizePreMatchSignals,
    computeWeeklyTeamPulseSummary,
    countGoalsAchievedThisWeek,
    computeTeamOverloadActive,
    countPlayersWithActiveRiskStandout,
    isReportDeduped,
    isReportEnabled, // PANEL C3 08.08.2026 (B10) — testowalna warstwa czysta
    fetchScheduledReportPreferences,
    fetchScheduledReportLog,
    recordScheduledReportSent,
    fetchMatchCountForDate,
    fetchPreMatchSignalsForTeam,
    fetchActiveDailyLogUserIds,
    fetchActiveFocusBlockCount,
    fetchGoalsCompletedInRange,
    WEEKDAY_STRING_TO_INDEX,
  },
};
