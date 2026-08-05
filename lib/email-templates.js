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

// ------------------------------------------------------------
// 5-11. NOWE (04.08.2026) — Digest sygnałów trenerskich (lib/coach-digest.js,
// lib/coach-digest-signals.js). Siedem szablonów, po jednym na sygnał z
// PLAN_SPOJNEJ_SCIEZKI.md sekcja 4 ("ŚCIEŻKA TRENERA") + rozszerzenia
// zaangażowania/docenienia zlecone 04.08.2026. Wspólne zasady dla
// wszystkich siedmiu:
//   - Kanał e-mail (nie push) — trener dostaje to jako ciche, event-driven
//     info do przejrzenia, nie pilne powiadomienie na telefon.
//   - Grupa 1 (team_overload, player_risk_standout): TREŚĆ GŁÓWNA CYTATU
//     jest VERBATIM z zaakceptowanej specyfikacji — nie parafrazowana.
//     "Nawigator, nie trener": nigdy diagnoza, nigdy nakaz, zawsze
//     "warto sprawdzić/rozważyć", nigdy "na pewno dlatego/musisz".
//   - Grupa 2 (player_went_quiet, player_never_started): informacyjny,
//     niealarmistyczny ton — fakt + delikatna sugestia kontaktu, zero
//     poczucia winy (ten sam duch co retentionReminderEmail dla zawodnika).
//   - Grupa 3 (player_high_consistency, focus_block_completed_strong,
//     goal_achieved): NOWY ton w tym projekcie — pierwszy mechanizm
//     czysto DOCENIAJĄCY. Zawsze z PRAWDZIWYMI liczbami konkretnego
//     zawodnika (nigdy generyczny szablon z podmienionym tylko imieniem —
//     naruszałoby to "prawdziwą personalizację" z FILTR_JAKOSCI_POLECENIE_
//     NOWA_SESJA.md), zawsze zachęca trenera do OSOBISTEGO docenienia
//     zawodnika (nie tylko informuje), NIGDY nie porównuje do innych
//     zawodników drużyny (nigdy "lepszy niż inni w drużynie").
// ------------------------------------------------------------
const COACH_APP_URL = 'https://gamechange-app.vercel.app/coach.html';

function coachDigestFooter() {
  return 'Ten e-mail wysyła system Gamechange na podstawie sygnałów w danych zawodników Twojej drużyny. ' +
    'Które kategorie sygnałów dostajesz — możesz zmienić w panelu trenera, zakładka Ustawienia.';
}

