// ============================================================
// test-coach-digest-signals.js — testy jednostkowe lib/coach-digest-signals.js
// ============================================================
// Uruchom: node tests/test-coach-digest-signals.js
//
// Zakres: WYŁĄCZNIE warstwa czysta (detectX/isDedupedByX) — ten plik nie
// wymaga @supabase/supabase-js (lib/coach-digest-signals.js nie ma żadnego
// require, w odróżnieniu od lib/coach-thread-library.js), więc zero atrapy
// modułu jest tu potrzebne. Dla każdego z 7 sygnałów: co najmniej jeden
// scenariusz "wykryty" i jeden "niewykryty" na granicy progu, plus
// scenariusz małej drużyny dla team_overload (ten sam problem co
// "Minimalny próg dla agregatów drużynowych" w ASYSTENT_SPORTOWCA_
// PROJEKT.md, Funkcja 9) i scenariusze deduplikacji per sygnał.
// ============================================================

const assert = require('assert');
const lib = require('../lib/coach-digest-signals.js');

const {
  TEAM_OVERLOAD_MIN_PLAYERS_WITH_DATA,
  TEAM_OVERLOAD_ELEVATED_RATIO,
  PLAYER_RISK_STANDOUT_DEDUP_COOLDOWN_DAYS,
  COACH_DIGEST_QUIET_THRESHOLD_DAYS,
  PLAYER_NEVER_STARTED_MIN_DAYS_SINCE_JOIN,
  HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS,
  HIGH_CONSISTENCY_JOURNAL_RATIO_THRESHOLD,
  HIGH_CONSISTENCY_DEDUP_COOLDOWN_DAYS,
  HIGH_CONSISTENCY_MIN_CALENDAR_EVENTS,
  FOCUS_BLOCK_STRONG_COMPLETION_RATIO,
  FOCUS_BLOCK_STRONG_MIN_TOTAL_SESSIONS,
  SIGNAL_TYPES,
  isoWeekKey,
  countDistinctDaysWithEntries,
  isReadinessElevated,
  detectTeamOverload,
  detectPlayerRiskStandout,
  detectPlayerWentQuiet,
  detectPlayerNeverStarted,
  detectPlayerHighConsistency,
  detectFocusBlockCompletedStrong,
  detectGoalAchieved,
  isDedupedByExactKey,
  isDedupedByCooldown,
  isSignalDeduped,
} = lib;

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

const NOW = new Date('2026-08-04T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgoIso(n, from) {
  return new Date((from || NOW).getTime() - n * DAY_MS).toISOString();
}

console.log('\n=== SIGNAL_TYPES / stałe podstawowe ===');
scenario('SIGNAL_TYPES ma dokładnie 7 sygnałów', () => {
  assert.strictEqual(SIGNAL_TYPES.length, 7);
});

// ============================================================
// isoWeekKey / countDistinctDaysWithEntries — pomocnicze
// ============================================================
console.log('\n=== Pomocnicze ===');
scenario('isoWeekKey: deterministyczny format ROK-Www', () => {
  const key = isoWeekKey(NOW);
  assert.ok(/^\d{4}-W\d{2}$/.test(key), `format nieoczekiwany: ${key}`);
});
scenario('isoWeekKey: ten sam tydzień dla dwóch dni tego samego tygodnia', () => {
  const a = isoWeekKey(new Date('2026-08-03T08:00:00Z')); // poniedziałek
  const b = isoWeekKey(new Date('2026-08-09T20:00:00Z')); // niedziela tego samego tygodnia
  assert.strictEqual(a, b);
});
scenario('isoWeekKey: różny tydzień między kolejnymi tygodniami', () => {
  const a = isoWeekKey(new Date('2026-08-03T08:00:00Z'));
  const b = isoWeekKey(new Date('2026-08-10T08:00:00Z'));
  assert.notStrictEqual(a, b);
});
scenario('countDistinctDaysWithEntries: liczy DNI, nie wpisy (kilka wpisów tego samego dnia = 1)', () => {
  const n = countDistinctDaysWithEntries([
    '2026-08-01T07:00:00Z', '2026-08-01T19:00:00Z', '2026-08-02T07:00:00Z',
  ]);
  assert.strictEqual(n, 2);
});
scenario('countDistinctDaysWithEntries: pusta lista -> 0', () => {
  assert.strictEqual(countDistinctDaysWithEntries([]), 0);
  assert.strictEqual(countDistinctDaysWithEntries(null), 0);
});
scenario('isReadinessElevated: false gdy brak sygnałów', () => {
  assert.strictEqual(isReadinessElevated(null), false);
  assert.strictEqual(isReadinessElevated({}), false);
});
scenario('isReadinessElevated: true gdy sen/nastrój/obciążenie/baseline aktywne', () => {
  assert.strictEqual(isReadinessElevated({ sleepFlag: { active: true } }), true);
  assert.strictEqual(isReadinessElevated({ moodFlag: { active: true } }), true);
  assert.strictEqual(isReadinessElevated({ weeklyLoadSpike: { active: true } }), true);
  assert.strictEqual(isReadinessElevated({ coldStartOrBaseline: { tired: true } }), true);
});

