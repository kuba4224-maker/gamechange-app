// ============================================================
// GAMECHANGE — /api/generate-recommendation.js
// ============================================================
// SZKIELET SILNIKA AI CENTRUM DECYZJI (Domena 06 — Funkcje koncepcyjne
// F3 "Co dziś zrobić?", F8 "Gotowość" most do specjalisty, F23 feedback
// i eskalacja).
//
// CO TEN PLIK ROBI:
//   1. Kontrola kosztów (dokładnie reguły z ASYSTENT_SPORTOWCA_ARCHITEKTURA
//      _TECHNICZNA.md, sekcja "Kontrola kosztów") — sprawdzana PRZED
//      jakimkolwiek płatnym wywołaniem AI.
//   2. Zbiera kontekst zawodnika (profil, Dziennik, ból, kontekst meczowy,
//      ANKIETA/DIAGNOZA i obserwacje trenera/rodzica — patrz POPRAWKA
//      niżej) i wstrzykuje właściwy wpis z `knowledge_base_entries` do
//      prompta.
//   3. Woła Anthropic API (miejsce jasno oznaczone — dziś zwróci czytelny
//      błąd, bo ANTHROPIC_API_KEY jeszcze nie ustawiony, patrz DO ZROBIENIA
//      PRZEZ KUBĘ w architekturze).
//   4. Zapisuje wynik do `decision_recommendations` w dokładnie takim
//      kształcie, jakiego już oczekuje gotowy, przetestowany frontend
//      (Czwarty ekran — Centrum Decyzji w asystent_app.html).
//
// ------------------------------------------------------------
// PODPOWIEDZI SILNIK A4 (08.08.2026, runda 4, pas A) — silnik przestaje
// opierać się wyłącznie na ogólnej wiedzy modelu i jednym akapicie z
// `knowledge_base_entries`. Doszła trzecia warstwa: `component_hints`
// (214 podpowiedzi z materiałów Kuby, każda z numerem strony), czytana
// przez `lib/recommendation-hints.js` i wstrzykiwana jako OSOBNA, nazwana
// sekcja promptu obok bazy wiedzy. Jedna wybrana podpowiedź jedzie razem
// z rekomendacją do `decision_recommendations.source_hint`, żeby zawodnik
// zobaczył ją na ekranie (reguła R1) — pas B buduje wyświetlanie.
// Domyka lukę 4e z `claude/AUDYT_BAZY_WIEDZY_REKOMENDACJI.md`.
// Przy braku tabeli / rocznika / Elementu celu silnik zachowuje się
// DOKŁADNIE tak jak przed tą zmianą, ale każdy taki stan ma własną nazwę
// w logu (reguła R5 — bez cichej pustki).
//
// ------------------------------------------------------------
// POPRAWKA (25.07.2026, wieczór — decyzja Kuby ws. ankiety jako wejścia
// do systemu): "jeżeli da się zbudować diagnozę... to chciałbym to
// zrobić... ankieta niech się stanie na razie gotowym wejściem do
// systemu... będą już w systemie pierwsze rekomendacje wynikające
// z wypełnionej ankiety."
//
// PRZED tą poprawką fetchPlayerContext() czytał WYŁĄCZNIE
// player_profiles/daily_logs/pain_entries/match_contexts — mimo że
// Domena 15 (most kont legacy) od dawna łączy `diagnostics` i
// `player_insights` z user_id przy tworzeniu konta, silnik rekomendacji
// nigdy tych dwóch tabel nie odczytywał. Efekt: nawet zawodnik z bogatą,
// świeżo powiązaną diagnozą dostawałby rekomendację wyłącznie na bazie
// Dziennika/bólu/meczów — czyli faktycznie od zera, dokładnie to czego
// Kuba chciał uniknąć ("nie chciałbym stracić algorytmów/danych z
// ankiety... chciałbym je wykorzystać w logice pełnego systemu").
//
// Naprawa: fetchPlayerContext() teraz dodatkowo pobiera (a) najnowszą
// powiązaną diagnozę (diagnostics, po user_id) i (b) aktywne (≤90 dni,
// ten sam próg i uzasadnienie co INSIGHT_MAX_AGE_DAYS w index.html)
// player_insights. computeRelativeDeficits() świadomie duplikuje
// getRelativeDeficits() z index.html — ten sam wzorzec i to samo
// uzasadnienie co przy SEG_NAMES w recommendation_engine.js (Marketplace):
// utrzymanie identycznej, niewielkiej logiki w dwóch miejscach jest
// tańsze niż sprzęganie dwóch osobnych aplikacji współdzielonym kodem
// frontendowym. Jeśli kiedyś próg/wzór w index.html się zmieni, trzeba
// pamiętać o ręcznej synchronizacji tutaj — dokładnie tak jak już dziś
// przy SEG_NAMES.
// ------------------------------------------------------------
//
// POPRAWKA (26.07.2026 — decyzja Kuby "wszystko na tak" na mapowanie
// segment→kategoria specjalisty ORAZ na progi Gotowości/horizon_weeks,
// patrz claude/MAPOWANIE_SEGMENTOW_KATEGORIE_MARKETPLACE.md i
// claude/PRZEGLAD_PROGOW_GOTOWOSCI_I_HORIZON_WEEKS.md):
//   1. Dodano SEGMENT_TO_SPECIALIST_CATEGORY + INJURY_MODE_OVERRIDE_CATEGORY
//      (poprawiona wersja mapowania z guided_match.html — regeneracja i
//      odpornosc przesunięte z physiotherapy na nutrition) i wypełnianie
//      kolumny decision_recommendations.suggested_specialist_category,
//      która od Domeny 11 istniała, ale nigdy nie była zapisywana (patrz
//      claude/asystent_sportowca_11_marketplace_linkage.sql).
//   2. Dodano computeReadinessSignals() — live-computation wymiaru
//      FIZYCZNEGO i MENTALNEGO Funkcji 8 (Gotowość), wstrzykiwane jako
//      kontekst narracyjny do promptu AI w buildUserPrompt(). Wymiar
//      MECZOWY i A3 (ACWR) świadomie NIE zaimplementowane — patrz
//      komentarz przy computeReadinessSignals() niżej i sekcja "CO
//      ŚWIADOMIE NIE JEST TU ZROBIONE" na końcu pliku.
// ------------------------------------------------------------
//
// POPRAWKA (03.08.2026 wieczór — decyzja Kuby o formacie
// match_context_answers.response_value, KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md
// 3.1, POTWIERDZONA 01.08.2026: kody WŁASNE per segment, nie generyczny
// enum; walidacja formatu na poziomie appki, nie CHECK świadomy segmentu):
//   Naprawia znalezisko #6 z syntezy Filtra Jakości
//   (FILTR_JAKOSCI_POLECENIE_NOWA_SESJA.md): "match_context_answers nie
//   czytane przez silnik rekomendacji — fetchPlayerContext nie odpytuje
//   tej tabeli". Tryb Mecz sam w sobie już działa end-to-end i zapisuje tę
//   tabelę (potwierdzone na żywym urządzeniu 29.07.2026, patrz
//   claude/KONTRAKT_MECZ.md, Krok 5 GATE) — ale silnik rekomendacji nigdy
//   tych danych nie czytał, więc leżały martwe we własnej tabeli.
//   1. fetchPlayerContext() dodatkowo pobiera fetchRecentMatchContextAnswers()
//      (ostatnie 15 odpowiedzi z kaskady meczowej) — wstrzykiwane do
//      promptu AI w buildUserPrompt() jako surowy, oznaczony kontekst
//      (ten sam wzorzec co OBSERWACJE TRENERA/RODZICA), z legendą która
//      grupa kodów jest niekorzystna a która nie.
//   2. `match_contexts` w fetchPlayerContext() dodatkowo pobiera kolumny
//      dodane przy przeprojektowaniu Meczu (self_rating, mental_state,
//      entered_recovery_state, demanding_conditions, position_played_today,
//      free_note) — istniały w bazie i w danych od 29.07.2026, ale nigdy
//      nie były odczytywane tutaj, więc `JSON.stringify(recentMatches)` w
//      promptcie AI był uboższy niż faktyczny stan wiersza.
//   3. Dodano computeMatchReadinessSignal()/buildMatchReadinessNarrative()
//      — WYMIAR MECZOWY Gotowości (Funkcja 8), wcześniej świadomie
//      nie zaimplementowany (patrz POPRAWKA 26.07.2026 wyżej) właśnie z
//      powodu braku decyzji o formacie response_value. V1, prosta
//      heurystyka jak reszta progów Gotowości (MATCH_NEGATIVE_OUTCOME_CODES,
//      zestawione wprost z banku pytań w
//      TRYB_MECZU_PRZEPROJEKTOWANIE_DECYZJE.md, punkt 10) — do korekty,
//      jeśli intuicja trenerska mówi inaczej.
// ------------------------------------------------------------
//
// CO ŚWIADOMIE NIE JEST TU ZROBIONE (świadomie odłożone, nie przeoczone
// — patrz sekcja na końcu pliku "CO ŚWIADOMIE NIE JEST TU ZROBIONE"):
//   - Detekcja KIEDY wygenerować training_focus (rotacja celu priorytetowego
//     z Funkcji 2, "priorytet rotuje dynamicznie").
//   - Live-computation Gotowości, wymiar FIZYCZNY i MENTALNY (Funkcja 8) —
//     ZAIMPLEMENTOWANE 26.07.2026 (patrz computeReadinessSignals() niżej,
//     zaakceptowane przez Kubę w claude/PRZEGLAD_PROGOW_GOTOWOSCI_I_
//     HORIZON_WEEKS.md). Wymiar MECZOWY — ZAIMPLEMENTOWANY 03.08.2026
//     (patrz POPRAWKA wyżej i computeMatchReadinessSignal() niżej).
//     Świadomie NIE zaimplementowane: wykrywanie wzorca bólu
//     (pain_pattern_match) — osobny, jeszcze nie zaprojektowany mechanizm.
//   - Automatyczne wyzwolenie eskalacji po 3+ odrzuceniach z rzędu.
//   - Cron/harmonogram wywołujący ten silnik okresowo dla zawodników z
//     JUŻ aktywnym celem (patrz jednak api_cron_onboard_diagnosis.js —
//     to jest cron, ale tylko dla PIERWSZEJ rekomendacji po ankiecie,
//     nie dla bieżącej rotacji).
// Ten plik zakłada, że coś innego (na razie nieistniejące, poza wyjątkiem
// wyżej) już zdecydowało CO i DLACZEGO wygenerować, i przekazuje mu
// gotowe parametry.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

