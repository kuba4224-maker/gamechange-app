// ============================================================
// GAMECHANGE — lib/push-rate-limiter.js
// ============================================================
// Pakiet z KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, sekcja 5.3: "Globalny limit
// powiadomień (2/dzień między wszystkimi rytmami)". Naprawia lukę opisaną
// wprost w nagłówku cron-send-notifications.js (POPRAWKA 29.07.2026,
// akapit "Pozostała ŚWIADOMIE NIEZAIMPLEMENTOWANA część specyfikacji"):
// globalny limit "max 2 powiadomienia dziennie na zawodnika" MIĘDZY
// WSZYSTKIMI rytmami + cisza nocna 21:00-7:00 jako osobna, przekrojowa
// bramka. Ten plik to właśnie ta brakująca bramka.
//
// ⚠️ UWAGA HISTORYCZNA (03.08.2026): ten plik (i push_send_log, i test-
// push-rate-limiter.js) był już RAZ napisany i przetestowany (8/8
// scenariuszy) w sesji 01.08.2026 — ale nigdy nie trafił do Project
// Knowledge ani na dysk, więc się zgubił. To jest ODTWORZENIE od zera na
// podstawie opisu w KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, NIE odzyskanie
// oryginalnego kodu — logika powinna być równoważna, ale to nowa
// implementacja, własne testy (patrz tests/test-push-rate-limiter.js),
// nie te same 8 scenariuszy co poprzednio. Kuba: warto przejrzeć przed
// wdrożeniem na produkcję, dokładnie jak każdy inny nowy kod.
//
// DLACZEGO NIE JEST TO ROUTE HTTP W api/: ten sam powód co
// lib/focus-block-adaptation.js — wołany WYŁĄCZNIE in-process przez
// cron-send-notifications.js, więc nie liczy się do limitu 12 Serverless
// Functions na Vercel Hobby (dziś dokładnie 12/12 plików w api/,
// potwierdzone 03.08.2026 — zero marginesu na nowy plik tam).
//
// PRIORYTET MIĘDZY RYTMAMI (POTWIERDZONE przez Kubę, 01.08.2026, sekcja
// 5.3 KOLEJKA_DECYZJI): kontekstowo > przed meczem > po treningu >
// [NOWE] checkin Bloku Skupienia > rano > [NOWE] utrzymanie Bloku
// Skupienia > tygodniowo. Egzekwowany NIE przez sortowanie tutaj, tylko
// przez KOLEJNOŚĆ WYWOŁAŃ rytmów w cron-send-notifications.js — ten plik
// tylko liczy/gate'uje, nie decyduje o kolejności. Ta kolejność jest
// PRIORITY_ORDER niżej wyłącznie jako dokumentacja/do testów, nie jest
// odczytywana przez cron-send-notifications.js w runtime.
// ============================================================

const { sendPush } = require('../api/send-push');

const WARSAW_TZ = 'Europe/Warsaw';
const DAILY_PUSH_CAP = 2;
const QUIET_HOUR_START = 21; // 21:00 Warszawa — od tej godziny cisza
const QUIET_HOUR_END = 7;    // do 7:00 Warszawa (wyłącznie)

// Wyłącznie do dokumentacji/testów — patrz komentarz w nagłówku pliku.
const PRIORITY_ORDER = [
  'contextual_insight',
  'pre_match',
  'post_training',
  'focus_block_checkin',
  'morning_readiness',
  'focus_block_maintenance',
  'weekly_summary',
];

// ------------------------------------------------------------
// Cisza nocna — 21:00-7:00 czasu Warszawy, PRZEKROJOWA bramka (dotyczy
// też contextual_insight, jedynego rytmu bez okna godzinowego). `hour`
// to godzina lokalna Warszawy (ten sam kształt co warsawNow.hour w
// cron-send-notifications.js — getWarsawNow().hour).
// ------------------------------------------------------------
function isQuietHours(hour) {
  return hour >= QUIET_HOUR_START || hour < QUIET_HOUR_END;
}

