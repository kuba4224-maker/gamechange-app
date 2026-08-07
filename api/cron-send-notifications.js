// ============================================================
// GAMECHANGE — cron-send-notifications.js (do wdrożenia: /api/cron-send-notifications.js w repo gamechange-app)
// ============================================================
// TERMINARZ A7 08.08.2026 (C6-N2): JEDYNY REALNY HARMONOGRAM CAŁEGO SYSTEMU —
// PIĘTNAŚCIE rytmów w ustalonej kolejności: powiadomienia push, retencja,
// digest trenera, rotacja training focus, wygasanie triala, zgody
// rodzicielskie i raport rodzica (ostatni, bo jako jedyny wysyła pocztę
// poza system). Każdy rytm w osobnym try/catch (runda 6) — rytm, który
// padnie, nie zabiera kolejnych. Historyczna nazwa pliku
// ("send-notifications") zostaje: zmiana ścieżki = zmiana 12 wpisów crona
// w vercel.json. Pierwotny nagłówek niżej (scheduler pięciu rytmów) opisywał
// stan sprzed rund 4–6 — zostawiony jako historia:
//
// SCHEDULER dla pięciu "rytmów" powiadomień push (F15, Domena 09 —
// asystent_sportowca_09_powiadomienia.sql). Ten sam wzorzec ochrony co
// api_cron_send_parent_reports.js/api_cron_settlement.js: CRON_SECRET w
// nagłówku Authorization, Vercel Cron dołącza go automatycznie.
//
// URUCHAMIANY CO ~2H (patrz zaktualizowany asystent_vercel.json — ~12
// wpisów, każdy raz dziennie o innej stałej godzinie UTC, zgodnie z
// limitem Vercel Hobby "cron job max raz dziennie na wpis" — obejście
// przez wielość wpisów, nie przez wysoką częstotliwość jednego wpisu).
//
// RYZYKO R7 (strefa czasowa): godzina lokalna liczona WYŁĄCZNIE przez
// Intl.DateTimeFormat z timeZone: 'Europe/Warsaw' w KAŻDYM przebiegu —
// NIGDY stały offset — żeby DST (zmiana czasu) nie rozjeżdżała dopasowania
// mimo że same wpisy crona są przypięte do stałych godzin UTC.
//
// POPRAWKA 29.07.2026 (Cowork, samodzielnie, w trakcie oczekiwania na
// weryfikację FIREBASE_SERVICE_ACCOUNT_JSON) — porównanie tej pierwszej
// wersji z pełną specyfikacją treści/warunków w
// APLIKACJA_MOBILNA_CHECKLISTA_WDROZENIA.md (Krok 4.8) wykazało PIĘĆ
// realnych rozjazdów między spisanym planem a tym co faktycznie wysyłał
// ten plik — naprawione w tej wersji, każdy opisany przy odpowiednim
// rytmie niżej:
//  1. morning_readiness nie sprawdzał w ogóle, czy zawodnik już zalogował
//     dzisiejszy wpis poranny (spec: "TYLKO jeśli jeszcze nie zalogował").
//  2. Domyślna godzina rano była 08:00 zamiast spisanych 7:30.
//  3. Żaden rytm nie miał rotacji treści dnia parzysty/nieparzysty (spec
//     wprost dla rytmu 1, tu zastosowana konsekwentnie też dla rytmu 2).
//  4. pre_match wysyłał TYLKO wieczorem dnia poprzedzającego — spec chce
//     DWÓCH wysłań (też rano w dniu meczu). Drugie wysłanie brakowało
//     całkowicie.
//  5. weekly_summary nie sprawdzał aktywnego celu (spec: "tylko jeśli
//     zawodnik ma aktywny cel") i nie wstawiał nazwy celu do treści.
//  6. contextual_insight wysyłał stały, ogólny tekst zamiast treści
//     konkretnej rekomendacji (spec: pierwsze ~60 znaków + "— sprawdź
//     rekomendację") i nie miał limitu "max 1 na 3 dni" ze specyfikacji.
// Pozostała ŚWIADOMIE NIEZAIMPLEMENTOWANA część specyfikacji (opisana
// wprost w sekcji "Limity częstotliwości i cisza nocna"): globalny limit
// "max 2 powiadomienia dziennie na zawodnika" z kolejnością priorytetów
// MIĘDZY rytmami, oraz cisza nocna 21:00-7:00 jako osobna, przekrojowa
// bramka. Powód: żaden z pozostałych czterech rytmów (poza contextual_
// insight) nie zapisuje w bazie ŻADNEGO logu wysyłki (patrz punkt 4
// nagłówka Domeny 09 — świadoma decyzja tamtej sesji), więc rzetelne
// policzenie "ile powiadomień TEGO dnia już dostał" wymaga nowej tabeli
// logu wysyłek (np. push_send_log) — zmiana schematu bazy, nie tylko
// logiki aplikacji. Nie wprowadzona samodzielnie bez choćby krótkiego
// zerknięcia Kuby, żeby nie dodawać tabeli do produkcyjnej bazy po cichu.
// Do zrobienia w kolejnym kroku — patrz notatka w checkliście.
//
// WDROŻONE: 29.07.2026, przez Cowork samodzielnie w przeglądarce (GitHub).
//
// ROZSZERZENIE 31.07.2026 (noc, Krok 5b, Blok Skupienia — Prowadzenie):
// dopisane trzy nowe rytmy (6, 7, 8) — focus_block_checkins (pytania
// kontrolne co ~14 dni), focus_block_maintenance (sprawdzenia Fazy 4 co
// ~45 dni dla zamkniętych bloków), focus_block_adaptation (adaptacja po
// sygnale bólu/zmęczenia, deterministyczna, bez AI, patrz
// lib/focus-block-adaptation.js). Zależność: tabela focus_block_checkins
// i kolumny last_content_dose_stage/last_content_dose_at/last_adaptation_at
// na focus_blocks (migracja SQL #3, claude/SQL_3_INSTRUKCJE_KROK5B_31_07_2026_NOC.md
// w Project Knowledge) MUSZĄ być uruchomione, inaczej te trzy rytmy będą
// się wywalać (catch per-blok, nie przerywa reszty crona, ale nic nie
// wyśle dopóki tabela nie istnieje).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { sendPush, verifyFirebaseConfig } = require('./send-push');
const { runFocusBlockAdaptation } = require('../lib/focus-block-adaptation');
const { stripeRequest } = require('../lib/stripe-client');
const { runCoachDigestCheck } = require('../lib/coach-digest');
// NAPRAWA 04.08.2026 (znalezisko z sesji Pakietu 19, patrz
// claude/DO_ZROBIENIA_PRZEZ_KUBE.md, Pakiet 19) — te dwie funkcje miały gotowy,
// przetestowany kod (Pakiety 1/2) od 03.08.2026, ale NIGDY nie były zaimportowane
// ani wołane w tym dyspozytorze — przypomnienia o powrocie i rotacja
// training_focus najpewniej nigdy faktycznie nie wystrzeliły na produkcji.
const { runRetentionCheck } = require('../lib/retention-check');
const { runTrainingFocusRotation } = require('../lib/training-focus-rotation');
// NOWE 05.08.2026 — Pakiet 20 ("Raporty w wybranych momentach"). ODTWORZONE:
// ten require + wywołanie w dyspozytorze niżej zniknęły z dysku razem z
// lib/coach-scheduled-reports.js samym — patrz nagłówek tamtego pliku po
// pełne wyjaśnienie (ZADANIE 3, weryfikacja Pakietu 20).
const { runCoachScheduledReportsCheck } = require('../lib/coach-scheduled-reports');
// ZRODLO C5 08.08.2026 — RAPORT RODZICA WCHODZI DO DYSPOZYTORA.
// Znalezisko C4-N4: api/cron-send-parent-reports.js NIGDY nie był wpisany
// do vercel.json, więc cały mechanizm raportu dla rodzica — wzbogacony
// w rundzie 4 o wskazówki z materiałów, trzy uczciwe stany pustki
// i porównanie z poprzednim raportem — po prostu się nie uruchamiał.
// To ten sam wzorzec, przez który runRetentionCheck i runTrainingFocusRotation
// przeleżały dwa dni z gotowym, przetestowanym kodem (naprawa 04.08.2026,
// osiem linijek wyżej) — i to samo lekarstwo.
//
// DLACZEGO TUTAJ, A NIE CZTERNASTYM WPISEM W vercel.json: plik ma już 13
// zadań, a plan Vercel Hobby ma limit, co do którego audyt po bloku 4
// (pozycja M4) podejrzewa, że jest po cichu przycinany. Dokładanie
// czternastego wpisu do listy, która może być obcinana bez ostrzeżenia,
// naprawiałoby cichy brak innym cichym brakiem. Dyspozytor ma 12 pewnych
// wpisów co ~2h — raport rodzica dostaje 12 szans dziennie zamiast zera,
// a bramką pozostaje last_sent_at + PARENT_REPORT_INTERVAL_DAYS (30, bez
// zmian), więc częstsze uruchamianie NIE znaczy częstszej wysyłki.
// Dokładnie ta sama własność, na której stoją runRetentionCheck
// (deduplikacja przez retention_reminder_log) i runCoachDigestCheck.
const { runParentReportsCheck } = require('../lib/parent-reports');

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
// notification_preferences — POPRAWIONE 29.07.2026, dokładnie zgodne z
// APLIKACJA_MOBILNA_CHECKLISTA_WDROZENIA.md (Krok 4.8): rano 7:30 (było
// błędnie 08:00), tygodniowo niedziela 18:00 (było błędnie 19:00).
const DEFAULT_TIMES = {
  morning_readiness: '07:30',
  weekly_summary: '18:00',
};
// Rytmy zdarzeniowe (patrz punkt 4 nagłówka Domeny 09) — każdy trafia w
// JEDNO stałe okno 2h dziennie, żeby uniknąć duplikatów bez nowego logu
// w bazie. POST_TRAINING_WINDOW_HOUR: uwaga, spec mówi "90 minut po
// zaplanowanym końcu treningu", ale calendar_events (Domena 07) NIE
// przechowuje żadnej godziny wydarzenia, tylko datę — więc dokładny
// czas końca treningu nie istnieje w dzisiejszym schemacie do policzenia
// "+90 minut". Świadome, udokumentowane tu wprost (nie było wcześniej)
// przybliżenie: stałe okno wieczorne, ten sam kompromis co przy pre_match
// (żadny dzisiejszy frontend i tak nie tworzy wydarzeń z godziną).
const POST_TRAINING_WINDOW_HOUR = 19; // wieczorem, po typowych treningach
const PRE_MATCH_EVENING_WINDOW_HOUR = 19; // wieczorem, dzień przed meczem
const PRE_MATCH_MORNING_WINDOW_HOUR = 7;  // NOWE 29.07.2026 — rano, w dniu meczu (spec: "dwa wysłania")
const WEEKLY_SUMMARY_WEEKDAY = 0;     // 0 = niedziela
const CONTEXTUAL_INSIGHT_MIN_GAP_DAYS = 3; // NOWE 29.07.2026 — spec: "max 1 na 3 dni"

