// ============================================================
// GAMECHANGE — lib/coach-digest.js
// ============================================================
// Orkiestrator "Digestu sygnałów trenerskich" (04.08.2026). Warstwa I/O
// (Supabase) rozdzielona od czystej logiki detekcji/deduplikacji w
// lib/coach-digest-signals.js — ten sam podział co
// lib/coach-thread-library.js (fetch*/run* tutaj, evaluate*/detect* tam).
//
// MECHANIZM (ustalony wprost w zleceniu, nie fixed-time report): trener
// zaznacza w Ustawieniach (coach.html), KTÓRE z 7 kategorii sygnałów chce
// dostawać e-mailem (coach_digest_preferences, wzorzec "brak wiersza =
// WŁĄCZONE" identyczny jak notification_preferences zawodnika). Cron
// (runCoachDigestCheck, wołane z api/cron-send-notifications.js) sprawdza
// PRZY KAŻDYM uruchomieniu, czy dla którejś włączonej kategorii pojawiło
// się coś NOWEGO — deduplikacja (coach_digest_signal_log) gwarantuje, że
// ten sam "epizod" sygnału nie wysyła się wielokrotnie mimo że cron leci
// ~12x/dziennie. To NIE jest cotygodniowy raport zbiorczy — to zdarzeniowe
// e-maile, jeden na wykryty, nowy sygnał.
//
// ZAKRES (świadomie): tylko relacje DRUŻYNOWE (teams.coach_user_id +
// team_memberships), zgodnie wprost z opisem zlecenia ("dla każdej
// drużyny z aktywnym trenerem"). Prywatne relacje coach_player_
// relationships (Pętla Trenera poza drużyną) świadomie POZA zakresem tego
// pakietu — jeśli Kuba zechce rozszerzyć, to osobna, przemyślana decyzja
// (inny model zgody/współdzielenia), nie cichy bonus tutaj.
//
// GATING WIDOCZNOŚCI — rozszerzenie istniejącej filozofii teams.
// visibility_level ('basic'/'extended'/'full', już respektowanej przez
// coach.html — patrz visibleRiskFlagKeys) na treść e-maili, żeby digest
// NIGDY nie ujawniał trenerowi więcej niż UI samo dziś pokazuje na danym
// poziomie zgody:
//   - team_overload             -> bez gatingu (ta sama ranga co mapa
//     cieplna drużyny/`fatigue` w visibleRiskFlagKeys, dostępna od Podstawowego).
//   - player_risk_standout:
//       * gałąź "zmęczenie/sen/nastrój" (isReadinessElevated) -> bez gatingu.
//       * gałąź "tryb kontuzji aktywny" -> wymaga 'extended'/'full' (ten sam
//         próg co `injury_mode` w visibleRiskFlagKeys).
//       * gałąź "ból wykluczający z treningu" -> wymaga 'full' (ten sam
//         próg co `pain` w visibleRiskFlagKeys).
//     Na niższym poziomie dana gałąź jest po prostu NIE sprawdzana (nie
//     tylko ukryta w treści) — trener na poziomie Podstawowym nigdy nie
//     powoduje zapytania o pain_entries/injury_mode_active tego zawodnika.
//   - player_went_quiet / player_never_started / player_high_consistency
//     -> bez gatingu (fakty obecności/nieobecności aktywności, ten sam
//     status co plakietka "insufficient_data" widoczna na każdym poziomie).
//   - focus_block_completed_strong -> wymaga 'extended'/'full' (dokładnie
//     ten sam próg co funkcja SQL coach_sees_focus_blocks,
//     INTEGRACJA_PETLA_TRENERA_SQL.md — połowa drużynowa tej funkcji).
//   - goal_achieved -> wymaga 'extended'/'full' (dokładnie ten sam próg co
//     etykieta w coach.html: "Rozszerzony — dodatkowo cele zawodników").
//
// SCHEMAT DANYCH — zweryfikowany ŻYWO przed napisaniem tego pliku (nie
// zgadywany), źródła:
//   - teams(id, coach_user_id, visibility_level, club_name) —
//     lib/coach-feedback-round.js, api/generate-coach-tip.js.
//   - team_memberships(team_id, player_user_id, status, joined_at) +
//     embed users(full_name, email) -> coach.html linia ~839.
//   - users(id, email, full_name) -> retention-check.js, coach.html.
//   - daily_logs(user_id, entry_type, payload, created_at, calendar_event_id)
//     -> retention-check.js, coach-thread-library.js.
//   - match_contexts(user_id, created_at) -> retention-check.js
//     (computeLastActivityAt, REUŻYTE stąd 1:1).
//   - pain_entries(user_id, excludes_from_training, created_at) ->
//     coach-thread-library.js (fetchHasRecentExcludingPain).
//   - player_profiles(user_id, injury_mode_active) -> KONTRAKT_PROFIL.md.
//   - calendar_events(id, user_id, event_type, status, scheduled_date,
//     focus_block_id) -> coach-thread-library.js (computeCalendarCompletionRate)
//     + generate-focus-block-content.js (generateClosingReview, status==
//     'completed' per blok Skupienia — inny mechanizm "wykonano" niż
//     scheduled+daily_logs.calendar_event_id, patrz UWAGA w
//     coach-digest-signals.js/detectFocusBlockCompletedStrong).
//   - focus_blocks(id, user_id, segment_id, status, closed_at) ->
//     generate-focus-block-content.js (fetchFocusBlock). `closed_at IS NOT
//     NULL` użyte jako obronny warunek "blok zakończony" zamiast zgadywania
//     dokładnego stringa statusu (potwierdzone: 'active' na pewno istnieje,
//     dokładna wartość statusu PO zamknięciu nie była w 100% pewna w tej
//     sesji — patrz DO_ZROBIENIA_PRZEZ_KUBE.md, ten pakiet).
//   - goals(id, user_id, segment_id, status, ended_at) -> mobile/docs/
//     KONTRAKT_CELE.md (`endGoal()`: PATCH status+ended_at=now — POTWIERDZA,
//     że ended_at jest ustawiany dokładnie w momencie zmiany statusu, więc
//     jest bezpiecznym filtrem "niedawno zakończony", nie tylko `status`).
//
// OCHRONNE OKNO "NIEDAWNO" dla sygnałów 6/7 (focus_block_completed_strong,
// goal_achieved) — SIGNAL_LOOKBACK_DAYS niżej, 30 dni. Bez tego pierwsze
// uruchomienie po wdrożeniu wysłałoby e-mail o KAŻDYM historycznie
// zamkniętym bloku/osiągniętym celu w całej historii systemu (deduplikacja
// per-id i tak by to docelowo zatrzymała od DRUGIEGO uruchomienia, ale
// pierwsze i tak zalałoby trenera starymi wiadomościami) — 30 dni to
// autonomiczny wybór, do korekty przez Kubę, patrz stała niżej.
// ============================================================

