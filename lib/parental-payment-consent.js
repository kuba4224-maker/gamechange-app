// ============================================================
// GAMECHANGE — lib/parental-payment-consent.js
// ============================================================
// NOWY PLIK (04.08.2026) — Model zgody rodzica na PŁATNOŚĆ dla niepełnoletnich
// zawodników (Kodeks cywilny art. 15/17/18/19, próg 18 lat — NIE mylić z
// progiem RODO 16 lat / `parental_consent` na zgodę na DANE, Funkcja 17,
// osobny, już istniejący mechanizm). Pełna specyfikacja prawna i uzasadnienie:
// `KOLEJKA DECYZJI I PROJEKTOWANIA.md`, sekcja 2 (2.1-2.5) — wersja PEŁNA
// (2.5: token + 14-dniowy termin + automatyczny zwrot), POTWIERDZONA jako
// jedyna, docelowa wersja (2.6, wersja lean, świadomie odrzucona).
//
// DLACZEGO TERAZ: K2 (Stripe Checkout, api/stripe-checkout.js) już pozwala
// KAŻDEMU kontu — w tym 13-17-latkowi — dokończyć realną płatność bez
// żadnej bramki zgody rodzica. To realna luka prawna (art. 18 KC — umowa
// bez potwierdzenia rodzica jest w "bezskuteczności zawieszonej"), którą
// ten plik zamyka, ZANIM przycisk płatności w asystent_app.html (wciąż
// zablokowany standing rule projektu, czeka na świeżą prośbę Kuby) w ogóle
// zacznie być używany przez prawdziwych, płacących nastolatków.
//
// MECHANIZM (dokładnie wg sekcji 2.5):
//   1. Zawodnik <18 lat kończy Stripe Checkout — dostęp aktywuje się OD RAZU
//      (webhook checkout.session.completed w api/stripe-checkout.js, bez
//      zmian w tej logice — to świadomie zgodne z 2.5 punkt 3: "w okresie
//      oczekiwania zawodnik może od razu korzystać").
//   2. RÓWNOLEGLE (ten plik): jeśli metadane sesji Checkout niosą e-mail
//      rodzica (bo frontend, gdy powstanie, wykrył wiek <18 i go zebrał),
//      tworzony jest wiersz `payment_parental_consents` (status='pending',
//      termin 14 dni) + wysyłany e-mail z tokenem do rodzica.
//   3. Rodzic potwierdza w terminie → nic więcej się nie dzieje, płatność
//      zostaje ważna retroaktywnie (RPC `respond_payment_parental_consent`,
//      SQL, patrz INTEGRACJA_ZGODA_RODZICA_PLATNOSC_SQL.md).
//   4. Rodzic odmawia ALBO termin mija bez odpowiedzi → dostęp wygasa,
//      subskrypcja w Stripe anulowana, próba automatycznego zwrotu ostatniej
//      opłaty — patrz runParentalConsentExpiry() w api/cron-send-notifications.js.
//
// ŚWIADOMIE KONSERWATYWNE liczenie wieku: `users.birth_year` to jedyne, co
// appka dziś zbiera (rok, NIE pełna data urodzenia) — patrz f-profile-
// birth-year w asystent_app.html. computed = bieżący_rok - birth_year jest
// zawsze GÓRNYM ograniczeniem prawdziwego wieku (ktoś, kto jeszcze nie miał
// urodzin w tym roku, ma realnie o rok MNIEJ niż computed). Stąd bezpieczna
// reguła: computed >= 19 GWARANTUJE pełnoletność (nawet dolna granica
// computed-1 to wciąż 18+); computed <= 18 może oznaczać realny wiek 17 ALBO
// 18 — w obu przypadkach wymagana zgoda. Brak birth_year w ogóle (profil
// nieuzupełniony) traktowany tak samo jak niepełnoletność — nigdy nie
// zakładamy dorosłości, gdy nie wiemy. Do zaostrzenia (mniej fałszywych
// alarmów), gdyby appka kiedyś zaczęła zbierać pełną datę urodzenia zamiast
// samego rocznika — nie teraz, poza zakresem tej zmiany.
// ============================================================

const CONSENT_WINDOW_DAYS = 14;

function computeAgeUpperBound(birthYear, now = new Date()) {
  if (birthYear == null || Number.isNaN(Number(birthYear))) return null;
  return now.getUTCFullYear() - Number(birthYear);
}

// true = appka MUSI zebrać e-mail rodzica i uruchomić ten mechanizm przed/przy płatności.
function requiresParentalConsent(birthYear, now = new Date()) {
  const ageUpperBound = computeAgeUpperBound(birthYear, now);
  if (ageUpperBound == null) return true; // brak danych — bezpieczny domyślny wybór
  return ageUpperBound < 19;
}

function generateConsentToken() {
  // Ten sam poziom losowości co inne tokeny bez logowania w tym projekcie
  // (session_bridge_codes, followups.response_token) — 24 bajty losowe,
  // zakodowane hex (48 znaków), generowane w JS (nie DEFAULT w Postgresie,
  // świadomie: brak pewności, czy pgcrypto/gen_random_bytes jest włączone
  // na tym projekcie Supabase, a to nie jest coś, co da się sprawdzić z tego
  // środowiska — patrz ograniczenie dostępu sieciowego opisane wielokrotnie
  // gdzie indziej w tej sesji).
  const crypto = require('crypto');
  return crypto.randomBytes(24).toString('hex');
}

// ------------------------------------------------------------
// Wołane z api/stripe-checkout.js (handleWebhook, checkout.session.completed)
// gdy metadane sesji niosą parent_email (frontend wykrył niepełnoletniość).
// Tworzy wiersz + zwraca token (do zbudowania linku e-maila przez wywołującego
// — ten plik świadomie nie zna adresu appki/domeny, ten sam podział
// odpowiedzialności co reszta lib/*.js w tym projekcie).
// ------------------------------------------------------------
async function createConsentRequest(supabase, { userId, parentEmail, pricingTier, stripeSubscriptionId, now = new Date() }) {
  if (!userId || !parentEmail || !pricingTier) {
    throw new Error('createConsentRequest: brak userId/parentEmail/pricingTier.');
  }
  const token = generateConsentToken();
  const expiresAt = new Date(now.getTime() + CONSENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('payment_parental_consents')
    .insert({
      user_id: userId,
      parent_email: parentEmail,
      consent_token: token,
      pricing_tier: pricingTier,
      stripe_subscription_id: stripeSubscriptionId || null,
      status: 'pending',
      requested_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select('id, consent_token, expires_at')
    .single();
  if (error) throw new Error(`createConsentRequest insert: ${error.message}`);
  return data;
}

module.exports = {
  CONSENT_WINDOW_DAYS,
  computeAgeUpperBound,
  requiresParentalConsent,
  generateConsentToken,
  createConsentRequest,
};
