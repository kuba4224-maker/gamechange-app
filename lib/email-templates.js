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
// ------------------------------------------------------------
function parentReportEmail({ report, unsubscribeUrl }) {
  const playerName = report.player_name || 'Twoje dziecko';
  const goal = report.priority_goal;
  const goalLine = goal
    ? `Priorytetowy cel tego okresu: <strong>${escapeHtml(SEG_NAMES[goal.segment_id] || goal.segment_id)}</strong>` +
      (goal.horizon_weeks ? ` (typowy horyzont: ok. ${escapeHtml(goal.horizon_weeks)} tyg. cierpliwości, zanim efekt będzie widoczny).` : '.')
    : 'Brak dziś ustawionego priorytetowego celu.';

  const subject = `Raport Gamechange — ${playerName}`;

  const bodyHtml = `
    <p style="font-size:15px;line-height:1.6;color:#3a3830;">Krótkie podsumowanie ostatniego okresu pracy ${escapeHtml(playerName)} w Gamechange — bez szczegółów dziennika, tylko ogólny obraz.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#3a3830;">${goalLine}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#3a3830;">Aktywnych celów: <strong>${escapeHtml(report.active_goals_count ?? 0)}</strong></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#3a3830;">Sesji treningowych zalogowanych w ostatnich 7 dniach: <strong>${escapeHtml(report.recent_training_sessions_7d ?? 0)}</strong></td></tr>
      <tr><td style="padding:10px 0;font-size:14px;color:#3a3830;">Meczów w ostatnich 30 dniach: <strong>${escapeHtml(report.recent_matches_30d ?? 0)}</strong></td></tr>
    </table>
    <p style="font-size:13px;color:#9a9488;">To zwięzły, ogólny obraz — szczegóły (dziennik, samopoczucie, rozmowy z asystentem AI) widzi wyłącznie ${escapeHtml(playerName)} w swoim koncie, zgodnie z zasadą, że to Jego/Jej narzędzie do samodzielnej pracy nad formą.</p>
  `;

  const footerHtml = unsubscribeUrl
    ? `Nie chcesz już dostawać tego raportu? <a href="${escapeHtml(unsubscribeUrl)}" style="color:#9a9488;">Wypisz się jednym kliknięciem</a> — bez logowania.`
    : '';

  return {
    subject,
    html: wrapHtml({ title: `Raport postępów — ${playerName}`, bodyHtml, footerHtml }),
    text:
      `Raport Gamechange — ${playerName}\n\n` +
      `${goal ? `Priorytetowy cel: ${SEG_NAMES[goal.segment_id] || goal.segment_id}` + (goal.horizon_weeks ? ` (ok. ${goal.horizon_weeks} tyg. horyzontu)` : '') : 'Brak dziś ustawionego priorytetowego celu.'}\n` +
      `Aktywnych celów: ${report.active_goals_count ?? 0}\n` +
      `Sesji treningowych (7 dni): ${report.recent_training_sessions_7d ?? 0}\n` +
      `Meczów (30 dni): ${report.recent_matches_30d ?? 0}\n\n` +
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

module.exports = { parentReportEmail, recommendationNotificationEmail };