const { sendEmail } = require('./email-sender');
const {
  teamOverloadDigestEmail, playerRiskStandoutDigestEmail, playerWentQuietDigestEmail,
  playerNeverStartedDigestEmail, playerHighConsistencyDigestEmail,
  focusBlockCompletedStrongDigestEmail, goalAchievedDigestEmail,
} = require('./email-templates');
const {
  fetchReadinessWindowLogs, computeReadinessSignals,
} = require('../api/generate-recommendation.js')._internal;
const signals = require('./coach-digest-signals');

const DAY_MS = 24 * 60 * 60 * 1000;

// Okno "niedawno" dla zdarzeń jednorazowych z historyczną tabelą (bloki
// skupienia zamknięte / cele osiągnięte) — patrz nagłówek pliku.
const SIGNAL_LOOKBACK_DAYS = 30;

function isoSince(now, days) {
  return new Date((now || new Date()).getTime() - days * DAY_MS).toISOString();
}

function playerLabel(userInfo) {
  if (!userInfo) return 'Zawodnik';
  return userInfo.full_name || userInfo.email || 'Zawodnik';
}

function visibilityAtLeast(level, min) {
  if (min === 'extended') return level === 'extended' || level === 'full';
  if (min === 'full') return level === 'full';
  return true;
}

// ------------------------------------------------------------
// I/O — WARSTWA POBIERANIA DANYCH
// ------------------------------------------------------------

async function fetchTeamsWithCoach(supabase) {
  const { data, error } = await supabase
    .from('teams')
    .select('id, coach_user_id, visibility_level, club_name')
    .not('coach_user_id', 'is', null);
  if (error) throw new Error(`fetchTeamsWithCoach: ${error.message}`);
  return data || [];
}