// ============================================================
// SYGNAŁ 1 — team_overload
// ============================================================
console.log('\n=== Sygnał 1: team_overload ===');
scenario('WYKRYTY: 5 zawodników z danymi, dokładnie 40% podwyższonych (granica)', () => {
  const r = detectTeamOverload({ eligiblePlayersCount: 5, elevatedCount: 2, now: NOW });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.signalKey, isoWeekKey(NOW));
});
scenario('NIEWYKRYTY: 5 zawodników z danymi, tylko 20% podwyższonych (poniżej progu odsetka)', () => {
  const r = detectTeamOverload({ eligiblePlayersCount: 5, elevatedCount: 1, now: NOW });
  assert.strictEqual(r.active, false);
});
scenario('MAŁA DRUŻYNA: 3 zawodników z danymi, WSZYSCY podwyższeni (100%) -> mimo to NIEWYKRYTY (próg minimalnej liczebności, ten sam problem co Funkcja 9)', () => {
  const r = detectTeamOverload({ eligiblePlayersCount: 3, elevatedCount: 3, now: NOW });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.detail.eligiblePlayersCount, 3);
});
scenario('BRAK DANYCH: 0 zawodników z danymi -> NIEWYKRYTY, zero dzielenia przez 0', () => {
  const r = detectTeamOverload({ eligiblePlayersCount: 0, elevatedCount: 0, now: NOW });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.detail.ratio, 0);
});
scenario('Stałe zgodne z modułem (kontrola regresji progów)', () => {
  assert.strictEqual(TEAM_OVERLOAD_MIN_PLAYERS_WITH_DATA, 5);
  assert.strictEqual(TEAM_OVERLOAD_ELEVATED_RATIO, 0.4);
});
scenario('DEDUP: ten sam tydzień ISO w logu -> zdeduplikowany', () => {
  const key = isoWeekKey(NOW);
  const deduped = isSignalDeduped({ signalType: 'team_overload', logs: [{ signal_key: key, sent_at: daysAgoIso(1) }], signalKey: key, now: NOW });
  assert.strictEqual(deduped, true);
});
scenario('DEDUP: inny tydzień ISO w logu (poprzedni tydzień) -> NIE zdeduplikowany, wysyłka wraca', () => {
  const prevWeekKey = isoWeekKey(new Date(NOW.getTime() - 8 * DAY_MS));
  const thisWeekKey = isoWeekKey(NOW);
  const deduped = isSignalDeduped({ signalType: 'team_overload', logs: [{ signal_key: prevWeekKey, sent_at: daysAgoIso(8) }], signalKey: thisWeekKey, now: NOW });
  assert.strictEqual(deduped, false);
});

