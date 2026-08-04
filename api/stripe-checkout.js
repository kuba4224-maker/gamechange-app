// ============================================================
// GAMECHANGE — /api/stripe-checkout.js
// ============================================================
// NOWY PLIK (04.08.2026) — Integracja Stripe (K2), pełny opis/uzasadnienie:
// AUDYT SPOJNOSCI CALEGO PROJEKTU.md, sekcja K2. Realizuje Komponent A
// (tworzenie Checkout Session) i Komponent B (webhook) z tamtej specyfikacji.
//
// DWIE ROLE W JEDNYM PLIKU (świadomie, nie przez pomyłkę): folder api/ jest
// dziś dokładnie na limicie 12/12 funkcji Vercel Hobby (ten sam limit, który
// wcześniej zmusił Pakiety 1-4 tej sesji do wejścia przez lib/ zamiast
// nowych plików w api/, patrz komentarz w lib/coach-recommendation-loop.js)
// — dodanie DWÓCH nowych plików (create-checkout-session.js + stripe-
// webhook.js) przekroczyłoby limit. Rozróżnienie ról w runtime: obecność
// nagłówka `stripe-signature` = webhook (wołany przez Stripe), jego brak =
// tworzenie sesji Checkout (wołane przez nasz własny frontend). Jeśli
// kiedyś przejdziesz na Vercel Pro (limit znika), można to bez ryzyka
// rozdzielić z powrotem na dwa pliki — logika wewnątrz już jest podzielona
// na dwie niezależne funkcje (handleCreateCheckoutSession/handleWebhook).
//
// WAŻNE — bodyParser wyłączony dla CAŁEGO pliku (obu ról): webhook wymaga
// SUROWEGO body (bajt w bajt) do weryfikacji podpisu Stripe —
// JSON.stringify(JSON.parse(body)) nie gwarantuje identycznego zapisu, więc
// nie może przejść przez domyślny parser Vercela. Ścieżka tworzenia sesji
// Checkout też więc parsuje JSON ręcznie (readRawBody niżej) — to jedyny
// sposób, żeby oba tryby współistniały bezpiecznie w jednym pliku.
//
// ZALEŻNOŚCI — świadomie BEZ pakietu npm `stripe`: REST API Stripe wołane
// wprost przez fetch() (ten sam styl co reszta projektu przy zewnętrznych
// API, patrz callAnthropic() w generate-recommendation.js) i weryfikacja
// podpisu webhooka ręcznie przez wbudowany moduł `crypto` (HMAC-SHA256 —
// dokładnie ten algorytm, którego stripe-node używa wewnątrz). Zero nowej
// zależności do `npm install` przed wdrożeniem.
//
// ZMIENNE ŚRODOWISKOWE (Vercel), do ustawienia PRZED wdrożeniem:
//   STRIPE_SECRET_KEY        — z Dashboardu Stripe (Developers → API keys).
//   STRIPE_WEBHOOK_SECRET    — z Dashboardu Stripe, PO zarejestrowaniu
//                              webhooka (Developers → Webhooks → Add
//                              endpoint, URL: https://<domena>/api/stripe-checkout,
//                              zdarzenia: checkout.session.completed,
//                              customer.subscription.updated,
//                              customer.subscription.deleted).
//   STRIPE_PRICE_INDIVIDUAL  — price_id obiektu Price 39 zł/mies. (recurring, PLN).
//   STRIPE_PRICE_TEAM_BASIC  — price_id obiektu Price 19 zł/mies. (recurring, PLN).
//   APP_BASE_URL             — opcjonalne, domyślnie poniżej; adres, na który
//                              Stripe przekieruje po (nie)udanej płatności.
// Krok 0 przed pierwszym użyciem: w Stripe Dashboard ręcznie utworzyć te
// DWA obiekty Price — patrz AUDYT SPOJNOSCI CALEGO PROJEKTU.md, sekcja K2,
// "Krok 0 tego komponentu" — TYLKO dwa, nie trzy (drużynowy z dopłatą
// współdzieli Price 39 zł z indywidualnym, rozróżnienie żyje w
// `pricing_tier` po stronie Gamechange, nie w Stripe).
//
// CO ŚWIADOMIE NIE JEST TU ZROBIONE:
//   1. Przycisk/ekran "Przejdź na wersję płatną" wołający Komponent A —
//      żyje w asystent_app.html, pliku zamrożonym standing rule projektu
//      (wymaga świeżej, wyraźnej prośby Kuby w danej sesji). Ten plik jest
//      w pełni gotowy na wywołanie, ale nic dziś jeszcze go nie woła.
//      Gdy ten przycisk powstanie: MUSI dla zawodników <19 lat (patrz
//      lib/parental-payment-consent.js) zebrać e-mail rodzica i wysłać go
//      jako `parentEmail` w body — bez tego handleCreateCheckoutSession
//      niżej odrzuci żądanie (walidacja już wdrożona, patrz KROK NOWY 2
//      niżej).
//   2. Naprawa długości triala (14/21 dni zamiast sztywnych 30) w triggerze
//      `handle_new_user()` — to osobna migracja SQL (Krok 1 z K2), świadomie
//      NIE napisana w tej turze bez odczytania NAJPIERW aktualnej treści
//      tego triggera (Krok 0 tego projektu: nie nadpisywać na żywo czegoś,
//      czego się nie widziało) — patrz DO_ZROBIENIA_PRZEZ_KUBE.md.
//   3. Sam webhook nie jest jeszcze zarejestrowany w Stripe Dashboardzie —
//      to również krok do wykonania przez Kubę po wdrożeniu (patrz wyżej).
//
// NOWE (04.08.2026) — zgoda rodzica na płatność dla niepełnoletnich (K2 miał
// tę lukę: każde konto, w tym 13-17-latka, mogło dokończyć Checkout bez
// żadnej bramki). Pełny mechanizm: lib/parental-payment-consent.js,
// lib/email-templates.js (parentalPaymentConsentEmail), nowa tabela
// `payment_parental_consents` (INTEGRACJA_ZGODA_RODZICA_PLATNOSC_SQL.md),
// nowy rytm runParentalConsentExpiry w api/cron-send-notifications.js.
// Dwa punkty dotknięte w TYM pliku, oznaczone "NOWE" niżej.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { sendEmail } = require('../lib/email-sender');
const { parentalPaymentConsentEmail } = require('../lib/email-templates');
const { requiresParentalConsent, createConsentRequest } = require('../lib/parental-payment-consent');