async function fetchUsersByIds(supabase, ids) {
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from('users').select('id, email, full_name').in('id', ids);
  if (error) { console.error('coach-digest: fetchUsersByIds error:', error); return new Map(); }
  return new Map((data || []).map((u) => [u.id, u]));
}

async function fetchDigestPreferences(supabase, coachUserIds) {
  if (!coachUserIds.length) return new Map();
  const { data, error } = await supabase
    .from('coach_digest_preferences')
    .select('coach_user_id, signal_type, enabled')
    .in('coach_user_id', coachUserIds);
  if (error) { console.error('coach-digest: fetchDigestPreferences error:', error); return new Map(); }
  const map = new Map();
  (data || []).forEach((r) => map.set(`${r.coach_user_id}:${r.signal_type}`, r.enabled));
  return map;
}

// Brak wiersza = WŁĄCZONE (dokładnie wzorzec notification_preferences
// zawodnika) — trener wypisuje się z tego, czego nie chce, nie zapisuje
// się od zera.
function isSignalEnabled(prefMap, coachUserId, signalType) {
  const key = `${coachUserId}:${signalType}`;
  return prefMap.has(key) ? prefMap.get(key) !== false : true;
}

async function fetchDigestSignalLog(supabase, coachUserId) {
  const { data, error } = await supabase
    .from('coach_digest_signal_log')
    .select('team_id, player_user_id, signal_type, signal_key, sent_at')
    .eq('coach_user_id', coachUserId)
    .limit(5000); // ochronny limit, ten sam duch co MAX_PER_RUN gdzie indziej
  if (error) { console.error('coach-digest: fetchDigestSignalLog error:', error); return []; }
  return data || [];
}

function logsFor(digestLog, { signalType, playerUserId = null, teamId = null }) {
  return digestLog.filter((l) => l.signal_type === signalType
    && l.player_user_id === playerUserId
    && (teamId === null ? true : l.team_id === teamId));
}

async function recordDigestSignalSent(supabase, { coachUserId, teamId, playerUserId, signalType, signalKey, now }) {
  const { error } = await supabase.from('coach_digest_signal_log').insert({
    coach_user_id: coachUserId,
    team_id: teamId,
    player_user_id: playerUserId,
    signal_type: signalType,
    signal_key: signalKey == null ? null : String(signalKey),
    sent_at: (now || new Date()).toISOString(),
  });
  if (error) console.error(`coach-digest: nie udało się zapisać coach_digest_signal_log (${signalType}):`, error);
}

async function fetchRoster(supabase, teamId) {
  const { data, error } = await supabase
    .from('team_memberships')
    .select('player_user_id, joined_at, users(full_name, email)')
    .eq('team_id', teamId)
    .eq('status', 'active');
  if (error) throw new Error(`fetchRoster: ${error.message}`);
  return data || [];
}

// "Ostatnia aktywność" per użytkownik z jednej tabeli, ograniczone do
// listy id (wariant fetchLatestPerUser z retention-check.js, ale
// zawężony do rosteru JEDNEJ drużyny zamiast całej bazy — dużo tańsze
// zapytanie przy pętli po wielu drużynach).
async function fetchLatestByUser(supabase, table, userIds) {
  if (!userIds.length) return new Map();
  const { data, error } = await supabase
    .from(table)
    .select('user_id, created_at')
    .in('user_id', userIds)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) { console.error(`coach-digest: fetchLatestByUser(${table}) error:`, error); return new Map(); }
  const map = new Map();
  (data || []).forEach((r) => { if (!map.has(r.user_id)) map.set(r.user_id, r.created_at); });
  return map;
}

async function fetchPlayersWithRecentData(supabase, userIds, sinceIso) {
  if (!userIds.length) return new Set();
  const { data, error } = await supabase
    .from('daily_logs')
    .select('user_id')
    .in('user_id', userIds)
    .gte('created_at', sinceIso)
    .limit(5000);
  if (error) { console.error('coach-digest: fetchPlayersWithRecentData error:', error); return new Set(); }
  return new Set((data || []).map((r) => r.user_id));
}

async function fetchReadinessSignalsByUser(supabase, userIds, now) {
  const entries = await Promise.all(userIds.map(async (uid) => {
    try {
      const windowLogs = await fetchReadinessWindowLogs(supabase, uid);
      return [uid, computeReadinessSignals(windowLogs, now)];
    } catch (e) {
      console.error(`coach-digest: fetchReadinessSignalsByUser(${uid}) error:`, e);
      return [uid, null];
    }
  }));
  return new Map(entries);
}