// ============================================================
// SYGNAŁ 2 — player_risk_standout
// ============================================================
console.log('\n=== Sygnał 2: player_risk_standout ===');
scenario('WYKRYTY: sygnały gotowości (sen) aktywne', () => {
  const r = detectPlayerRiskStandout({ readinessSignals: { sleepFlag: { active: true } }, injuryModeActive: false, recentExcludingPain: false });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.detail.fatigueActive, true);
});
scenario('WYKRYTY: tryb kontuzji aktywny, bez sygnałów zmęczenia', () => {
  const r = detectPlayerRiskStandout({ readinessSignals: null, injuryModeActive: true, recentExcludingPain: false });
  assert.strictEqual(r.active, true);
});
scenario('WYKRYTY: niedawny ból wykluczający z treningu', () => {
  const r = detectPlayerRiskStandout({ readinessSignals: null, injuryModeActive: false, recentExcludingPain: true });
  assert.strictEqual(r.active, true);
});
scenario('NIEWYKRYTY: żaden z trzech warunków', () => {
  const r = detectPlayerRiskStandout({ readinessSignals: { sleepFlag: { active: false } }, injuryModeActive: false, recentExcludingPain: false });
  assert.strictEqual(r.active, false);
});
scenario('DEDUP: log sprzed 5 dni (< 14 dni cooldown) -> zdeduplikowany', () => {
  const deduped = isSignalDeduped({ signalType: 'player_risk_standout', logs: [{ signal_key: '2026-07-30', sent_at: daysAgoIso(5) }], now: NOW });
  assert.strictEqual(deduped, true);
});
scenario('DEDUP: log dokładnie na granicy 14 dni (jeszcze w oknie) -> zdeduplikowany', () => {
  const deduped = isSignalDeduped({ signalType: 'player_risk_standout', logs: [{ signal_key: 'x', sent_at: daysAgoIso(13.9) }], now: NOW });
  assert.strictEqual(deduped, true);
});
scenario('DEDUP: log sprzed 20 dni (> 14 dni cooldown) -> NIE zdeduplikowany', () => {
  const deduped = isSignalDeduped({ signalType: 'player_risk_standout', logs: [{ signal_key: 'x', sent_at: daysAgoIso(20) }], now: NOW });
  assert.strictEqual(deduped, false);
});
scenario('Stała cooldown zgodna ze zleceniem (14 dni, PODANE wprost, nie autonomiczne)', () => {
  assert.strictEqual(PLAYER_RISK_STANDOUT_DEDUP_COOLDOWN_DAYS, 14);
});

// ============================================================
// SYGNAŁ 3 — player_went_quiet
// ============================================================
console.log('\n=== Sygnał 3: player_went_quiet ===');
scenario('WYKRYTY: 10 dni ciszy (dokładnie próg domyślny)', () => {
  const lastActivityAt = daysAgoIso(COACH_DIGEST_QUIET_THRESHOLD_DAYS);
  const r = detectPlayerWentQuiet({ lastActivityAt, now: NOW });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.signalKey, lastActivityAt);
});
scenario('NIEWYKRYTY: 9 dni ciszy (poniżej progu)', () => {
  const lastActivityAt = daysAgoIso(9);
  const r = detectPlayerWentQuiet({ lastActivityAt, now: NOW });
  assert.strictEqual(r.active, false);
});
scenario('NIEWYKRYTY: brak jakiejkolwiek aktywności w historii (lastActivityAt=null)', () => {
  const r = detectPlayerWentQuiet({ lastActivityAt: null, now: NOW });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.signalKey, null);
});
scenario('DEDUP: log z TYM SAMYM lastActivityAt (ten sam epizod) -> zdeduplikowany', () => {
  const lastActivityAt = daysAgoIso(12);
  const deduped = isSignalDeduped({ signalType: 'player_went_quiet', logs: [{ signal_key: lastActivityAt, sent_at: daysAgoIso(2) }], signalKey: lastActivityAt, now: NOW });
  assert.strictEqual(deduped, true);
});
scenario('DEDUP: log z INNYM lastActivityAt (zawodnik wrócił, potem znów ucichł -> nowy epizod) -> NIE zdeduplikowany', () => {
  const oldEpisodeKey = daysAgoIso(25);
  const newEpisodeKey = daysAgoIso(11);
  const deduped = isSignalDeduped({ signalType: 'player_went_quiet', logs: [{ signal_key: oldEpisodeKey, sent_at: daysAgoIso(20) }], signalKey: newEpisodeKey, now: NOW });
  assert.strictEqual(deduped, false);
});

// ============================================================
// SYGNAŁ 4 — player_never_started
// ============================================================
console.log('\n=== Sygnał 4: player_never_started ===');
scenario('WYKRYTY: dołączył 5 dni temu (dokładnie próg), zero wpisów Dziennika', () => {
  const r = detectPlayerNeverStarted({ joinedAt: daysAgoIso(PLAYER_NEVER_STARTED_MIN_DAYS_SINCE_JOIN), hasAnyDailyLog: false, now: NOW });
  assert.strictEqual(r.active, true);
});
scenario('NIEWYKRYTY: dołączył 4 dni temu (poniżej progu)', () => {
  const r = detectPlayerNeverStarted({ joinedAt: daysAgoIso(4), hasAnyDailyLog: false, now: NOW });
  assert.strictEqual(r.active, false);
});
scenario('NIEWYKRYTY: dołączył dawno temu, ale MA już wpis Dziennika (inny przypadek niż "przestał")', () => {
  const r = detectPlayerNeverStarted({ joinedAt: daysAgoIso(30), hasAnyDailyLog: true, now: NOW });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.detail.reason, 'has_logs');
});
scenario('DEDUP: jakikolwiek log istnieje -> zdeduplikowany na zawsze (klucz stały)', () => {
  const deduped = isSignalDeduped({ signalType: 'player_never_started', logs: [{ signal_key: 'never_started', sent_at: daysAgoIso(100) }], signalKey: 'never_started', now: NOW });
  assert.strictEqual(deduped, true);
});
scenario('DEDUP: brak logu -> NIE zdeduplikowany', () => {
  const deduped = isSignalDeduped({ signalType: 'player_never_started', logs: [], signalKey: 'never_started', now: NOW });
  assert.strictEqual(deduped, false);
});

