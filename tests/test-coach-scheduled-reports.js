// ============================================================
// test-coach-scheduled-reports.js — testy jednostkowe lib/coach-scheduled-reports.js
// ============================================================
// Uruchom: node tests/test-coach-scheduled-reports.js
//
// Zakres: WYŁĄCZNIE warstwa czysta (_internal: hourInWindow/addOneDay/
// unwrapRpcRows/detectX/summarizeX/computeX/isReportDeduped) — ten sam
// zakres i ten sam powód co test-coach-digest-signals.js: require('../lib/
// coach-scheduled-reports.js') NIE pociąga za sobą @supabase/supabase-js
// (top-level require lib/coach-digest.js jest w tym pliku CELOWO lazy,
// wewnątrz runCoachScheduledReportsCheck — patrz nagłówek pliku
// źródłowego), więc zero atrapy Supabase jest tu potrzebne.
//
// ⚠️ Ten plik testowy jest ODTWORZENIEM (05.08.2026) — oryginał (wraz z
// oryginalnym lib/coach-scheduled-reports.js) zniknął z dysku Kuby mimo
// dokumentacji "39/39 testów przechodzi, Na dysku" — patrz nagłówek
// lib/coach-scheduled-reports.js po pełne wyjaśnienie. Testy niżej
// weryfikują ODTWORZONY kod, nie oryginalny — napisane niezależnie od
// implementacji, patrząc na kontrakt opisany w claude/INTEGRACJA_RAPORTY_
// KRYTYCZNE_MOMENTY.md.
// ============================================================

const assert = require('assert');
const lib = require('../lib/coach-scheduled-reports.js');

const {
  REPORT_TYPES,
  PRE_MATCH_TEAM_BRIEFING_WINDOW_HOUR,
  WEEKLY_TEAM_PULSE_WINDOW_HOUR,
  PRE_MATCH_BRIEFING_MIN_PLAYERS_WITH_MATCH_LOGGED,
  MAX_SCHEDULED_REPORT_EMAILS_PER_RUN,
} = lib;

const {
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
  WEEKDAY_STRING_TO_INDEX,
} = lib._internal;