async function fetchInjuryModeActiveUserIds(supabase, userIds) {
  if (!userIds.length) return new Set();
  const { data, error } = await supabase.from('player_profiles').select('user_id, injury_mode_active').in('user_id', userIds);
  if (error) { console.error('coach-digest: fetchInjuryModeActiveUserIds error:', error); return new Set(); }
  return new Set((data || []).filter((r) => r.injury_mode_active).map((r) => r.user_id));
}

async function fetchRecentExcludingPainUserIds(supabase, userIds, sinceIso) {
  if (!userIds.length) return new Set();
  const { data, error } = await supabase
    .from('pain_entries')
    .select('user_id')
    .in('user_id', userIds)
    .eq('excludes_from_training', true)
    .gte('created_at', sinceIso)
    .limit(5000);
  if (error) { console.error('coach-digest: fetchRecentExcludingPainUserIds error:', error); return new Set(); }
  return new Set((data || []).map((r) => r.user_id));
}

async function fetchDailyLogDatesByUser(supabase, userIds, sinceIso) {
  if (!userIds.length) return new Map();
  const { data, error } = await supabase
    .from('daily_logs')
    .select('user_id, created_at')
    .in('user_id', userIds)
    .gte('created_at', sinceIso)
    .limit(20000);
  if (error) { console.error('coach-digest: fetchDailyLogDatesByUser error:', error); return new Map(); }
  const byUser = new Map();
  (data || []).forEach((r) => {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r.created_at);
  });
  return byUser;
}

// Zbiorczy odpowiednik computeCalendarCompletionRate (coach-thread-library.js)
// dla całego rosteru naraz — jedna para zapytań zamiast N par.
async function fetchCalendarCompletionByUser(supabase, userIds, sinceDateStr, todayDateStr) {
  if (!userIds.length) return new Map();
  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('id, user_id')
    .in('user_id', userIds)
    .eq('status', 'scheduled')
    .in('event_type', ['club_training', 'own_training', 'micro_session'])
    .gte('scheduled_date', sinceDateStr)
    .lt('scheduled_date', todayDateStr)
    .limit(20000);
  if (error) { console.error('coach-digest: fetchCalendarCompletionByUser(events) error:', error); return new Map(); }
  const byUser = new Map();
  (events || []).forEach((e) => {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, { total: 0, ids: [] });
    const rec = byUser.get(e.user_id);
    rec.total++;
    rec.ids.push(e.id);
  });
  const allIds = (events || []).map((e) => e.id);
  let completedSet = new Set();
  if (allIds.length) {
    const { data: logged, error: logErr } = await supabase
      .from('daily_logs')
      .select('calendar_event_id')
      .in('calendar_event_id', allIds)
      .limit(20000);
    if (logErr) console.error('coach-digest: fetchCalendarCompletionByUser(logs) error:', logErr);
    completedSet = new Set((logged || []).map((r) => r.calendar_event_id));
  }
  const result = new Map();
  byUser.forEach((rec, uid) => {
    const completed = rec.ids.filter((id) => completedSet.has(id)).length;
    result.set(uid, { total: rec.total, completed });
  });
  return result;
}

async function fetchConcludedFocusBlocks(supabase, userIds, sinceIso) {
  if (!userIds.length) return [];
  const { data, error } = await supabase
    .from('focus_blocks')
    .select('id, user_id, status, closed_at, segment_id')
    .in('user_id', userIds)
    .not('closed_at', 'is', null)
    .gte('closed_at', sinceIso)
    .limit(2000);
  if (error) { console.error('coach-digest: fetchConcludedFocusBlocks error:', error); return []; }
  return data || [];
}

async function fetchFocusBlockCompletionCounts(supabase, focusBlockIds) {
  if (!focusBlockIds.length) return new Map();
  const { data, error } = await supabase
    .from('calendar_events')
    .select('focus_block_id, status')
    .in('focus_block_id', focusBlockIds)
    .limit(20000);
  if (error) { console.error('coach-digest: fetchFocusBlockCompletionCounts error:', error); return new Map(); }
  const map = new Map();
  (data || []).forEach((r) => {
    if (!r.focus_block_id) return;
    if (!map.has(r.focus_block_id)) map.set(r.focus_block_id, { total: 0, completed: 0 });
    const rec = map.get(r.focus_block_id);
    rec.total++;
    if (r.status === 'completed') rec.completed++;
  });
  return map;
}