module.exports.config = { api: { bodyParser: false } };

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------
// Weryfikacja podpisu webhooka Stripe, ręcznie (bez pakietu `stripe`).
// Format nagłówka Stripe-Signature: "t=<timestamp>,v1=<hex hmac>[,v0=...]".
// Podpisywany string to `${timestamp}.${rawBody}`, HMAC-SHA256 z
// STRIPE_WEBHOOK_SECRET jako kluczem — dokładnie ten mechanizm, którego
// stripe.webhooks.constructEvent() używa wewnątrz oficjalnego SDK.
// ------------------------------------------------------------
function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) throw new Error('Brak nagłówka stripe-signature.');
  const parts = {};
  signatureHeader.split(',').forEach(p => {
    const idx = p.indexOf('=');
    if (idx === -1) return;
    parts[p.slice(0, idx)] = p.slice(idx + 1);
  });
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) throw new Error('Nieprawidłowy format nagłówka stripe-signature.');

  // Tolerancja 5 minut na rozjazd zegara / replay — ten sam domyślny limit co w SDK Stripe.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > 300) throw new Error('Zdarzenie webhooka zbyt stare (możliwy replay) — odrzucone.');

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const computedSig = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  const a = Buffer.from(computedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Nieprawidłowy podpis webhooka.');
  }
}

// ------------------------------------------------------------
// Wywołanie REST API Stripe — WYODRĘBNIONE (04.08.2026) do lib/stripe-client.js,
// żeby api/cron-send-notifications.js (runParentalConsentExpiry) mogło go
// reużyć bez duplikacji. Zachowanie identyczne co poprzednia lokalna wersja.
// ------------------------------------------------------------
const { stripeRequest } = require('../lib/stripe-client');

