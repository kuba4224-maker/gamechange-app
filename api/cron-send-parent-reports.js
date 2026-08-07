// ============================================================
// GAMECHANGE — /api/cron-send-parent-reports.js
// ============================================================
// ZRODLO C5 08.08.2026 — TEN PLIK JEST JUŻ TYLKO CIENKĄ OBUDOWĄ.
// Cała logika mieszka w lib/parent-reports.js (`runParentReportsCheck`) —
// ten sam wzorzec, którym api/submit-coach-tip-feedback.js zszedł do
// lib/coach-tip-feedback.js (decyzja 3b, 04.08.2026). ZERO ZMIANY LOGIKI
// i ZERO zmiany kontraktu tego endpointu: te same kody odpowiedzi, ten
// sam kształt `results` ({sent, failed, skippedNoReport, missingExtras,
// snapshotFailed}), ta sama ochrona CRON_SECRET. 16 scenariuszy
// w tests/test-cron-send-parent-reports.js przechodzi bez zmiany ani
// jednej linii testu — i to jest dowód, że przeniesienie niczego nie
// ruszyło.
//
// CO SIĘ REALNIE ZMIENIŁO W TEJ RUNDZIE: raport rodzica zaczął się
// wreszcie URUCHAMIAĆ. Ten endpoint nigdy nie był wpisany do vercel.json
// (znalezisko C4-N4), więc mechanizm wzbogacony w rundzie 4 nie odpalał
// się sam. Od tej rundy woła go dyspozytor
// api/cron-send-notifications.js — 12 wpisów crona, które już istnieją,
// zamiast czternastego wpisu w pliku, co do którego podejrzewamy, że
// Vercel Hobby po cichu go przycina (pozycja M4 audytu po bloku 4).
//
// ⚠️ TEN PLIK MOŻNA USUNĄĆ i jest to POŻĄDANE — api/ zejdzie wtedy do
// 11 z 12 funkcji Vercel Hobby (ograniczenie O1) i zrobi się miejsce na
// przyszły endpoint. Nic go nie woła: nie ma go w vercel.json i nigdy nie
// było. Zostaje wyłącznie dlatego, że sesja delegowana nie ma jak skasować
// pliku na dysku Kuby (most plików potrafi pisać, nie potrafi usuwać) —
// a przeniesienie go do folderu-śmietnika wewnątrz repo, które Vercel
// wdraża, opublikowałoby kod backendu jako plik statyczny. Usunięcie to
// jedno polecenie po stronie Kuby:
//     git rm gamechange-app/api/cron-send-parent-reports.js
// Po nim trzeba jeszcze usunąć wpis z vercel.json — którego tam nie ma,
// więc nie trzeba nic więcej. Dyspozytor działa niezależnie od tego pliku.
//
// PO CO W OGÓLE ZOSTAWIAĆ (argument w drugą stronę, do rozstrzygnięcia
// przez Kubę): ręczne odpalenie wysyłki jednym `curl`em, bez czekania na
// najbliższe okno crona, przy pierwszym prawdziwym rodzicu w pilotażu.
// Po skasowaniu pliku ta możliwość znika — najbliższe okno dyspozytora
// jest co ~2h, więc koszt jest mały, ale niezerowy.
//
// ── Historia pliku (zachowana) ───────────────────────────────────────
// POPRAWKA 03.08.2026: `require('../lib/email-sender')` miał brakujący
// cudzysłów zamykający — błąd składni, który zawiesiłby ten plik przy
// każdym wywołaniu. Nieszkodliwy do tej pory wyłącznie dlatego, że ten
// cron nigdy nie był realnie wywołany w produkcji.
// RODZIC C4 08.08.2026: warstwa materiałów dla rodzica, migawka wysłanego
// raportu i dwa liczniki niecichego braku — wszystko to żyje teraz
// w lib/parent-reports.js, opisane w nagłówku tamtego pliku.
//
// ŚWIADOMIE OTWARTE / POZA TYM PLIKIEM:
// 1. PARENT_REPORT_INTERVAL_DAYS (dziś 30) — decyzja Kuby, zmienna
//    środowiskowa w Vercelu, zero zmian w kodzie. Rekomendacja skrócenia
//    do 14 dni z raportu C rundy 4 nadal czeka.
// 2. Opt-in „zawodnik podaje e-mail rodzica" — nadal nie istnieje w żadnej
//    appce (znalezisko C4-N2). Dopóki go nie ma, `parent_report_subscriptions`
//    jest pusta i ta wysyłka, choć wreszcie uruchamiana, wyśle zero maili.
//    Wpięcie do dyspozytora usuwa DRUGI z dwóch powodów, dla których runda 4
//    nie docierała do nikogo. Pierwszy zostaje.
// 3. Wybór dostawcy e-maili — EMAIL_PROVIDER/EMAIL_API_KEY weszły do
//    Vercela 05.08.2026 (potwierdzone w audycie po bloku 4).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { runParentReportsCheck } = require('../lib/parent-reports');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supabase = getAdminClient();
    const outcome = await runParentReportsCheck(supabase);
    if (!outcome.ok) {
      return res.status(500).json({ ok: false, error: outcome.error, results: outcome.results });
    }
    return res.status(200).json({ ok: true, results: outcome.results });
  } catch (e) {
    // Tu dochodzi już tylko brak SUPABASE_URL/SERVICE_ROLE_KEY —
    // runParentReportsCheck z zasady nie rzuca (patrz jej nagłówek).
    console.error('cron-send-parent-reports error:', e);
    return res.status(500).json({
      ok: false,
      error: 'Błąd wykonania schedulera.',
      results: { sent: 0, failed: 0, skippedNoReport: 0, missingExtras: 0, snapshotFailed: 0 },
    });
  }
};

module.exports._internal = { getAdminClient };
