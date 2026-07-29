// ============================================================
// GAMECHANGE — send-push.js (do wdrożenia: /api/send-push.js w repo gamechange-app)
// ============================================================
// Warstwa wysyłki powiadomień push — BEZPOŚREDNIE FCM (firebase-admin),
// NIE przekaźnik Expo Push Service. Decyzja opisana i uzasadniona w
// APLIKACJA_MOBILNA_ARCHITEKTURA_I_RYZYKA.md, sekcja 6.3: pełna kontrola
// nad ścieżką dostarczenia, zero dodatkowego dostawcy w krytycznej
// ścieżce, zero niespodzianek kosztowych przy skalowaniu. Ten sam wzorzec
// modułu co api_email_sender.js w tym samym katalogu: JEDNA eksportowana
// funkcja (`sendPush`), wołana IN-PROCESS przez cron-send-notifications.js
// (patrz api_cron_send_notifications.js), zero HTTP między funkcjami
// Vercel (ten sam powód co przy generateRecommendation() w
// api_submit_recommendation_feedback.js — nie trzeba przekazywać
// sekretu między funkcjami).
//
// KONFIGURACJA WYMAGANA (Krok 4.1-4.4 checklisty migracji mobilnej, [KUBA]):
// - Projekt Firebase z dodaną aplikacją Android + iOS (google-services.json
//   / GoogleService-Info.plist trafiają do repo MOBILNEGO, nie tego).
// - Klucz .p8 APNs wgrany do Firebase Console → Cloud Messaging → iOS.
// - Konto serwisowe Firebase (Firebase Console → Project Settings →
//   Service Accounts → Generate new private key) — JSON klucza wklejony
//   do zmiennej środowiskowej FIREBASE_SERVICE_ACCOUNT_JSON w Vercel
//   (całość jako jeden string, ten sam wzorzec co pozostałe sekrety w tym
//   projekcie — SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, EMAIL_API_KEY).
//
// ŚWIADOMIE POZA TYM PLIKIEM:
// - Retry przy błędzie wysyłki pojedynczego tokenu — cron loguje błąd i
//   nie ponawia w tym samym przebiegu (ten sam poziom prostoty co
//   email-sender.js/cron-send-parent-reports.js na start pilotażu).
// - Usuwanie tokenów, dla których FCM zwraca "unregistered"/"invalid" —
//   dziś tylko logowane i zwracane w `invalidTokens`, NIE usuwane
//   automatycznie z push_tokens. Do rozważenia w kolejnym przebiegu, żeby
//   tabela nie rosła martwymi tokenami; świadomie odłożone teraz.
//
// WDROŻONE: 29.07.2026, przez Cowork samodzielnie w przeglądarce (GitHub).
// Wymaga `npm install firebase-admin` w repo gamechange-app przed
// pierwszym użyciem (Vercel zrobi to automatycznie z package.json, jeśli
// firebase-admin jest tam dodany — SPRAWDZIĆ przy pierwszym deployu).
// ============================================================

const admin = require('firebase-admin');

let appInstance = null;

function getFirebaseApp() {
  if (appInstance) return appInstance;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'send_push: FIREBASE_SERVICE_ACCOUNT_JSON nie skonfigurowany — moduł wysyłki jest gotowy, ' +
      'brakuje tylko klucza konta serwisowego Firebase w zmiennych środowiskowych Vercel ' +
      '(Firebase Console → Project Settings → Service Accounts → Generate new private key, ' +
      'wklej całą treść JSON jako wartość tej zmiennej — ten sam wzorzec co SUPABASE_SERVICE_ROLE_KEY).'
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error('send_push: FIREBASE_SERVICE_ACCOUNT_JSON nie jest poprawnym JSON-em: ' + e.message);
  }

  appInstance = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return appInstance;
}

// ------------------------------------------------------------
// sendPush — JEDYNA funkcja, którą powinien wołać kod wywołujący
// (cron-send-notifications.js). Przyjmuje JEDEN token albo tablicę
// tokenów (te same surowe tokeny urządzenia zapisane w push_tokens.token
// przez klienta — patrz lib/push-notifications.ts w repo mobilnym —
// NIE tokeny Expo Push Service, to inny format).
//
// Zwraca { successCount, failureCount, invalidTokens } — invalidTokens to
// lista tokenów, dla których FCM zwrócił błąd wskazujący na
// odinstalowaną/nieaktualną rejestrację — wywołujący kod MOŻE (nie musi
// dziś) użyć tej listy do posprzątania push_tokens; patrz TODO w nagłówku.
// ------------------------------------------------------------
async function sendPush(tokens, { title, body, data } = {}) {
  if (!title || !body) throw new Error('sendPush: brak title/body powiadomienia.');
  const tokenList = Array.isArray(tokens) ? tokens : [tokens];
  if (tokenList.length === 0) return { successCount: 0, failureCount: 0, invalidTokens: [] };

  getFirebaseApp();
  const messaging = admin.messaging();

  // Dane muszą być stringami dla FCM (data payload to Record<string,string>).
  const stringData = data
    ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
    : undefined;

  const message = {
    notification: { title, body },
    data: stringData,
    tokens: tokenList,
  };

  const result = await messaging.sendEachForMulticast(message);

  const invalidTokens = [];
  result.responses.forEach((resp, i) => {
    if (!resp.success) {
      const code = resp.error && resp.error.code;
      console.error(`send_push: błąd wysyłki do tokenu ${tokenList[i]}:`, code, resp.error && resp.error.message);
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        invalidTokens.push(tokenList[i]);
      }
    }
  });

  return { successCount: result.successCount, failureCount: result.failureCount, invalidTokens };
}

module.exports = { sendPush };