// NOWE 31.07.2026 (Krok 5b) — okna/interwały dla rytmów Bloku Skupienia.
const FOCUS_BLOCK_CHECKIN_INTERVAL_DAYS = 14;   // Faza 2a: co ~2 tygodnie
const FOCUS_BLOCK_CHECKIN_WINDOW_HOUR = 10;     // stałe okno rano
// DYSPOZYTOR C6 08.08.2026 — dopisek do pusha rytmu 6, gdy w TEJ turze
// powstała nowa dawka treści (znalezisko A28/M12). Od rundy 5 dawka
// FAKTYCZNIE ląduje w bazie, ale push mówił wyłącznie pytanie kontrolne —
// zawodnik nie miał żadnego powodu, żeby zajrzeć do Bloku po treść, o której
// nie wiedział. Zbudowana rzecz, o której odbiorca nie wie, to ta sama klasa
// braku co rzecz niezbudowana (reguła R1).
// BRZMIENIE (test 15-latka): bez „dawka" (brzmi jak lekarstwo), bez
// „materiał"/„treść" (brzmi jak szkoła), bez wykrzyknika. Separator „ · "
// to ten sam znak, którym appka oddziela źródło od treści w Bloku
// („Z materiałów Gamechange · Moc, s. 8") — więc zawodnik już go zna.
// Jedno zdanie, bo push i tak zostaje przycięty na liście powiadomień.
const NOWA_DAWKA_DOPISEK = ' · Jest nowa porcja wiedzy w Twoim Bloku.';
const FOCUS_BLOCK_MAINTENANCE_INTERVAL_DAYS = 45; // Faza 4: "rzadkie" sprawdzanie, ~1.5 miesiąca
const FOCUS_BLOCK_MAINTENANCE_WINDOW_HOUR = 10;