// PODPOWIEDZI SILNIK A4 08.08.2026 — trzecia warstwa wiedzy obok
// `knowledge_base_entries` (akapit na segment) i `segment_components`
// (taksonomia dla UI): 214 atomowych podpowiedzi z materiałów Kuby, każda
// z numerem strony. Domyka lukę 4e z AUDYT_BAZY_WIEDZY_REKOMENDACJI.md.
// Cała logika mieszka w lib/ — ograniczenie O1 (api/ ma 12 z 12 plików).
const {
  loadHintsForRecommendation,
  buildHintPromptBlock,
  pickShowcaseHint,
  isMissingColumnError,
} = require('../lib/recommendation-hints.js');

// ------------------------------------------------------------
// KONFIGURACJA — zmienne środowiskowe Vercel, ta sama konwencja
// nazewnicza co w Marketplace (patrz MARKETPLACE_CHECKLISTA_WDROZENIA.md,
// Krok 4): SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY już tam opisane.
// Nowe w tym pliku: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (opcjonalne,
// z sensownym domyślnym), DECISION_ENGINE_SECRET (nowy, patrz niżej).
// ------------------------------------------------------------
// UWAGA CELOWA: wszystkie odczytywane niżej jako funkcje, NIE jako stałe na
// poziomie modułu — Vercel ładuje moduł raz per cold start, więc w praktyce
// różnicy nie widać, ale odczyt na żądanie jest odporny na współdzielenie
// modułu między wywołaniami (np. testy jednostkowe zmieniające
// process.env w trakcie działania procesu — to jest dokładnie to, co
// złapał test_generate_recommendation.js podczas budowy tego pliku: stała
// odczytana raz przy pierwszym require() ignorowała późniejszą zmianę env).
function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ------------------------------------------------------------
// NAZWY SEGMENTÓW — kopia z SEG_NAMES w index.html (ten sam wzorzec
// świadomej duplikacji co w recommendation_engine.js Marketplace).
// Potrzebne tu do budowania czytelnego kontekstu diagnozy w prompcie
// (patrz buildUserPrompt) bez odpytywania public.segments za każdym razem.
// ------------------------------------------------------------
const SEG_NAMES = {
  moc: 'MOC',
  wytrzymalosc: 'WYTRZYMAŁOŚĆ',
  fizycznosc: 'FIZYCZNOŚĆ',
  techFund: 'TECHNIKA FUND.',
  techSpec: 'TECHNIKA SPEC.',
  regeneracja: 'REGENERACJA',
  odpornosc: 'ODPORNOŚĆ',
  odzywianie: 'ODŻYWIENIE',
  tolerancja: 'TOL. OBCIĄŻEŃ',
  koncentracja: 'KONCENTRACJA',
  mental: 'ODWAGA W GRZE',
  percepcja: 'PERCEPCJA',
  decyzja: 'SZYBK. DECYZJI',
};

// ------------------------------------------------------------
// MAPOWANIE SEGMENT → KATEGORIA SPECJALISTY MARKETPLACE
// Zaakceptowane przez Kubę 26.07.2026 (patrz
// claude/MAPOWANIE_SEGMENTOW_KATEGORIE_MARKETPLACE.md). To jest
// POPRAWIONA wersja tablicy z guided_match.html/recommendation_engine.js:
// regeneracja i odpornosc przesunięte z physiotherapy na nutrition (ich
// protokoły to sen+odżywienie potreningowe+magnez i białko/wit.D/cynk/
// żelazo — zero pokrycia fizjoterapeutycznego). Warstwa urazowa
// (INJURY_MODE_OVERRIDE_CATEGORY) skopiowana 1:1 z już przetestowanej
// logiki Marketplace, bez zmian.
//
// Wypełnia decision_recommendations.suggested_specialist_category —
// kolumna istniała od Domeny 11, ale nigdy nie była zapisywana (patrz
// claude/asystent_sportowca_11_marketplace_linkage.sql, sekcja "punkt
// otwarty").
// ------------------------------------------------------------
const SEGMENT_TO_SPECIALIST_CATEGORY = {
  moc: 'strength_conditioning',
  wytrzymalosc: 'strength_conditioning',
  fizycznosc: 'strength_conditioning',
  tolerancja: 'physiotherapy',
  regeneracja: 'nutrition',
  odpornosc: 'nutrition',
  odzywianie: 'nutrition',
  techFund: 'technical_tactical',
  techSpec: 'technical_tactical',
  percepcja: 'technical_tactical',
  decyzja: 'technical_tactical',
  koncentracja: 'sports_psychology',
  mental: 'sports_psychology',
};

const INJURY_MODE_OVERRIDE_CATEGORY = {
  moc: 'orthopedics',
  wytrzymalosc: 'orthopedics',
  fizycznosc: 'orthopedics',
  regeneracja: 'orthopedics',
  tolerancja: 'orthopedics',
  odpornosc: 'orthopedics',
};

// ------------------------------------------------------------
// DOZOWANIE A6 08.08.2026 — CZY W OGÓLE SIĘGAĆ PO PODPOWIEDZI
// ------------------------------------------------------------
// DECYZJA PRODUKTOWA SESJI GŁÓWNEJ z 08.08.2026
// (`claude/AUDYT_PO_BLOKU_4_08_08_2026.md`, sekcja 5, "Rozstrzygnięte przez
// sesję główną, bez pytania"): **`specialist_referral` bez segmentu NIE
// sięga po `tolerancja`.**
//
// SKĄD SIĘ WZIĘŁA: znalezisko A24 z rundy 4 zauważyło, że skierowanie do
// specjalisty z powodu wzorca bólu (`pain_pattern_match`) nie ma segmentu,
// więc nigdy nie dostanie ani jednej podpowiedzi — choć segment
// `tolerancja` ma 18 podpowiedzi wprost o bólu i powrocie po przerwie.
// Kuszące było podstawić `tolerancja` domyślnie. Sesja główna to
// ODRZUCIŁA i ta funkcja jest miejscem, w którym ta decyzja jest ZAPISANA
// W KODZIE, a nie tylko w dokumencie.
//
// DLACZEGO ODRZUCONA — powód, żeby nikt tego nie „naprawił" za pół roku:
// wzorzec bólu w kolanie nie znaczy, że problemem jest tolerancja
// obciążeń. Podstawienie segmentu zrobiłoby z DOMYSŁU DANE: model
// dostałby 18 konkretnych zdań o tolerancji obciążeń, oparł na nich
// ostrożne skierowanie, a `pickShowcaseHint()` przykleiłby do niego
// podpowiedź z tytułem materiału i numerem strony. Zawodnik zobaczyłby
// przypis "Tolerancja obciążeń — System Gamechange, s. 4" pod
// skierowaniem, którego nikt nigdy nie powiązał z tolerancją. To nie jest
// brak funkcji — to byłby fałszywy dowód, a przy skierowaniu do
// specjalisty fałszywy dowód jest gorszy niż jego brak.
//
// DODATKOWO (mierzalne, nie kosmetyczne): dziś przy braku segmentu ścieżka
// i tak kończy się pustką, ale DOPIERO PO wykonaniu zapytania o rocznik
// zawodnika (`fetchPlayerBirthYear`) — potrzebnego wyłącznie do bramki
// wiekowej, którą i tak nie ma czego przepuszczać. Ta funkcja pozwala
// odciąć to o krok wcześniej i powiedzieć w logu, że to WYBÓR, a nie
// przypadek (reguła R5: pusty wynik i "świadomie nie pytaliśmy" to dwie
// różne rzeczy).
//
// Funkcja CZYSTA — zero I/O, w całości testowalna.
function shouldLoadHints({ recommendationType, segmentId } = {}) {
  if (segmentId) return { load: true, powod: 'segment_znany' };
  if (recommendationType === 'specialist_referral') {
    return { load: false, powod: 'specialist_referral_bez_segmentu_swiadomie_bez_podpowiedzi' };
  }
  return { load: false, powod: 'brak_segmentu' };
}

function resolveSuggestedSpecialistCategory(segmentId, injuryModeActive) {
  if (!segmentId) return null;
  if (injuryModeActive && INJURY_MODE_OVERRIDE_CATEGORY[segmentId]) {
    return INJURY_MODE_OVERRIDE_CATEGORY[segmentId];
  }
  return SEGMENT_TO_SPECIALIST_CATEGORY[segmentId] || null;
}