let passed = 0;
let failed = 0;
function scenario(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${e.stack || e.message}`);
  }
}

// warsawNow syntetyczny — ten sam kształt co getWarsawNow() w
// api/cron-send-notifications.js: { hour, minute, day, dateStr, weekday }.
// weekday: 0=Ndz..6=Sob (WEEKDAY_INDEX tamtego pliku).
function makeWarsawNow({ hour = 19, minute = 0, dateStr = '2026-08-05', weekday = 3 } = {}) {
  return { hour, minute, day: Number(dateStr.slice(8, 10)), dateStr, weekday };
}

console.log('\n=== Stałe podstawowe ===');
scenario('REPORT_TYPES ma dokładnie 2 typy raportu', () => {
  assert.strictEqual(REPORT_TYPES.length, 2);
  assert.ok(REPORT_TYPES.includes('pre_match_team_briefing'));
  assert.ok(REPORT_TYPES.includes('weekly_team_pulse'));
});
scenario('okna wieczorne = 19 (ta sama godzina co PRE_MATCH_EVENING_WINDOW_HOUR)', () => {
  assert.strictEqual(PRE_MATCH_TEAM_BRIEFING_WINDOW_HOUR, 19);
  assert.strictEqual(WEEKLY_TEAM_PULSE_WINDOW_HOUR, 19);
});
scenario('próg minimalnej liczby zawodników z zalogowanym meczem = 1', () => {
  assert.strictEqual(PRE_MATCH_BRIEFING_MIN_PLAYERS_WITH_MATCH_LOGGED, 1);
});
scenario('limit e-maili na przebieg crona = 30', () => {
  assert.strictEqual(MAX_SCHEDULED_REPORT_EMAILS_PER_RUN, 30);
});
scenario('WEEKDAY_STRING_TO_INDEX ma 7 dni, MON=1 SUN=0', () => {
  assert.strictEqual(Object.keys(WEEKDAY_STRING_TO_INDEX).length, 7);
  assert.strictEqual(WEEKDAY_STRING_TO_INDEX.MON, 1);
  assert.strictEqual(WEEKDAY_STRING_TO_INDEX.SUN, 0);
  assert.strictEqual(WEEKDAY_STRING_TO_INDEX.SAT, 6);
});

console.log('\n=== hourInWindow ===');
scenario('godzina dokładnie równa celowi -> w oknie', () => {
  assert.strictEqual(hourInWindow(19, 19), true);
});
scenario('godzina 1h przed celem (okno 2h) -> w oknie', () => {
  assert.strictEqual(hourInWindow(18, 19), true);
});
scenario('godzina 2h przed celem -> POZA oknem (okno wyłącznie [target, target+2))', () => {
  assert.strictEqual(hourInWindow(17, 19), false);
});
scenario('godzina 1h PO celu -> poza oknem', () => {
  assert.strictEqual(hourInWindow(20, 19), false);
});
scenario('zawijanie przez północ (23 vs cel 0) -> w oknie', () => {
  assert.strictEqual(hourInWindow(23, 0), true);
});

console.log('\n=== addOneDay ===');
scenario('zwykły dzień', () => {
  assert.strictEqual(addOneDay('2026-08-05'), '2026-08-06');
});
scenario('granica miesiąca', () => {
  assert.strictEqual(addOneDay('2026-08-31'), '2026-09-01');
});
scenario('granica roku', () => {
  assert.strictEqual(addOneDay('2026-12-31'), '2027-01-01');
});
scenario('rok przestępny, koniec lutego', () => {
  assert.strictEqual(addOneDay('2028-02-28'), '2028-02-29');
});

console.log('\n=== dateStrToUtcDate ===');
scenario('zwraca północ UTC danego dnia', () => {
  const d = dateStrToUtcDate('2026-08-05');
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(d.getUTCMonth(), 7); // sierpień = index 7
  assert.strictEqual(d.getUTCDate(), 5);
  assert.strictEqual(d.getUTCHours(), 0);
});

console.log('\n=== playerLabel ===');
scenario('preferuje full_name', () => {
  assert.strictEqual(playerLabel({ full_name: 'Jan Kowalski', email: 'jan@example.com' }), 'Jan Kowalski');
});
scenario('spada do email gdy brak full_name', () => {
  assert.strictEqual(playerLabel({ email: 'jan@example.com' }), 'jan@example.com');
});
scenario('spada do "Zawodnik" gdy brak obu', () => {
  assert.strictEqual(playerLabel({}), 'Zawodnik');
});
scenario('spada do "Zawodnik" gdy null/undefined', () => {
  assert.strictEqual(playerLabel(null), 'Zawodnik');
  assert.strictEqual(playerLabel(undefined), 'Zawodnik');
});

console.log('\n=== unwrapRpcRows (rdzeń naprawy błędu data.results / ZADANIE 2) ===');
scenario('surowa tablica (rzeczywisty kształt SETOF record) -> ta sama tablica', () => {
  const input = [{ player_user_id: 'a', flags: {} }];
  assert.deepStrictEqual(unwrapRpcRows(input), input);
});
scenario('pusta surowa tablica -> pusta tablica', () => {
  assert.deepStrictEqual(unwrapRpcRows([]), []);
});
scenario('obiekt z kluczem results (hipotetyczny kształt klienta) -> results', () => {
  const rows = [{ player_user_id: 'b' }];
  assert.deepStrictEqual(unwrapRpcRows({ results: rows }), rows);
});
scenario('null -> pusta tablica', () => {
  assert.deepStrictEqual(unwrapRpcRows(null), []);
});
scenario('undefined -> pusta tablica', () => {
  assert.deepStrictEqual(unwrapRpcRows(undefined), []);
});
scenario('obiekt bez klucza results -> pusta tablica', () => {
  assert.deepStrictEqual(unwrapRpcRows({ foo: 'bar' }), []);
});

console.log('\n=== detectPreMatchTeamBriefingDue ===');
scenario('włączony + w oknie + próg spełniony -> active, reportKey = jutrzejsza data', () => {
  const r = detectPreMatchTeamBriefingDue({ warsawNow: makeWarsawNow({ hour: 19, dateStr: '2026-08-05' }), matchTomorrowCount: 1, enabled: true });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.reportKey, '2026-08-06');
  assert.strictEqual(r.reportType, 'pre_match_team_briefing');
});
scenario('dokładnie na progu (count === MIN) -> active', () => {
  const r = detectPreMatchTeamBriefingDue({ warsawNow: makeWarsawNow(), matchTomorrowCount: PRE_MATCH_BRIEFING_MIN_PLAYERS_WITH_MATCH_LOGGED, enabled: true });
  assert.strictEqual(r.active, true);
});
scenario('zero zawodników z zalogowanym meczem -> nieaktywny', () => {
  const r = detectPreMatchTeamBriefingDue({ warsawNow: makeWarsawNow(), matchTomorrowCount: 0, enabled: true });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.detail.thresholdMet, false);
});
scenario('poza oknem godzinowym -> nieaktywny mimo spełnionego progu', () => {
  const r = detectPreMatchTeamBriefingDue({ warsawNow: makeWarsawNow({ hour: 10 }), matchTomorrowCount: 3, enabled: true });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.detail.windowActive, false);
});
scenario('trener nie włączył (enabled=false) -> nieaktywny mimo spełnionych reszty warunków', () => {
  const r = detectPreMatchTeamBriefingDue({ warsawNow: makeWarsawNow(), matchTomorrowCount: 5, enabled: false });
  assert.strictEqual(r.active, false);
});
scenario('brak warsawNow -> nieaktywny, reportKey null', () => {
  const r = detectPreMatchTeamBriefingDue({ matchTomorrowCount: 5, enabled: true });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.reportKey, null);
});

console.log('\n=== detectWeeklyTeamPulseDue ===');
scenario('dzień tygodnia zgadza się + w oknie + włączony -> active', () => {
  // 2026-08-05 to środa (WED=3) w naszym syntetycznym warsawNow (weekday:3)
  const r = detectWeeklyTeamPulseDue({ warsawNow: makeWarsawNow({ weekday: 3 }), weeklyDayOfWeek: 'WED', enabled: true });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.reportType, 'weekly_team_pulse');
  assert.ok(/^\d{4}-W\d{2}$/.test(r.reportKey));
});
scenario('zły dzień tygodnia -> nieaktywny', () => {
  const r = detectWeeklyTeamPulseDue({ warsawNow: makeWarsawNow({ weekday: 3 }), weeklyDayOfWeek: 'FRI', enabled: true });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.detail.dayMatches, false);
});
scenario('poza oknem godzinowym -> nieaktywny mimo zgodnego dnia', () => {
  const r = detectWeeklyTeamPulseDue({ warsawNow: makeWarsawNow({ weekday: 3, hour: 8 }), weeklyDayOfWeek: 'WED', enabled: true });
  assert.strictEqual(r.active, false);
});
scenario('brak wybranego dnia (weeklyDayOfWeek null) -> nieaktywny', () => {
  const r = detectWeeklyTeamPulseDue({ warsawNow: makeWarsawNow({ weekday: 3 }), weeklyDayOfWeek: null, enabled: true });
  assert.strictEqual(r.active, false);
});
scenario('trener nie włączył -> nieaktywny mimo zgodnego dnia i okna', () => {
  const r = detectWeeklyTeamPulseDue({ warsawNow: makeWarsawNow({ weekday: 3 }), weeklyDayOfWeek: 'WED', enabled: false });
  assert.strictEqual(r.active, false);
});
scenario('reportKey = ten sam numer tygodnia ISO niezależnie od dnia tygodnia w tym samym tygodniu', () => {
  const r1 = detectWeeklyTeamPulseDue({ warsawNow: makeWarsawNow({ dateStr: '2026-08-03', weekday: 1 }), weeklyDayOfWeek: 'MON', enabled: true });
  const r2 = detectWeeklyTeamPulseDue({ warsawNow: makeWarsawNow({ dateStr: '2026-08-07', weekday: 5 }), weeklyDayOfWeek: 'FRI', enabled: true });
  assert.strictEqual(r1.reportKey, r2.reportKey);
});

console.log('\n=== summarizePreMatchSignals ===');
scenario('pusta lista wierszy -> checkedCount=0, riskCount=0', () => {
  const s = summarizePreMatchSignals({ rows: [], userInfoById: new Map() });
  assert.strictEqual(s.checkedCount, 0);
  assert.strictEqual(s.riskCount, 0);
  assert.deepStrictEqual(s.riskPlayerNames, []);
});
scenario('część zawodników z aktywną flagą -> policzeni i wymienieni po imieniu', () => {
  const userInfoById = new Map([
    ['p1', { full_name: 'Ala' }],
    ['p2', { full_name: 'Bartek' }],
    ['p3', { full_name: 'Celina' }],
  ]);
  const rows = [
    { player_user_id: 'p1', flags: { fatigue: true, pain: false } },
    { player_user_id: 'p2', flags: { fatigue: false, pain: false } },
    { player_user_id: 'p3', flags: { injury_mode: true } },
  ];
  const s = summarizePreMatchSignals({ rows, userInfoById });
  assert.strictEqual(s.checkedCount, 3);
  assert.strictEqual(s.riskCount, 2);
  assert.deepStrictEqual(s.riskPlayerNames.sort(), ['Ala', 'Celina'].sort());
});
scenario('wszystkie flagi false -> zero na ryzyku', () => {
  const rows = [{ player_user_id: 'p1', flags: { fatigue: false, pain: false, insufficient_data: false } }];
  const s = summarizePreMatchSignals({ rows, userInfoById: new Map() });
  assert.strictEqual(s.riskCount, 0);
});
scenario('wiersz bez pola flags (defensywnie) -> nie liczy się jako ryzyko, nie wywala', () => {
  const rows = [{ player_user_id: 'p1' }];
  assert.doesNotThrow(() => summarizePreMatchSignals({ rows, userInfoById: new Map() }));
  const s = summarizePreMatchSignals({ rows, userInfoById: new Map() });
  assert.strictEqual(s.riskCount, 0);
});
scenario('rows nie jest tablicą (defensywnie) -> traktowane jako puste, nie wywala', () => {
  assert.doesNotThrow(() => summarizePreMatchSignals({ rows: undefined, userInfoById: new Map() }));
  const s = summarizePreMatchSignals({ rows: null, userInfoById: new Map() });
  assert.strictEqual(s.checkedCount, 0);
});
scenario('brak wpisu w userInfoById -> spada do etykiety "Zawodnik", nie wywala', () => {
  const rows = [{ player_user_id: 'ghost', flags: { fatigue: true } }];
  const s = summarizePreMatchSignals({ rows, userInfoById: new Map() });
  assert.deepStrictEqual(s.riskPlayerNames, ['Zawodnik']);
});

console.log('\n=== computeWeeklyTeamPulseSummary ===');
scenario('normalny przypadek — ratio policzone poprawnie', () => {
  const s = computeWeeklyTeamPulseSummary({ rosterCount: 10, activePlayersCount: 4, activeFocusBlocksCount: 2 });
  assert.strictEqual(s.rosterCount, 10);
  assert.strictEqual(s.activePlayersCount, 4);
  assert.strictEqual(s.activeRatio, 0.4);
  assert.strictEqual(s.activeFocusBlocksCount, 2);
});
scenario('pusty roster (rosterCount=0) -> ratio 0, nie dzieli przez zero', () => {
  const s = computeWeeklyTeamPulseSummary({ rosterCount: 0, activePlayersCount: 0, activeFocusBlocksCount: 0 });
  assert.strictEqual(s.activeRatio, 0);
});
scenario('brak activeFocusBlocksCount -> domyślnie 0', () => {
  const s = computeWeeklyTeamPulseSummary({ rosterCount: 5, activePlayersCount: 5 });
  assert.strictEqual(s.activeFocusBlocksCount, 0);
});
scenario('wszyscy aktywni -> ratio 1', () => {
  const s = computeWeeklyTeamPulseSummary({ rosterCount: 3, activePlayersCount: 3 });
  assert.strictEqual(s.activeRatio, 1);
});

console.log('\n=== isReportDeduped ===');
scenario('brak logów -> nie zdeduplikowany', () => {
  assert.strictEqual(isReportDeduped({ logs: [], reportKey: '2026-08-06' }), false);
});
scenario('log z dokładnie tym samym kluczem -> zdeduplikowany', () => {
  const logs = [{ report_key: '2026-08-06' }];
  assert.strictEqual(isReportDeduped({ logs, reportKey: '2026-08-06' }), true);
});
scenario('log z innym kluczem -> nie zdeduplikowany', () => {
  const logs = [{ report_key: '2026-08-05' }];
  assert.strictEqual(isReportDeduped({ logs, reportKey: '2026-08-06' }), false);
});
scenario('reportKey null -> nigdy nie zdeduplikowany (ochronne zachowanie)', () => {
  const logs = [{ report_key: '2026-08-06' }];
  assert.strictEqual(isReportDeduped({ logs, reportKey: null }), false);
});
scenario('porównanie po String() — liczba vs string tego samego klucza -> zdeduplikowany', () => {
  const logs = [{ report_key: '2026-W32' }];
  assert.strictEqual(isReportDeduped({ logs, reportKey: '2026-W32' }), true);
});

console.log(`\n=== WYNIK: ${passed} passed, ${failed} failed (razem ${passed + failed}) ===\n`);
if (failed > 0) process.exit(1);
