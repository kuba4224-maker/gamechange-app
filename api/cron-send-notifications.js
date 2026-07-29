// ============================================================
// GAMECHANGE — cron-send-notifications.js (do wdrożenia: /api/cron-send-notifications.js w repo gamechange-app)
// ============================================================
// SCHEDULER dla pięciu "rytmów" powiadomień push (F15, Domena 09 —
// asystent_sportowca_09_powiadomienia.sql). Ten sam wzorzec ochrony co
// api_cron_send_parent_reports.js/api_cron_settlement.js: CRON_SECRET w
// nagłówku Authorization, Vercel Cron dołącza go automatycznie.
//
// URUCHAMIANY CO ~2H (patrz zaktualizowany asystent_vercel.json — ~12
// wpisów, każdy raz dziennie o innej stałej godzinie UTC, zgodnie z
// limitem Vercel Hobby "cron job max raz dziennie na wpis" — obejście
// przez wielość wpisów, nie przez wysoką częstotliwość jednego wpisu; DO
// ZWERYFIKOWANIA przez Kubę przed wdrożeniem, czy ten limit Vercel nadal
// obowiązuje w tej samej formie — zasady dostawców zewnętrznych się
// zmieniają, ten sam nawyk co przy weryfikacji Stripe/Vercel gdzie indziej
// w projekcie).
//
// RYZYKO R7 (strefa czasowa): godzina lokalna liczona WYŁĄCZNIE przez
// Intl.DateTimeFormat z timeZone: 'Europe/Warsaw' w KAŻDYM przebiegu —
// NIGDY stały offset — żeby DST (zmiana czasu) nie rozjeżdżała dopasowania
// mimo że same wpisy crona są przypięte do stałych godzin UTC.
//
// ZAŁOŻENIA WYMAGAJĄCE PRZEGLĄDU KUBY (nie 🛑 STOP — nie dotyczą kont/
// identyfikatorów, ale wpływają na to KIEDY realnie przyjdzie push) — pełen
// opis w docs/KROK_4_PUSH_POWIADOMIENIA.md w repo mobilnym:
// 1. weekly_summary ma dzień ustalony na sztywno (niedziela) — Domena 09
//    ma tylko preferred_time (godzina), bez dnia tygodnia.
// 2. DEFAULT_TIMES niżej to robocze wartości dla użytkowników bez wiersza
//    w notification_preferences — "system uczy się rytmu" (F15) NIE jest
//    tu zaimplementowane.
// 3. pre_match zależy od calendar_events.event_type='match' — DB na to
//    pozwala (Domena 09 rozszerzyła CHECK), ale żaden dzisiejszy frontend
//    (web ani appka natywna) nie daje sposobu na utworzenie takiego
//    wydarzenia — funkcja gotowa, realnie dziś nieaktywna.
// 4. Cztery z pięciu rytmów bez deduplikacji w bazie — poprawność przeciw
//    duplikatom opiera się na tym, że każdy trafia w JEDNO stałe okno ~2h
//    dziennie (patrz stałe *_WINDOW_HOUR niżej). Jedyny rytm z prawdziwą
//    deduplikacją to contextual_insight (decision_recommendations.notified_at).
//
// WDROŻONE: 29.07.2026, przez Cowork samodzielnie w przeglądarce (GitHub).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { sendPush } = require('./send-push');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const WARSAW_TZ = 'Europe/Warsaw';

// Domyślne godziny dla użytkowników bez własnego wiersza w
// notification_preferences (patrz punkt 2 w nagłówku pliku) — robocze
// wartości, nie potwierdzone przez Kubę, łatwe do zmiany tutaj.
const DEFAULT_TIMES = {
  morning_readiness: '08:00',
  weekly_summary: '19:00',
};
// Rytmy zdarzeniowe (patrz punkt 4 nagłówka) — każdy trafia w JEDNO stałe
// okno 2h dziennie, żeby uniknąć duplikatów bez nowego logu w bazie.
const POST_TRAINING_WINDOW_HOUR = 19; // wieczorem, po typowych treningach
const PRE_MATCH_WINDOW_HOUR = 19;     // wieczorem, dzień przed meczem
const WEEKLY_SUMMARY_WEEKDAY = 0;     // 0 = niedziela

function getWarsawNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: WARSAW_TZ,
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`; // lokalna data Warszawy, YYYY-MM-DD
  const weekdayShort = get('weekday'); // 'Mon'..'Sun'
  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, minute, dateStr, weekday: WEEKDAY_INDEX[weekdayShort] };
}

// Czy `targetHour` mieści się w oknie [currentHour, currentHour+2) tego
// przebiegu — tak dopasowujemy preferencję zawodnika do rytmu crona co
// ~2h, niezależnie od dokładnej minuty jego preferencji.
function hourInWindow(currentHour, targetHour) {
  const diff = (targetHour - currentHour + 24) % 24;
  return diff < 2;
}

async function getTokensForUser(supabase, userId) {
  const { data, error } = await supabase.from('push_tokens').select('token').eq('user_id', userId);
  if (error || !data) return [];
  return data.map((r) => r.token);
}

// ------------------------------------------------------------
// Rytm 1: morning_readiness — "rano, sprawdź gotowość". Zegarowy,
// per-użytkownik przez notification_preferences.preferred_time.
// ------------------------------------------------------------
async function runMorningReadiness(supabase, warsawNow, results) {
  const { data: users, error } = await supabase.from('users').select('id');
  if (error || !users) { console.error('cron-send-notifications: błąd pobierania users (morning_readiness):', error); return; }

  const { data: prefRows } = await supabase
    .from('notification_preferences')
    .select('user_id, enabled, preferred_time')
    .eq('notification_type', 'morning_readiness');
  const prefByUser = Object.fromEntries((prefRows || []).map((r) => [r.user_id, r]));

  for (const u of users) {
    const pref = prefByUser[u.id];
    if (pref && pref.enabled === false) continue; // jawnie wyłączone
    const targetTime = (pref && pref.preferred_time) || DEFAULT_TIMES.morning_readiness;
    const targetHour = Number(targetTime.split(':')[0]);
    if (!hourInWindow(warsawNow.hour, targetHour)) continue;

    const tokens = await getTokensForUser(supabase, u.id);
    if (tokens.length === 0) continue;
    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body: 'Jak się dziś czujesz? Sprawdź swoją gotowość i dodaj poranny wpis do Dziennika.',
        data: { type: 'morning_readiness' },
      });
      results.morning_readiness++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd wysyłki morning_readiness dla ${u.id}:`, e);
    }
  }
}

// ------------------------------------------------------------
// Rytm 2: post_training — "po treningu, zaloguj sesję". Zdarzeniowy:
// dzisiejsze zaplanowane treningi (club_training/own_training/
// micro_session), dla których zawodnik jeszcze nie dodał wpisu w
// Dzienniku (ten sam test "wykonano" co w ekranie Kalendarz appki
// natywnej — istnienie daily_logs.calendar_event_id wskazującego na to
// wydarzenie). Świadomie POMIJA 'task' (nie trening) i 'match' (osobny
// rytm pre_match, nie post_training).
// ------------------------------------------------------------
async function runPostTraining(supabase, warsawNow, results) {
  if (!hourInWindow(warsawNow.hour, POST_TRAINING_WINDOW_HOUR)) return;

  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('id, user_id, event_type')
    .eq('status', 'scheduled')
    .eq('scheduled_date', warsawNow.dateStr)
    .in('event_type', ['club_training', 'own_training', 'micro_session']);
  if (error || !events || events.length === 0) return;

  const { data: prefRows } = await supabase
    .from('notification_preferences')
    .select('user_id, enabled')
    .eq('notification_type', 'post_training');
  const prefByUser = Object.fromEntries((prefRows || []).map((r) => [r.user_id, r]));

  const { data: loggedRows } = await supabase
    .from('daily_logs')
    .select('calendar_event_id')
    .not('calendar_event_id', 'is', null);
  const loggedEventIds = new Set((loggedRows || []).map((r) => r.calendar_event_id));

  for (const ev of events) {
    if (loggedEventIds.has(ev.id)) continue; // już zalogowane
    const pref = prefByUser[ev.user_id];
    if (pref && pref.enabled === false) continue;

    const tokens = await getTokensForUser(supabase, ev.user_id);
    if (tokens.length === 0) continue;
    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body: 'Miałeś dziś zaplanowany trening — zaloguj sesję w Dzienniku, jak skończysz.',
        data: { type: 'post_training', calendarEventId: ev.id },
      });
      results.post_training++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd wysyłki post_training dla ${ev.user_id}:`, e);
    }
  }
}

// ------------------------------------------------------------
// Rytm 3: pre_match — "przed meczem, przypomnienie o check-inie".
// Zdarzeniowy: jutrzejsze zaplanowane wydarzenia event_type='match'.
// UWAGA (patrz punkt 3 nagłówka pliku): dziś żaden frontend nie tworzy
// takich wydarzeń — ta funkcja jest gotowa, ale realnie nieaktywna,
// dopóki ta luka nie zostanie zamknięta gdzie indziej.
// ------------------------------------------------------------
async function runPreMatch(supabase, warsawNow, results) {
  if (!hourInWindow(warsawNow.hour, PRE_MATCH_WINDOW_HOUR)) return;

  const tomorrow = new Date(`${warsawNow.dateStr}T00:00:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const y = tomorrow.getFullYear();
  const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const d = String(tomorrow.getDate()).padStart(2, '0');
  const tomorrowStr = `${y}-${m}-${d}`;

  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('id, user_id')
    .eq('status', 'scheduled')
    .eq('scheduled_date', tomorrowStr)
    .eq('event_type', 'match');
  if (error || !events || events.length === 0) return;

  const { data: prefRows } = await supabase
    .from('notification_preferences')
    .select('user_id, enabled')
    .eq('notification_type', 'pre_match');
  const prefByUser = Object.fromEntries((prefRows || []).map((r) => [r.user_id, r]));

  for (const ev of events) {
    const pref = prefByUser[ev.user_id];
    if (pref && pref.enabled === false) continue;

    const tokens = await getTokensForUser(supabase, ev.user_id);
    if (tokens.length === 0) continue;
    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body: 'Jutro masz mecz — sprawdź swój Profil i zadbaj o regenerację przed grą.',
        data: { type: 'pre_match', calendarEventId: ev.id },
      });
      results.pre_match++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd wysyłki pre_match dla ${ev.user_id}:`, e);
    }
  }
}

// ------------------------------------------------------------
// Rytm 4: weekly_summary — "tygodniowo, podsumowanie postępu celów".
// Dzień ustalony na sztywno (niedziela, patrz punkt 1 nagłówka pliku),
// godzina per-użytkownik jak w morning_readiness.
// ------------------------------------------------------------
async function runWeeklySummary(supabase, warsawNow, results) {
  if (warsawNow.weekday !== WEEKLY_SUMMARY_WEEKDAY) return;

  const { data: users, error } = await supabase.from('users').select('id');
  if (error || !users) { console.error('cron-send-notifications: błąd pobierania users (weekly_summary):', error); return; }

  const { data: prefRows } = await supabase
    .from('notification_preferences')
    .select('user_id, enabled, preferred_time')
    .eq('notification_type', 'weekly_summary');
  const prefByUser = Object.fromEntries((prefRows || []).map((r) => [r.user_id, r]));

  for (const u of users) {
    const pref = prefByUser[u.id];
    if (pref && pref.enabled === false) continue;
    const targetTime = (pref && pref.preferred_time) || DEFAULT_TIMES.weekly_summary;
    const targetHour = Number(targetTime.split(':')[0]);
    if (!hourInWindow(warsawNow.hour, targetHour)) continue;

    const tokens = await getTokensForUser(supabase, u.id);
    if (tokens.length === 0) continue;
    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body: 'Podsumowanie tygodnia gotowe — sprawdź postęp swoich celów w appce.',
        data: { type: 'weekly_summary' },
      });
      results.weekly_summary++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd wysyłki weekly_summary dla ${u.id}:`, e);
    }
  }
}

