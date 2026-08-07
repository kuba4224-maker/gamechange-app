// ============================================================
// GAMECHANGE — lib/parent-reports.js
// ============================================================
// ZRODLO C5 08.08.2026 — PRZENIESIONE z api/cron-send-parent-reports.js.
//
// PO CO: znalezisko C4-N4 (raport C rundy 4) — `cron-send-parent-reports`
// NIGDY nie był wpisany do vercel.json, więc cały mechanizm raportu dla
// rodzica, wzbogacony w rundzie 4, po prostu SIĘ NIE URUCHAMIAŁ. Kod
// działał, testy przechodziły, mapa produktu mogła zapisać „zrobione",
// a rodzic nigdy niczego nie dostawał. Podręcznikowy „cichy brak", tylko
// o piętro wyżej niż zwykle: nie w logice, a w harmonogramie.
//
// DLACZEGO NIE CZTERNASTY WPIS W vercel.json: plik ma już 13 zadań cron,
// a plan Vercel Hobby ma limit, którego nie znamy na pewno (pozycja M4
// audytu po bloku 4 — Kuba sprawdza w panelu Vercela, ile z 13 jest
// faktycznie zarejestrowanych). Dokładanie czternastego wpisu do listy,
// co do której podejrzewamy, że jest po cichu przycinana, naprawiałoby
// cichy brak innym cichym brakiem.
//
// ZAMIAST TEGO: raport rodzica wchodzi do dyspozytora
// api/cron-send-notifications.js — dokładnie tym samym wzorcem, którym
// weszły tam runRetentionCheck, runTrainingFocusRotation,
// runCoachDigestCheck i runCoachScheduledReportsCheck: import na górze,
// jedno `await` w dyspozytorze, nowe klucze w obiekcie `results`.
// Dyspozytor ma w vercel.json 12 wpisów (co ~2h), więc raport rodzica
// dostaje 12 szans dziennie zamiast zera. Bramką pozostaje last_sent_at
// + PARENT_REPORT_INTERVAL_DAYS, więc częstsze uruchamianie NIE znaczy
// częstszej wysyłki — dokładnie ta sama własność, na której stoi
// retention-check (deduplikacja przez log) i coach-digest.
//
// WZORZEC WYCIĄGNIĘCIA: ten sam co lib/coach-tip-feedback.js (decyzja 3b,
// 04.08.2026) — logika schodzi do lib/, a plik w api/ zostaje cienką
// obudową. ZERO ZMIANY LOGIKI: wszystko poniżej to ten sam kod co
// w api/cron-send-parent-reports.js z rundy 4, przeniesiony 1:1. Jedyne
// realne różnice, obie strukturalne, nie behawioralne:
//   1. klient Supabase przychodzi PARAMETREM zamiast być tworzony w środku
//      (dyspozytor ma już swojego — nie ma powodu robić drugiego);
//   2. funkcja ZWRACA wynik zamiast pisać do `res` (obudowa w api/ i
//      dyspozytor potrzebują dwóch różnych rzeczy z tego samego przebiegu).
//
// CZEGO TU ŚWIADOMIE NIE ZMIENIŁEM: PARENT_REPORT_INTERVAL_DAYS zostaje
// jak było (30, zmienna środowiskowa). Rekomendacja skrócenia do 14 dni
// z raportu C rundy 4 czeka na decyzję Kuby i jest zmianą jednej zmiennej
// w Vercelu, nie w kodzie.
//
// ── Oryginalny opis mechanizmu (z api/cron-send-parent-reports.js) ────
// Dla każdej aktywnej subskrypcji rodzica, której „czas nadszedł", woła
// istniejącą funkcję get_parent_report(token) (Domena 16), buduje e-mail
// przez lib/email-templates.js, wysyła przez lib/email-sender.js
// i aktualizuje last_sent_at PO udanej wysyłce — więc nieudana wysyłka
// nie „gubi" subskrypcji, po prostu spróbuje ponownie przy następnym
// przebiegu.
//
// ── RODZIC C4 08.08.2026 (przeniesione bez zmian) ────────────────────
// 1. drugie, ADDYTYWNE wywołanie `get_parent_report_extras(token, segment)`
//    — wskazówki z materiałów dla rodzica, migawka poprzedniego raportu
//    i data ostatniego wpisu dziecka. `get_parent_report` nietknięta;
// 2. zapis MIGAWKI wysłanego raportu do `parent_report_snapshots` PO
//    udanej wysyłce — jedyne źródło zdania „co się zmieniło" w kolejnym
//    raporcie;
// 3. dwa liczniki (`missingExtras`, `snapshotFailed`), żeby brak migracji
//    NIE był cichy (reguła R5).
// ============================================================

