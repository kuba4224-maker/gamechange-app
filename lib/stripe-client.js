// ============================================================
// GAMECHANGE — lib/stripe-client.js
// ============================================================
// NOWY PLIK (04.08.2026) — wyodrębnione z api/stripe-checkout.js, żeby
// api/cron-send-notifications.js (runParentalConsentExpiry, patrz tam)
// mogło wołać Stripe REST API (anulowanie subskrypcji + zwrot) bez
// duplikowania tej samej logiki w drugim pliku. api/stripe-checkout.js
// zaktualizowany, żeby importować stąd zamiast trzymać własną kopię —
// zachowanie identyczne, zero zmiany w tym, co już działało.
//
// Świadomie BEZ pakietu npm `stripe` (ten sam wybór co reszta integracji
// Stripe w tym projekcie) — REST API wołane wprost przez fetch().
// ============================================================

// ------------------------------------------------------------
// Wywołanie REST API Stripe. Domyślnie POST (tworzenie/aktualizacja
// zasobów), ale Stripe akceptuje też GET (odczyt, pola jako query string)
// i DELETE (np. anulowanie subskrypcji) na tych samych endpointach.
// Stripe oczekuje form-encoded body dla POST (NIE JSON), łącznie z
// zagnieżdżonymi polami w notacji "line_items[0][price]" — to samo dla
// query stringa przy GET.
// ------------------------------------------------------------
async function stripeRequest(path, fields, method = 'POST') {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY nie skonfigurowany w Vercel.');

  const encoded = new URLSearchParams(fields || {}).toString();
  const authHeader = `Basic ${Buffer.from(secretKey + ':').toString('base64')}`;

  let url = `https://api.stripe.com/v1/${path}`;
  const init = { method, headers: { Authorization: authHeader } };
  if (method === 'GET' || method === 'DELETE') {
    if (encoded) url += `?${encoded}`;
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encoded;
  }

  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || res.statusText;
    throw new Error(`Stripe API error (${method} ${path}): ${msg}`);
  }
  return data;
}

module.exports = { stripeRequest };