// Granice "dzisiejszej" doby Warszawy jako zakres UTC ISO — do zapytania
// o "ile wysłano DZIŚ" niezależnie od tego, kiedy dokładnie w ciągu dnia
// przebiega cron. Ten sam wzorzec (Intl, nie stały offset) co
// getWarsawNow()/toWarsawDateStr() w cron-send-notifications.js, żeby DST
// nie rozjeżdżało granicy dnia.
function warsawDayBoundsUTC(dateStr) {
  // Warszawa jest UTC+1 (zima) albo UTC+2 (lato) — zamiast zgadywać offset,
  // budujemy dzień jako [dateStr 00:00 Warszawa, dateStr+1 00:00 Warszawa)
  // przez binarne domykanie z Intl: sprawdzamy kolejne minuty UTC wokół
  // przybliżonej północy i bierzemy tę, której lokalna data Warszawy
  // faktycznie zmienia się na `dateStr`. Prostsze i wystarczająco dokładne
  // podejście: użyj Intl żeby przeliczyć `dateStr 00:00:00` interpretowane
  // KOLEJNO jako UTC-1 i UTC-2, i wybierz tę wersję, której lokalna data
  // Warszawy zgadza się z dateStr.
  for (const offsetHours of [1, 2]) { // CET / CEST
    const candidateStartUTC = new Date(`${dateStr}T00:00:00.000Z`);
    candidateStartUTC.setUTCHours(candidateStartUTC.getUTCHours() - offsetHours);
    const check = new Intl.DateTimeFormat('en-GB', {
      timeZone: WARSAW_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(new Date(candidateStartUTC.getTime() + 60 * 1000)); // +1 min, żeby uniknąć granicznych zaokrągleń
    const get = (t) => check.find((p) => p.type === t)?.value;
    const localDate = `${get('year')}-${get('month')}-${get('day')}`;
    const localHour = Number(get('hour'));
    if (localDate === dateStr && localHour === 0) {
      const endUTC = new Date(candidateStartUTC.getTime() + 24 * 60 * 60 * 1000);
      return { startUTC: candidateStartUTC.toISOString(), endUTC: endUTC.toISOString() };
    }
  }
  // Awaryjnie (nie powinno się zdarzyć) — załóż CET (UTC+1).
  const fallbackStart = new Date(`${dateStr}T00:00:00.000Z`);
  fallbackStart.setUTCHours(fallbackStart.getUTCHours() - 1);
  const fallbackEnd = new Date(fallbackStart.getTime() + 24 * 60 * 60 * 1000);
  return { startUTC: fallbackStart.toISOString(), endUTC: fallbackEnd.toISOString() };
}

// ------------------------------------------------------------
// Ile powiadomień push (MIĘDZY WSZYSTKIMI rytmami) użytkownik już dostał
// w dzisiejszej dobie Warszawy.
// ------------------------------------------------------------
async function getTodaySentCount(supabase, userId, warsawDateStr) {
  const { startUTC, endUTC } = warsawDayBoundsUTC(warsawDateStr);
  const { count, error } = await supabase
    .from('push_send_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('sent_at', startUTC)
    .lt('sent_at', endUTC);
  if (error) {
    console.error('push-rate-limiter: getTodaySentCount error:', error);
    return 0; // fail-open na błąd odczytu, żeby jeden błąd bazy nie ucichł całego systemu powiadomień
  }
  return count || 0;
}

// ------------------------------------------------------------
// Decyzja "czy WOLNO wysłać" — quiet hours + limit dobowy. Czysta funkcja
// od `sentCountToday`/`hour`, żeby dało się przetestować bez bazy.
// ------------------------------------------------------------
function canSendGivenState({ hour, sentCountToday, cap = DAILY_PUSH_CAP }) {
  if (isQuietHours(hour)) return { allowed: false, reason: 'quiet_hours' };
  if (sentCountToday >= cap) return { allowed: false, reason: 'daily_cap_reached' };
  return { allowed: true };
}

async function canSend(supabase, userId, warsawNow) {
  if (isQuietHours(warsawNow.hour)) return { allowed: false, reason: 'quiet_hours' };
  const sentCountToday = await getTodaySentCount(supabase, userId, warsawNow.dateStr);
  return canSendGivenState({ hour: warsawNow.hour, sentCountToday });
}

async function recordSent(supabase, userId, notificationType, sentAtIso) {
  const { error } = await supabase
    .from('push_send_log')
    .insert({ user_id: userId, notification_type: notificationType, sent_at: sentAtIso || new Date().toISOString() });
  if (error) {
    // Push już wysłany — brak logu oznacza, że limit dobowy dla tego
    // użytkownika policzy się nieco za nisko przy KOLEJNYCH sprawdzeniach
    // (ten sam, świadomie zaakceptowany kompromis co przy notified_at w
    // rytmie contextual_insight — rzadkie, logowane, nie krytyczne).
    console.error(`push-rate-limiter: nie udało się zapisać push_send_log dla ${userId}:`, error);
  }
}

// ------------------------------------------------------------
// gatedSendPush — JEDYNA funkcja, którą powinny wołać rytmy w
// cron-send-notifications.js zamiast bezpośrednio sendPush(). Łączy
// bramkę (quiet hours + limit dobowy) + samą wysyłkę + zapis do logu w
// jednym miejscu, żeby diff w cron-send-notifications.js przy każdym
// miejscu wysyłki był minimalny (jedna linijka zamienna).
// Zwraca { sent: boolean, reason?: string }.
// ------------------------------------------------------------
async function gatedSendPush(supabase, { userId, tokens, notificationType, title, body, data, warsawNow }) {
  const gate = await canSend(supabase, userId, warsawNow);
  if (!gate.allowed) return { sent: false, reason: gate.reason };

  await sendPush(tokens, { title, body, data });
  await recordSent(supabase, userId, notificationType, new Date().toISOString());
  return { sent: true };
}

module.exports = {
  DAILY_PUSH_CAP,
  QUIET_HOUR_START,
  QUIET_HOUR_END,
  PRIORITY_ORDER,
  isQuietHours,
  warsawDayBoundsUTC,
  getTodaySentCount,
  canSendGivenState,
  canSend,
  recordSent,
  gatedSendPush,
};