// ============================================================
// SYGNAŁ 5 — player_high_consistency
// ============================================================
console.log('\n=== Sygnał 5: player_high_consistency ===');
scenario('WYKRYTY (kryterium dziennik): dokładnie na granicy 85% (17/20)', () => {
  const r = detectPlayerHighConsistency({ journalDaysWithEntry: 17, journalWindowDays: 20 });
  assert.strictEqual(r.detail.journalRatio, 0.85);
  assert.strictEqual(r.active, true);
});
scenario('NIEWYKRYTY (kryterium dziennik): tuż poniżej granicy (16/20 = 80%)', () => {
  const r = detectPlayerHighConsistency({ journalDaysWithEntry: 16, journalWindowDays: 20 });
  assert.strictEqual(r.active, false);
});
scenario('WYKRYTY (kryterium kalendarz OR): wysoki odsetek zrealizowanych zaplanowanych wydarzeń, próbka wystarczająca', () => {
  const r = detectPlayerHighConsistency({
    journalDaysWithEntry: 2, journalWindowDays: 21, // dziennik nisko
    calendarCompletedCount: 5, calendarTotalCount: 5,
  });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.detail.calendarStrong, true);
});
scenario('NIEWYKRYTY: kalendarz 100%, ale próbka za mała (poniżej HIGH_CONSISTENCY_MIN_CALENDAR_EVENTS) -> kryterium kalendarza nie liczy się', () => {
  const r = detectPlayerHighConsistency({
    journalDaysWithEntry: 2, journalWindowDays: 21,
    calendarCompletedCount: 2, calendarTotalCount: 2,
  });
  assert.strictEqual(r.detail.calendarStrong, false);
  assert.strictEqual(r.active, false);
});
scenario('Domyślne okno 21 dni używane, gdy journalWindowDays nie podane', () => {
  const r = detectPlayerHighConsistency({ journalDaysWithEntry: 18 });
  assert.strictEqual(r.detail.journalWindowDays, HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS);
});
scenario('DEDUP: log sprzed 10 dni (< 21 dni cooldown) -> zdeduplikowany', () => {
  const deduped = isSignalDeduped({ signalType: 'player_high_consistency', logs: [{ signal_key: 'x', sent_at: daysAgoIso(10) }], now: NOW });
  assert.strictEqual(deduped, true);
});
scenario('DEDUP: log sprzed 22 dni (> 21 dni cooldown) -> NIE zdeduplikowany', () => {
  const deduped = isSignalDeduped({ signalType: 'player_high_consistency', logs: [{ signal_key: 'x', sent_at: daysAgoIso(22) }], now: NOW });
  assert.strictEqual(deduped, false);
});
scenario('Stałe: okno i cooldown 21 dni (PODANE wprost w zleceniu)', () => {
  assert.strictEqual(HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS, 21);
  assert.strictEqual(HIGH_CONSISTENCY_DEDUP_COOLDOWN_DAYS, 21);
  assert.strictEqual(HIGH_CONSISTENCY_JOURNAL_RATIO_THRESHOLD, 0.85);
  assert.strictEqual(HIGH_CONSISTENCY_MIN_CALENDAR_EVENTS, 5);
});