// ------------------------------------------------------------
// WZGLĘDNE WYKRYWANIE DEFICYTÓW — świadoma duplikacja getRelativeDeficits()
// z index.html (patrz POPRAWKA w nagłówku pliku). Porównanie WYŁĄCZNIE do
// własnych wyników zawodnika (mediana ± odchylenie), nie do sztywnego
// progu — dokładnie ta sama logika co w narzędziu ankiety, żeby "top
// deficyt" znaczył to samo w obu miejscach systemu.
// ------------------------------------------------------------
function computeRelativeDeficits(scores, limit = 4) {
  const entries = Object.entries(scores || {});
  const values = entries.map(([, v]) => v).sort((a, b) => a - b);
  const n = values.length;
  if (n === 0) return [];

  const median = n % 2 === 0
    ? (values[n / 2 - 1] + values[n / 2]) / 2
    : values[(n - 1) / 2];

  const variance = values.reduce((sum, v) => sum + Math.pow(v - median, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  const MIN_ABS_GAP = 9;
  const DEV_MULTIPLIER = 0.5;

  const deficits = entries.filter(([, score]) => {
    const statisticallyLow = score < median - DEV_MULTIPLIER * stdDev;
    const meaningfulGap = (median - score) >= MIN_ABS_GAP;
    return statisticallyLow && meaningfulGap;
  });

  deficits.sort((a, b) => a[1] - b[1]);
  return deficits.slice(0, limit);
}

// Fallback gdy profil jest wyrównany (Scenariusz 2/3 w index.html) —
// żaden segment nie spełnia progu statystycznego. UPROSZCZENIE ŚWIADOME
// względem index.html: tam istnieje bogatszy fallback pozycyjny
// (POSITION_PROFILES.tiers — segmenty "key" dla danej pozycji na boisku).
// Tu, na start (v1 mostu ankieta→system), bierzemy po prostu najniżej
// punktowany segment ogółem — prostsze, nie wymaga duplikowania całej
// tabeli 13×8 pozycji w tym pliku. Jeśli w praktyce da to gorsze pierwsze
// rekomendacje niż warto, rozszerzyć o POSITION_PROFILES.tiers analogicznie
// do SEGMENT_TO_CATEGORY_CHRONIC w recommendation_engine.js.
function pickLowestScoringSegment(scores) {
  const entries = Object.entries(scores || {});
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  return entries[0][0];
}

// ------------------------------------------------------------
// KONTROLA KOSZTÓW
// Cztery niezależne reguły — patrz ASYSTENT_SPORTOWCA_ARCHITEKTURA_
// TECHNICZNA.md, sekcja "Kontrola kosztów". Każda zwraca
// { allowed, reason? }. Wołane w kolejności od najogólniejszej
// (twardy limit dobowy) do specyficznej dla typu — pierwsza blokada
// przerywa dalsze sprawdzanie.
// ------------------------------------------------------------

async function checkHardDailyCap(supabase, userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('decision_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since);
  if (error) throw new Error(`checkHardDailyCap: ${error.message}`);
  if ((count || 0) >= 5) {
    return { allowed: false, reason: 'Twardy limit bezpieczeństwa: 5 wywołań AI/dobę już wykorzystane.' };
  }
  return { allowed: true };
}

async function checkTrainingFocusCadence(supabase, userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('decision_recommendations')
    .select('id')
    .eq('user_id', userId)
    .eq('recommendation_type', 'training_focus')
    .gte('created_at', since)
    .limit(1);
  if (error) throw new Error(`checkTrainingFocusCadence: ${error.message}`);
  if (data && data.length > 0) {
    return {
      allowed: false,
      reason: 'training_focus już wygenerowany w ciągu ostatnich 24h (limit obowiązuje nawet przy zmianie celu priorytetowego).',
    };
  }
  return { allowed: true };
}

async function checkPainPatternCooldown(supabase, userId, bodyLocation) {
  if (!bodyLocation) throw new Error('checkPainPatternCooldown: brak relatedBodyLocation.');
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('decision_recommendations')
    .select('id')
    .eq('user_id', userId)
    .eq('recommendation_type', 'specialist_referral')
    .eq('referral_reason', 'pain_pattern_match')
    .eq('related_body_location', bodyLocation)
    .is('feedback_response', null)
    .gte('created_at', since)
    .limit(1);
  if (error) throw new Error(`checkPainPatternCooldown: ${error.message}`);
  if (data && data.length > 0) {
    return {
      allowed: false,
      reason: `Wciąż otwarte skierowanie (bez feedbacku) dla lokalizacji "${bodyLocation}" z ostatnich 14 dni.`,
    };
  }
  return { allowed: true };
}

async function checkFeedbackEscalationNotYetFired(supabase, userId, segmentId) {
  if (!segmentId) throw new Error('checkFeedbackEscalationNotYetFired: brak segmentId.');
  const { data: lastEscalation, error: escError } = await supabase
    .from('decision_recommendations')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('recommendation_type', 'specialist_referral')
    .eq('referral_reason', 'feedback_escalation')
    .eq('segment_id', segmentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (escError) throw new Error(`checkFeedbackEscalationNotYetFired: ${escError.message}`);
  if (!lastEscalation || lastEscalation.length === 0) {
    return { allowed: true }; // nigdy nie wystrzelona dla tego segmentu
  }
  const lastFiredAt = lastEscalation[0].created_at;
  // "Reset" = nowa akceptacja/wykonanie (feedback_response='done') w tym
  // segmencie PO ostatniej eskalacji — patrz komentarz w architekturze.
  const { data: resetRows, error: resetError } = await supabase
    .from('decision_recommendations')
    .select('id')
    .eq('user_id', userId)
    .eq('segment_id', segmentId)
    .eq('feedback_response', 'done')
    .gt('created_at', lastFiredAt)
    .limit(1);
  if (resetError) throw new Error(`checkFeedbackEscalationNotYetFired: ${resetError.message}`);
  if (resetRows && resetRows.length > 0) {
    return { allowed: true }; // licznik zresetowany
  }
  return {
    allowed: false,
    reason: `Eskalacja dla segmentu "${segmentId}" już wystrzelona i nie zresetowana (brak feedbacku "done" od tego czasu).`,
  };
}

// ------------------------------------------------------------
// TON (Funkcja 3, sygnał 4) — WŁASNA INTERPRETACJA PROGU, do korekty
// przez Kubę jeśli intuicja trenerska mówi inaczej (ten sam status co
// progi gotowości w research_gotowosc_progi.md — logicznie dobrana
// wartość startowa, nie bezpośrednio zbadana liczba):
//   1 odrzucenie z rzędu  -> bez zmian (assertive)
//   2 odrzucenia z rzędu  -> ton pytający (questioning)
//   3+ odrzucenia z rzędu -> to już nie jest kwestia tonu, tylko sygnał do
//     eskalacji (specialist_referral/feedback_escalation) — patrz
//     checkFeedbackEscalationNotYetFired wyżej. Ten silnik NIE wywołuje
//     eskalacji automatycznie w trakcie generowania training_focus (patrz
//     "CO ŚWIADOMIE NIE JEST TU ZROBIONE" na końcu pliku) — tylko liczy
//     streak pod kątem tonu bieżącej odpowiedzi.
// ------------------------------------------------------------
async function computeRejectionStreak(supabase, userId, segmentId) {
  const { data, error } = await supabase
    .from('decision_recommendations')
    .select('feedback_response')
    .eq('user_id', userId)
    .eq('recommendation_type', 'training_focus')
    .eq('segment_id', segmentId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`computeRejectionStreak: ${error.message}`);
  let streak = 0;
  for (const row of data || []) {
    if (row.feedback_response === 'did_not_make_sense') streak++;
    else break;
  }
  return streak;
}

// ============================================================
// GOTOWOŚĆ (Funkcja 8) — sygnały liczone na żywo z okna Dziennika.
// ============================================================
// Zaakceptowane przez Kubę 26.07.2026 ("Progi gotowości dokładnie tak
// samo. Potwierdzam i wszystko na tak"), patrz
// claude/PRZEGLAD_PROGOW_GOTOWOSCI_I_HORIZON_WEEKS.md (Część 1) dla
// pełnego uzasadnienia każdego progu.
//
// Świadomie NIE zaimplementowane tutaj (ta sama notatka):
//   - A3 ACWR — memo aktywnie odradza wdrożenie w V1 (metodologia
//     kwestionowana od 2020 r., Impellizzeri i wsp.; próg A2 poniżej
//     wystarcza jako główny twardy sygnał obciążenia).
//   - Wymiar meczowy — nierozstrzygalne samym researchem, czeka na
//     osobną decyzję Kuby o formacie response_value (Domena 15/11).
//   - Wykrywanie wzorca bólu (pain_pattern_match) — osobny mechanizm,
//     nieprojektowany tutaj.
//
// Funkcja 8 NIE ma dedykowanego ekranu/UI (patrz
// ASYSTENT_SPORTOWCA_ARCHITEKTURA_TECHNICZNA.md) — wynik poniższych
// funkcji to WYŁĄCZNIE surowy materiał narracyjny wstrzykiwany do
// promptu AI (buildUserPrompt). Sam recommendation_text wygenerowany
// przez AI pełni rolę "wyświetlenia Gotowości" zawodnikowi.
// ------------------------------------------------------------

const READINESS_WINDOW_DAYS = 30; // 7+7 dni na A2, 21 dni na linię bazową C1/mood, z zapasem
const BASELINE_MIN_MORNING_ENTRIES = 14; // propozycja produktowa z memo (14 wpisów / 21 dni), nie naukowa liczba
const BASELINE_WINDOW_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchReadinessWindowLogs(supabase, userId) {
  const since = new Date(Date.now() - READINESS_WINDOW_DAYS * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from('daily_logs')
    .select('entry_type, payload, created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: true }); // rosnąco -- ułatwia liczenie okien czasowych od najstarszego wpisu
  if (error) throw new Error(`fetchReadinessWindowLogs: ${error.message}`);
  return data || [];
}

function dateKeyUTC(iso) {
  return new Date(iso).toISOString().slice(0, 10); // YYYY-MM-DD w UTC -- proste, spójne z resztą wpisów co do strefy
}

function daysBetweenKeys(keyA, keyB) {
  return Math.round((new Date(keyB + 'T00:00:00Z').getTime() - new Date(keyA + 'T00:00:00Z').getTime()) / DAY_MS);
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
}

// Ostatnie N kolejnych (bez dziury) dni kalendarzowych z wpisem porannym,
// posortowanych rosnąco -- zwraca null jeśli nie ma N wpisów albo mają
// dziurę (brakujący dzień pomiędzy), zgodnie z "kolejne dni/noce" we
// wszystkich regułach B1/C1/mood (nie wystarczą 2 dowolne wpisy poranne
// w oknie, muszą następować bezpośrednio po sobie kalendarzowo).
function lastConsecutiveMorningDays(morningByDay, n) {
  const daysSorted = Object.keys(morningByDay).sort();
  if (daysSorted.length < n) return null;
  const lastN = daysSorted.slice(-n);
  for (let i = 1; i < lastN.length; i++) {
    if (daysBetweenKeys(lastN[i - 1], lastN[i]) !== 1) return null;
  }
  return lastN.map((k) => morningByDay[k]);
}

// Główna funkcja -- czysta (bez I/O), łatwa do testowania w izolacji.
// Wejście: windowLogs = wynik fetchReadinessWindowLogs (posortowany rosnąco).
function computeReadinessSignals(windowLogs, now) {
  const nowIso = (now || new Date()).toISOString();
  const todayKey = dateKeyUTC(nowIso);

  // --- Wpisy poranne, jeden na dzień (jeśli dubel tego samego dnia,
  // zostaje ostatni -- logi wchodzą posortowane rosnąco po created_at) ---
  const morningByDay = {};
  for (const log of windowLogs) {
    if (log.entry_type !== 'morning' || !log.payload) continue;
    morningByDay[dateKeyUTC(log.created_at)] = log.payload;
  }

  // --- Wpisy treningowe, obciążenie dzienne (RPE x czas trwania) ---
  const trainingLogs = windowLogs.filter((l) => l.entry_type === 'post_training' && l.payload
    && typeof l.payload.rpe === 'number' && typeof l.payload.duration_minutes === 'number');
  const dailyLoad = {};
  for (const log of trainingLogs) {
    const key = dateKeyUTC(log.created_at);
    dailyLoad[key] = (dailyLoad[key] || 0) + log.payload.rpe * log.payload.duration_minutes;
  }
  function loadOnDay(key) { return dailyLoad[key] || 0; }
  function weekLoadEndingAt(endKey) {
    let sum = 0;
    const endMs = new Date(endKey + 'T00:00:00Z').getTime();
    for (let i = 0; i < 7; i++) {
      sum += loadOnDay(new Date(endMs - i * DAY_MS).toISOString().slice(0, 10));
    }
    return sum;
  }

  // ---------------- A2: tygodniowy skok obciążenia (główny twardy sygnał) ----------------
  // Wymaga min. 2 pełnych tygodni danych wg memo -- uproszczenie
  // inżynierskie tego wymogu: sprawdzamy, że najstarszy wpis w oknie
  // (dowolnego typu) jest sprzed >=13 dni, czyli mamy jakiekolwiek
  // wpisy pokrywające obie porównywane tygodniowe strefy.
  let weeklyLoadSpike = null;
  const allDateKeys = windowLogs.map((l) => dateKeyUTC(l.created_at));
  if (allDateKeys.length) {
    const earliestKey = allDateKeys.reduce((a, b) => (a < b ? a : b));
    const spanDays = daysBetweenKeys(earliestKey, todayKey);
    if (spanDays >= 13) {
      const currentWeek = weekLoadEndingAt(todayKey);
      const prevWeekEndKey = new Date(new Date(todayKey + 'T00:00:00Z').getTime() - 7 * DAY_MS).toISOString().slice(0, 10);
      const prevWeek = weekLoadEndingAt(prevWeekEndKey);
      if (prevWeek > 0) {
        const changePct = (currentWeek - prevWeek) / prevWeek;
        weeklyLoadSpike = { active: changePct >= 0.15, changePct, currentWeek, prevWeek };
      }
    }
  }

  // ---------------- A1: monotonia (POMOCNICZA, nigdy samodzielny powód) ----------------
  let monotony = null;
  {
    const values = [];
    const endMs = new Date(todayKey + 'T00:00:00Z').getTime();
    for (let i = 0; i < 7; i++) {
      values.push(loadOnDay(new Date(endMs - i * DAY_MS).toISOString().slice(0, 10)));
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean > 0) {
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);
      // stdDev===0 z mean>0 = identyczne obciążenie każdego dnia tygodnia --
      // to z definicji skrajna monotonia (mean/0 = nieskończoność).
      const value = stdDev === 0 ? null : mean / stdDev;
      monotony = { value, elevated: value === null ? true : value > 2.0 };
    }
  }

  // ---------------- B1: sen < 7h przez >=2 kolejne noce ----------------
  let sleepFlag = { active: false };
  {
    const lastTwo = lastConsecutiveMorningDays(morningByDay, 2);
    if (lastTwo && lastTwo.every((p) => typeof p.sleep_hours === 'number' && p.sleep_hours < 7)) {
      sleepFlag = { active: true, consecutiveDays: 2 };
    }
  }
  // Standing kontekst "cel to 8-9h, brak flagi przy 7-8h to NIE optimum"
  // jest w buildSystemPrompt() (stała zasada niezależna od danych
  // konkretnego zawodnika), nie tutaj.

  // ---------------- C1: cold-start / linia bazowa (wymiar fizyczny) ----------------
  let coldStartOrBaseline;
  {
    const morningDaysInBaselineWindow = Object.keys(morningByDay)
      .filter((k) => daysBetweenKeys(k, todayKey) <= BASELINE_WINDOW_DAYS);
    const useBaseline = morningDaysInBaselineWindow.length >= BASELINE_MIN_MORNING_ENTRIES;

    const lastThreeTrainings = trainingLogs.slice(-3);
    const avgRpe = lastThreeTrainings.length === 3
      ? lastThreeTrainings.reduce((s, l) => s + l.payload.rpe, 0) / 3
      : null;
    const lastTwoMornings = lastConsecutiveMorningDays(morningByDay, 2);

    if (avgRpe === null || !lastTwoMornings) {
      coldStartOrBaseline = { mode: useBaseline ? 'baseline' : 'cold_start', tired: false, insufficientData: true };
    } else if (useBaseline) {
      // Interpretacja inżynierska "porównania do własnej mediany ±2 pkt"
      // z memo (propozycja produktowa, NIE naukowa liczba -- ten sam
      // status co techSpec/odpornosc w horizon_weeks: do korekty przez
      // Kubę, jeśli intuicja trenerska mówi inaczej).
      const rpeHistory = trainingLogs.map((l) => l.payload.rpe);
      const sleepQHistory = morningDaysInBaselineWindow
        .map((k) => morningByDay[k].sleep_quality).filter((v) => typeof v === 'number');
      const fatigueHistory = morningDaysInBaselineWindow
        .map((k) => morningByDay[k].morning_fatigue).filter((v) => typeof v === 'number');
      const medRpe = medianOf(rpeHistory);
      const medSleepQ = medianOf(sleepQHistory);
      const medFatigue = medianOf(fatigueHistory);

      const rpeTired = medRpe !== null && avgRpe > medRpe + 1;
      const sleepTired = lastTwoMornings.every((p) =>
        (typeof p.sleep_quality === 'number' && medSleepQ !== null && p.sleep_quality < medSleepQ - 2) ||
        (typeof p.morning_fatigue === 'number' && medFatigue !== null && p.morning_fatigue > medFatigue + 2));
      coldStartOrBaseline = { mode: 'baseline', tired: rpeTired && sleepTired, avgRpe, medRpe, medSleepQ, medFatigue };
    } else {
      const rpeTired = avgRpe >= 7;
      const sleepTired = lastTwoMornings.every((p) =>
        (typeof p.sleep_quality === 'number' && p.sleep_quality <= 4) ||
        (typeof p.morning_fatigue === 'number' && p.morning_fatigue >= 7));
      coldStartOrBaseline = { mode: 'cold_start', tired: rpeTired && sleepTired, avgRpe };
    }
  }

  // ---------------- Nastrój/motywacja: mood_motivation <=4 przez >=2 kolejne dni ----------------
  // Próg zaakceptowany przez Kubę 26.07.2026 -- temat wrażliwy (nieletni
  // zawodnik), ton WYŁĄCZNIE łagodny/nie-diagnostyczny wymuszony w
  // buildReadinessNarrative() niżej i w buildSystemPrompt().
  let moodFlag = { active: false };
  {
    const lastTwo = lastConsecutiveMorningDays(morningByDay, 2);
    if (lastTwo && lastTwo.every((p) => typeof p.mood_motivation === 'number' && p.mood_motivation <= 4)) {
      moodFlag = { active: true, consecutiveDays: 2, requiresGentleTone: true };
    }
  }

  return { weeklyLoadSpike, monotony, sleepFlag, coldStartOrBaseline, moodFlag };
}

// Przekłada surowe sygnały na linie tekstu PO POLSKU do wstrzyknięcia w
// prompt AI. A1 (monotonia) jest tu ZAWSZE oznaczona jako pomocnicza --
// zgodnie z memo, nigdy nie może być jedynym powodem komunikatu o
// zmęczeniu. Sygnał nastroju ma wymuszony, niekliniczny ton.
function buildReadinessNarrative(signals) {
  if (!signals) return [];
  const lines = [];

  if (signals.weeklyLoadSpike && signals.weeklyLoadSpike.active) {
    const pct = Math.round(signals.weeklyLoadSpike.changePct * 100);
    lines.push(`SYGNAŁ GOTOWOŚCI (fizyczny, główny): tygodniowe obciążenie treningowe (RPE x czas) wzrosło o ${pct}% względem poprzedniego tygodnia (próg ryzyka: >=15%) -- przy tak szybkiej progresji ryzyko kontuzji istotnie rośnie.`);
  }

  if (signals.monotony && signals.monotony.elevated) {
    lines.push('SYGNAŁ POMOCNICZY, KONTEKSTOWY (NIGDY samodzielny powód komunikatu "jesteś zmęczony"): monotonia treningowa ostatniego tygodnia jest podwyższona (mało zróżnicowane obciążenie dzień po dniu) -- potraktuj to wyłącznie jako dodatkowy kontekst obok innych sygnałów, nie jako osobny alarm.');
  }

  if (signals.sleepFlag && signals.sleepFlag.active) {
    lines.push('SYGNAŁ GOTOWOŚCI (fizyczny): sen poniżej 7h przez 2 kolejne noce z rzędu.');
  }

  if (signals.coldStartOrBaseline && signals.coldStartOrBaseline.tired) {
    const modeNote = signals.coldStartOrBaseline.mode === 'baseline'
      ? 'porównanie do własnej linii bazowej zawodnika (ma już >=14 wpisów porannych w ostatnich 21 dniach)'
      : 'reguła startowa -- zawodnik nie ma jeszcze wystarczającej historii do linii bazowej';
    lines.push(`SYGNAŁ GOTOWOŚCI (fizyczny, ${modeNote}): wysokie obciążenie ostatnich sesji w połączeniu ze słabym snem/zmęczeniem porannym przez 2 kolejne dni -- wskazuje na zmęczenie.`);
  }

  if (signals.moodFlag && signals.moodFlag.active) {
    lines.push('SYGNAŁ GOTOWOŚCI (mentalny -- TON WYŁĄCZNIE łagodny i NIE-diagnostyczny, to nastoletni zawodnik, nie pacjent): nastrój/motywacja niska przez 2 kolejne dni z rzędu. Sformułuj to jako zwykłe, ciepłe zainteresowanie samopoczuciem (np. "zauważyliśmy, że ostatnio jest Ci trudniej -- wszystko w porządku?"), nigdy jako ocenę kliniczną, diagnozę czy alarm.');
  }

  return lines;
}

// ============================================================
// WYMIAR MECZOWY GOTOWOŚCI (Funkcja 8) — DODANE 03.08.2026, patrz POPRAWKA
// w nagłówku pliku. Wcześniej świadomie NIE zaimplementowany — blokerem
// był nierozstrzygnięty format `match_context_answers.response_value`
// (teraz POTWIERDZONY, KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md 3.1).
// ============================================================
//
// Zestaw kodów odpowiedzi oznaczających NIEKORZYSTNY wynik zdarzenia w
// meczu, zebrany wprost z banku pytań (TRYB_MECZU_PRZEPROJEKTOWANIE_
// DECYZJE.md, punkt 10) — jeden kod per segment, ten który w opisie banku
// wprost odpowiada "sytuacja wystąpiła i wypadła źle" (nigdy
// `no_occurrence`/`no_recall`/warianty "zadziałało" — te NIE trafiają
// tutaj). `regeneracja` świadomie pominięta na tej liście: jej sygnał
// (`entered_fatigued`) już żyje w rdzeniu karty i jest częścią osobnego,
// istniejącego mechanizmu (patrz TRYB_MECZU_PRZEPROJEKTOWANIE_DECYZJE.md,
// sekcja Regeneracja) — dublowanie go tutaj liczyłoby ten sam sygnał
// dwa razy w jednym meczu.
const MATCH_NEGATIVE_OUTCOME_CODES = new Set([
  'late_scan_cost',      // percepcja
  'hesitated',           // decyzja
  'became_cautious',     // mental
  'drifted_slow_return', // koncentracja
  'lost_race',           // moc
  'significant_drop',    // wytrzymałość
  'lost_duel',           // fizyczność
  'broke_down',          // technika fundamentalna
  'attempted_no_effect', // technika specjalistyczna
  'above_normal_toll',   // tolerancja obciążeń
  'symptoms_present',    // odporność
  'energy_crash',        // odżywianie
]);

// V1, prosta heurystyka -- LOGICZNIE dobrana wartość startowa, NIE
// naukowo zbadana liczba (ten sam status co progi A2/B1/C1 wyżej), do
// korekty jeśli intuicja trenerska mówi inaczej: patrzy WYŁĄCZNIE na
// NAJNOWSZY zalogowany mecz (matchAnswers wchodzi posortowane malejąco po
// created_at, patrz fetchRecentMatchContextAnswers) -- starsze mecze nie
// wpływają na Gotowość DZISIAJ, tylko na trend widoczny gdzie indziej.
// Próg >=2 niekorzystnych kodów w JEDNYM meczu (nie sam fakt jednego) --
// pojedynczy niekorzystny wynik to normalna zmienność meczowa, nie sygnał.
function computeMatchReadinessSignal(matchAnswers) {
  if (!matchAnswers || !matchAnswers.length) return { active: false };
  const latestMatchId = matchAnswers[0].match_context_id;
  if (!latestMatchId) return { active: false };
  const latestMatchAnswers = matchAnswers.filter((a) => a.match_context_id === latestMatchId);
  const negativeCount = latestMatchAnswers.filter((a) => MATCH_NEGATIVE_OUTCOME_CODES.has(a.response_value)).length;
  return {
    active: negativeCount >= 2,
    negativeCount,
    totalAnswered: latestMatchAnswers.length,
  };
}

// Ten sam ton "sygnał kontekstowy, nie samodzielny alarm" co reszta
// buildReadinessNarrative() -- pojedynczy słaby mecz to normalna
// zmienność, seria takich meczów to co innego, ale rozpoznawanie SERII
// (nie tylko najnowszego meczu) to świadomie odłożony zakres tej wersji,
// patrz "CO ŚWIADOMIE NIE JEST TU ZROBIONE" na końcu pliku.
function buildMatchReadinessNarrative(matchSignal) {
  if (!matchSignal || !matchSignal.active) return [];
  return [`SYGNAŁ GOTOWOŚCI (wymiar meczowy): w najnowszym zalogowanym meczu zawodnik zgłosił ${matchSignal.negativeCount} niekorzystnych wyników na pytania segmentowe kaskady (na ${matchSignal.totalAnswered} odpowiedzianych w tym meczu) -- potraktuj to jako dodatkowy kontekst obok pozostałych sygnałów Gotowości, nigdy jako samodzielny alarm ani dowód chronicznego problemu (to jeden mecz, nie seria).`];
}

// ------------------------------------------------------------
// KONTEKST ZAWODNIKA — dokładnie te kolumny/tabele co w rzeczywistym
// schemacie (zweryfikowane przez odczyt SQL, nie z pamięci):
// player_profiles (Domena 01), daily_logs + pain_entries (Domena 03),
// match_contexts (Domena 04).
//
// POPRAWKA (25.07.2026): dodano diagnostics (Domena 02, powiązane przez
// most z Domeny 15) i player_insights (też Domena 15) — patrz uzasadnienie
// w nagłówku pliku. Obie są opcjonalne (może nie być jeszcze żadnej
// powiązanej ankiety, np. zawodnik założył konto bez wcześniejszego
// wypełnienia formularza) — reszta silnika działa identycznie jak wcześniej
// gdy ich brak, po prostu bez tej dodatkowej warstwy kontekstu.
// ------------------------------------------------------------
const INSIGHT_MAX_AGE_DAYS = 90; // ten sam próg i uzasadnienie co w index.html

async function fetchPlayerDiagnosis(supabase, userId) {
  const { data, error } = await supabase
    .from('diagnostics')
    .select('scores, top_deficits, position, level, overall_score, created_at, diagnosis_type')
    .eq('user_id', userId)
    .not('scores', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`fetchPlayerDiagnosis: ${error.message}`);
  return data || null;
}

async function fetchPlayerInsights(supabase, userId) {
  const cutoff = new Date(Date.now() - INSIGHT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('player_insights')
    .select('source, segment_id, response_value, response_comment, created_at')
    .eq('user_id', userId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw new Error(`fetchPlayerInsights: ${error.message}`);
  return data || [];
}

// DODANE 03.08.2026 — patrz POPRAWKA w nagłówku pliku. `match_context_id`
// wybrane celowo (obok segment_id/response_value/followup_value) mimo że
// nie trafia bezpośrednio do promptu AI -- computeMatchReadinessSignal()
// go potrzebuje, żeby zgrupować odpowiedzi z tego SAMEGO meczu (limit=15
// to zapas na mecze z 2-3 odpowiedziami każdy, nie sam limit meczów).
const MATCH_ANSWERS_LIMIT = 15;

async function fetchRecentMatchContextAnswers(supabase, userId) {
  const { data, error } = await supabase
    .from('match_context_answers')
    .select('segment_id, response_value, followup_value, selection_source, was_goal_segment, match_context_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MATCH_ANSWERS_LIMIT);
  if (error) throw new Error(`fetchRecentMatchContextAnswers: ${error.message}`);
  return data || [];
}

async function fetchPlayerContext(supabase, userId) {
  const [profileRes, recentLogsRes, recentPainRes, recentMatchesRes, diagnosis, insights, matchAnswers] = await Promise.all([
    supabase.from('player_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('daily_logs').select('entry_type, session_type, payload, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('pain_entries').select('body_location, side, intensity, excludes_from_training, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    // POPRAWKA (03.08.2026): dodane self_rating/mental_state/entered_recovery_state/
    // demanding_conditions/position_played_today/free_note -- kolumny dodane przy
    // przeprojektowaniu Meczu (TRYB_MECZU_PRZEPROJEKTOWANIE_DECYZJE.md, punkt 9),
    // żywe w bazie od 29.07.2026, ale nigdy wcześniej nieodczytywane tutaj.
    supabase.from('match_contexts').select('game_type, own_score, opponent_score, role, minutes_played, match_rpe, self_rating, mental_state, entered_recovery_state, demanding_conditions, position_played_today, free_note, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(3),
    fetchPlayerDiagnosis(supabase, userId),
    fetchPlayerInsights(supabase, userId),
    fetchRecentMatchContextAnswers(supabase, userId),
  ]);
  if (profileRes.error) throw new Error(`fetchPlayerContext(profile): ${profileRes.error.message}`);
  if (recentLogsRes.error) throw new Error(`fetchPlayerContext(logs): ${recentLogsRes.error.message}`);
  if (recentPainRes.error) throw new Error(`fetchPlayerContext(pain): ${recentPainRes.error.message}`);
  if (recentMatchesRes.error) throw new Error(`fetchPlayerContext(matches): ${recentMatchesRes.error.message}`);
  return {
    profile: profileRes.data,
    recentLogs: recentLogsRes.data || [],
    recentPain: recentPainRes.data || [],
    recentMatches: recentMatchesRes.data || [],
    diagnosis,
    insights,
    matchAnswers,
  };
}

async function fetchKnowledgeBase(supabase, segmentId) {
  if (!segmentId) return null;
  const { data, error } = await supabase
    .from('knowledge_base_entries')
    .select('content')
    .eq('segment_id', segmentId)
    .maybeSingle();
  if (error) throw new Error(`fetchKnowledgeBase: ${error.message}`);
  return data ? data.content : null;
}

// Dla training_focus segmentId powinien pochodzić z samego celu (goal),
// nie tylko z parametru wejściowego — unika rozjazdu, jeśli caller poda
// niespójną parę goalId/segmentId.
async function resolveGoalSegment(supabase, goalId) {
  if (!goalId) return null;
  const { data, error } = await supabase
    .from('goals').select('id, segment_id, status').eq('id', goalId).maybeSingle();
  if (error) throw new Error(`resolveGoalSegment: ${error.message}`);
  if (!data) throw new Error(`resolveGoalSegment: cel o id=${goalId} nie istnieje.`);
  // POPRAWKA (pełny audyt całości): status był pobierany, ale nigdy nie
  // sprawdzany — silnik mógł wygenerować rekomendację "training_focus"
  // dla celu, który zawodnik już oznaczył jako 'completed' albo
  // 'abandoned' (asystent_sportowca_05_cele.sql: status IN ('active',
  // 'completed', 'abandoned')). Realny scenariusz: zawodnik porzuca cel,
  // ale zaplanowane/opóźnione wywołanie silnika (albo przyszły cron)
  // i tak generuje sugestię dotyczącą segmentu z NIEAKTUALNEGO już celu —
  // myląca rekomendacja bez pokrycia w bieżących priorytetach zawodnika.
  if (data.status !== 'active') {
    throw new Error(`resolveGoalSegment: cel o id=${goalId} nie jest aktywny (status=${data.status}).`);
  }
  return data.segment_id;
}

// ------------------------------------------------------------
// PROMPT — filozofia i format wprost z Funkcji 3 dokumentu koncepcyjnego
// (ASYSTENT_SPORTOWCA_PROJEKT.md), nie wymyślone od nowa.
// ------------------------------------------------------------
// PODPOWIEDZI SILNIK A4 08.08.2026 — doszedł czwarty, OPCJONALNY parametr
// `hintSelection` (wynik selectHintsForPrompt() z lib/recommendation-hints.js).
// Gdy go nie ma albo nie niesie ani jednej podpowiedzi, prompt jest
// generowany DOKŁADNIE tak jak przed tą zmianą, co do bajta — dlatego
// wszystkie 55 istniejących scenariuszy w tests/test-generate-recommendation.js
// przechodzą bez modyfikacji.
function buildSystemPrompt({ recommendationType, knowledgeBaseContent, confidenceTone, hintSelection }) {
  const toneInstruction = confidenceTone === 'questioning'
    ? 'Zawodnik ostatnio kilka razy z rzędu odrzucił podobne sugestie jako "nie miało sensu". Złagodź ton — sformułuj rekomendację jako pytanie/hipotezę, nie stanowcze stwierdzenie (np. "czy coś w Twojej sytuacji sprawia że X się nie sprawdza?"), zamiast być w pełni asertywnym.'
    : 'Formułuj rekomendację asertywnie i wprost, na podstawie danych.';

  const kbBlock = knowledgeBaseContent
    ? `BAZA WIEDZY GAMECHANGE dla tego segmentu (źródło prawdy — nigdy jej nie neguj, nigdy nie proponuj czegoś sprzecznego z nią):\n${knowledgeBaseContent}\n\n`
    : '';

  // PODPOWIEDZI SILNIK A4 08.08.2026 — osobna, NAZWANA sekcja promptu,
  // OBOK bazy wiedzy, nigdy zamiast niej. Pusty string, gdy podpowiedzi
  // nie ma — wtedy prompt jest identyczny z dzisiejszym.
  const hintsBlock = buildHintPromptBlock(hintSelection);
  const hasHints = hintsBlock.length > 0;

  // Dodatkowe pole `used_hint_klucz` wchodzi do formatu odpowiedzi WYŁĄCZNIE
  // wtedy, gdy podpowiedzi faktycznie poszły do promptu. Model mówi nim,
  // na której podpowiedzi oparł rekomendację — dzięki temu to, co zawodnik
  // zobaczy na ekranie, zgadza się z tym, czego model naprawdę użył
  // (reguła R1). Pole jest opcjonalne: brak nie psuje niczego, silnik
  // spada wtedy na podpowiedź najlepiej wycelowaną.
  const usedHintField = hasHints
    ? ', "used_hint_klucz": "klucz podpowiedzi z sekcji PODPOWIEDZI, na której oparłeś rekomendację (dokładnie ten ciąg z nawiasu, np. moc-segment-01) — albo pusty string, jeśli żadna nie pasowała"'
    : '';

  const formatBlock = recommendationType === 'training_focus'
    ? `{"weekly_focus_text": "krótki nagłówek priorytetu tygodnia", "recommendation_text": "konkretna, wykonalna rekomendacja działania", "rationale_text": "krótkie uzasadnienie oparte na danych zawodnika podanych niżej"${usedHintField}}`
    : `{"recommendation_text": "rzeczowa, ostrożna sugestia rozmowy ze specjalistą", "rationale_text": "krótkie wyjaśnienie dlaczego, oparte na danych"${usedHintField}}`;

  // Stała zasada edukacyjna (Gotowość, próg B1) — NIEZALEŻNA od danych
  // konkretnego zawodnika, dlatego żyje tutaj a nie w computeReadinessSignals().
  // Zaakceptowane przez Kubę 26.07.2026 (patrz
  // claude/PRZEGLAD_PROGOW_GOTOWOSCI_I_HORIZON_WEEKS.md, pozycja B1):
  // brak aktywnej flagi "zły sen" (próg <7h) NIE oznacza optymalnego snu.
  const sleepContextBlock = 'KONTEKST SNU (stała zasada, zawsze obowiązuje niezależnie od tego, czy poniżej pojawia się aktywny sygnał "zły sen"): 7-8h snu to NIE jest optymalny wynik dla młodego sportowca, tylko brak alarmu. Celem jest 8-9h/noc — możesz o tym wspomnieć jako kontekst edukacyjny, nawet gdy dane akurat nie pokazują twardego problemu.';

  return `Jesteś silnikiem Centrum Decyzji w aplikacji Gamechange dla młodych piłkarzy.

FILOZOFIA (nienaruszalna, wprost z dokumentu koncepcyjnego Funkcji 3): Centrum Decyzji jest NAWIGATOREM, nie planistą. Nie piszesz dokładnego planu treningowego — kierunkujesz i uzasadniasz. Zawodnik samodzielnie realizuje szczegóły (albo korzysta ze specjalisty z Marketplace).

${kbBlock}${hintsBlock}TON: ${toneInstruction}

${sleepContextBlock}

${recommendationType === 'specialist_referral' ? 'WAŻNE (dotyczy tylko skierowania do specjalisty): to ma być OSTROŻNA sugestia, nie alarm. Wzorzec bólu może równie dobrze wynikać ze zwykłego przetrenowania, nie nawrotu kontuzji — pisz "warto to sprawdzić", nigdy "prawdopodobnie masz nawrót kontuzji".\n\n' : ''}JĘZYK: wyłącznie polski, zwięźle, konkretnie, bez żargonu, zwracaj się do zawodnika bezpośrednio ("Ty").

FORMAT ODPOWIEDZI: zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu, bez komentarzy) dokładnie w tym kształcie:
${formatBlock}`;
}

// POPRAWKA (25.07.2026): dodano blok "Z ANKIETY DIAGNOSTYCZNEJ" i
// "OBSERWACJE TRENERA/RODZICA" — dokładnie ten sam typ informacji, który
// _buildDiagData()/generateAIDiagnosis() w index.html już od dawna
// wstrzykuje do SWOJEGO prompta AI przy generowaniu diagnozy. Tu robimy
// analogicznie dla Centrum Decyzji, żeby pierwsza (i każda kolejna)
// rekomendacja uwzględniała to, co system już wie o zawodniku z ankiety,
// zamiast zaczynać wyłącznie od Dziennika.
//
// POPRAWKA (26.07.2026): dodano extra.readinessLines — sygnały Gotowości
// (Funkcja 8) obliczone przez computeReadinessSignals()/buildReadinessNarrative()
// w generateRecommendation() i przekazane tutaj jako gotowe linie tekstu.
function buildUserPrompt({ recommendationType, referralReason, context, extra }) {
  const { profile, recentLogs, recentPain, recentMatches, diagnosis, insights, matchAnswers } = context;
  const lines = [];
  lines.push(`Typ rekomendacji do wygenerowania: ${recommendationType}${referralReason ? ' / ' + referralReason : ''}.`);

  if (profile) {
    lines.push(`Pozycja: ${profile.position_primary || 'nieznana'}. Poziom: ${profile.current_level || 'nieznany'}.`);
    if (profile.injury_mode_active) {
      lines.push(`UWAGA — Tryb kontuzji AKTYWNY (kategoria: ${profile.injury_mode_category || 'brak'}). Rekomendacja MUSI to uwzględniać — żadnej sugestii intensywnego obciążenia w obszarze objętym kontuzją.`);
    }
  }

  if (diagnosis && diagnosis.scores) {
    let scores;
    try { scores = typeof diagnosis.scores === 'string' ? JSON.parse(diagnosis.scores) : diagnosis.scores; }
    catch (e) { scores = null; }
    if (scores) {
      const deficits = computeRelativeDeficits(scores, 4);
      const deficitsStr = deficits.length
        ? deficits.map(([id, score]) => `${SEG_NAMES[id] || id} (${score}/100)`).join(', ')
        : 'brak statystycznie istotnego wąskiego gardła — profil wyrównany';
      const whenStr = diagnosis.created_at ? new Date(diagnosis.created_at).toLocaleDateString('pl-PL') : 'nieznana data';
      lines.push(`Z ANKIETY DIAGNOSTYCZNEJ (wypełniona ${whenStr}${diagnosis.diagnosis_type ? ', typ: ' + diagnosis.diagnosis_type : ''}): wykryte wąskie gardła — ${deficitsStr}.`);
    }
  } else {
    lines.push('Zawodnik nie ma jeszcze powiązanej ankiety diagnostycznej — nie zgaduj deficytów, bazuj wyłącznie na danych niżej.');
  }

  if (insights && insights.length) {
    const insightLines = insights.slice(0, 5).map((ins) => {
      const who = ins.source === 'coach' ? 'Trener zaobserwował' : ins.source === 'parent' ? 'Rodzic zaobserwował' : 'Zawodnik potwierdził';
      const segName = SEG_NAMES[ins.segment_id] || ins.segment_id;
      const detail = ins.response_comment || ins.response_value || '';
      return `${who} (obszar: ${segName}): ${detail}`.trim();
    });
    lines.push(`OBSERWACJE TRENERA/RODZICA (ostatnie ${INSIGHT_MAX_AGE_DAYS} dni):\n${insightLines.join('\n')}`);
  }

  if (recentLogs.length) {
    lines.push(`Ostatnie wpisy w Dzienniku (najnowsze pierwsze, max 10, skala pól 0-10): ${JSON.stringify(recentLogs)}`);
  }
  if (recentPain.length) {
    lines.push(`Ostatnie zgłoszenia bólu (najnowsze pierwsze, max 10): ${JSON.stringify(recentPain)}`);
  }
  if (recentMatches.length) {
    lines.push(`Ostatnie mecze (najnowsze pierwsze, max 3): ${JSON.stringify(recentMatches)}`);
  }
  // DODANE 03.08.2026 (patrz POPRAWKA w nagłówku pliku) -- naprawia
  // znalezisko #6 z syntezy Filtra Jakości: match_context_answers nigdy
  // wcześniej nie było czytane przez silnik. Krótka legenda w tekście
  // zamiast osobnego bloku systemowego -- to jedyne miejsce, gdzie te
  // kody są potrzebne AI, więc kontekst zostaje razem z danymi.
  if (matchAnswers && matchAnswers.length) {
    const SELECTION_SOURCE_LABELS = { goal: 'cel', deficit: 'deficyt', position: 'pozycja', rotation: 'rotacja' };
    const matchAnswerLines = matchAnswers.slice(0, 10).map((a) => {
      const segName = SEG_NAMES[a.segment_id] || a.segment_id;
      const sourceLabel = SELECTION_SOURCE_LABELS[a.selection_source] || a.selection_source || 'nieznane';
      let line = `${segName} (pytanie wybrane z powodu: ${sourceLabel}): ${a.response_value}`;
      if (a.followup_value) line += ` / pogłębienie: ${a.followup_value}`;
      return line;
    });
    lines.push(`ODPOWIEDZI Z PYTAŃ MECZOWYCH (kaskada po meczu, najnowsze pierwsze, max 10 — kod ${Array.from(MATCH_NEGATIVE_OUTCOME_CODES).join('/')} to zawsze NIEKORZYSTNY wynik zdarzenia w meczu, "no_occurrence"/"no_recall" to brak danych a nie problem, reszta kodów to wynik NEUTRALNY lub KORZYSTNY):\n${matchAnswerLines.join('\n')}`);
  }
  if (extra && extra.readinessLines && extra.readinessLines.length) {
    lines.push(...extra.readinessLines);
  }
  if (extra && extra.painNote) lines.push(extra.painNote);
  if (extra && extra.goalNote) lines.push(extra.goalNote);

  if (!recentLogs.length && !recentMatches.length && !recentPain.length && !(matchAnswers && matchAnswers.length) && !(diagnosis && diagnosis.scores)) {
    lines.push('Brak dotychczasowych danych w Dzienniku/kontekście meczowym/ankiecie — jeśli to za mało do konkretnej rekomendacji, napisz to wprost zamiast zgadywać.');
  }

  return lines.join('\n');
}

// ------------------------------------------------------------
// WYWOŁANIE ANTHROPIC API — TODO(Kuba): zadziała od razu, gdy
// ANTHROPIC_API_KEY trafi do zmiennych środowiskowych Vercel. Do tego
// czasu rzuca czytelny błąd zamiast cichego niepowodzenia.
// ------------------------------------------------------------
async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY nie skonfigurowany — silnik jest gotowy, brakuje tylko klucza (patrz "DO ZROBIENIA PRZEZ KUBĘ" w architekturze).');
  }
  // Fallback zaktualizowany 04.08.2026 na 'claude-sonnet-5' (aktualny wg
  // docs.claude.com w tym dniu) — używany tylko, gdy ANTHROPIC_MODEL nie
  // jest ustawiona w Vercel. Nazwy modeli zmieniają się z czasem, warto
  // sprawdzić ponownie, jeśli minie dużo miesięcy bez wdrożenia.
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Odpowiedź Anthropic bez bloku tekstowego.');
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownJsonFence(textBlock.text));
  } catch (e) {
    throw new Error(`Nie udało się sparsować JSON z odpowiedzi AI: ${e.message}. Surowa odpowiedź (pierwsze 500 znaków): ${textBlock.text.slice(0, 500)}`);
  }
  return parsed;
}

// POPRAWKA (31.07.2026 — sesja naprawcza, patrz claude/SESJA_START_NAPRAWA_
// JSON_RECOMMENDATION.md): ten sam błąd znaleziony i naprawiony 30.07.2026
// w api/validate-goal-refinement.js (żywy test na produkcji) — mimo
// instrukcji w system prompcie "zwróć WYŁĄCZNIE poprawny JSON (bez
// markdown, bez bloków kodu)", model Anthropic czasem i tak owija
// odpowiedź w blok kodu markdown (```json ... ```), co wcześniej psuło
// JSON.parse (rzucało błąd zamiast zwrócić wynik). Funkcja poniżej
// skopiowana 1:1 z już przetestowanej wersji w validate-goal-refinement.js.
function stripMarkdownJsonFence(text) {
    const trimmed = text.trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1] : trimmed;
}

// ------------------------------------------------------------
// ORKIESTRATOR — główna funkcja silnika, do reużycia przez ten plik
// (HTTP handler niżej) i przez każdego przyszłego wywołującego (cron,
// webhook feedbacku itd.) bez duplikowania logiki.
//
// drugi parametr (injectedSupabase) jest opcjonalny — do testów
// jednostkowych bez prawdziwego połączenia z Supabase, oraz do
// przyszłego reużycia gdy wywołujący ma już gotowego klienta.
// ------------------------------------------------------------
async function generateRecommendation(params, injectedSupabase) {
  const {
    userId,
    recommendationType,
    referralReason,
    goalId,
    relatedBodyLocation,
    relatedInjuryHistoryId,
  } = params || {};
  let { segmentId } = params || {};

  if (!userId) throw new Error('generateRecommendation: brak userId.');
  if (!['training_focus', 'specialist_referral'].includes(recommendationType)) {
    throw new Error(`generateRecommendation: nieprawidłowy recommendationType "${recommendationType}".`);
  }
  if (recommendationType === 'specialist_referral' && !['pain_pattern_match', 'feedback_escalation', 'other'].includes(referralReason)) {
    throw new Error(`generateRecommendation: nieprawidłowy referralReason "${referralReason}".`);
  }
  if (recommendationType === 'specialist_referral' && referralReason === 'pain_pattern_match' && !relatedBodyLocation) {
    throw new Error('generateRecommendation: pain_pattern_match wymaga relatedBodyLocation.');
  }
  if (recommendationType === 'specialist_referral' && referralReason === 'feedback_escalation' && !segmentId) {
    throw new Error('generateRecommendation: feedback_escalation wymaga segmentId.');
  }

  const supabase = injectedSupabase || getAdminClient();

  // training_focus: segmentId zawsze wyprowadzony z samego celu (goalId),
  // nie z parametru wejściowego — unika rozjazdu jeśli caller poda
  // niespójną parę goalId/segmentId.
  if (recommendationType === 'training_focus') {
    if (!goalId) throw new Error('generateRecommendation: training_focus wymaga goalId.');
    segmentId = await resolveGoalSegment(supabase, goalId);
  }

  // --- 1. Kontrola kosztów, w kolejności od najogólniejszej ---
  const hardCap = await checkHardDailyCap(supabase, userId);
  if (!hardCap.allowed) return { ok: false, blocked: true, reason: hardCap.reason };

  if (recommendationType === 'training_focus') {
    const cadence = await checkTrainingFocusCadence(supabase, userId);
    if (!cadence.allowed) return { ok: false, blocked: true, reason: cadence.reason };
  } else if (referralReason === 'pain_pattern_match') {
    const cooldown = await checkPainPatternCooldown(supabase, userId, relatedBodyLocation);
    if (!cooldown.allowed) return { ok: false, blocked: true, reason: cooldown.reason };
  } else if (referralReason === 'feedback_escalation') {
    const notYetFired = await checkFeedbackEscalationNotYetFired(supabase, userId, segmentId);
    if (!notYetFired.allowed) return { ok: false, blocked: true, reason: notYetFired.reason };
  }

  // --- 2. Kontekst + baza wiedzy + sygnały Gotowości ---
  const context = await fetchPlayerContext(supabase, userId);
  const knowledgeBaseContent = await fetchKnowledgeBase(supabase, segmentId);
  const readinessLogs = await fetchReadinessWindowLogs(supabase, userId);
  const readinessSignals = computeReadinessSignals(readinessLogs);
  // DODANE 03.08.2026 — wymiar MECZOWY Gotowości, patrz POPRAWKA w
  // nagłówku pliku. context.matchAnswers już posortowane malejąco po
  // created_at przez fetchRecentMatchContextAnswers().
  const matchReadinessSignal = computeMatchReadinessSignal(context.matchAnswers);
  const readinessLines = [
    ...buildReadinessNarrative(readinessSignals),
    ...buildMatchReadinessNarrative(matchReadinessSignal),
  ];

  // --- 3. Ton — tylko training_focus ma tu sens (patrz komentarz wyżej) ---
  let confidenceTone = 'assertive';
  if (recommendationType === 'training_focus' && segmentId) {
    const streak = await computeRejectionStreak(supabase, userId, segmentId);
    if (streak >= 2) confidenceTone = 'questioning';
  }

  // --- 3b. PODPOWIEDZI SILNIK A4 08.08.2026 — podpowiedzi z materiałów ---
  // NIGDY nie przerywa generowania. Brak tabeli (Kuba nie wkleił jeszcze
  // migracji), brak rocznika, brak Elementu celu — każdy z tych stanów
  // zostawia silnik w dzisiejszym zachowaniu, ale ZAWSZE ląduje w logu
  // pod własną nazwą (reguła R5 — żadnej cichej pustki).
  //
  // DOZOWANIE A6 08.08.2026 — bramka `shouldLoadHints()` PRZED wywołaniem.
  // Decyzja produktowa: `specialist_referral` bez segmentu świadomie NIE
  // sięga po `tolerancja` (pełne uzasadnienie przy definicji funkcji).
  // Nie podstawiamy segmentu i nie wykonujemy zapytań, które nie mają
  // czego przefiltrować — ale mówimy to WPROST, zamiast zostawić pustkę
  // wyglądającą jak "sprawdziłem i nic nie było".
  let hintLoad = null;
  const bramkaPodpowiedzi = shouldLoadHints({ recommendationType, segmentId });
  if (!bramkaPodpowiedzi.load) {
    console.log(`[podpowiedzi] pominiete=tak powod=${bramkaPodpowiedzi.powod}`);
    if (bramkaPodpowiedzi.powod === 'specialist_referral_bez_segmentu_swiadomie_bez_podpowiedzi') {
      console.log('[podpowiedzi] skierowanie do specjalisty bez segmentu NIE dostaje podpowiedzi i NIE podstawiamy za nie segmentu "tolerancja" — decyzja produktowa sesji głównej z 08.08.2026 (AUDYT_PO_BLOKU_4_08_08_2026.md, sekcja 5; znalezisko A24). Podpowiedź z tytułem materiału i numerem strony pod skierowaniem, którego nikt z tym segmentem nie powiązał, byłaby fałszywym dowodem.');
    }
  }
  if (bramkaPodpowiedzi.load) {
    try {
      hintLoad = await loadHintsForRecommendation(supabase, {
        segmentId, userId, goalId: recommendationType === 'training_focus' ? goalId : null,
      });
      console.log(hintLoad.log);
      if (hintLoad.stanTabeli === 'brak_tabeli') {
        console.log('[podpowiedzi] tabela component_hints nie istnieje — silnik pracuje jak przed rundą 4. To NIE znaczy "sprawdziłem i nic nie znalazłem".');
      } else if (hintLoad.stanTabeli === 'blad') {
        console.error(`[podpowiedzi] BŁĄD odczytu component_hints (silnik jedzie dalej bez nich): ${hintLoad.blad}`);
      }
      if (hintLoad.selection && hintLoad.selection.niedopasowane > 0) {
        console.error(`[podpowiedzi] UWAGA: ${hintLoad.selection.niedopasowane} podpowiedzi ma component_id=NULL mimo wypełnionej nazwy Obszaru/Elementu — to NIEUDANE dopasowanie w migracji, nie zamierzona reguła segmentowa. Zapytanie kontrolne (2) w claude/PODPOWIEDZI_Z_MATERIALOW_A.md pokaże które.`);
      }
      if (hintLoad.stanCelowania === 'brak_kolumny_elementu') {
        console.log('[podpowiedzi] w tabeli goals nie ma żadnej ze znanych kolumn Elementu — celujemy w segment, nie w Element. To stan "nie wiem", nie "cel bez Elementu".');
      }
    } catch (e) {
      // Warstwa podpowiedzi nie ma prawa wywrócić rekomendacji, która
      // działa od 25.07.2026.
      console.error(`[podpowiedzi] nieoczekiwany wyjątek, silnik jedzie dalej bez podpowiedzi: ${e.message}`);
      hintLoad = null;
    }
  }
  const hintSelection = hintLoad ? hintLoad.selection : null;

  // --- 4. Prompt + wywołanie AI ---
  const systemPrompt = buildSystemPrompt({ recommendationType, knowledgeBaseContent, confidenceTone, hintSelection });
  const userPrompt = buildUserPrompt({
    recommendationType,
    referralReason,
    context,
    extra: {
      painNote: relatedBodyLocation ? `Wzorzec bólu wykryty w lokalizacji: ${relatedBodyLocation}.` : null,
      readinessLines,
    },
  });
  const aiResult = await callAnthropic(systemPrompt, userPrompt);

  if (!aiResult || !aiResult.recommendation_text) {
    throw new Error('Odpowiedź AI nie zawiera wymaganego pola recommendation_text.');
  }

  // --- 5. Zapis — dokładnie kształt, jakiego oczekuje gotowy frontend ---
  const suggestedSpecialistCategory = resolveSuggestedSpecialistCategory(
    segmentId,
    context.profile && context.profile.injury_mode_active
  );

  const row = {
    user_id: userId,
    recommendation_type: recommendationType,
    goal_id: recommendationType === 'training_focus' ? goalId : null,
    segment_id: segmentId || null,
    referral_reason: recommendationType === 'specialist_referral' ? referralReason : null,
    related_body_location: relatedBodyLocation || null,
    related_injury_history_id: relatedInjuryHistoryId || null,
    weekly_focus_text: aiResult.weekly_focus_text || null,
    recommendation_text: aiResult.recommendation_text,
    rationale_text: aiResult.rationale_text || null,
    confidence_tone: confidenceTone,
    suggested_specialist_category: suggestedSpecialistCategory,
  };

  // PODPOWIEDZI SILNIK A4 08.08.2026 — REGUŁA R1: prompt bogatszy o
  // podpowiedzi to za mało. Rekomendacja musi POWIEŹĆ ZE SOBĄ konkretną
  // podpowiedź w postaci nadającej się do pokazania na ekranie: treść,
  // materiał, strona. Pełny kontrakt (kształt pola + przykład prawdziwego
  // rekordu) opisany dla pasa B w claude/RAPORT_ZWROTNY_A_RUNDA_4.md,
  // sekcja 11 — pas B buduje wyświetlanie i to jego jedyne źródło.
  const showcaseHint = pickShowcaseHint(
    hintSelection,
    typeof aiResult.used_hint_klucz === 'string' && aiResult.used_hint_klucz
      ? aiResult.used_hint_klucz
      : null
  );
  if (showcaseHint) row.source_hint = showcaseHint;

  let inserted = null;
  {
    const first = await supabase
      .from('decision_recommendations').insert(row).select().single();
    if (first.error && showcaseHint && isMissingColumnError(first.error)) {
      // Kolumna `source_hint` jeszcze nie istnieje (Kuba nie wkleił migracji
      // z sekcji 10 raportu). Zapisujemy rekomendację BEZ niej — silnik ma
      // działać dokładnie tak jak dziś — ale mówimy to wprost w logu,
      // zamiast po cichu zgubić podpowiedź (reguła R5).
      console.error('[podpowiedzi] decision_recommendations nie ma kolumny source_hint — rekomendacja zapisana BEZ podpowiedzi dla ekranu. Zawodnik jej NIE zobaczy, dopóki migracja z sekcji 10 raportu A rundy 4 nie zostanie wklejona.');
      const bezPola = { ...row };
      delete bezPola.source_hint;
      const second = await supabase
        .from('decision_recommendations').insert(bezPola).select().single();
      if (second.error) throw new Error(`generateRecommendation(insert): ${second.error.message}`);
      inserted = second.data;
    } else if (first.error) {
      throw new Error(`generateRecommendation(insert): ${first.error.message}`);
    } else {
      inserted = first.data;
    }
  }

  return { ok: true, blocked: false, recommendation: inserted };
}

// ------------------------------------------------------------
// HTTP HANDLER (Vercel Function) — cienki wrapper, ten sam wzorzec co
// api_mark_booking_completed.js w Marketplace.
// ------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Ten endpoint NIE jest dla zawodnika — wywołuje go wyłącznie zaufana
  // logika backendu (cron pierwszej rekomendacji z ankiety — patrz
  // api_cron_onboard_diagnosis.js, przyszła detekcja wzorca bólu/eskalacji),
  // nigdy bezpośrednio frontend appki (koszt AI + zapis treści rekomendacji
  // to uprawnienie wyłącznie service role, patrz RLS w
  // asystent_sportowca_06_centrum_decyzji.sql). Ten sam wzorzec co
  // CRON_SECRET już używany w Marketplace.
  const engineSecret = process.env.DECISION_ENGINE_SECRET;
  if (!engineSecret || req.headers['x-engine-secret'] !== engineSecret) {
    return res.status(401).json({ error: 'Brak autoryzacji.' });
  }

  const {
    userId, recommendationType, referralReason, goalId, segmentId,
    relatedBodyLocation, relatedInjuryHistoryId,
  } = req.body || {};

  try {
    const result = await generateRecommendation({
      userId, recommendationType, referralReason, goalId, segmentId,
      relatedBodyLocation, relatedInjuryHistoryId,
    });
    if (!result.ok) {
      // Zablokowane przez kontrolę kosztów — to oczekiwany wynik, nie błąd.
      return res.status(200).json(result);
    }
    return res.status(201).json(result);
  } catch (e) {
    console.error('generate-recommendation error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// Eksport do reużycia przez przyszły cron/wyzwalacz bez duplikowania
// logiki (i do testów jednostkowych).
module.exports.generateRecommendation = generateRecommendation;
module.exports._internal = {
  checkHardDailyCap,
  checkTrainingFocusCadence,
  checkPainPatternCooldown,
  checkFeedbackEscalationNotYetFired,
  computeRejectionStreak,
  fetchPlayerContext,
  fetchPlayerDiagnosis,
  fetchPlayerInsights,
  fetchKnowledgeBase,
  resolveGoalSegment,
  computeRelativeDeficits,
  pickLowestScoringSegment,
  buildSystemPrompt,
  buildUserPrompt,
  SEG_NAMES,
  SEGMENT_TO_SPECIALIST_CATEGORY,
  INJURY_MODE_OVERRIDE_CATEGORY,
  resolveSuggestedSpecialistCategory,
  // DOZOWANIE A6 08.08.2026
  shouldLoadHints,
  fetchReadinessWindowLogs,
  computeReadinessSignals,
  buildReadinessNarrative,
  fetchRecentMatchContextAnswers,
  computeMatchReadinessSignal,
  buildMatchReadinessNarrative,
  MATCH_NEGATIVE_OUTCOME_CODES,
};

// ============================================================
// CO ŚWIADOMIE NIE JEST TU ZROBIONE (nie przeoczone — celowo poza
// zakresem tego szkieletu, bo wymaga decyzji/projektu, których jeszcze
// nie ma, dokładnie ta sama dyscyplina co przy living_diagnosis_pulses
// i match_context_answers wcześniej w tym projekcie):
//
// 1. DETEKCJA KIEDY wygenerować training_focus DLA ZAWODNIKA, KTÓRY JUŻ MA
//    aktywny cel — ZBUDOWANE 01.08.2026 jako osobny moduł
//    lib/training-focus-rotation.js (Pakiet B/2): rytm co 7 dni
//    (TRAINING_FOCUS_ROTATION_CADENCE_DAYS) LUB wcześniej przy meczu za
//    2-6 dni, plus wewnętrzny checkTrainingFocusCadence() jako zabezpieczenie
//    przed podwójnym wywołaniem tego samego dnia — patrz integracja w
//    api/cron-send-notifications.js. To NIE jest pełne "ważenie RPE/snu/
//    kontekstu meczowego" wspomniane niżej — to prostsza, celowo wybrana
//    heurystyka czasowa, która okazała się wystarczająca. Poniższy opis
//    zostaje jako historia pierwotnego, szerszego zamysłu, nie aktualny
//    brak. PIERWSZA rekomendacja (zaraz po ankiecie,
//    zanim zawodnik ma jeszcze jakikolwiek cel) ma już swój mechanizm —
//    patrz api_cron_onboard_diagnosis.js — ale to nie zastępuje bieżącej
//    rotacji dla zawodników z historią.
//
// 2. LIVE-COMPUTATION GOTOWOŚCI (Funkcja 8) — wymiar FIZYCZNY i MENTALNY
//    ZAIMPLEMENTOWANE 26.07.2026 (computeReadinessSignals() wyżej,
//    zaakceptowane przez Kubę w claude/PRZEGLAD_PROGOW_GOTOWOSCI_I_
//    HORIZON_WEEKS.md). Wymiar MECZOWY — ZAIMPLEMENTOWANY 03.08.2026
//    (computeMatchReadinessSignal()/buildMatchReadinessNarrative() wyżej,
//    po decyzji Kuby o formacie response_value, KOLEJKA_DECYZJI_I_
//    PROJEKTOWANIA.md 3.1). Nadal NIE zaimplementowane:
//    a) A3 ACWR — memo aktywnie odradza wdrożenie w V1.
//    b) WYKRYWANIE WZORCA BÓLU (pain_pattern_match — "ból w tej samej
//       lokalizacji co historyczna kontuzja, powtarzający się"). Sam
//       mechanizm (ile powtórzeń, jakie okno czasowe) nie jest jeszcze
//       zaprojektowany. Ten plik zakłada że coś innego już wykryło wzorzec
//       i podaje relatedBodyLocation/relatedInjuryHistoryId.
//    c) ROZPOZNAWANIE SERII słabych meczów (nie tylko najnowszego) w
//       wymiarze meczowym Gotowości — computeMatchReadinessSignal() w V1
//       patrzy wyłącznie na najnowszy mecz, świadome uproszczenie (patrz
//       komentarz przy funkcji), do rozbudowy jeśli okaże się za wąskie.
//    d) "Diagnoza żywa" (living_diagnosis_pulses, rotacyjne pytania
//       pojedynczego segmentu poza meczem/dziennikiem) — osobny mechanizm
//       UI, wymaga zmian w mecz.tsx/asystent_app.html/appce mobilnej, poza
//       zakresem tego pliku i tej sesji (patrz zasada projektu: te ekrany
//       zmieniają się wyłącznie na świeżą, wyraźną prośbę Kuby).
//
// 3. AUTOMATYCZNE WYWOŁANIE ESKALACJI po 3+ odrzuceniach z rzędu.
//    ZBUDOWANE 27.07.2026 (część 3 tamtej sesji) — ten punkt jest
//    nieaktualny, zostawiony wcześniej bez poprawki (patrz audyt spójności,
//    znalezisko D5). computeRejectionStreak() jest teraz faktycznie
//    wywoływane: asystent_app.html submitFeedback() woła
//    /api/submit-recommendation-feedback (nowy plik) zamiast bezpośredniego
//    PATCH — ten endpoint zapisuje feedback, liczy streak i przy 3+ z rzędu
//    ("did_not_make_sense" na training_focus) woła generateRecommendation()
//    z recommendationType='specialist_referral', referralReason=
//    'feedback_escalation' in-process. Patrz submit-recommendation-
//    feedback.js po pełny opis.
//
// 4. CRON / HARMONOGRAM wywołujący ten silnik okresowo dla WSZYSTKICH
//    aktywnych celów (rotacja bieżąca, nie pierwsza rekomendacja) — nie
//    zbudowany, bo wymaga najpierw punktu 1. Wzorzec do naśladowania gdy
//    powstanie: api_cron_settlement.js + vercel.json z Marketplace
//    (Vercel Cron, patrz KROK 6 w MARKETPLACE_CHECKLISTA_WDROZENIA.md).
//
// 5. Nazwa modelu Anthropic (ANTHROPIC_MODEL) — fallback zaktualizowany
//    04.08.2026 na 'claude-sonnet-5', patrz komentarz przy callAnthropic().
// ============================================================