async function fetchRecentlyCompletedGoals(supabase, userIds, sinceIso) {
  if (!userIds.length) return [];
  const { data, error } = await supabase
    .from('goals')
    .select('id, user_id, segment_id, status, ended_at')
    .in('user_id', userIds)
    .eq('status', 'completed')
    .not('ended_at', 'is', null)
    .gte('ended_at', sinceIso)
    .limit(2000);
  if (error) { console.error('coach-digest: fetchRecentlyCompletedGoals error:', error); return []; }
  return data || [];
}

// ------------------------------------------------------------
// Budowa e-maila dla jednego "kandydata" sygnału (patrz collectCandidates
// niżej) — jedno miejsce mapujące signalType -> szablon z email-templates.js,
// żeby nie rozrzucać tej decyzji po całym pliku.
// ------------------------------------------------------------
function buildEmailForCandidate(c) {
  switch (c.signalType) {
    case 'team_overload':
      return teamOverloadDigestEmail({ teamName: c.teamName, eligiblePlayersCount: c.detail.eligiblePlayersCount, elevatedCount: c.detail.elevatedCount });
    case 'player_risk_standout':
      return playerRiskStandoutDigestEmail({ playerName: c.playerName });
    case 'player_went_quiet':
      return playerWentQuietDigestEmail({ playerName: c.playerName, daysSince: c.detail.daysSince });
    case 'player_never_started':
      return playerNeverStartedDigestEmail({ playerName: c.playerName, daysSinceJoin: c.detail.daysSinceJoin });
    case 'player_high_consistency':
      return playerHighConsistencyDigestEmail({
        playerName: c.playerName,
        criterion: c.detail.calendarStrong && !c.detail.journalStrong ? 'calendar' : 'journal',
        journalDaysWithEntry: c.detail.journalDaysWithEntry,
        journalWindowDays: c.detail.journalWindowDays,
        calendarCompleted: c.detail.calendarCompletedCount,
        calendarTotal: c.detail.calendarTotalCount,
      });
    case 'focus_block_completed_strong':
      return focusBlockCompletedStrongDigestEmail({ playerName: c.playerName, segmentId: c.segmentId, completedCount: c.detail.completedCount, totalCount: c.detail.totalCount });
    case 'goal_achieved':
      return goalAchievedDigestEmail({ playerName: c.playerName, segmentId: c.segmentId });
    default:
      throw new Error(`buildEmailForCandidate: nieznany signalType ${c.signalType}`);
  }
}