// ============================================================
// SYGNAŁ 6 — focus_block_completed_strong
// ============================================================
console.log('\n=== Sygnał 6: focus_block_completed_strong ===');
scenario('WYKRYTY: blok zakończony (status != active), 10/12 (83%) >= 80%, próbka wystarczająca', () => {
  const r = detectFocusBlockCompletedStrong({ status: 'closed', completedCount: 10, totalCount: 12 });
  assert.strictEqual(r.active, true);
});
scenario('WYKRYTY: dokładnie na granicy 80% (10/12.5 nie całkowite -> użyjmy 8/10=80%)', () => {
  const r = detectFocusBlockCompletedStrong({ status: 'closed', completedCount: 8, totalCount: 10 });
  assert.strictEqual(r.detail.ratio, FOCUS_BLOCK_STRONG_COMPLETION_RATIO);
  assert.strictEqual(r.active, true);
});
scenario('NIEWYKRYTY: blok WCIĄŻ aktywny (status=active), nawet przy wysokim odsetku', () => {
  const r = detectFocusBlockCompletedStrong({ status: 'active', completedCount: 11, totalCount: 12 });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.detail.isConcluded, false);
});
scenario('NIEWYKRYTY: odsetek poniżej progu (6/10=60%)', () => {
  const r = detectFocusBlockCompletedStrong({ status: 'closed', completedCount: 6, totalCount: 10 });
  assert.strictEqual(r.active, false);
});
scenario('NIEWYKRYTY: próbka za mała (2/2=100%, poniżej FOCUS_BLOCK_STRONG_MIN_TOTAL_SESSIONS)', () => {
  const r = detectFocusBlockCompletedStrong({ status: 'closed', completedCount: 2, totalCount: 2 });
  assert.strictEqual(r.active, false);
  assert.ok(2 < FOCUS_BLOCK_STRONG_MIN_TOTAL_SESSIONS);
});
scenario('DEDUP: log z tym samym focus_block_id -> zdeduplikowany (jednorazowy per blok)', () => {
  const deduped = isSignalDeduped({ signalType: 'focus_block_completed_strong', logs: [{ signal_key: 'block-abc', sent_at: daysAgoIso(90) }], signalKey: 'block-abc', now: NOW });
  assert.strictEqual(deduped, true);
});
scenario('DEDUP: log z INNYM focus_block_id (inny blok tego samego zawodnika) -> NIE zdeduplikowany', () => {
  const deduped = isSignalDeduped({ signalType: 'focus_block_completed_strong', logs: [{ signal_key: 'block-abc', sent_at: daysAgoIso(90) }], signalKey: 'block-xyz', now: NOW });
  assert.strictEqual(deduped, false);
});

// ============================================================
// SYGNAŁ 7 — goal_achieved
// ============================================================
console.log('\n=== Sygnał 7: goal_achieved ===');
scenario('WYKRYTY: status=completed', () => {
  const r = detectGoalAchieved({ status: 'completed' });
  assert.strictEqual(r.active, true);
});
scenario('NIEWYKRYTY: status=active', () => {
  const r = detectGoalAchieved({ status: 'active' });
  assert.strictEqual(r.active, false);
});
scenario('NIEWYKRYTY: status=abandoned (porzucony, nie osiągnięty)', () => {
  const r = detectGoalAchieved({ status: 'abandoned' });
  assert.strictEqual(r.active, false);
});
scenario('DEDUP: log z tym samym goal_id -> zdeduplikowany (jednorazowy per cel)', () => {
  const deduped = isSignalDeduped({ signalType: 'goal_achieved', logs: [{ signal_key: 'goal-1', sent_at: daysAgoIso(200) }], signalKey: 'goal-1', now: NOW });
  assert.strictEqual(deduped, true);
});
scenario('DEDUP: brak logu dla tego goal_id -> NIE zdeduplikowany', () => {
  const deduped = isSignalDeduped({ signalType: 'goal_achieved', logs: [{ signal_key: 'goal-OTHER', sent_at: daysAgoIso(200) }], signalKey: 'goal-1', now: NOW });
  assert.strictEqual(deduped, false);
});

// ============================================================
// isDedupedByExactKey / isDedupedByCooldown — testy bezpośrednie
// (poza isSignalDeduped, dla pełnego pokrycia obu prymitywów)
// ============================================================
console.log('\n=== Prymitywy deduplikacji (bezpośrednio) ===');
scenario('isDedupedByExactKey: pusta lista logów -> false', () => {
  assert.strictEqual(isDedupedByExactKey({ logs: [], signalKey: 'x' }), false);
});
scenario('isDedupedByExactKey: signalKey=null -> zawsze false (nigdy nie dedupuje po pustym kluczu)', () => {
  assert.strictEqual(isDedupedByExactKey({ logs: [{ signal_key: null }], signalKey: null }), false);
});
scenario('isDedupedByCooldown: pusta lista logów -> false', () => {
  assert.strictEqual(isDedupedByCooldown({ logs: [], now: NOW, cooldownDays: 14 }), false);
});

console.log(`\n=== WYNIK: ${passed} zaliczonych, ${failed} niezaliczonych (łącznie ${passed + failed}) ===\n`);
process.exit(failed === 0 ? 0 : 1);