const { sendEmail } = require('./email-sender');
const { parentReportEmail } = require('./email-templates');

// Adres strony raportu/wypisania (raport-rodzica.html).
const PARENT_REPORT_BASE_URL =
  process.env.PARENT_REPORT_BASE_URL || 'https://gamechange-app.vercel.app/raport-rodzica.html';

// ------------------------------------------------------------
// Czysta funkcja — moment, od którego subskrypcja jest „na czas".
// Wyciągnięta osobno wyłącznie po to, żeby dało się ją przetestować bez
// atrapy bazy i żeby interwał był policzony w JEDNYM miejscu.
// `now` podawane parametrem — test nie może czekać 30 dni.
// ------------------------------------------------------------
function parentReportCutoffIso(intervalDays, now) {
  const days = Number(intervalDays) > 0 ? Number(intervalDays) : 30;
  const base = now instanceof Date ? now.getTime() : Date.now();
  return new Date(base - days * 24 * 60 * 60 * 1000).toISOString();
}

// ------------------------------------------------------------
// runParentReportsCheck(supabase, results)
//
// `supabase` — klient service-role (dyspozytor ma swojego, obudowa w api/
//              tworzy własnego).
// `results`  — OPCJONALNY, płaski obiekt liczników dyspozytora. Gdy podany,
//              te same liczby lądują w nim pod kluczami `parent_reports*`.
//              Ten sam wzorzec co runRetentionCheck (`if (results) ...`).
//
// Zwraca: { ok, error, results: { sent, failed, skippedNoReport,
//           missingExtras, snapshotFailed } }
//
// NIGDY NIE RZUCA. To jest celowe i ważne: w dyspozytorze ta funkcja jest
// jednym z czternastu rytmów w jednym `try`, więc wyjątek stąd zabrałby
// ze sobą całą resztę przebiegu (i zwrócił 500 na cron, który poza tym
// zrobił swoje). Awaria raportu rodzica ma być policzona, nie zaraźliwa.
// ------------------------------------------------------------
async function runParentReportsCheck(supabase, results) {
  const intervalDays = Number(process.env.PARENT_REPORT_INTERVAL_DAYS) || 30;
  const counters = { sent: 0, failed: 0, skippedNoReport: 0, missingExtras: 0, snapshotFailed: 0 };

  const publish = () => {
    if (!results) return;
    results.parent_reports = (results.parent_reports || 0) + counters.sent;
    results.parent_reports_failed = (results.parent_reports_failed || 0) + counters.failed;
    results.parent_reports_skipped_no_report = (results.parent_reports_skipped_no_report || 0) + counters.skippedNoReport;
    results.parent_reports_missing_extras = (results.parent_reports_missing_extras || 0) + counters.missingExtras;
    results.parent_reports_snapshot_failed = (results.parent_reports_snapshot_failed || 0) + counters.snapshotFailed;
  };

  try {
    const cutoff = parentReportCutoffIso(intervalDays, new Date());

    // „Czas nadszedł" = aktywna subskrypcja, której albo nigdy nic nie
    // wysłano (last_sent_at IS NULL — pierwszy raport), albo minęło co
    // najmniej intervalDays od ostatniej wysyłki. Wykorzystuje istniejący
    // indeks idx_parent_report_due (active, last_sent_at) WHERE active.
    const { data: dueSubs, error: fetchError } = await supabase
      .from('parent_report_subscriptions')
      .select('id, access_token, parent_email')
      .eq('active', true)
      .or(`last_sent_at.is.null,last_sent_at.lt.${cutoff}`);

    if (fetchError) {
      console.error('parent-reports: błąd pobierania subskrypcji:', fetchError);
      publish();
      return { ok: false, error: 'Błąd pobierania subskrypcji.', results: counters };
    }

    for (const sub of dueSubs || []) {
      try {
        const { data: report, error: reportError } = await supabase.rpc('get_parent_report', {
          p_token: sub.access_token,
        });

        if (reportError || !report) {
          // Token nieaktywny/nieznany mimo active=true w tabeli (wyścig
          // z równoczesnym wypisaniem się) — pomiń, nie traktuj jako
          // błąd wysyłki wymagający ponowienia.
          counters.skippedNoReport++;
          continue;
        }

        // RODZIC C4 08.08.2026 — warstwa materiałów dla rodzica + porównanie
        // z poprzednim raportem. Świadomie DRUGIE, osobne wywołanie zamiast
        // rozszerzania get_parent_report: tamta funkcja żyje na produkcji
        // w wersji bogatszej niż jakakolwiek jej rekonstrukcja w repo
        // (patrz RAPORT_RODZICA_SQL.md) i nadpisanie jej z niepełnym ciałem
        // skasowałoby działającą logikę.
        //
        // Brak funkcji (migracja niewklejona) NIE przerywa wysyłki: raport
        // wychodzi w wersji sprzed rundy 4, a fakt braku jest policzony.
        let extras = null;
        try {
          const { data: extrasData, error: extrasError } = await supabase.rpc('get_parent_report_extras', {
            p_token: sub.access_token,
            p_segment_id: (report.priority_goal && report.priority_goal.segment_id) || null,
          });
          if (extrasError || !extrasData) {
            counters.missingExtras++;
            console.warn(`parent-reports: brak warstwy materiałów dla subskrypcji ${sub.id} (get_parent_report_extras):`, extrasError || 'pusty wynik');
          } else {
            extras = extrasData;
          }
        } catch (extrasCallError) {
          counters.missingExtras++;
          console.warn(`parent-reports: get_parent_report_extras niedostępne dla subskrypcji ${sub.id}:`, extrasCallError);
        }

        const unsubscribeUrl = `${PARENT_REPORT_BASE_URL}?token=${sub.access_token}&action=unsubscribe`;
        const { subject, html, text } = parentReportEmail({ report, unsubscribeUrl, extras });

        await sendEmail({ to: sub.parent_email, subject, html, text });

        const { error: updateError } = await supabase
          .from('parent_report_subscriptions')
          .update({ last_sent_at: new Date().toISOString() })
          .eq('id', sub.id);

        if (updateError) {
          // Wysłane, ale nie zaznaczone — kolejny przebieg wyśle duplikat.
          // Rzadkie, logowane wprost, nie ukrywane.
          console.error(`parent-reports: e-mail wysłany, ale nie zaktualizowano last_sent_at dla subskrypcji ${sub.id}:`, updateError);
        }

        // RODZIC C4 08.08.2026 — migawka tego, co rodzic właśnie dostał.
        // Świadomie zapisywana PO udanej wysyłce: ma odpowiadać temu, co
        // rodzic realnie zobaczył, a nie temu, co próbowaliśmy wysłać.
        // Nieudany zapis migawki NIE psuje wysyłki — najgorsze, co się
        // stanie, to że następny raport powie uczciwie „nie mam z czym
        // porównać".
        try {
          const { error: snapshotError } = await supabase
            .from('parent_report_snapshots')
            .insert({ subscription_id: sub.id, sent_report: report });
          if (snapshotError) {
            counters.snapshotFailed++;
            console.warn(`parent-reports: nie zapisano migawki raportu dla subskrypcji ${sub.id}:`, snapshotError);
          }
        } catch (snapshotCallError) {
          counters.snapshotFailed++;
          console.warn(`parent-reports: tabela parent_report_snapshots niedostępna (subskrypcja ${sub.id}):`, snapshotCallError);
        }

        counters.sent++;
      } catch (perSubError) {
        counters.failed++;
        console.error(`parent-reports: błąd dla subskrypcji ${sub.id}:`, perSubError);
      }
    }

    console.log('parent-reports zakończony:', counters);
    publish();
    return { ok: true, results: counters };
  } catch (e) {
    console.error('parent-reports error:', e);
    publish();
    return { ok: false, error: 'Błąd wykonania schedulera.', results: counters };
  }
}

module.exports = {
  PARENT_REPORT_BASE_URL,
  parentReportCutoffIso,
  runParentReportsCheck,
};