// ------------------------------------------------------------
// Rytm 5: contextual_insight — "system wykrył coś wartego uwagi". JEDYNY
// rytm z deduplikacją w bazie (decision_recommendations.notified_at) —
// bezpieczny do sprawdzania na KAŻDYM przebiegu (co ~2h), bez okna
// godzinowego.
// ------------------------------------------------------------
async function runContextualInsight(supabase, results) {
  const { data: recs, error } = await supabase
    .from('decision_recommendations')
    .select('id, user_id')
    .is('notified_at', null);
  if (error || !recs || recs.length === 0) return;

  const { data: prefRows } = await supabase
    .from('notification_preferences')
    .select('user_id, enabled')
    .eq('notification_type', 'contextual_insight');
  const prefByUser = Object.fromEntries((prefRows || []).map((r) => [r.user_id, r]));

  for (const rec of recs) {
    const pref = prefByUser[rec.user_id];
    if (pref && pref.enabled === false) continue;

    const tokens = await getTokensForUser(supabase, rec.user_id);
    if (tokens.length === 0) continue; // brak urządzenia — spróbuj przy kolejnym przebiegu

    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body: 'Mamy dla Ciebie nową rekomendację w Centrum Decyzji — sprawdź, co warto teraz zrobić.',
        data: { type: 'contextual_insight', recommendationId: rec.id },
      });
      const { error: updateError } = await supabase
        .from('decision_recommendations')
        .update({ notified_at: new Date().toISOString() })
        .eq('id', rec.id);
      if (updateError) {
        console.error(`cron-send-notifications: push wysłany, ale nie zaznaczono notified_at dla rekomendacji ${rec.id}:`, updateError);
      }
      results.contextual_insight++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd wysyłki contextual_insight dla ${rec.user_id}:`, e);
    }
  }
}

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { morning_readiness: 0, post_training: 0, pre_match: 0, weekly_summary: 0, contextual_insight: 0 };

  try {
    const supabase = getAdminClient();
    const warsawNow = getWarsawNow();

    await runMorningReadiness(supabase, warsawNow, results);
    await runPostTraining(supabase, warsawNow, results);
    await runPreMatch(supabase, warsawNow, results);
    await runWeeklySummary(supabase, warsawNow, results);
    await runContextualInsight(supabase, results);

    console.log('cron-send-notifications zakończony:', results);
    return res.status(200).json({ ok: true, results });
  } catch (e) {
    console.error('cron-send-notifications error:', e);
    return res.status(500).json({ ok: false, error: e.message, results });
  }
};