// ------------------------------------------------------------
// GŁÓWNA FUNKCJA — wołana przez cron (api/cron-send-notifications.js).
// `results`, jeśli podany, dostaje przyrost results.coach_digest.
// ------------------------------------------------------------
async function runCoachDigestCheck(supabase, results) {
  const now = new Date();
  const teams = await fetchTeamsWithCoach(supabase);
  if (!teams.length) return;

  const coachIds = [...new Set(teams.map((t) => t.coach_user_id))];
  const [coachUsers, prefMap] = await Promise.all([
    fetchUsersByIds(supabase, coachIds),
    fetchDigestPreferences(supabase, coachIds),
  ]);

  const MAX = signals.MAX_DIGEST_EMAILS_PER_RUN;
  let sentThisRun = 0;

  const sinceSevenDaysIso = isoSince(now, 7);
  const sinceRiskWindowIso = isoSince(now, signals.PLAYER_RISK_STANDOUT_RECENT_PAIN_WINDOW_DAYS);
  const sinceConsistencyWindowIso = isoSince(now, signals.HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS);
  const sinceLookbackIso = isoSince(now, SIGNAL_LOOKBACK_DAYS);
  const todayStr = now.toISOString().slice(0, 10);
  const calendarSinceStr = new Date(now.getTime() - signals.HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);

  for (const team of teams) {
    if (sentThisRun >= MAX) break;
    const coach = coachUsers.get(team.coach_user_id);
    if (!coach || !coach.email) continue;

    const enabledTypes = new Set(signals.SIGNAL_TYPES.filter((t) => isSignalEnabled(prefMap, team.coach_user_id, t)));
    if (!enabledTypes.size) continue; // trener wypisał się ze wszystkiego -- pomiń całą drużynę bez zbędnych zapytań

    let roster;
    try {
      roster = await fetchRoster(supabase, team.id);
    } catch (e) {
      console.error(`coach-digest: fetchRoster(${team.id}) error:`, e);
      continue;
    }
    if (!roster.length) continue;

    const rosterIds = roster.map((r) => r.player_user_id);
    const userInfoById = new Map(roster.map((r) => [r.player_user_id, r.users || {}]));
    const joinedAtById = new Map(roster.map((r) => [r.player_user_id, r.joined_at]));

    const digestLog = await fetchDigestSignalLog(supabase, team.coach_user_id);
    const candidates = [];

    // ---- Dane współdzielone przez kilka sygnałów naraz ----
    const needsReadiness = enabledTypes.has('team_overload') || enabledTypes.has('player_risk_standout');
    const needsActivity = enabledTypes.has('player_went_quiet') || enabledTypes.has('player_never_started');

    const [
      playersWithRecentData,
      readinessByUser,
      latestDailyLogByUser,
      latestMatchContextByUser,
      injuryModeUserIds,
      recentPainUserIds,
      dailyLogDatesByUser,
      calendarCompletionByUser,
      concludedFocusBlocks,
      completedGoals,
    ] = await Promise.all([
      enabledTypes.has('team_overload') ? fetchPlayersWithRecentData(supabase, rosterIds, sinceSevenDaysIso) : Promise.resolve(new Set()),
      needsReadiness ? fetchReadinessSignalsByUser(supabase, rosterIds, now) : Promise.resolve(new Map()),
      needsActivity ? fetchLatestByUser(supabase, 'daily_logs', rosterIds) : Promise.resolve(new Map()),
      needsActivity ? fetchLatestByUser(supabase, 'match_contexts', rosterIds) : Promise.resolve(new Map()),
      (enabledTypes.has('player_risk_standout') && visibilityAtLeast(team.visibility_level, 'extended'))
        ? fetchInjuryModeActiveUserIds(supabase, rosterIds) : Promise.resolve(new Set()),
      (enabledTypes.has('player_risk_standout') && visibilityAtLeast(team.visibility_level, 'full'))
        ? fetchRecentExcludingPainUserIds(supabase, rosterIds, sinceRiskWindowIso) : Promise.resolve(new Set()),
      enabledTypes.has('player_high_consistency') ? fetchDailyLogDatesByUser(supabase, rosterIds, sinceConsistencyWindowIso) : Promise.resolve(new Map()),
      enabledTypes.has('player_high_consistency') ? fetchCalendarCompletionByUser(supabase, rosterIds, calendarSinceStr, todayStr) : Promise.resolve(new Map()),
      (enabledTypes.has('focus_block_completed_strong') && visibilityAtLeast(team.visibility_level, 'extended'))
        ? fetchConcludedFocusBlocks(supabase, rosterIds, sinceLookbackIso) : Promise.resolve([]),
      (enabledTypes.has('goal_achieved') && visibilityAtLeast(team.visibility_level, 'extended'))
        ? fetchRecentlyCompletedGoals(supabase, rosterIds, sinceLookbackIso) : Promise.resolve([]),
    ]);

    // ---- Sygnał 1: team_overload (drużynowy, nie per-zawodnik) ----
    if (enabledTypes.has('team_overload')) {
      const eligible = rosterIds.filter((id) => playersWithRecentData.has(id));
      const elevatedCount = eligible.filter((id) => signals.isReadinessElevated(readinessByUser.get(id))).length;
      const result = signals.detectTeamOverload({ eligiblePlayersCount: eligible.length, elevatedCount, now });
      if (result.active) {
        const relevantLogs = logsFor(digestLog, { signalType: 'team_overload', playerUserId: null, teamId: team.id });
        if (!signals.isSignalDeduped({ signalType: 'team_overload', logs: relevantLogs, signalKey: result.signalKey, now })) {
          candidates.push({
            signalType: 'team_overload', teamId: team.id, playerUserId: null, signalKey: result.signalKey,
            teamName: team.club_name, detail: result.detail,
          });
        }
      }
    }

    // ---- Sygnały per-zawodnik ----
    for (const playerUserId of rosterIds) {
      if (sentThisRun + candidates.length >= MAX) break;
      const userInfo = userInfoById.get(playerUserId);
      const name = playerLabel(userInfo);

      if (enabledTypes.has('player_risk_standout')) {
        const readinessSignals = readinessByUser.get(playerUserId);
        const injuryModeActive = injuryModeUserIds.has(playerUserId); // Set pusty jeśli brak gatingu -> zawsze false, poprawnie
        const recentExcludingPain = recentPainUserIds.has(playerUserId);
        const result = signals.detectPlayerRiskStandout({ readinessSignals, injuryModeActive, recentExcludingPain });
        if (result.active) {
          const relevantLogs = logsFor(digestLog, { signalType: 'player_risk_standout', playerUserId, teamId: team.id });
          if (!signals.isSignalDeduped({ signalType: 'player_risk_standout', logs: relevantLogs, signalKey: null, now })) {
            candidates.push({ signalType: 'player_risk_standout', teamId: team.id, playerUserId, signalKey: null, playerName: name, detail: result.detail });
          }
        }
      }

      if (enabledTypes.has('player_went_quiet')) {
        const lastActivityAt = signalsComputeLastActivityAt(latestDailyLogByUser.get(playerUserId), latestMatchContextByUser.get(playerUserId));
        const result = signals.detectPlayerWentQuiet({ lastActivityAt, now });
        if (result.active) {
          const relevantLogs = logsFor(digestLog, { signalType: 'player_went_quiet', playerUserId, teamId: team.id });
          if (!signals.isSignalDeduped({ signalType: 'player_went_quiet', logs: relevantLogs, signalKey: result.signalKey, now })) {
            candidates.push({ signalType: 'player_went_quiet', teamId: team.id, playerUserId, signalKey: result.signalKey, playerName: name, detail: result.detail });
          }
        }
      }

      if (enabledTypes.has('player_never_started')) {
        const hasAnyDailyLog = latestDailyLogByUser.has(playerUserId);
        const joinedAt = joinedAtById.get(playerUserId);
        if (joinedAt) {
          const result = signals.detectPlayerNeverStarted({ joinedAt, hasAnyDailyLog, now });
          if (result.active) {
            const relevantLogs = logsFor(digestLog, { signalType: 'player_never_started', playerUserId, teamId: team.id });
            if (!signals.isSignalDeduped({ signalType: 'player_never_started', logs: relevantLogs, signalKey: result.signalKey, now })) {
              candidates.push({ signalType: 'player_never_started', teamId: team.id, playerUserId, signalKey: result.signalKey, playerName: name, detail: result.detail });
            }
          }
        }
      }

      if (enabledTypes.has('player_high_consistency')) {
        const dates = dailyLogDatesByUser.get(playerUserId) || [];
        const journalDaysWithEntry = signals.countDistinctDaysWithEntries(dates);
        const calendarStats = calendarCompletionByUser.get(playerUserId) || null;
        const result = signals.detectPlayerHighConsistency({
          journalDaysWithEntry,
          journalWindowDays: signals.HIGH_CONSISTENCY_JOURNAL_WINDOW_DAYS,
          calendarCompletedCount: calendarStats ? calendarStats.completed : null,
          calendarTotalCount: calendarStats ? calendarStats.total : null,
        });
        if (result.active) {
          const relevantLogs = logsFor(digestLog, { signalType: 'player_high_consistency', playerUserId, teamId: team.id });
          if (!signals.isSignalDeduped({ signalType: 'player_high_consistency', logs: relevantLogs, signalKey: null, now })) {
            candidates.push({ signalType: 'player_high_consistency', teamId: team.id, playerUserId, signalKey: null, playerName: name, detail: result.detail });
          }
        }
      }

      if (enabledTypes.has('focus_block_completed_strong')) {
        const blocks = concludedFocusBlocks.filter((b) => b.user_id === playerUserId);
        for (const block of blocks) {
          const counts = null; // uzupełnione niżej po jednym zbiorczym zapytaniu (patrz pętla po candidates focus_block)
          candidates.push({
            signalType: 'focus_block_completed_strong', teamId: team.id, playerUserId, signalKey: block.id,
            playerName: name, segmentId: block.segment_id, _focusBlock: block, detail: counts,
          });
        }
      }

      if (enabledTypes.has('goal_achieved')) {
        const goalsForPlayer = completedGoals.filter((g) => g.user_id === playerUserId);
        for (const goal of goalsForPlayer) {
          const result = signals.detectGoalAchieved({ status: goal.status });
          if (result.active) {
            const relevantLogs = logsFor(digestLog, { signalType: 'goal_achieved', playerUserId, teamId: team.id });
            if (!signals.isSignalDeduped({ signalType: 'goal_achieved', logs: relevantLogs, signalKey: goal.id, now })) {
              candidates.push({ signalType: 'goal_achieved', teamId: team.id, playerUserId, signalKey: goal.id, playerName: name, segmentId: goal.segment_id, detail: { status: goal.status } });
            }
          }
        }
      }
    }

    // ---- Dokończenie focus_block_completed_strong: policz completedCount/
    // totalCount zbiorczo dla wszystkich kandydatów naraz (jedno zapytanie),
    // dopiero teraz sprawdź próg + deduplikację (detekcja wymaga liczb). ----
    const focusBlockCandidates = candidates.filter((c) => c.signalType === 'focus_block_completed_strong');
    if (focusBlockCandidates.length) {
      const counts = await fetchFocusBlockCompletionCounts(supabase, focusBlockCandidates.map((c) => c._focusBlock.id));
      for (let i = candidates.length - 1; i >= 0; i--) {
        const c = candidates[i];
        if (c.signalType !== 'focus_block_completed_strong') continue;
        const stat = counts.get(c._focusBlock.id) || { total: 0, completed: 0 };
        const result = signals.detectFocusBlockCompletedStrong({ status: c._focusBlock.status, completedCount: stat.completed, totalCount: stat.total });
        if (!result.active) { candidates.splice(i, 1); continue; }
        const relevantLogs = logsFor(digestLog, { signalType: 'focus_block_completed_strong', playerUserId: c.playerUserId, teamId: team.id });
        if (signals.isSignalDeduped({ signalType: 'focus_block_completed_strong', logs: relevantLogs, signalKey: c.signalKey, now })) { candidates.splice(i, 1); continue; }
        c.detail = result.detail;
        delete c._focusBlock;
      }
    }

    // ---- Wysyłka kandydatów tej drużyny (respektując globalny limit runu) ----
    for (const c of candidates) {
      if (sentThisRun >= MAX) break;
      try {
        const { subject, html, text } = buildEmailForCandidate(c);
        await sendEmail({ to: coach.email, subject, html, text });
        await recordDigestSignalSent(supabase, {
          coachUserId: team.coach_user_id, teamId: c.teamId, playerUserId: c.playerUserId,
          signalType: c.signalType, signalKey: c.signalKey, now,
        });
        sentThisRun++;
        if (results) results.coach_digest = (results.coach_digest || 0) + 1;
      } catch (e) {
        console.error(`coach-digest: błąd wysyłki (${c.signalType}, coach=${team.coach_user_id}):`, e);
      }
    }
  }
}