// NOWE 04.08.2026 — Komponent C integracji Stripe (K2). Patrz komentarz
// przy runTrialExpiry() niżej.
const TRIAL_EXPIRY_WINDOW_HOUR = 4;

// Etykiety segmentów do wstawienia w treść weekly_summary ("z celem
// [nazwa]") — zweryfikowane wprost z SEGMENT_NAME_TO_ID w
// claude/guided_match.html/index.html (Project Knowledge), NIE zgadywane
// z pamięci. `segments` w bazie (Domena 00) przechowuje tylko krótki
// techniczny `id` (np. "techFund"), bez osobnej kolumny z ładną nazwą —
// stąd mapowanie trzyma się tutaj, tak jak SEGMENT_TO_CATEGORY_CHRONIC
// w guided_match.html trzyma podobne mapowanie lokalnie zamiast w bazie.
const SEGMENT_DISPLAY_NAME = {
  moc: 'Moc',
  wytrzymalosc: 'Wytrzymałość',
  fizycznosc: 'Fizyczność',
  techFund: 'Technika fundamentalna',
  techSpec: 'Technika specjalistyczna',
  tolerancja: 'Tolerancja obciążeń',
  regeneracja: 'Regeneracja',
  odpornosc: 'Odporność organizmu',
  odzywianie: 'Odżywienie organizmu',
  koncentracja: 'Koncentracja',
  mental: 'Stan mentalny',
  percepcja: 'Percepcja',
  decyzja: 'Szybkość decyzji',
};

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
  const day = Number(get('day'));
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`; // lokalna data Warszawy, YYYY-MM-DD
  const weekdayShort = get('weekday'); // 'Mon'..'Sun'
  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, minute, day, dateStr, weekday: WEEKDAY_INDEX[weekdayShort] };
}

// Data (YYYY-MM-DD) danego momentu w czasie Warszawy — do porównywania
// "czy ten wpis dziennika powstał dzisiaj", tą samą metodą (Intl, nie
// stały offset) co getWarsawNow(), żeby DST nie rozjeżdżało porównania.
function toWarsawDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: WARSAW_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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

// NOWE 29.07.2026 — brakująca część specyfikacji rytmu 1: "TYLKO jeśli
// zawodnik jeszcze nie zalogował dzisiejszego wpisu porannego". Pobiera
// kilka ostatnich wpisów typu 'morning' i sprawdza, czy któryś powstał
// w dzisiejszej dacie Warszawy (limit 3 jako margines na wpisy tuż koło
// północy, gdzie kolejność created_at i data lokalna mogłyby się minąć).
async function hasLoggedMorningToday(supabase, userId, warsawNow) {
  const { data, error } = await supabase
    .from('daily_logs')
    .select('created_at')
    .eq('user_id', userId)
    .eq('entry_type', 'morning')
    .order('created_at', { ascending: false })
    .limit(3);
  if (error || !data) return false;
  return data.some((row) => toWarsawDateStr(new Date(row.created_at)) === warsawNow.dateStr);
}

// ------------------------------------------------------------
// Rytm 1: morning_readiness — "rano, sprawdź gotowość". Zegarowy,
// per-użytkownik przez notification_preferences.preferred_time.
// POPRAWIONE 29.07.2026: dodany warunek "jeszcze nie zalogował dziś" +
// rotacja treści wg parzystości dnia miesiąca, dokładnie jak w spec.
// ------------------------------------------------------------
async function runMorningReadiness(supabase, warsawNow, results) {
  const { data: users, error } = await supabase.from('users').select('id');
  if (error || !users) { console.error('cron-send-notifications: błąd pobierania users (morning_readiness):', error); return; }

  const { data: prefRows } = await supabase
    .from('notification_preferences')
    .select('user_id, enabled, preferred_time')
    .eq('notification_type', 'morning_readiness');
  const prefByUser = Object.fromEntries((prefRows || []).map((r) => [r.user_id, r]));

  const body = warsawNow.day % 2 === 0
    ? 'Nowy dzień. Zaznacz jak spałeś i jak się czujesz.'
    : 'Jak się dziś czujesz? Sprawdź gotowość, zajmie chwilę.';

  for (const u of users) {
    const pref = prefByUser[u.id];
    if (pref && pref.enabled === false) continue; // jawnie wyłączone
    const targetTime = (pref && pref.preferred_time) || DEFAULT_TIMES.morning_readiness;
    const targetHour = Number(targetTime.split(':')[0]);
    if (!hourInWindow(warsawNow.hour, targetHour)) continue;

    if (await hasLoggedMorningToday(supabase, u.id, warsawNow)) continue; // już zalogowane dziś — nie nagabuj

    const tokens = await getTokensForUser(supabase, u.id);
    if (tokens.length === 0) continue;
    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body,
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
// Dzienniku (test "wykonano" = istnienie daily_logs.calendar_event_id
// wskazującego na to wydarzenie). Świadomie POMIJA 'task' (nie trening)
// i 'match' (osobny rytm pre_match, nie post_training).
// POPRAWIONE 29.07.2026: rotacja treści (ten sam wzorzec co rytm 1 —
// spec tego wprost nie wymaga tylko dla tego rytmu, ale motywacja
// "żeby nie nudziło" z rytmu 1 stosuje się identycznie tutaj).
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

  const body = warsawNow.day % 2 === 0
    ? 'Jak poszła dzisiejsza sesja? Zaloguj na gorąco.'
    : 'Trening za Tobą? Zapisz jak poszedł, zanim zapomnisz szczegóły.';

  for (const ev of events) {
    if (loggedEventIds.has(ev.id)) continue; // już zalogowane
    const pref = prefByUser[ev.user_id];
    if (pref && pref.enabled === false) continue;

    const tokens = await getTokensForUser(supabase, ev.user_id);
    if (tokens.length === 0) continue;
    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body,
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
// Zdarzeniowy, DWA wysłania (spec, POPRAWIONE 29.07.2026 — wcześniej
// istniało tylko pierwsze z nich):
//   (a) wieczorem dnia poprzedzającego — jutrzejsze event_type='match'
//   (b) rano w dniu meczu (NOWE) — dzisiejsze event_type='match'
// UWAGA (bez zmian): dziś żaden frontend nie tworzy wydarzeń
// event_type='match' — ta funkcja jest gotowa, ale realnie nieaktywna,
// dopóki ta luka nie zostanie zamknięta gdzie indziej.
// ------------------------------------------------------------
async function sendPreMatchForDate(supabase, targetDateStr, bodyText, resultsKeyLabel, results) {
  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('id, user_id')
    .eq('status', 'scheduled')
    .eq('scheduled_date', targetDateStr)
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
        body: bodyText,
        data: { type: 'pre_match', calendarEventId: ev.id },
      });
      results.pre_match++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd wysyłki pre_match (${resultsKeyLabel}) dla ${ev.user_id}:`, e);
    }
  }
}