// ------------------------------------------------------------
// 5. team_overload — Grupa 1. Treść cytatu VERBATIM (nie zmieniać słów).
//    Liczby pod cytatem to KONTEKST dodany przez ten szablon, nie część
//    zatwierdzonego zdania.
// ------------------------------------------------------------
function teamOverloadDigestEmail({ teamName, eligiblePlayersCount, elevatedCount } = {}) {
  const team = teamName || 'Twoja drużyna';
  const subject = `Sygnał przeciążenia — ${team}`;
  const verbatim = 'W tym tygodniu kilku zawodników pokazuje sygnały przeciążenia — rozważ zmniejszenie objętości lub intensywności najbliższego treningu.';
  const contextLine = (eligiblePlayersCount && elevatedCount)
    ? `${escapeHtml(elevatedCount)} z ${escapeHtml(eligiblePlayersCount)} zawodników z danymi z ostatniego tygodnia pokazuje jednocześnie podwyższone zmęczenie, zaburzony sen lub obniżony nastrój.`
    : '';

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">Drużyna: <strong>${escapeHtml(team)}</strong></p>
    <p style="font-size:15px;line-height:1.6;color:#0e0d0b;background:#f5f2ec;padding:14px 18px;border-left:3px solid #E8432D;">${escapeHtml(verbatim)}</p>
    ${contextLine ? `<p style="font-size:13px;line-height:1.6;color:#9a9488;">${contextLine}</p>` : ''}
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz panel trenera</a></p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Sygnał przeciążenia drużyny', bodyHtml, footerHtml: coachDigestFooter() }),
    text: `Drużyna: ${team}\n\n${verbatim}\n\n${contextLine ? contextLine + '\n\n' : ''}Otwórz panel trenera: ${COACH_APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 6. player_risk_standout — Grupa 1. Treść cytatu VERBATIM poza podmianą
//    [Imię] -> playerName, dokładnie jak zlecono.
// ------------------------------------------------------------
function playerRiskStandoutDigestEmail({ playerName } = {}) {
  const name = playerName || 'Zawodnik';
  const subject = `Warto sprawdzić, jak się czuje ${name}`;
  const verbatim = `${name} pokazuje w ostatnim tygodniu sygnały warte sprawdzenia bezpośrednio — porozmawiaj z nim, zanim się to nawarstwi.`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#0e0d0b;background:#f5f2ec;padding:14px 18px;border-left:3px solid #E8432D;">${escapeHtml(verbatim)}</p>
    <p style="font-size:13px;line-height:1.6;color:#9a9488;">To sygnał, nie diagnoza — dane mogą oznaczać różne rzeczy naraz. Krótka, bezpośrednia rozmowa to najlepszy następny krok.</p>
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz panel trenera</a></p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Sygnał warty sprawdzenia', bodyHtml, footerHtml: coachDigestFooter() }),
    text: `${verbatim}\n\nTo sygnał, nie diagnoza — krótka, bezpośrednia rozmowa to najlepszy następny krok.\n\nOtwórz panel trenera: ${COACH_APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 7. player_went_quiet — Grupa 2. Informacyjny, niealarmistyczny ton.
// ------------------------------------------------------------
function playerWentQuietDigestEmail({ playerName, daysSince } = {}) {
  const name = playerName || 'Zawodnik';
  const days = Math.round(daysSince || 0);
  const subject = `${name} ucichł — brak aktywności od ${days} dni`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">${escapeHtml(name)} był wcześniej aktywny w Dzienniku, a od <strong>${escapeHtml(days)} dni</strong> nie ma od niego żadnego wpisu ani aktywności meczowej.</p>
    <p style="font-size:14px;line-height:1.6;color:#3a3830;">To może być wiele rzeczy naraz — urlop, kontuzja, spadek motywacji, po prostu inny tydzień. Krótkie pytanie "co słychać?" często wystarcza, żeby to sprawdzić.</p>
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz panel trenera</a></p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Zawodnik ucichł', bodyHtml, footerHtml: coachDigestFooter() }),
    text: `${name} był wcześniej aktywny w Dzienniku, a od ${days} dni nie ma od niego żadnej aktywności.\n\nKrótkie pytanie "co słychać?" często wystarcza, żeby to sprawdzić.\n\nOtwórz panel trenera: ${COACH_APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 8. player_never_started — Grupa 2. Informacyjny, niealarmistyczny ton,
//    wyraźnie inny przypadek niż "ucichł" (ten zawodnik nigdy nie zaczął).
// ------------------------------------------------------------
function playerNeverStartedDigestEmail({ playerName, daysSinceJoin } = {}) {
  const name = playerName || 'Zawodnik';
  const days = Math.round(daysSinceJoin || 0);
  const subject = `${name} jeszcze nie zaczął prowadzić Dziennika`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">${escapeHtml(name)} dołączył do drużyny <strong>${escapeHtml(days)} dni temu</strong>, ale wciąż nie ma od niego ani jednego wpisu w Dzienniku.</p>
    <p style="font-size:14px;line-height:1.6;color:#3a3830;">Czasem pierwszy krok jest najtrudniejszy — krótka wiadomość albo pokazanie appki na treningu potrafi to odblokować.</p>
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz panel trenera</a></p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Zawodnik jeszcze nie wystartował', bodyHtml, footerHtml: coachDigestFooter() }),
    text: `${name} dołączył do drużyny ${days} dni temu, ale wciąż nie ma od niego ani jednego wpisu w Dzienniku.\n\nCzasem pierwszy krok jest najtrudniejszy — krótka wiadomość potrafi to odblokować.\n\nOtwórz panel trenera: ${COACH_APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 9. player_high_consistency — Grupa 3, NOWY ton (czysto doceniający).
//    `criterion` = 'journal' | 'calendar' — który warunek wyzwolił sygnał
//    (mogą oba być prawdziwe naraz, wybieramy ten z mocniejszym wynikiem
//    po stronie wołającego, patrz lib/coach-digest.js). Zawsze prawdziwe
//    liczby TEGO zawodnika, zero porównania do reszty drużyny.
// ------------------------------------------------------------
function playerHighConsistencyDigestEmail({ playerName, criterion, journalDaysWithEntry, journalWindowDays, calendarCompleted, calendarTotal } = {}) {
  const name = playerName || 'Zawodnik';
  const subject = `${name} — rzadka konsekwencja warta docenienia`;

  const statLine = criterion === 'calendar'
    ? `${escapeHtml(name)} zrealizował <strong>${escapeHtml(calendarCompleted)} z ${escapeHtml(calendarTotal)}</strong> zaplanowanych sesji w ostatnich tygodniach.`
    : `${escapeHtml(name)} zalogował wpis w Dzienniku w <strong>${escapeHtml(journalDaysWithEntry)} z ${escapeHtml(journalWindowDays)}</strong> ostatnich dni.`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#0e0d0b;background:#f5f2ec;padding:14px 18px;border-left:3px solid #E8432D;">${statLine} To rzadka konsekwencja — warto mu to powiedzieć wprost, zanim uzna, że nikt tego nie zauważa.</p>
    <p style="font-size:14px;line-height:1.6;color:#3a3830;">Nie chodzi o porównanie z resztą zespołu — to osobisty wynik, na który naprawdę pracował. Krótkie, bezpośrednie "widzę, że regularnie to robisz" potrafi zrobić więcej niż się wydaje.</p>
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz panel trenera</a></p>
  `;

  const statLineText = criterion === 'calendar'
    ? `${name} zrealizował ${calendarCompleted} z ${calendarTotal} zaplanowanych sesji w ostatnich tygodniach.`
    : `${name} zalogował wpis w Dzienniku w ${journalDaysWithEntry} z ${journalWindowDays} ostatnich dni.`;

  return {
    subject,
    html: wrapHtml({ title: 'Warto docenić', bodyHtml, footerHtml: coachDigestFooter() }),
    text: `${statLineText} To rzadka konsekwencja — warto mu to powiedzieć wprost.\n\nTo osobisty wynik, nie porównanie z resztą zespołu.\n\nOtwórz panel trenera: ${COACH_APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 10. focus_block_completed_strong — Grupa 3, NOWY ton. `segmentId`
//     opcjonalny (etykieta filaru/segmentu, jeśli znana wołającemu).
// ------------------------------------------------------------
function focusBlockCompletedStrongDigestEmail({ playerName, segmentId, completedCount, totalCount } = {}) {
  const name = playerName || 'Zawodnik';
  const segLabel = SEG_NAMES[segmentId] || segmentId || null;
  const subject = `${name} domknął Blok Skupienia z mocnym wynikiem`;

  const statLine = segLabel
    ? `${escapeHtml(name)} zamknął właśnie Blok Skupienia (${escapeHtml(segLabel)}) z wynikiem <strong>${escapeHtml(completedCount)}/${escapeHtml(totalCount)}</strong> zrealizowanych sesji.`
    : `${escapeHtml(name)} zamknął właśnie Blok Skupienia z wynikiem <strong>${escapeHtml(completedCount)}/${escapeHtml(totalCount)}</strong> zrealizowanych sesji.`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#0e0d0b;background:#f5f2ec;padding:14px 18px;border-left:3px solid #E8432D;">${statLine} Solidna, konsekwentna praca przez cały okres bloku.</p>
    <p style="font-size:14px;line-height:1.6;color:#3a3830;">Warto to zauważyć wprost — to właśnie ten rodzaj systematyczności, który realnie przekłada się na formę.</p>
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz panel trenera</a></p>
  `;

  const statLineText = segLabel
    ? `${name} zamknął Blok Skupienia (${segLabel}) z wynikiem ${completedCount}/${totalCount} zrealizowanych sesji.`
    : `${name} zamknął Blok Skupienia z wynikiem ${completedCount}/${totalCount} zrealizowanych sesji.`;

  return {
    subject,
    html: wrapHtml({ title: 'Mocno zamknięty Blok Skupienia', bodyHtml, footerHtml: coachDigestFooter() }),
    text: `${statLineText} Solidna, konsekwentna praca.\n\nWarto to zauważyć wprost.\n\nOtwórz panel trenera: ${COACH_APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 11. goal_achieved — Grupa 3, NOWY ton.
// ------------------------------------------------------------
function goalAchievedDigestEmail({ playerName, segmentId } = {}) {
  const name = playerName || 'Zawodnik';
  const segLabel = SEG_NAMES[segmentId] || segmentId || null;
  const subject = segLabel ? `${name} osiągnął cel — ${segLabel}` : `${name} osiągnął swój cel`;

  const statLine = segLabel
    ? `${escapeHtml(name)} właśnie osiągnął swój cel w obszarze <strong>${escapeHtml(segLabel)}</strong>.`
    : `${escapeHtml(name)} właśnie osiągnął swój cel.`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#0e0d0b;background:#f5f2ec;padding:14px 18px;border-left:3px solid #E8432D;">${statLine} Warto to zauważyć i pogratulować bezpośrednio, zanim zabraknie chwili.</p>
    <p style="font-size:14px;line-height:1.6;color:#3a3830;">Krótkie, osobiste "gratulacje" od trenera znaczy więcej niż jakiekolwiek powiadomienie w appce.</p>
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz panel trenera</a></p>
  `;

  const statLineText = segLabel
    ? `${name} właśnie osiągnął swój cel w obszarze ${segLabel}.`
    : `${name} właśnie osiągnął swój cel.`;

  return {
    subject,
    html: wrapHtml({ title: 'Cel osiągnięty', bodyHtml, footerHtml: coachDigestFooter() }),
    text: `${statLineText} Warto to zauważyć i pogratulować bezpośrednio.\n\nOtwórz panel trenera: ${COACH_APP_URL}\n`,
  };
}

// ------------------------------------------------------------
// 12-13. "Raporty w wybranych momentach" (Pakiet 20, 04.08.2026) —
// lib/coach-scheduled-reports.js. W ODRÓŻNIENIU od Digestu (zdarzeniowy)
// to mechanizm CZASOWY — trener sam wybrał moment, w którym chce dostać
// snapshot, niezależnie od tego czy coś się zmieniło. Ton neutralny/
// informacyjny (nie "sygnał", tylko "oto stan"), spójny z resztą systemu.
//
// ⚠️ ODTWORZONE 05.08.2026 — patrz nagłówek lib/coach-scheduled-reports.js
// po pełne wyjaśnienie: oryginał zniknął z dysku mimo dokumentacji "Na
// dysku, 44/44 testów przechodzi". Te dwie funkcje są odtworzeniem wg
// pełnej specyfikacji w claude/INTEGRACJA_RAPORTY_KRYTYCZNE_MOMENTY.md,
// sekcja 4 — nie bajt-w-bajt kopią oryginalnej treści (ta nigdy nie
// trafiła do Project Knowledge w pełnym brzmieniu).
// ------------------------------------------------------------
function coachScheduledReportFooter() {
  return 'Ten e-mail wysyła system Gamechange, bo włączyłeś go w panelu trenera, zakładka Ustawienia, ' +
    'sekcja "Raporty w wybranych momentach". Możesz go tam w każdej chwili wyłączyć.';
}

// 12. pre_match_team_briefing — wieczór przed meczem drużyny. Treść =
//     ten sam snapshot co get_pre_match_signals() (widok "Skład Meczowy"),
//     gating widoczności już wykonany PRZED wywołaniem tego szablonu
//     (patrz lib/coach-scheduled-reports.js) — świadomie NIE powtórzony tu.
function preMatchTeamBriefingEmail({ teamName, checkedCount, riskCount, riskPlayerNames } = {}) {
  const team = teamName || 'Twoja drużyna';
  const checked = checkedCount || 0;
  const risk = riskCount || 0;
  const names = (riskPlayerNames || []).map(escapeHtml).join(', ');
  const subject = risk > 0
    ? `Jutro mecz — ${risk} ${risk === 1 ? 'zawodnik wart' : 'zawodników wartych'} sprawdzenia — ${team}`
    : `Jutro mecz — skład bez sygnałów ryzyka — ${team}`;

  const riskLineHtml = risk > 0
    ? `<strong>${escapeHtml(risk)} z ${escapeHtml(checked)}</strong> sprawdzonych zawodników pokazuje dziś aktywny sygnał ryzyka: ${names}.`
    : `Żaden z <strong>${escapeHtml(checked)}</strong> sprawdzonych zawodników nie pokazuje dziś aktywnego sygnału ryzyka.`;
  const riskLineText = risk > 0
    ? `${risk} z ${checked} sprawdzonych zawodników pokazuje dziś aktywny sygnał ryzyka: ${(riskPlayerNames || []).join(', ')}.`
    : `Żaden z ${checked} sprawdzonych zawodników nie pokazuje dziś aktywnego sygnału ryzyka.`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">Drużyna: <strong>${escapeHtml(team)}</strong> gra jutro.</p>
    <p style="font-size:15px;line-height:1.6;color:#0e0d0b;background:#f5f2ec;padding:14px 18px;border-left:3px solid #E8432D;">${riskLineHtml}</p>
    <p style="font-size:13px;line-height:1.6;color:#9a9488;">Dokładnie to samo, co zobaczysz w widoku "Skład Meczowy" w panelu — ten e-mail to tylko przypomnienie, żeby nie trzeba było samemu otwierać appki wieczorem.</p>
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz Skład Meczowy</a></p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Przegląd przed meczem drużyny', bodyHtml, footerHtml: coachScheduledReportFooter() }),
    text: `Drużyna: ${team} gra jutro.\n\n${riskLineText}\n\nOtwórz Skład Meczowy: ${COACH_APP_URL}\n`,
  };
}

// 13. weekly_team_pulse — cotygodniowy puls, dzień wybrany przez trenera.
//     Świadomie lekka treść (ma się czytać w ~20 sekund) — patrz
//     dokument projektowy, sekcja 4.2, dlaczego team_overload NIE jest
//     tu powtórzone (dubluje Digest).
function weeklyTeamPulseEmail({ teamName, rosterCount, activePlayersCount, activeFocusBlocksCount } = {}) {
  const team = teamName || 'Twoja drużyna';
  const roster = rosterCount || 0;
  const active = activePlayersCount || 0;
  const blocks = activeFocusBlocksCount || 0;
  const pct = roster > 0 ? Math.round((active / roster) * 100) : 0;
  const subject = `Cotygodniowy puls drużyny — ${team}`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">Drużyna: <strong>${escapeHtml(team)}</strong></p>
    <p style="font-size:15px;line-height:1.6;color:#0e0d0b;background:#f5f2ec;padding:14px 18px;border-left:3px solid #E8432D;">
      <strong>${escapeHtml(active)} z ${escapeHtml(roster)}</strong> zawodników (${escapeHtml(pct)}%) miało w ostatnich 7 dniach jakikolwiek wpis w Dzienniku.<br>
      <strong>${escapeHtml(blocks)}</strong> ${blocks === 1 ? 'aktywny Blok Skupienia' : 'aktywnych Bloków Skupienia'} w drużynie dziś.
    </p>
    <p style="margin-top:20px;"><a href="${COACH_APP_URL}" style="display:inline-block;padding:12px 20px;background:#0e0d0b;color:#f5f2ec;text-decoration:none;font-size:14px;">Otwórz panel trenera</a></p>
  `;

  return {
    subject,
    html: wrapHtml({ title: 'Cotygodniowy puls drużyny', bodyHtml, footerHtml: coachScheduledReportFooter() }),
    text: `Drużyna: ${team}\n\n${active} z ${roster} zawodników (${pct}%) miało w ostatnich 7 dniach jakikolwiek wpis w Dzienniku.\n${blocks} ${blocks === 1 ? 'aktywny Blok Skupienia' : 'aktywnych Bloków Skupienia'} w drużynie dziś.\n\nOtwórz panel trenera: ${COACH_APP_URL}\n`,
  };
}

module.exports = {
  parentReportEmail, recommendationNotificationEmail, retentionReminderEmail, parentalPaymentConsentEmail,
  teamOverloadDigestEmail, playerRiskStandoutDigestEmail, playerWentQuietDigestEmail, playerNeverStartedDigestEmail,
  playerHighConsistencyDigestEmail, focusBlockCompletedStrongDigestEmail, goalAchievedDigestEmail,
  preMatchTeamBriefingEmail, weeklyTeamPulseEmail,
};
