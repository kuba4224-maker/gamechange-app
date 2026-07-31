// ============================================================
// GAMECHANGE — /api/cron-send-parent-reports.js
// ============================================================
// SCHEDULER dla cyklicznego raportu dla rodzica (Domena 16). Ten sam
// wzorzec co api_cron_settlement.js (Marketplace): zabezpieczone przez
// CRON_SECRET, Vercel Cron dołącza go automatycznie jako nagłówek
// Authorization przy wywołaniach z crona — nikt z zewnątrz nie może
// wywołać tego endpointu i wymusić masowej wysyłki.
//
// CO TEN PLIK ROBI: dla każdej aktywnej subskrypcji rodzica, której
// "czas nadszedł" (patrz PARENT_REPORT_INTERVAL_DAYS niżej), woła już
// istniejącą funkcję get_parent_report(token) (Domena 16, treść
// PROWIZORYCZNA — czeka na przegląd Kuby, ten plik tego nie zmienia),
// buduje e-mail przez email_templates.js, wysyła przez email_sender.js
// (provider-agnostyczne, patrz ten plik), i aktualizuje last_sent_at
// PO udanej wysyłce — więc nieudana wysyłka nie "gubi" subskrypcji,
// po prostu spróbuje ponownie przy następnym uruchomieniu crona.
//
// ŚWIADOMIE OTWARTE / POZA TYM PLIKIEM (nie błąd, zapisane wprost):
// 1. PARENT_REPORT_INTERVAL_DAYS (częstotliwość wysyłki) — decyzja
//    Kuby, dziś domyślnie 30 (miesięcznie, propozycja robocza zgodna
//    z "Domena 16, punkt otwarty 2: częstotliwość — do ustalenia") —
//    zmiana to jedna zmienna środowiskowa w Vercel, zero zmian w kodzie.
// 2. Strona raportu (czytająca get_parent_report po tokenie z URL) i
//    strona wypisania się — FRONTEND, jawnie poza zakresem Domeny 16
//    ("Sama strona raportu — frontend, nie schemat"). PARENT_REPORT_
//    BASE_URL niżej wskazuje na przyszły adres tej strony — dopóki
//    strona nie istnieje, link w mailu będzie prowadził do 404, co
//    NIE blokuje samego uruchomienia crona (kolumny/e-mail działają
//    niezależnie), ale oznacza, że end-to-end test wymaga najpierw
//    zbudowania tej strony.
// 3. Wybór dostawcy e-maili (EMAIL_PROVIDER/EMAIL_API_KEY) — patrz
//    email_sender.js, decyzja Kuby, ten sam wzorzec co ANTHROPIC_API_KEY.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('../lib/email-sender);
const { parentReportEmail } = require('../lib/email-templates');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Adres przyszłej strony raportu/wypisania — patrz punkt 2 w nagłówku.
// Do zmiany, gdy strona faktycznie powstanie; nie blokuje działania crona.
const PARENT_REPORT_BASE_URL =
  process.env.PARENT_REPORT_BASE_URL || 'https://gamechange-app.vercel.app/raport-rodzica.html';

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const intervalDays = Number(process.env.PARENT_REPORT_INTERVAL_DAYS) || 30;
  const results = { sent: 0, failed: 0, skippedNoReport: 0 };

  try {
    const supabase = getAdminClient();
    const cutoff = new Date(Date.now() - intervalDays * 24 * 60 * 60 * 1000).toISOString();

    // "Czas nadszedł" = aktywna subskrypcja, której albo nigdy nic nie
    // wysłano (last_sent_at IS NULL — pierwszy raport), albo minęło co
    // najmniej intervalDays od ostatniej wysyłki. Wykorzystuje istniejący
    // indeks idx_parent_report_due (active, last_sent_at) WHERE active.
    const { data: dueSubs, error: fetchError } = await supabase
      .from('parent_report_subscriptions')
      .select('id, access_token, parent_email')
      .eq('active', true)
      .or(`last_sent_at.is.null,last_sent_at.lt.${cutoff}`);

    if (fetchError) {
      console.error('cron-send-parent-reports: błąd pobierania subskrypcji:', fetchError);
      return res.status(500).json({ ok: false, error: 'Błąd pobierania subskrypcji.', results });
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
          results.skippedNoReport++;
          continue;
        }

        const unsubscribeUrl = `${PARENT_REPORT_BASE_URL}?token=${sub.access_token}&action=unsubscribe`;
        const { subject, html, text } = parentReportEmail({ report, unsubscribeUrl });

        await sendEmail({ to: sub.parent_email, subject, html, text });

        const { error: updateError } = await supabase
          .from('parent_report_subscriptions')
          .update({ last_sent_at: new Date().toISOString() })
          .eq('id', sub.id);

        if (updateError) {
          // Wysłane, ale nie zaznaczone — kolejny przebieg crona wyśle
          // duplikat. Rzadkie, logowane wprost, nie ukrywane.
          console.error(`cron-send-parent-reports: e-mail wysłany, ale nie zaktualizowano last_sent_at dla subskrypcji ${sub.id}:`, updateError);
        }

        results.sent++;
      } catch (perSubError) {
        results.failed++;
        console.error(`cron-send-parent-reports: błąd dla subskrypcji ${sub.id}:`, perSubError);
      }
    }

    console.log('cron-send-parent-reports zakończony:', results);
    return res.status(200).json({ ok: true, results });
  } catch (e) {
    console.error('cron-send-parent-reports error:', e);
    return res.status(500).json({ ok: false, error: 'Błąd wykonania schedulera.', results });
  }
};