// ------------------------------------------------------------
// ROLA 1 — tworzenie Checkout Session (Komponent A). Wołane przez nasz
// frontend, gdy zawodnik/rodzic klika "Przejdź na wersję płatną".
//
// AUTORYZACJA: ten sam trust boundary, już przyjęty gdzie indziej w tym
// projekcie (patrz submit-recommendation-feedback.js) — "caller zna userId
// zalogowanego zawodnika", bez pełnej weryfikacji access_token. Świadomie
// spójne z resztą projektu, nie nowy, słabszy wzorzec wymyślony tu.
// ------------------------------------------------------------
async function handleCreateCheckoutSession(req, res) {
  const rawBody = await readRawBody(req);
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch (e) {
    return res.status(400).json({ error: 'Nieprawidłowy JSON.' });
  }
  const { userId, pricingTier, parentEmail } = payload;
  if (!userId || !['individual', 'team_basic', 'team_upgraded'].includes(pricingTier)) {
    return res.status(400).json({ error: 'Brak userId albo nieprawidłowy pricingTier.' });
  }

  // 'team_basic' korzysta z Price 19 zł, 'individual' i 'team_upgraded'
  // (drużynowy z dopłatą) — z Price 39 zł. Rozróżnienie poziomu funkcji
  // żyje wyłącznie w pricing_tier po stronie Gamechange (K1), nie w Stripe.
  const priceId = pricingTier === 'team_basic'
    ? process.env.STRIPE_PRICE_TEAM_BASIC
    : process.env.STRIPE_PRICE_INDIVIDUAL;
  if (!priceId) {
    return res.status(500).json({ error: `Brak skonfigurowanego price_id w Vercel dla pricing_tier="${pricingTier}".` });
  }

  const supabase = getAdminClient();
  try {
    const { data: sub, error: subError } = await supabase
      .from('subscriptions')
      .select('id, subscriber_user_id, stripe_customer_id')
      .eq('subscriber_user_id', userId)
      .maybeSingle();
    if (subError) throw new Error(`fetch subscription: ${subError.message}`);
    if (!sub) return res.status(404).json({ error: 'Nie znaleziono subskrypcji dla tego użytkownika.' });

    // NOWE (04.08.2026) — zgoda rodzica na płatność, patrz nagłówek pliku i
    // lib/parental-payment-consent.js. Sprawdzone TU (przed utworzeniem
    // Checkout Session), żeby appka mogła od razu pokazać czytelny błąd
    // zamiast dopuszczać niepełnoletniego do ekranu płatności Stripe bez
    // zebranego e-maila rodzica — webhook niżej i tak by utworzył prośbę o
    // zgodę PO płatności, ale lepiej zebrać e-mail PRZED, nie gonić za nim
    // po fakcie.
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('birth_year')
      .eq('id', userId)
      .maybeSingle();
    if (userError) throw new Error(`fetch users.birth_year: ${userError.message}`);
    const needsParentalConsent = requiresParentalConsent(userRow ? userRow.birth_year : null);
    if (needsParentalConsent && (!parentEmail || !parentEmail.includes('@'))) {
      return res.status(400).json({
        error: 'parent_email_required',
        message: 'Ten zawodnik jest (albo może być) niepełnoletni — do przejścia na wersję płatną potrzebny jest e-mail rodzica/opiekuna.',
      });
    }

    const appUrl = process.env.APP_BASE_URL || 'https://asystent-gamechange.vercel.app';
    const fields = {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': userId,
      'metadata[pricing_tier]': pricingTier,
      success_url: `${appUrl}/asystent_app.html?checkout=success`,
      cancel_url: `${appUrl}/asystent_app.html?checkout=cancelled`,
    };
    if (needsParentalConsent) fields['metadata[parent_email]'] = parentEmail;
    // Jeśli mamy już stripe_customer_id z wcześniejszej sesji (np. trial,
    // który wcześniej zainicjował, ale nie dokończył płatności) — reużywamy
    // go, zamiast tworzyć duplikat klienta w Stripe. W przeciwnym razie
    // Stripe Checkout sam poprosi o e-mail podczas płatności.
    if (sub.stripe_customer_id) fields.customer = sub.stripe_customer_id;

    const session = await stripeRequest('checkout/sessions', fields);
    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    console.error('stripe-checkout: handleCreateCheckoutSession error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// ------------------------------------------------------------
// ROLA 2 — webhook (Komponent B). Wołane przez Stripe. Trzy zdarzenia,
// zgodnie z K2 (AUDYT SPOJNOSCI CALEGO PROJEKTU.md):
//   - checkout.session.completed — pierwsza udana płatność.
//   - customer.subscription.updated — każda zmiana statusu (np.
//     active → past_due przy nieudanej płatności) — status lustrzanie
//     odwzorowuje enum Stripe, zgodnie z tym, co Domena 10 zakładała.
//   - customer.subscription.deleted — anulowanie.
// Wszystkie trzy operacje są idempotentne (UPDATE po kluczu, nie INSERT) —
// bezpieczne, jeśli Stripe kiedyś dostarczy to samo zdarzenie dwa razy
// (ich własna, udokumentowana możliwość "at least once delivery").
// ------------------------------------------------------------
async function handleWebhook(req, res) {
  const rawBody = await readRawBody(req);
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Brak STRIPE_WEBHOOK_SECRET w Vercel.' });

  try {
    verifyStripeSignature(rawBody, req.headers['stripe-signature'], secret);
  } catch (e) {
    console.error('stripe-checkout: nieprawidłowy podpis webhooka:', e.message);
    return res.status(400).json({ error: e.message });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Nieprawidłowy JSON w zdarzeniu.' });
  }

  const supabase = getAdminClient();
  try {
    const obj = (event.data && event.data.object) || {};

    if (event.type === 'checkout.session.completed') {
      const userId = obj.metadata && obj.metadata.user_id;
      const pricingTier = obj.metadata && obj.metadata.pricing_tier;
      const parentEmail = obj.metadata && obj.metadata.parent_email;
      if (!userId) {
        console.error('stripe-checkout: checkout.session.completed bez metadata.user_id, sesja', obj.id);
        return res.status(200).json({ ok: true, skipped: 'brak user_id w metadanych' });
      }
      const updateFields = {
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.subscription,
        status: 'active',
      };
      if (pricingTier) updateFields.pricing_tier = pricingTier;

      const { error } = await supabase
        .from('subscriptions')
        .update(updateFields)
        .eq('subscriber_user_id', userId);
      if (error) throw new Error(`update subscriptions (checkout.session.completed): ${error.message}`);

      // NOWE (04.08.2026) — zgoda rodzica na płatność. Dostęp jest już
      // aktywny (UPDATE wyżej) — zgodnie z KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md
      // sekcja 2.5 punkt 3, zawodnik korzysta od razu, ta prośba to
      // RÓWNOLEGŁA, formalna warstwa prawna, nie blokada dostępu. Świadomie
      // NIE przerywa całego webhooka, jeśli e-mail się nie wyśle (subskrypcja
      // ma już zostać aktywna niezależnie) — błąd tylko logowany.
      if (parentEmail) {
        try {
          const consent = await createConsentRequest(supabase, {
            userId,
            parentEmail,
            pricingTier: pricingTier || 'individual',
            stripeSubscriptionId: obj.subscription,
          });
          const appUrl = process.env.APP_BASE_URL || 'https://asystent-gamechange.vercel.app';
          const confirmUrl = `${appUrl}/potwierdz-platnosc.html?token=${consent.consent_token}&action=confirmed`;
          const declineUrl = `${appUrl}/potwierdz-platnosc.html?token=${consent.consent_token}&action=declined`;

          const { data: userRow } = await supabase
            .from('users')
            .select('full_name')
            .eq('id', userId)
            .maybeSingle();

          const { subject, html, text } = parentalPaymentConsentEmail({
            playerName: userRow ? userRow.full_name : null,
            pricingTier: pricingTier || 'individual',
            confirmUrl,
            declineUrl,
            expiresAt: consent.expires_at,
          });
          await sendEmail({ to: parentEmail, subject, html, text });
        } catch (consentErr) {
          console.error('stripe-checkout: nie udało się utworzyć/wysłać prośby o zgodę rodzica:', consentErr);
        }
      }

    } else if (event.type === 'customer.subscription.updated') {
      const updateFields = { status: obj.status };
      if (obj.current_period_end) {
        updateFields.current_period_end = new Date(obj.current_period_end * 1000).toISOString();
      }
      const { error } = await supabase
        .from('subscriptions')
        .update(updateFields)
        .eq('stripe_subscription_id', obj.id);
      if (error) throw new Error(`update subscriptions (customer.subscription.updated): ${error.message}`);

    } else if (event.type === 'customer.subscription.deleted') {
      const { error } = await supabase
        .from('subscriptions')
        .update({ status: 'canceled' })
        .eq('stripe_subscription_id', obj.id);
      if (error) throw new Error(`update subscriptions (customer.subscription.deleted): ${error.message}`);
    }
    // Inne typy zdarzeń — świadomie ignorowane (200 OK). Stripe wysyła
    // dziesiątki typów zdarzeń; nasłuchujemy tylko na te, które faktycznie
    // zmieniają stan subskrypcji w Gamechange.

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('stripe-checkout: błąd przetwarzania webhooka', event.type, e);
    // 500 → Stripe automatycznie ponowi próbę (retry) zgodnie ze swoim
    // standardowym zachowaniem — bezpieczne, wszystkie operacje wyżej są
    // idempotentne.
    return res.status(500).json({ error: e.message });
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.headers['stripe-signature']) {
    return handleWebhook(req, res);
  }
  return handleCreateCheckoutSession(req, res);
};

// dopisane wyłącznie po to, żeby dało się pokryć testem weryfikację podpisu
// webhooka (patrz tests/test-stripe-checkout.js) — funkcja bezpieczeństwa,
// warta bezpośredniego testu jednostkowego, zero zmiany zachowania.
module.exports._internal = { verifyStripeSignature };