// Kopia computeLastActivityAt z retention-check.js (MAX z dwóch źródeł
// aktywności) — świadomie NIE importowana stamtąd, żeby lib/coach-digest.js
// nie musiał wymagać lib/retention-check.js wyłącznie dla jednej, trywialnej
// funkcji pomocniczej (zero realnego ryzyka rozjazdu -- logika to jedna
// linia Math.max, POTWIERDZONA przez Kubę 01.08.2026 i cytowana 1:1).
function signalsComputeLastActivityAt(latestDailyLogAt, latestMatchContextAt) {
  const a = latestDailyLogAt ? new Date(latestDailyLogAt).getTime() : null;
  const b = latestMatchContextAt ? new Date(latestMatchContextAt).getTime() : null;
  if (a === null && b === null) return null;
  const maxMs = Math.max(a === null ? -Infinity : a, b === null ? -Infinity : b);
  return new Date(maxMs).toISOString();
}

module.exports = {
  SIGNAL_LOOKBACK_DAYS,
  runCoachDigestCheck,
  _internal: {
    isoSince, playerLabel, visibilityAtLeast, isSignalEnabled, logsFor,
    fetchTeamsWithCoach, fetchUsersByIds, fetchDigestPreferences, fetchDigestSignalLog,
    fetchRoster, fetchLatestByUser, fetchPlayersWithRecentData, fetchReadinessSignalsByUser,
    fetchInjuryModeActiveUserIds, fetchRecentExcludingPainUserIds, fetchDailyLogDatesByUser,
    fetchCalendarCompletionByUser, fetchConcludedFocusBlocks, fetchFocusBlockCompletionCounts,
    fetchRecentlyCompletedGoals, buildEmailForCandidate, signalsComputeLastActivityAt,
  },
};
