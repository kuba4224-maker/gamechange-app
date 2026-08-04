// ============================================================
// GAMECHANGE — lib/retention-check.js
// ============================================================
// Pakiet z KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, sekcja 5.1: "Mechanizm
// retencji". Naprawia: brak jakiejkolwiek implementacji sygnału retencji/
// churnu (P4 z Filtra Jakości) — dziś nic w systemie nie zauważa, że
// zawodnik przestał wracać.
//
// POTWIERDZONE przez Kubę (01.08.2026): "ostatnia aktywność" =
// MAX(daily_logs.created_at, match_contexts.created_at).
//
// Kanał: E-MAIL (Resend, przez lib/email-sender.js) — NIE push. Patrz
// KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md sekcja 1.3: "Dostawca e-maili
// (Raport Rodzica + SYGNAŁ CHURNU Z RETENCJI)" — retencja od początku
// była projektowana jako kanał e-mailowy, więc świadomie NIE przechodzi
// przez push-rate-limiter.js/limit 2 push'y dziennie (inny kanał, inny
// budżet uwagi).
//
// PRÓG — 5-7 dni nieaktywności (opisane w KOLEJKA_DECYZJI jako zakres, nie
// pojedyncza potwierdzona liczba). Zaimplementowane jako JEDNA zmienna
// środowiskowa RETENTION_INACTIVITY_THRESHOLD_DAYS (domyślnie 6, środek
// zakresu) — ten sam wzorzec co PARENT_REPORT_INTERVAL_DAYS w
// cron-send-parent-reports.js: kalibracja to zmiana jednej zmiennej w
// Vercel, zero zmian w kodzie. Kuba: do skorygowania, jeśli 6 dni okaże
// się za wcześnie/za późno w praktyce pilotażu.
//
// ⚠️ UWAGA HISTORYCZNA (03.08.2026): ten plik (i test-retention-check.js,
// RETENCJA_SQL.md) był już RAZ napisany i przetestowany (12/12
// scenariuszy) w sesji 01.08.2026 — zgubiony jak reszta pakietów z
// sekcji 5 (nigdy nie trafił do Project Knowledge/na dysk). To
// ODTWORZENIE od zera z opisu, nie odzyskanie oryginału — nowa
// implementacja, własne testy, do przejrzenia przez Kubę przed
// wdrożeniem (w szczególności: treść maila w lib/email-templates.js,
// retentionReminderEmail — dopisana teraz, ton nigdy nie był
// zatwierdzony przez Kubę wprost).
//
// DEDUPLIKACJA — nowa tabela `retention_reminder_log`, JEDEN wiersz per
// użytkownik (upsert), przechowujący `last_activity_at` w momencie
// WYSŁANIA ostatniego przypomnienia. Jeśli od tego czasu zawodnik NIE
// miał żadnej nowej aktywności (ten sam last_activity_at co przy
// zapisanym przypomnieniu) — to wciąż ten sam "epizod" nieaktywności,
// NIE wysyłaj drugi raz (bez tego, cron uruchamiany ~12x/dziennie
// wysyłałby to samo przypomnienie codziennie w nieskończoność). Nowa
// aktywność PO przypomnieniu, a potem znów przekroczenie progu — to nowy
// epizod, przypomnienie wraca. Migracja: patrz RETENCJA_SQL.md.
// ============================================================

const { sendEmail } = require('./email-sender');
const { retentionReminderEmail } = require('./email-templates');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_INACTIVITY_THRESHOLD_DAYS = Number(process.env.RETENTION_INACTIVITY_THRESHOLD_DAYS) || 6;
const MAX_PER_RUN = 50; // ochronny limit, ten sam duch co MAX_PER_RUN gdzie indziej w systemie

// ------------------------------------------------------------
// Czysta funkcja — "ostatnia aktywność" = MAX(daily_logs.created_at,
// match_contexts.created_at), DOKŁADNIE jak potwierdził Kuba. Argumenty
// to najnowsze created_at z każdej z dwóch tabel dla JEDNEGO użytkownika
// (albo null, jeśli użytkownik nie ma żadnego wiersza w danej tabeli).
// ------------------------------------------------------------
function computeLastActivityAt(latestDailyLogAt, latestMatchContextAt) {
  const a = latestDailyLogAt ? new Date(latestDailyLogAt).getTime() : null;
  const b = latestMatchContextAt ? new Date(latestMatchContextAt).getTime() : null;
  if (a === null && b === null) return null;
  const maxMs = Math.max(a === null ? -Infinity : a, b === null ? -Infinity : b);
  return new Date(maxMs).toISOString();
}