async function runPreMatch(supabase, warsawNow, results) {
  // (a) wieczorem dnia poprzedzającego — dotyczy JUTRZEJSZEGO meczu
  if (hourInWindow(warsawNow.hour, PRE_MATCH_EVENING_WINDOW_HOUR)) {
    const tomorrow = new Date(`${warsawNow.dateStr}T00:00:00`);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getDate()).padStart(2, '0');
    await sendPreMatchForDate(
      supabase, `${y}-${m}-${d}`,
      'Jutro grasz. Zajrzyj do trybu meczowego, zanim wyjdziesz z domu.',
      'wieczór przed', results
    );
  }

  // (b) NOWE 29.07.2026 — rano, w dniu meczu (dotyczy DZISIEJSZEGO meczu)
  if (hourInWindow(warsawNow.hour, PRE_MATCH_MORNING_WINDOW_HOUR)) {
    await sendPreMatchForDate(
      supabase, warsawNow.dateStr,
      'Dziś mecz. Sprawdź check-in meczowy.',
      'rano w dniu', results
    );
  }
}

// ------------------------------------------------------------
// Rytm 4: weekly_summary — "tygodniowo, podsumowanie postępu celów".
// Dzień ustalony na sztywno (niedziela), godzina per-użytkownik jak w
// morning_readiness. POPRAWIONE 29.07.2026: dodany warunek "tylko jeśli
// zawodnik ma aktywny cel" + wstawienie nazwy celu do treści, dokładnie
// jak w spec ("Zobacz jak poszło z celem [nazwa]").
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

    // Aktywny cel zawodnika — priorytetowy, jeśli jest; w innym razie
    // najnowszy aktywny. Brak żadnego aktywnego celu = pomiń (spec).
    const { data: goals } = await supabase
      .from('goals')
      .select('segment_id, is_priority, created_at')
      .eq('user_id', u.id)
      .eq('status', 'active')
      .order('is_priority', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);
    if (!goals || goals.length === 0) continue; // brak aktywnego celu — podsumowanie byłoby puste

    const goalName = SEGMENT_DISPLAY_NAME[goals[0].segment_id] || goals[0].segment_id;

    const tokens = await getTokensForUser(supabase, u.id);
    if (tokens.length === 0) continue;
    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body: `Twój tydzień w liczbach czeka. Zobacz jak poszło z celem ${goalName}.`,
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
// godzinowego. POPRAWIONE 29.07.2026: treść buduje się teraz z
// rzeczywistej rekomendacji (pierwsze ~60 znaków, jak w spec) zamiast
// stałego ogólnego tekstu; dodany limit "max 1 na 3 dni na zawodnika"
// (spec) — sprawdzany przez najnowsze notified_at TEGO użytkownika w
// całej tabeli, plus lokalny licznik w ramach jednego przebiegu, żeby
// dwie nowe rekomendacje tego samego zawodnika w jednym przebiegu nie
// wysłały dwóch push'ów naraz.
// ------------------------------------------------------------
async function runContextualInsight(supabase, results) {
  const { data: recs, error } = await supabase
    .from('decision_recommendations')
    .select('id, user_id, recommendation_text')
    .is('notified_at', null)
    .order('created_at', { ascending: true });
  if (error || !recs || recs.length === 0) return;

  const { data: prefRows } = await supabase
    .from('notification_preferences')
    .select('user_id, enabled')
    .eq('notification_type', 'contextual_insight');
  const prefByUser = Object.fromEntries((prefRows || []).map((r) => [r.user_id, r]));

  const gapThreshold = new Date(Date.now() - CONTEXTUAL_INSIGHT_MIN_GAP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentlyNotified } = await supabase
    .from('decision_recommendations')
    .select('user_id')
    .not('notified_at', 'is', null)
    .gte('notified_at', gapThreshold);
  const recentlyNotifiedUsers = new Set((recentlyNotified || []).map((r) => r.user_id));
  const sentThisRun = new Set();

  for (const rec of recs) {
    const pref = prefByUser[rec.user_id];
    if (pref && pref.enabled === false) continue;
    if (recentlyNotifiedUsers.has(rec.user_id) || sentThisRun.has(rec.user_id)) continue; // limit: max 1 / 3 dni

    const tokens = await getTokensForUser(supabase, rec.user_id);
    if (tokens.length === 0) continue; // brak urządzenia — spróbuj przy kolejnym przebiegu

    const raw = (rec.recommendation_text || '').trim();
    const snippet = raw.slice(0, 60);
    const body = `${snippet}${raw.length > 60 ? '…' : ''} — sprawdź rekomendację`;

    try {
      await sendPush(tokens, {
        title: 'Gamechange',
        body,
        data: { type: 'contextual_insight', recommendationId: rec.id },
      });
      const { error: updateError } = await supabase
        .from('decision_recommendations')
        .update({ notified_at: new Date().toISOString() })
        .eq('id', rec.id);
      if (updateError) {
        console.error(`cron-send-notifications: push wysłany, ale nie zaznaczono notified_at dla rekomendacji ${rec.id}:`, updateError);
      }
      sentThisRun.add(rec.user_id);
      results.contextual_insight++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd wysyłki contextual_insight dla ${rec.user_id}:`, e);
    }
  }
}

// ------------------------------------------------------------
// Rytm 6: focus_block_checkins — Faza 2a Bloku Skupienia. Co ~14 dni na
// aktywny blok generuje pytanie kontrolne (i ewentualną dawkę treści,
// Faza 2b) przez api/generate-focus-block-content.js (action: 'checkin'),
// zapisuje wiersz w focus_block_checkins, wysyła push.
// NOWE 31.07.2026 (Krok 5b).
// ------------------------------------------------------------
async function runFocusBlockCheckins(supabase, warsawNow, results) {
  if (!hourInWindow(warsawNow.hour, FOCUS_BLOCK_CHECKIN_WINDOW_HOUR)) return;

  const { data: blocks, error } = await supabase
    .from('focus_blocks')
    .select('id, user_id, started_at')
    .eq('status', 'active');
  if (error || !blocks || blocks.length === 0) return;

  const { generateCheckin } = require('./generate-focus-block-content')._internal;

  for (const block of blocks) {
    try {
      const { data: lastCheckin } = await supabase
        .from('focus_block_checkins')
        .select('asked_at')
        .eq('focus_block_id', block.id)
        .eq('checkin_type', 'progress')
        .order('asked_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const sinceRef = lastCheckin ? new Date(lastCheckin.asked_at) : new Date(block.started_at);
      const daysSince = (Date.now() - sinceRef.getTime()) / (24 * 60 * 60 * 1000);
      if (daysSince < FOCUS_BLOCK_CHECKIN_INTERVAL_DAYS) continue;

      const generated = await generateCheckin({ focusBlockId: block.id });
      if (!generated.ok) continue;

      const { data: inserted, error: insertError } = await supabase
        .from('focus_block_checkins')
        .insert({ focus_block_id: block.id, checkin_type: 'progress', question_text: generated.question })
        .select('id')
        .single();
      if (insertError) {
        console.error('cron-send-notifications: runFocusBlockCheckins insert error:', insertError);
        continue;
      }

      if (generated.contentDose) {
        await supabase.from('focus_blocks')
          .update({ last_content_dose_stage: generated.stageAtDose, last_content_dose_at: new Date().toISOString() })
          .eq('id', block.id);
      }

      const tokens = await getTokensForUser(supabase, block.user_id);
      if (tokens.length === 0) continue;
      // DYSPOZYTOR C6 08.08.2026 — push mówi, że przyszła nowa porcja wiedzy.
      // Czytamy TĘ SAMĄ `generated.contentDose`, którą kilka linii wyżej
      // czyta zegar kadencji (`last_content_dose_at`) — świadomie ten sam
      // warunek, nie osobny: kontrakt pasa A z rundy 5 mówi, że
      // `contentDose === true` znaczy „w TEJ turze powstała NOWA dawka",
      // a nie „blok ma jakąś dawkę". Gdyby dopisek jechał na innym warunku,
      // zawodnik dostawałby zaproszenie do treści, której już dawno nie ma
      // po co szukać. Zegar kadencji jest NIETKNIĘTY — to tylko odczyt.
      // Bez dawki `body` jest co do znaku takie, jak przed tą rundą.
      const bodyPusha = generated.contentDose
        ? `${generated.question}${NOWA_DAWKA_DOPISEK}`
        : generated.question;
      await sendPush(tokens, {
        title: 'Gamechange',
        body: bodyPusha,
        data: { type: 'focus_block_checkin', focusBlockId: block.id, checkinId: inserted.id },
      });
      results.focus_block_checkins++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd runFocusBlockCheckins dla bloku ${block.id}:`, e);
    }
  }
}

