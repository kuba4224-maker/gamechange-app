// ============================================================
// GAMECHANGE — email_templates.js
// ============================================================
// Buduje temat + treść (html/text) dla e-maili wysyłanych przez
// email_sender.js. Świadomie osobny plik od email_sender.js — ten tu
// zna TREŚĆ wiadomości (co i dlaczego), tamten zna WYSYŁKĘ (jak i przez
// kogo) — ten sam podział odpowiedzialności co recommendation_engine.js
// (Marketplace, logika dopasowania) vs api_create_booking.js (Marketplace,
// zapis do bazy): jedna rzecz nie musi wiedzieć jak działa druga.
//
// STYL: prosty inline HTML (bez frameworków CSS-w-mailu, bez obrazków)
// — najbezpieczniejszy wybór pod kątem klientów pocztowych (Gmail,
// Outlook) na start pilotażu. Każdy szablon ma zarówno html jak i text
// (fallback dla klientów blokujących HTML / czytników ekranu).
//
// TON: zgodny z już ustaloną filozofią systemu ("nawigator, nie
// planista", ostrożny/afirmujący ton — patrz ASYSTENT_SPORTOWCA_
// ARCHITEKTURA_TECHNICZNA.md) — dotyczy to szczególnie raportu dla
// rodzica: rodzic czyta o NASTOLETNIM dziecku, ton musi być spokojny,
// nigdy alarmistyczny, nigdy nie brzmieć jak diagnoza medyczna/kliniczna.
//
// NOWE (03.08.2026): retentionReminderEmail — dopisane przy odtwarzaniu
// pakietu retencji (KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, sekcja 5.1).
// Ton dobrany zgodnie z tą samą filozofią (zachęcający, nigdy winiący/
// nie brzmiący jak powiadomienie o zaległości) — ale to treść NIGDY
// wprost nie zatwierdzona przez Kubę, tylko najlepsza własna próba
// zgodna z resztą systemu. Do przejrzenia przed wdrożeniem.
//
// POPRAWKA 03.08.2026 (sesja "raport-rodzica.html"): ta wersja pliku
// (z retentionReminderEmail) NIE dotarła wcześniej na dysk Kuby —
// lib/retention-check.js, który już tam jest i już woła
// retentionReminderEmail(), wywołałby "retentionReminderEmail is not a
// function" przy pierwszym realnym uruchomieniu. Ten plik to naprawia
// PRZY OKAZJI głównego zadania tej sesji (dwie linie o skoku wzrostowym
// w parentReportEmail(), patrz punkt 1 niżej) — pełne wyjaśnienie w
// RAPORT_RODZICA_STATUS_03_08_2026.md.
// ============================================================

const APP_URL = 'https://gamechange-app.vercel.app/asystent_app.html';