// ------------------------------------------------------------
// Czysta funkcja decyzyjna — testowalna bez bazy/e-maila. `lastReminderFor
// Activity` to last_activity_at zapisany przy OSTATNIM wysłanym
// przypomnieniu (null, jeśli nigdy nie wysłano) — patrz komentarz o
// deduplikacji w nagłówku pliku.
// ------------------------------------------------------------
function isRetentionReminderDue({ lastActivityAt, now, lastReminderForActivity, thresholdDays = RETENTION_INACTIVITY_THRESHOLD_DAYS }) {
  if (!lastActivityAt) return { due: false, reason: 'no_activity_ever' }; // poza zakresem V1 -- nigdy nic nie zalogował
  const daysSince = (now.getTime() - new Date(lastActivityAt).getTime()) / DAY_MS;
  if (daysSince < thresholdDays) return { due: false, reason: 'below_threshold' };
  if (lastReminderForActivity && lastReminderForActivity === lastActivityAt) {
    return { due: false, reason: 'already_reminded_this_episode' };
  }
  return { due: true, reason: 'threshold_crossed' };
}

// ------------------------------------------------------------
// Per-użytkownik: najnowszy daily_logs.created_at i najnowszy
// match_contexts.created_at, przez dwa proste zapytania (ten sam wzorzec
// co fetchLatestDiagnosisPerUser w cron-onboard-diagnosis.js) — prostsze
// i bardziej czytelne niż jedno zapytanie z UNION/agregacją międzytabelową
// po stronie klienta supabase-js.
// ------------------------------------------------------------
async function fetchLatestPerUser(supabase, table) {
  const { data, error } = await supabase
    .from(table)
    .select('user_id, created_at')
    .order('created_at', { ascending: false })
    .limit(5000); // ochronny limit -- patrz uwaga w fetchLatestDiagnosisPerUser o tym samym wzorcu
  if (error) {
    console.error(`retention-check: fetchLatestPerUser(${table}) error:`, error);
    return new Map();
  }
  const latestByUser = new Map();
  for (const row of data || []) {
    if (!latestByUser.has(row.user_id)) latestByUser.set(row.user_id, row.created_at);
  }
  return latestByUser;
}

async function fetchAllUserIds(supabase) {
  const { data, error } = await supabase.from('users').select('id, email');
  if (error) {
    console.error('retention-check: fetchAllUserIds error:', error);
    return [];
  }
  return data || [];
}

async function fetchReminderLog(supabase) {
  const { data, error } = await supabase.from('retention_reminder_log').select('user_id, last_activity_at');
  if (error) {
    console.error('retention-check: fetchReminderLog error:', error);
    return new Map();
  }
  return new Map((data || []).map((r) => [r.user_id, r.last_activity_at]));
}

async function recordReminderSent(supabase, userId, lastActivityAt) {
  const { error } = await supabase
    .from('retention_reminder_log')
    .upsert({ user_id: userId, last_activity_at: lastActivityAt, sent_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) {
    console.error(`retention-check: nie udało się zapisać retention_reminder_log dla ${userId}:`, error);
  }
}

// ------------------------------------------------------------
// Główna funkcja wołana przez cron, RAZ dziennie (patrz stałe okno
// godzinowe w cron-send-notifications.js, ten sam wzorzec co
// weekly_summary/runTrainingFocusRotation — nie ma sensu sprawdzać co 2h,
// wynik i tak zależy tylko od dat, nie godzin). `results`, jeśli podany,
// dostaje przyrost results.retention_check.
// ------------------------------------------------------------
async function runRetentionCheck(supabase, results) {
  const [users, dailyLogLatest, matchContextLatest, reminderLog] = await Promise.all([
    fetchAllUserIds(supabase),
    fetchLatestPerUser(supabase, 'daily_logs'),
    fetchLatestPerUser(supabase, 'match_contexts'),
    fetchReminderLog(supabase),
  ]);
  if (users.length === 0) return;

  const now = new Date();
  let processed = 0;

  for (const user of users) {
    if (processed >= MAX_PER_RUN) {
      console.warn(`retention-check: limit ${MAX_PER_RUN}/przebieg osiągnięty, reszta poczeka do następnego uruchomienia.`);
      break;
    }

    const lastActivityAt = computeLastActivityAt(dailyLogLatest.get(user.id), matchContextLatest.get(user.id));
    const lastReminderForActivity = reminderLog.get(user.id) || null;
    const decision = isRetentionReminderDue({ lastActivityAt, now, lastReminderForActivity });
    if (!decision.due) continue;
    if (!user.email) continue; // brak adresu -- nie ma jak wysłać, pomiń bez błędu

    processed++;
    try {
      const { subject, html, text } = retentionReminderEmail({});
      await sendEmail({ to: user.email, subject, html, text });
      await recordReminderSent(supabase, user.id, lastActivityAt);
      if (results) results.retention_check = (results.retention_check || 0) + 1;
    } catch (e) {
      console.error(`retention-check: błąd wysyłki dla usera ${user.id}:`, e);
    }
  }
}

module.exports = {
  RETENTION_INACTIVITY_THRESHOLD_DAYS,
  computeLastActivityAt,
  isRetentionReminderDue,
  runRetentionCheck,
};
