// ============================================================
// GAMECHANGE — email_sender.js
// ============================================================
// Warstwa wysyłki e-maili, PROVIDER-AGNOSTYCZNA — cel: wybór dostawcy
// (Resend / Postmark / SendGrid / EmailJS) przez Kubę sprowadza się do
// (1) wklejenia klucza API w Vercel, (2) opcjonalnie jednej zmiennej
// EMAIL_PROVIDER, bez przepisywania żadnego wywołującego kodu (przyszły
// cron raportu dla rodzica — patrz api_cron_send_parent_reports.js w tym
// samym katalogu — i przyszłe powiadomienia e-mailowe, patrz STATUS_I_
// ROADMAPA: "e-mail jako kanał powiadomień na start pilotażu").
//
// WZORZEC ZGODNY Z RESZTĄ BACKENDU (celowo, nie przypadkiem):
// - Zmienne środowiskowe czytane WEWNĄTRZ funkcji, nie jako stałe modułu
//   — dokładnie ta sama zasada i to samo uzasadnienie co w
//   api_generate_recommendation.js (getAdminClient/callAnthropic): moduł
//   ładuje się raz per cold start, ale odczyt na żądanie jest odporny na
//   testy jednostkowe zmieniające process.env w trakcie działania procesu.
// - Brak klucza → czytelny, rzucany błąd zamiast cichego niepowodzenia —
//   ta sama filozofia co ANTHROPIC_API_KEY/CRON_SECRET.
// - Nigdy nie zakłada, KTÓRY dostawca zostanie wybrany — to świadomie
//   odłożona decyzja Kuby (patrz DECYZJE CZEKAJĄCE NA KUBĘ w
//   STATUS_I_ROADMAP_PILOTAZ). Resend jest dziś domyślny (prosty REST,
//   dobra dostarczalność, hojny darmowy tier), ale zamiana na inny
//   dostawcy to jedna nowa funkcja `sendVia<Dostawca>` + jeden wpis w
//   PROVIDERS niżej — zero zmian w kodzie wywołującym `sendEmail`.
//
// ŚWIADOMIE POZA TYM PLIKIEM:
// - Retry/kolejka przy błędzie wysyłki — na start pilotażu wystarczy,
//   że cron loguje błąd i spróbuje przy następnym uruchomieniu (ten sam
//   poziom prostoty co api_cron_settlement.js).
// - Śledzenie statusu doręczenia (webhooki dostawcy: bounced/opened) —
//   przedwczesne przy 1 klubie pilotażowym, łatwe do dodania później
//   bez zmiany tego interfejsu.
// ============================================================

// ------------------------------------------------------------
// Rejestr dostawców — dodanie nowego to jedna funkcja `sendVia...`
// (ten sam kształt argumentów co poniższe dwie) + jeden wpis tutaj.
// ------------------------------------------------------------
const PROVIDERS = {
  resend: sendViaResend,
  postmark: sendViaPostmark,
};

function getConfig() {
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  const apiKey = process.env.EMAIL_API_KEY;
  const fromAddress = process.env.EMAIL_FROM || 'Gamechange <no-reply@gamechange-app.vercel.app>';

  if (!PROVIDERS[provider]) {
    throw new Error(
      `email_sender: nieznany EMAIL_PROVIDER "${provider}". Obsługiwane dziś: ${Object.keys(PROVIDERS).join(', ')}. ` +
      `Dodanie kolejnego dostawcy (np. sendgrid/emailjs) wymaga jednej nowej funkcji sendVia<Dostawca> w tym pliku.`
    );
  }
  if (!apiKey) {
    throw new Error(
      `email_sender: EMAIL_API_KEY nie skonfigurowany — moduł wysyłki jest gotowy, brakuje tylko klucza ` +
      `dostawcy "${provider}" w zmiennych środowiskowych Vercel (ten sam wzorzec co ANTHROPIC_API_KEY/CRON_SECRET).`
    );
  }
  return { provider, apiKey, fromAddress };
}

// ------------------------------------------------------------
// sendEmail — JEDYNA funkcja, którą powinien wołać kod wywołujący
// (cron raportu dla rodzica, przyszłe powiadomienia). Nie importuje
// nikt bezpośrednio sendViaResend/sendViaPostmark spoza tego pliku.
//
// `to` może być pojedynczym adresem albo tablicą — ujednolicane niżej
// per-dostawca, bo Resend i Postmark oczekują różnych kształtów.
// ------------------------------------------------------------
async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!to) throw new Error('sendEmail: brak odbiorcy (to).');
  if (!subject) throw new Error('sendEmail: brak tematu (subject).');
  if (!html && !text) throw new Error('sendEmail: brak treści wiadomości (html lub text).');

  const { provider, apiKey, fromAddress } = getConfig();
  const send = PROVIDERS[provider];
  return send({ to, subject, html, text, replyTo, apiKey, from: fromAddress });
}

// ------------------------------------------------------------
// Resend (resend.com) — domyślny dostawca. Prosty REST, JSON in/out.
// ------------------------------------------------------------
async function sendViaResend({ to, subject, html, text, replyTo, apiKey, from }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      reply_to: replyTo || undefined,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { provider: 'resend', id: data.id };
}

// ------------------------------------------------------------
// Postmark (postmarkapp.com) — alternatywny dostawca, gdyby Kuba
// wybrał ten zamiast Resend. Uwaga API: token w nagłówku, nie Bearer;
// pola nazwane PascalCase (zgodnie z ich dokumentacją, nie błąd).
// ------------------------------------------------------------
async function sendViaPostmark({ to, subject, html, text, replyTo, apiKey, from }) {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': apiKey,
    },
    body: JSON.stringify({
      From: from,
      To: Array.isArray(to) ? to.join(',') : to,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      ReplyTo: replyTo || undefined,
    }),
  });

  if (!res.ok) {
    throw new Error(`Postmark API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { provider: 'postmark', id: data.MessageID };
}

module.exports = { sendEmail };