// ------------------------------------------------------------
// Rytm 7: focus_block_maintenance — Faza 4 Bloku Skupienia. Dla ZAMKNIĘTYCH
// (status='completed') bloków, rzadkie (co ~45 dni) sprawdzenie czy element
// nadal jest opanowany. Pytanie stałe (BEZ AI — prosty, przewidywalny tekst,
// nie wymaga wywołania Anthropic dla czegoś tak prostego).
// NOWE 31.07.2026 (Krok 5b).
// ------------------------------------------------------------
async function runFocusBlockMaintenance(supabase, warsawNow, results) {
  if (!hourInWindow(warsawNow.hour, FOCUS_BLOCK_MAINTENANCE_WINDOW_HOUR)) return;

  const { data: blocks, error } = await supabase
    .from('focus_blocks')
    .select('id, user_id, segment_id, closed_at')
    .eq('status', 'completed');
  if (error || !blocks || blocks.length === 0) return;

  for (const block of blocks) {
    if (!block.closed_at) continue;
    try {
      const { data: lastCheckin } = await supabase
        .from('focus_block_checkins')
        .select('asked_at')
        .eq('focus_block_id', block.id)
        .eq('checkin_type', 'maintenance')
        .order('asked_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const sinceRef = lastCheckin ? new Date(lastCheckin.asked_at) : new Date(block.closed_at);
      const daysSince = (Date.now() - sinceRef.getTime()) / (24 * 60 * 60 * 1000);
      if (daysSince < FOCUS_BLOCK_MAINTENANCE_INTERVAL_DAYS) continue;

      const elementLabel = SEGMENT_DISPLAY_NAME[block.segment_id] || block.segment_id;
      const questionText = `Czy nadal czujesz się pewnie w elemencie z Twojego zamkniętego Bloku Skupienia (${elementLabel})?`;

      const { data: inserted, error: insertError } = await supabase
        .from('focus_block_checkins')
        .insert({ focus_block_id: block.id, checkin_type: 'maintenance', question_text: questionText })
        .select('id')
        .single();
      if (insertError) {
        console.error('cron-send-notifications: runFocusBlockMaintenance insert error:', insertError);
        continue;
      }

      const tokens = await getTokensForUser(supabase, block.user_id);
      if (tokens.length === 0) continue;
      await sendPush(tokens, {
        title: 'Gamechange',
        body: questionText,
        data: { type: 'focus_block_maintenance', focusBlockId: block.id, checkinId: inserted.id },
      });
      results.focus_block_maintenance++;
    } catch (e) {
      console.error(`cron-send-notifications: błąd runFocusBlockMaintenance dla bloku ${block.id}:`, e);
    }
  }
}

// ------------------------------------------------------------
// NOWE 04.08.2026 — Komponent C integracji Stripe (K2, AUDYT SPOJNOSCI
// CALEGO PROJEKTU.md). Trial NIE tworzy żadnego obiektu w Stripe (patrz
// api/stripe-checkout.js, Komponent A) — więc webhook Stripe nigdy sam nie
// dowie się, że ktoś po prostu przestał korzystać i nigdy nie kliknął
// "przejdź na płatną wersję" (nie ma czego nasłuchiwać). Ten rytm to
// jedyny mechanizm, który to zamyka: sprawdza, czy status='trialing' i
// current_period_end już minął — jeśli tak, ustawia status='expired' (ten
// sam skutek dostępowy co anulowanie). Bez tego ktoś z wygasłym trialem
// zachowałby pełny dostęp bezterminowo, bo nic nigdy formalnie by tego nie
// zamknęło. Operacja idempotentna (UPDATE po warunku, nie po id) — bezpieczna
// przy wielokrotnym uruchomieniu w tym samym oknie.
// ------------------------------------------------------------
async function runTrialExpiry(supabase, warsawNow, results) {
  if (!hourInWindow(warsawNow.hour, TRIAL_EXPIRY_WINDOW_HOUR)) return;

  const { data: expired, error } = await supabase
    .from('subscriptions')
    .update({ status: 'expired' })
    .eq('status', 'trialing')
    .lt('current_period_end', new Date().toISOString())
    .select('id');
  if (error) {
    console.error('cron-send-notifications: runTrialExpiry error:', error);
    return;
  }
  results.trial_expiry = (expired || []).length;
}

// ------------------------------------------------------------
// NOWE 04.08.2026 — zgoda rodzica na płatność dla niepełnoletnich (patrz
// lib/parental-payment-consent.js, api/stripe-checkout.js i
// KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md sekcja 2.5). Ten rytm zamyka DWA
// przypadki, oba wymagające tego samego rezultatu po stronie Stripe
// (anulowanie subskrypcji + próba zwrotu ostatniej opłaty):
//   (a) status='pending' i termin (expires_at) już minął — rodzic nigdy nie
//       odpowiedział.
//   (b) status='declined' — rodzic świadomie kliknął "Nie wyrażam zgody"
//       (RPC respond_payment_parental_consent w SQL już wtedy ustawiło
//       subscriptions.status='expired' NATYCHMIAST, ale nie mogło samo
//       wywołać Stripe REST API z poziomu Postgresa — stąd dokończenie tu).
// Kolumna `stripe_action_completed_at` (nie `status`) jest tym, co ten rytm
// sprawdza, żeby uniknąć podwójnego przetworzenia — rozdziela "co widzi
// zawodnik/rodzic" (status) od "czy Stripe-owa strona sprzątania już się
// wykonała" (osobny znacznik czasu), zgodnie z tym samym wzorcem
// idempotentności co reszta tego pliku (UPDATE po warunku, nie po id).
//
// ⚠️ Zwrot pieniędzy to jedyna operacja w całym tym projekcie, która
// realnie rusza czyimiś finansami automatycznie — dlatego świadomie
// NIGDY nie przerywa się w połowie: anulowanie subskrypcji i próba zwrotu
// są w osobnych blokach try/catch, a każdy krok zostaje odnotowany w
// `refund_note` (odczytywalne przez Kubę w Table Editorze), zamiast cicho
// połykać błąd. Zalecany JEDEN, realny test end-to-end na testowej
// płatności (Stripe test mode) przed pierwszym prawdziwym niepełnoletnim
// klientem — patrz DO_ZROBIENIA_PRZEZ_KUBE.md.
// ------------------------------------------------------------
async function runParentalConsentExpiry(supabase, results) {
  const nowIso = new Date().toISOString();

  const { data: timedOut, error: timeoutError } = await supabase
    .from('payment_parental_consents')
    .select('id, user_id, stripe_subscription_id, status')
    .is('stripe_action_completed_at', null)
    .eq('status', 'pending')
    .lt('expires_at', nowIso);
  if (timeoutError) {
    console.error('cron-send-notifications: runParentalConsentExpiry (timeout fetch) error:', timeoutError);
    return;
  }

  // Wygasłe bez odpowiedzi → oznacz jako 'expired' PRZED sprzątaniem w Stripe
  // (ten sam powód co runTrialExpiry: dostęp ma się skończyć niezależnie od
  // tego, czy sam Stripe zdąży odpowiedzieć na czas).
  const timedOutIds = (timedOut || []).map(r => r.id);
  if (timedOutIds.length > 0) {
    const { error: markExpiredError } = await supabase
      .from('payment_parental_consents')
      .update({ status: 'expired' })
      .in('id', timedOutIds);
    if (markExpiredError) {
      console.error('cron-send-notifications: runParentalConsentExpiry (mark expired) error:', markExpiredError);
    }
    const { error: subExpireError } = await supabase
      .from('subscriptions')
      .update({ status: 'expired' })
      .in('subscriber_user_id', timedOut.map(r => r.user_id));
    if (subExpireError) {
      console.error('cron-send-notifications: runParentalConsentExpiry (subscriptions expire) error:', subExpireError);
    }
  }

  const { data: declined, error: declinedError } = await supabase
    .from('payment_parental_consents')
    .select('id, user_id, stripe_subscription_id, status')
    .is('stripe_action_completed_at', null)
    .eq('status', 'declined');
  if (declinedError) {
    console.error('cron-send-notifications: runParentalConsentExpiry (declined fetch) error:', declinedError);
  }

  const toProcess = [...(timedOut || []), ...(declined || [])];
  results.parental_consent_expiry = 0;

  for (const row of toProcess) {
    let refundNote = '';
    try {
      if (row.stripe_subscription_id) {
        try {
          await stripeRequest(`subscriptions/${row.stripe_subscription_id}`, {}, 'DELETE');
        } catch (cancelErr) {
          refundNote += `Anulowanie subskrypcji nieudane: ${cancelErr.message}. `;
        }

        // Najprostszy, wystarczająco niezawodny sposób znalezienia "ostatniej
        // opłaty do zwrotu" bez zagnieżdżonego expand: subskrypcja ma
        // customer.id (potrzebny osobny odczyt, bo nie trzymamy customer_id
        // na wierszu payment_parental_consents) — patrz niżej.
        try {
          const { data: subRow } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('stripe_subscription_id', row.stripe_subscription_id)
            .maybeSingle();
          const customerId = subRow && subRow.stripe_customer_id;
          if (customerId) {
            const charges = await stripeRequest('charges', { customer: customerId, limit: '1' }, 'GET');
            const latestCharge = charges && charges.data && charges.data[0];
            if (latestCharge && latestCharge.refunded === false) {
              await stripeRequest('refunds', { charge: latestCharge.id }, 'POST');
              refundNote += `Zwrot wykonany automatycznie dla charge ${latestCharge.id}.`;
            } else if (latestCharge) {
              refundNote += `Ostatnia opłata (${latestCharge.id}) już wcześniej zwrócona/oznaczona — pominięto.`;
            } else {
              refundNote += 'Nie znaleziono żadnej opłaty do zwrotu (możliwe, że trial nigdy nie przeszedł w płatność).';
            }
          } else {
            refundNote += 'Brak stripe_customer_id — zwrot NIE wykonany automatycznie, sprawdź ręcznie w Stripe Dashboard.';
          }
        } catch (refundErr) {
          refundNote += `Próba zwrotu nieudana: ${refundErr.message} — sprawdź ręcznie w Stripe Dashboard.`;
        }
      } else {
        refundNote = 'Brak stripe_subscription_id na tym wierszu — nic nie było do anulowania/zwrotu (płatność mogła nigdy nie dojść do skutku).';
      }

      await supabase
        .from('payment_parental_consents')
        .update({ stripe_action_completed_at: new Date().toISOString(), refund_note: refundNote })
        .eq('id', row.id);
      results.parental_consent_expiry++;
    } catch (e) {
      console.error(`cron-send-notifications: runParentalConsentExpiry błąd dla wiersza ${row.id}:`, e);
    }
  }
}

// ------------------------------------------------------------
// DYSPOZYTOR C6 08.08.2026 — IZOLACJA RYTMÓW.
//
// PROBLEM, KTÓRY TO ZAMYKA (znalezisko C5-N4): do tej rundy piętnaście
// rytmów stało w JEDNYM `try`. Rytm, który rzucił wyjątkiem, zabierał ze
// sobą WSZYSTKIE NASTĘPNE w kolejce — a odpowiedź crona nie mówiła, że
// coś się nie wykonało: mówiła tylko `ok:false` i komunikat pierwszego
// błędu. Czyli awaria rytmu 3 wyglądała identycznie jak awaria całego
// dyspozytora, a dwanaście rytmów po nim milczało. To jest „cichy brak"
// na poziomie harmonogramu — dokładnie ten wzorzec, przez który raport
// rodzica przeleżał całą rundę z gotowym, przetestowanym kodem.
//
// CO SIĘ ZMIENIA: każdy z piętnastu rytmów ma własny `try/catch`. Rytm,
// który rzuci, dostaje `results.<klucz>_error` z komunikatem, a kolejka
// idzie dalej. Kolejność 1–15 NIETKNIĘTA (raport rodzica nadal ostatni —
// jako jedyny wysyła pocztę do osób spoza systemu).
//
// CZEGO TO NIE ZMIENIA: przy przebiegu bez wyjątków odpowiedź jest
// IDENTYCZNA co do znaku z tą sprzed tej rundy — żaden klucz `_error`
// nie powstaje, `results` ma dokładnie te same 19 pól, status 200,
// `ok:true`. Zmienia się WYŁĄCZNIE los wyjątku. Osiem starszych funkcji
// nie jest tej rundy — są OPAKOWANE, nie naprawiane.
//
// DLACZEGO NADAL 500, A NIE 200, GDY COŚ PADŁO: 500 to jedyny sygnał,
// który widać w panelu Vercela bez otwierania treści odpowiedzi.
// Zwrócenie 200 przy padniętym rytmie zamieniłoby jeden cichy brak na
// drugi: kolejka by dokończyła, ale w dashboardzie byłoby zielono.
// Kod statusu zostaje więc dokładnie taki, jaki był („gdzieś poleciał
// wyjątek → 500"); zmienia się to, że przed zwróceniem 500 pozostałe
// rytmy zdążyły zrobić swoje, i to, że odpowiedź mówi KTÓRE padły.
// Ponowne uruchomienie jest bezpieczne z tej samej własności, na której
// stoi cały ten plik: każdy rytm ma własną bramkę (okno godzinowe,
// `last_sent_at`, log deduplikacji), więc dyspozytor jest wołany 12x
// dziennie i trzynaste wywołanie niczego nie dubluje.
// ------------------------------------------------------------
function zapiszBladRytmu(results, klucz, nazwaFunkcji, e) {
  // Do odpowiedzi HTTP idzie WYŁĄCZNIE `e.message` — nigdy `e.stack`.
  // Stack ma trafić do logu Vercela (linia niżej), gdzie jest przydatny,
  // a nie do treści odpowiedzi endpointu chronionego jednym sekretem.
  results[`${klucz}_error`] = (e && e.message) ? e.message : String(e);
  console.error(`cron-send-notifications: rytm ${nazwaFunkcji} (${klucz}) rzucił wyjątkiem — kolejka idzie dalej:`, e);
}

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = {
    morning_readiness: 0, post_training: 0, pre_match: 0, weekly_summary: 0, contextual_insight: 0,
    focus_block_checkins: 0, focus_block_maintenance: 0, focus_block_adaptation: 0,
    trial_expiry: 0, parental_consent_expiry: 0, coach_digest: 0,
    retention_check: 0, training_focus_rotation: 0,
    coach_scheduled_reports: 0,
    // ZRODLO C5 08.08.2026 — pięć liczników raportu rodzica. Świadomie
    // PIĘĆ, nie jeden: cztery pozostałe to zabezpieczenie „niecichego
    // braku" z rundy 4 (reguła R5) i zniknęłyby, gdyby spłaszczyć je do
    // samego `parent_reports`. `parent_reports_missing_extras` równe
    // liczbie wysłanych raportów znaczy „migracja rundy 4 nie została
    // wklejona, rodzice dostają wersję sprzed niej" — i to musi być widać
    // w odpowiedzi crona, nie tylko w logu. Wszystkie pięć jawnie
    // wyzerowane, żeby przebieg bez subskrypcji pokazywał zera, a nie brak
    // pola (brak pola nie odróżnia „nikt nie był na czas" od „ten rytm
    // w ogóle się nie wykonał").
    parent_reports: 0, parent_reports_failed: 0, parent_reports_skipped_no_report: 0,
    parent_reports_missing_extras: 0, parent_reports_snapshot_failed: 0,
  };

  // DIAGNOSTYKA 29.07.2026 — patrz komentarz przy verifyFirebaseConfig() w
  // send-push.js: bez tego, "sukces" poniżej (wszystkie rytmy = 0, bo
  // pilotaż nie ma jeszcze żadnego tokenu push w bazie) nic nie mówi o
  // tym, czy FIREBASE_SERVICE_ACCOUNT_JSON w ogóle się parsuje. Wołane
  // NIEZALEŻNIE od tego, czy jakikolwiek rytm dziś kogoś wywoła; nic nie
  // wysyła, nigdy nie loguje/zwraca treści sekretu.
  let firebaseConfigOk = false;
  let firebaseConfigError = null;
  try {
    verifyFirebaseConfig();
    firebaseConfigOk = true;
  } catch (e) {
    firebaseConfigError = e.message;
    console.error('cron-send-notifications: Firebase config selftest nieudany:', e.message);
  }

  try {
    const supabase = getAdminClient();
    const warsawNow = getWarsawNow();

    // DYSPOZYTOR C6 08.08.2026 — piętnaście rytmów, piętnaście osobnych
    // `try/catch`. Świadomie rozpisane jeden po drugim zamiast pętli po
    // tablicy: kolejność 1–15 jest tu ustaleniem projektowym (raport
    // rodzica ostatni), a lista widoczna wprost w kodzie jest jedynym
    // miejscem, w którym tę kolejność da się przeczytać i sprawdzić
    // `grep`em. Pętla po tablicy schowałaby ją o jeden poziom głębiej.
    try { await runMorningReadiness(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'morning_readiness', 'runMorningReadiness', e); }

    try { await runPostTraining(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'post_training', 'runPostTraining', e); }

    try { await runPreMatch(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'pre_match', 'runPreMatch', e); }

    try { await runWeeklySummary(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'weekly_summary', 'runWeeklySummary', e); }

    try { await runContextualInsight(supabase, results); }
    catch (e) { zapiszBladRytmu(results, 'contextual_insight', 'runContextualInsight', e); }

    try { await runFocusBlockCheckins(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'focus_block_checkins', 'runFocusBlockCheckins', e); }

    try { await runFocusBlockMaintenance(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'focus_block_maintenance', 'runFocusBlockMaintenance', e); }

    try { await runFocusBlockAdaptation(supabase, results); }
    catch (e) { zapiszBladRytmu(results, 'focus_block_adaptation', 'runFocusBlockAdaptation', e); }

    try { await runTrialExpiry(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'trial_expiry', 'runTrialExpiry', e); }

    try { await runParentalConsentExpiry(supabase, results); }
    catch (e) { zapiszBladRytmu(results, 'parental_consent_expiry', 'runParentalConsentExpiry', e); }

    try { await runCoachDigestCheck(supabase, results); }
    catch (e) { zapiszBladRytmu(results, 'coach_digest', 'runCoachDigestCheck', e); }

    try { await runRetentionCheck(supabase, results); }
    catch (e) { zapiszBladRytmu(results, 'retention_check', 'runRetentionCheck', e); }

    try { await runTrainingFocusRotation(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'training_focus_rotation', 'runTrainingFocusRotation', e); }

    try { await runCoachScheduledReportsCheck(supabase, warsawNow, results); }
    catch (e) { zapiszBladRytmu(results, 'coach_scheduled_reports', 'runCoachScheduledReportsCheck', e); }

    // ZRODLO C5 08.08.2026 — raport rodzica. ŚWIADOMIE OSTATNI w kolejce:
    // to jedyny rytm, który wysyła e-maile do osób spoza systemu (rodziców),
    // i jedyny, który dołączył do tego dyspozytora w tej rundzie. Gdyby
    // miał się wywrócić, ma to zrobić PO tym, jak trzynaście pozostałych
    // rytmów zrobiło swoje. Sama funkcja z zasady nie rzuca (patrz nagłówek
    // lib/parent-reports.js) — kolejność jest drugim pasem bezpieczeństwa,
    // nie jedynym.
    // DYSPOZYTOR C6 08.08.2026 — od tej rundy jest jeszcze trzeci pas:
    // własny `try/catch`. Kolejność i tak zostaje ostatnia, bo powód powyżej
    // (poczta poza system) nie zniknął.
    try { await runParentReportsCheck(supabase, results); }
    catch (e) { zapiszBladRytmu(results, 'parent_reports', 'runParentReportsCheck', e); }

    // DYSPOZYTOR C6 08.08.2026 — jawny stan „coś się nie wykonało" (reguła R5).
    // Bez tego trzeba by przeglądać dwadzieścia kluczy `results` w poszukiwaniu
    // sufiksu `_error`. Pole powstaje WYŁĄCZNIE wtedy, gdy jakiś rytm padł —
    // przebieg bez wyjątków ma odpowiedź co do znaku taką, jak przed tą rundą.
    const kluczeZBledem = Object.keys(results)
      .filter((k) => k.endsWith('_error'))
      .map((k) => k.slice(0, -'_error'.length));

    if (kluczeZBledem.length > 0) {
      const podsumowanie = `${kluczeZBledem.length} z 15 rytmów rzuciło wyjątkiem: ${kluczeZBledem.join(', ')}`;
      console.error('cron-send-notifications zakończony Z BŁĘDAMI RYTMÓW:', { ...results, firebaseConfigOk, firebaseConfigError });
      return res.status(500).json({
        ok: false,
        error: podsumowanie,
        rytmy_z_bledem: kluczeZBledem,
        results,
        firebaseConfigOk,
        firebaseConfigError,
      });
    }

    console.log('cron-send-notifications zakończony:', { ...results, firebaseConfigOk, firebaseConfigError });
    return res.status(200).json({ ok: true, results, firebaseConfigOk, firebaseConfigError });
  } catch (e) {
    console.error('cron-send-notifications error:', e);
    return res.status(500).json({ ok: false, error: e.message, results, firebaseConfigOk, firebaseConfigError });
  }
};

// dopisane wyłącznie po to, żeby dało się pokryć testem dziewięć rytmów
// tego pliku niezależnie od siebie (patrz tests/test-cron-send-notifications.js)
// — każda funkcja rytmu przyjmuje `warsawNow`/`supabase` jako parametry, więc
// test może podać syntetyczny czas zamiast czekać na realne okno godzinowe.
// Czysto addytywne, zero zmiany zachowania handlera powyżej.
module.exports._internal = {
  getWarsawNow,
  toWarsawDateStr,
  hourInWindow,
  getTokensForUser,
  hasLoggedMorningToday,
  runMorningReadiness,
  runPostTraining,
  sendPreMatchForDate,
  runPreMatch,
  runWeeklySummary,
  runContextualInsight,
  runFocusBlockCheckins,
  runFocusBlockMaintenance,
  runTrialExpiry,
  runParentalConsentExpiry,
  runCoachDigestCheck,
  runRetentionCheck,
  runTrainingFocusRotation,
  runCoachScheduledReportsCheck,
  runParentReportsCheck, // ZRODLO C5 08.08.2026
  SEGMENT_DISPLAY_NAME,
};