// ------------------------------------------------------------
// Segmenty — etykiety PL, kopia świadomie zduplikowana z SEG_NAMES
// (api_generate_recommendation.js) — ten sam wzorzec świadomej
// duplikacji małego, stabilnego słownika w kilku miejscach systemu,
// już wcześniej zaakceptowany (patrz komentarz przy SEG_NAMES).
// ------------------------------------------------------------
const SEG_NAMES = {
  moc: 'Moc',
  wytrzymalosc: 'Wytrzymałość',
  fizycznosc: 'Fizyczność',
  techFund: 'Technika fundamentalna',
  techSpec: 'Technika specjalistyczna',
  regeneracja: 'Regeneracja',
  odpornosc: 'Odporność',
  odzywianie: 'Odżywienie',
  tolerancja: 'Tolerancja obciążeń',
  koncentracja: 'Koncentracja',
  mental: 'Odwaga w grze',
  percepcja: 'Percepcja',
  decyzja: 'Szybkość decyzji',
};

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function wrapHtml({ title, bodyHtml, footerHtml }) {
  // Minimalny, samodzielny layout — bez zewnętrznych zasobów (żadnych
  // linkowanych fontów/CSS spoza wiadomości), żeby renderowało się
  // identycznie niezależnie od klienta pocztowego i jego polityki
  // blokowania zewnętrznych zasobów.
  return `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f2ec;font-family:Arial,Helvetica,sans-serif;color:#0e0d0b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d8d3c8;">
        <tr><td style="padding:24px 32px;border-bottom:1px solid #d8d3c8;">
          <span style="font-size:13px;letter-spacing:0.15em;text-transform:uppercase;color:#9a9488;">Gamechange</span>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <h1 style="font-size:20px;margin:0 0 16px 0;color:#0e0d0b;">${escapeHtml(title)}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #d8d3c8;font-size:12px;color:#9a9488;">
          ${footerHtml || ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ------------------------------------------------------------
// 1. Raport dla rodzica (cykliczny) — treść zgodna z get_parent_report
//    (Domena 16). UWAGA: get_parent_report jest wprost oznaczona jako
//    "propozycja robocza, czeka na przegląd Kuby" — ten szablon
//    renderuje cokolwiek ta funkcja dziś zwraca, więc gdy treść
//    get_parent_report się zmieni (po przeglądzie Kuby), ten szablon
//    trzeba zaktualizować równolegle, nie automatycznie się dostosuje.
//
// `report` to obiekt JSONB zwrócony przez get_parent_report(p_token).
// `unsubscribeUrl` — link do parent_report_unsubscribe, budowany przez
// wywołującego (zna access_token, którego ten plik świadomie nie widzi).
//
// DOPISANE 03.08.2026 — dwie linie o skoku wzrostowym, treść ZGODNA z
// "ZOPTYMALIZOWANĄ TREŚCIĄ RAPORTU — POTWIERDZONĄ 29.07.2026, bez
// poprawek" (RAPORT_RODZICA_ANALIZA_I_OPTYMALIZACJA.md): ton zawsze
// edukacyjny/uspokajający, świadomie BEZ terminologii medycznej i BEZ
// przesiewu postawy — dokładnie te dwa pola (`growth_spurt_typical_age_
// range`/`height_growth_rate_elevated`), które get_parent_report zwraca
// (patrz RAPORT_RODZICA_SQL.md). Ta sama treść (słowo w słowo) jest też
// w raport-rodzica.html, żeby e-mail i strona brzmiały identycznie.
// ------------------------------------------------------------
function parentReportEmail({ report, unsubscribeUrl }) {
  const playerName = report.player_name || 'Twoje dziecko';
  const goal = report.priority_goal;
  const goalLine = goal
    ? `Priorytetowy cel tego okresu: <strong>${escapeHtml(SEG_NAMES[goal.segment_id] || goal.segment_id)}</strong>` +
      (goal.horizon_weeks ? ` (typowy horyzont: ok. ${escapeHtml(goal.horizon_weeks)} tyg. cierpliwości, zanim efekt będzie widoczny).` : '.')
    : 'Brak dziś ustawionego priorytetowego celu.';

  const subject = `Raport Gamechange — ${playerName}`;

  const growthAgeNoteHtml = report.growth_spurt_typical_age_range
    ? `<p style="font-size:13px;line-height:1.6;color:#3a3830;background:#f5f2ec;padding:14px 16px;border-left:3px solid #E8432D;margin-top:16px;">W tym wieku (11–16 lat) organizm często przechodzi naturalny okres szybszego wzrostu — to normalna faza rozwoju, w której warto zwracać nieco większą uwagę na odpoczynek i stopniowe zwiększanie obciążeń treningowych. System Gamechange bierze to pod uwagę przy doborze wskazówek dla ${escapeHtml(playerName)}.</p>`
    : '';
  const growthRateNoteHtml = report.height_growth_rate_elevated
    ? `<p style="font-size:13px;line-height:1.6;color:#3a3830;background:#f5f2ec;padding:14px 16px;border-left:3px solid #E8432D;margin-top:${report.growth_spurt_typical_age_range ? '8px' : '16px'};">Ostatnie pomiary wzrostu pokazują wyraźnie szybsze tempo wzrastania — to naturalne zjawisko w tym okresie, nie powód do niepokoju, ale dobry moment, żeby razem z dzieckiem zadbać o sen i regenerację.</p>`
    : '';

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">Krótkie podsumowanie ostatniego okresu pracy ${escapeHtml(playerName)} w Gamechange — bez szczegółów dziennika, tylko ogólny obraz.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#3a3830;">${goalLine}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#3a3830;">Aktywnych celów: <strong>${escapeHtml(report.active_goals_count ?? 0)}</strong></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#3a3830;">Sesji treningowych zalogowanych w ostatnich 7 dniach: <strong>${escapeHtml(report.recent_training_sessions_7d ?? 0)}</strong></td></tr>
      <tr><td style="padding:10px 0;font-size:14px;color:#3a3830;">Meczów w ostatnich 30 dniach: <strong>${escapeHtml(report.recent_matches_30d ?? 0)}</strong></td></tr>
    </table>
    ${growthAgeNoteHtml}${growthRateNoteHtml}
    <p style="font-size:13px;color:#9a9488;margin-top:16px;">To zwięzły, ogólny obraz — szczegóły (dziennik, samopoczucie, rozmowy z asystentem AI) widzi wyłącznie ${escapeHtml(playerName)} w swoim koncie, zgodnie z zasadą, że to Jego/Jej narzędzie do samodzielnej pracy nad formą.</p>
  `;

  const footerHtml = unsubscribeUrl
    ? `Nie chcesz już dostawać tego raportu? <a href="${escapeHtml(unsubscribeUrl)}" style="color:#9a9488;">Wypisz się jednym kliknięciem</a> — bez logowania.`
    : '';

  const growthAgeNoteText = report.growth_spurt_typical_age_range
    ? `\nW tym wieku (11-16 lat) organizm często przechodzi naturalny okres szybszego wzrostu — normalna faza rozwoju, warto zwracać nieco większą uwagę na odpoczynek.\n`
    : '';
  const growthRateNoteText = report.height_growth_rate_elevated
    ? `\nOstatnie pomiary wzrostu pokazują wyraźnie szybsze tempo wzrastania — naturalne zjawisko, dobry moment na sen i regenerację.\n`
    : '';

  return {
    subject,
    html: wrapHtml({ title: `Raport postępów — ${playerName}`, bodyHtml, footerHtml }),
    text:
      `Raport Gamechange — ${playerName}\n\n` +
      `${goal ? `Priorytetowy cel: ${SEG_NAMES[goal.segment_id] || goal.segment_id}` + (goal.horizon_weeks ? ` (ok. ${goal.horizon_weeks} tyg. horyzontu)` : '') : 'Brak dziś ustawionego priorytetowego celu.'}\n` +
      `Aktywnych celów: ${report.active_goals_count ?? 0}\n` +
      `Sesji treningowych (7 dni): ${report.recent_training_sessions_7d ?? 0}\n` +
      `Meczów (30 dni): ${report.recent_matches_30d ?? 0}\n` +
      growthAgeNoteText + growthRateNoteText + '\n' +
      (unsubscribeUrl ? `Wypisz się: ${unsubscribeUrl}\n` : ''),
  };
}

// ------------------------------------------------------------
// 2. Powiadomienie o nowej rekomendacji Centrum Decyzji — kanał
//    e-mail zamiast push na start pilotażu (patrz STATUS_I_ROADMAP:
//    "e-mail jako kanał powiadomień na start, push jako fast-follow").
//    Treść = to, co Centrum Decyzji już wygenerowało (weekly_focus_text/
//    recommendation_text) — ten plik tylko je opakowuje w e-mail,
//    świadomie NIE generuje własnej treści.
// ------------------------------------------------------------
function recommendationNotificationEmail({ playerName, segmentId, weeklyFocusText, recommendationText }) {
  const segLabel = SEG_NAMES[segmentId] || segmentId;
  const subject = `Nowa wskazówka od Twojego asystenta — ${segLabel}`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">Cześć${playerName ? ' ' + escapeHtml(playerName) : ''}, Twój asystent przygotował świeżą wskazówkę na segment <strong>${escapeHtml(segLabel)}</strong>.</p>
    ${weeklyFocusText ? `<p style="font-size:14px;line-height:1.6;color:#0e0d0b;background:#f5f2ec;padding:14px 18px;border-left:3px solid #E8432D;">${escapeHtml(weeklyFocusText)}</p>` : ''}
    ${recommendationText ? `<p style="font-size:14px;line-height:1.6;color:#3a3830;">${escapeHtml(recommendationText)}</p>` : ''}
    <p style="margin-top:20px;"><a href="${APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz Centrum Decyzji</a></p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Nowa wskazówka od asystenta', bodyHtml }),
    text:
      `Nowa wskazówka — ${segLabel}\n\n` +
      (weeklyFocusText ? `${weeklyFocusText}\n\n` : '') +
      (recommendationText ? `${recommendationText}\n\n` : '') +
      `Otwórz: ${APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 3. NOWE (03.08.2026) — przypomnienie retencyjne (lib/retention-check.js).
//    Kanał e-mail (nie push, patrz uzasadnienie w retention-check.js).
//    Świadomie BEZ konkretnych liczb/statystyk (retention-check.js nie
//    zbiera żadnych poza samą datą ostatniej aktywności) — zachęcający,
//    otwarty ton, zero "zaległości"/poczucia winy, zgodnie z resztą
//    systemu. `playerName` opcjonalne (schemat `users` nie ma dziś
//    potwierdzonej kolumny z imieniem — do uzupełnienia, jeśli/gdy taka
//    kolumna powstanie).
// ------------------------------------------------------------
function retentionReminderEmail({ playerName } = {}) {
  const greeting = playerName ? `Cześć ${escapeHtml(playerName)}` : 'Cześć';
  const subject = 'Kilka dni ciszy — Twój Gamechange czeka, kiedy będziesz gotów';

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">${greeting}, zauważyliśmy, że od kilku dni nie zaglądałeś do swojego Dziennika ani Centrum Decyzji. Bez presji — czasem po prostu jest inny tydzień.</p>
    <p style="font-size:14px;line-height:1.6;color:#3a3830;">Twoje dane, cele i rekomendacje wciąż tam są i czekają. Jeśli masz chwilę, wystarczy jeden krótki wpis, żeby wrócić do rytmu.</p>
    <p style="margin-top:20px;"><a href="${APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Wróć do Gamechange</a></p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Twój Gamechange czeka', bodyHtml }),
    text:
      `${greeting}, zauważyliśmy, że od kilku dni nie zaglądałeś do swojego Dziennika ani Centrum Decyzji. Bez presji — czasem po prostu jest inny tydzień.\n\n` +
      `Twoje dane, cele i rekomendacje wciąż tam są i czekają.\n\n` +
      `Otwórz: ${APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 4. NOWE (04.08.2026) — zgoda rodzica na PŁATNY abonament niepełnoletniego
//    zawodnika (Kodeks cywilny art. 18, próg 18 lat — NIE mylić z progiem
//    RODO 16 lat / zgodą na DANE, Funkcja 17, osobny mechanizm). Pełny
//    kontekst prawny: `KOLEJKA DECYZJI I PROJEKTOWANIA.md`, sekcja 2.5.
//    Token generowany i wysyłany przez lib/parental-payment-consent.js,
//    wołane z api/stripe-checkout.js zaraz po udanej płatności — dostęp
//    zawodnika jest już aktywny w tym momencie (2.5, punkt 3), więc ton
//    tego e-maila jest informacyjny/proszący o formalne potwierdzenie, NIE
//    ostrzegawczy/blokujący — rodzic nie powstrzymuje niczego w toku, tylko
//    formalizuje coś, co już się dzieje.
// ------------------------------------------------------------
function parentalPaymentConsentEmail({ playerName, pricingTier, confirmUrl, declineUrl, expiresAt }) {
  const name = playerName || 'Twoje dziecko';
  const planLabel = pricingTier === 'team_basic' ? 'abonament drużynowy Gamechange' : 'abonament Gamechange';
  const subject = `Prośba o potwierdzenie — płatny abonament ${name} w Gamechange`;

  const expiresLabel = expiresAt
    ? new Date(expiresAt).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">${escapeHtml(name)} właśnie rozpoczął/-ęła płatny ${escapeHtml(planLabel)} w Gamechange (aplikacja wspierająca rozwój sportowy nastoletnich zawodników piłki nożnej). Ponieważ ${escapeHtml(name)} nie ma jeszcze ukończonych 18 lat, potrzebujemy Twojego potwierdzenia jako rodzica/opiekuna — zgodnie z Kodeksem cywilnym umowa zawarta przez osobę niepełnoletnią wymaga zgody opiekuna.</p>
    <p style="font-size:14px;line-height:1.6;color:#3a3830;"><strong>${escapeHtml(name)} ma dziś pełny dostęp do appki</strong> — nie musisz nic robić, żeby to zablokować. Prosimy tylko o formalne potwierdzenie w ciągu 14 dni${expiresLabel ? ` (do ${expiresLabel})` : ''}.</p>
    <p style="font-size:14px;line-height:1.6;color:#3a3830;">Jeśli nie potwierdzisz w tym terminie albo klikniesz "Nie wyrażam zgody" — dostęp do płatnych funkcji zostanie wyłączony, a pobrana opłata automatycznie zwrócona. Zero dodatkowych kroków z Twojej strony w tym przypadku.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="padding-right:12px;"><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:12px 22px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Potwierdzam</a></td>
        <td><a href="${escapeHtml(declineUrl)}" style="display:inline-block;padding:12px 22px;background:#ffffff;color:#3a3830;text-decoration:none;font-size:14px;border:1px solid #d8d3c8;">Nie wyrażam zgody</a></td>
      </tr>
    </table>
    <p style="font-size:12px;color:#9a9488;">Szczegóły dziennika i rozmów z asystentem AI widzi wyłącznie ${escapeHtml(name)} — to potwierdzenie dotyczy wyłącznie samej płatności, nie udostępnia Ci wglądu w konto.</p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Potwierdzenie płatnego abonamentu', bodyHtml }),
    text:
      `${name} rozpoczął/-ęła płatny ${planLabel} w Gamechange. Ponieważ nie ma jeszcze 18 lat, ` +
      `potrzebujemy Twojego potwierdzenia jako rodzica/opiekuna (Kodeks cywilny).\n\n` +
      `${name} ma dziś pełny dostęp — nie musisz nic robić, żeby to zablokować. Prosimy o potwierdzenie w ciągu 14 dni${expiresLabel ? ` (do ${expiresLabel})` : ''}.\n\n` +
      `Jeśli nie potwierdzisz w terminie albo odmówisz — dostęp wyłączy się automatycznie, a opłata zostanie zwrócona.\n\n` +
      `Potwierdzam: ${confirmUrl}\n` +
      `Nie wyrażam zgody: ${declineUrl}\n`,
  };
}

module.exports = { parentReportEmail, recommendationNotificationEmail, retentionReminderEmail, parentalPaymentConsentEmail };
