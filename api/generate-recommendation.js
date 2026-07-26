// ============================================================
// GAMECHANGE - /api/generate-recommendation.js
// ============================================================
// SZKIELET SILNIKA AI CENTRUM DECYZJI (Domena 06 - Funkcje koncepcyjne
// F3 "Co dzis zrobic?", F8 "Gotowosc" most do specjalisty, F23 feedback
// i eskalacja).
//
// CO TEN PLIK ROBI:
//   1. Kontrola kosztow (dokladnie reguly z ASYSTENT_SPORTOWCA_ARCHITEKTURA
//      _TECHNICZNA.md, sekcja "Kontrola kosztow") - sprawdzana PRZED
//      jakimkolwiek platnym wywolaniem AI.
//   2. Zbiera kontekst zawodnika (profil, Dziennik, bol, kontekst meczowy,
//      ANKIETA/DIAGNOZA i obserwacje trenera/rodzica - patrz POPRAWKA
//      nizej) i wstrzykuje wlasciwy wpis z `knowledge_base_entries` do
//      prompta.
//   3. Wola Anthropic API (miejsce jasno oznaczone - dzis zwroci czytelny
//      blad, bo ANTHROPIC_API_KEY jeszcze nie ustawiony, patrz DO ZROBIENIA
//      PRZEZ KUBE w architekturze).
//   4. Zapisuje wynik do `decision_recommendations` w dokladnie takim
//      ksztalcie, jakiego juz oczekuje gotowy, przetestowany frontend
//      (Czwarty ekran - Centrum Decyzji w asystent_app.html).
//
// ------------------------------------------------------------
// POPRAWKA (25.07.2026, wieczor - decyzja Kuby ws. ankiety jako wejscia
// do systemu): "jezeli da sie zbudowac diagnoze... to chcialbym to
// zrobic... ankieta niech sie stanie na razie gotowym wejsciem do
// systemu... beda juz w systemie pierwsze rekomendacje wynikajace
// z wypelnionej ankiety."
//
// PRZED ta poprawka fetchPlayerContext() czytal WYLACZNIE
// player_profiles/daily_logs/pain_entries/match_contexts - mimo ze
// Domena 15 (most kont legacy) od dawna laczy `diagnostics` i
// `player_insights` z user_id przy tworzeniu konta, silnik rekomendacji
// nigdy tych dwoch tabel nie odczytywal. Efekt: nawet zawodnik z bogata,
// swiezo powiazana diagnoza dostawalby rekomendacje wylacznie na bazie
// Dziennika/bolu/meczow - czyli faktycznie od zera, dokladnie to czego
// Kuba chcial uniknac ("nie chcialbym stracic algorytmow/danych z
// ankiety... chcialbym je wykorzystac w logice pelnego systemu").
//
// Naprawa: fetchPlayerContext() teraz dodatkowo pobiera (a) najnowsza
// powiazana diagnoze (diagnostics, po user_id) i (b) aktywne (<=90 dni,
// ten sam prog i uzasadnienie co INSIGHT_MAX_AGE_DAYS w index.html)
// player_insights. computeRelativeDeficits() swiadomie duplikuje
// getRelativeDeficits() z index.html - ten sam wzorzec i to samo
// uzasadnienie co przy SEG_NAMES w recommendation_engine.js (Marketplace):
// utrzymanie identycznej, niewielkiej logiki w dwoch miejscach jest
// tansze niz sprzeganie dwoch osobnych aplikacji wspoldzielonym kodem
// frontendowym. Jesli kiedys prog/wzor w index.html sie zmieni, trzeba
// pamietac o recznej synchronizacji tutaj - dokladnie tak jak juz dzis
// przy SEG_NAMES.
// ------------------------------------------------------------
//
// CO SWIADOMIE NIE JEST TU ZROBIONE (swiadomie odlozone, nie przeoczone
// - patrz sekcja na koncu pliku "CO SWIADOMIE NIE JEST TU ZROBIONE"):
//   - Detekcja KIEDY wygenerowac training_focus (rotacja celu priorytetowego
//     z Funkcji 2, "priorytet rotuje dynamicznie").
//   - Live-computation Gotowosci (Funkcja 8, trzy wymiary) i wykrywanie
//     wzorca bolu (pain_pattern_match).
//   - Automatyczne wyzwolenie eskalacji po 3+ odrzuceniach z rzedu.
//   - Cron/harmonogram wywolujacy ten silnik okresowo dla zawodnikow z
//     JUZ aktywnym celem (patrz jednak api_cron_onboard_diagnosis.js -
//     to jest cron, ale tylko dla PIERWSZEJ rekomendacji po ankiecie,
//     nie dla biezacej rotacji).
// Ten plik zaklada, ze cos innego (na razie nieistniejace, poza wyjatkiem
// wyzej) juz zdecydowalo CO i DLACZEGO wygenerowac, i przekazuje mu
// gotowe parametry.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

// ------------------------------------------------------------
// KONFIGURACJA - zmienne srodowiskowe Vercel, ta sama konwencja
// nazewnicza co w Marketplace (patrz MARKETPLACE_CHECKLISTA_WDROZENIA.md,
// Krok 4): SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY juz tam opisane.
// Nowe w tym pliku: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (opcjonalne,
// z sensownym domyslnym), DECISION_ENGINE_SECRET (nowy, patrz nizej).
// ------------------------------------------------------------
// UWAGA CELOWA: wszystkie odczytywane nizej jako funkcje, NIE jako stale na
// poziomie modulu - Vercel laduje modul raz per cold start, wiec w praktyce
// roznicy nie widac, ale odczyt na zadanie jest odporny na wspoldzielenie
// modulu miedzy wywolaniami (np. testy jednostkowe zmieniajace
// process.env w trakcie dzialania procesu - to jest dokladnie to, co
// zlapal test_generate_recommendation.js podczas budowy tego pliku: stala
// odczytana raz przy pierwszym require() ignorowala pozniejsza zmiane env).
function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych srodowiskowych.');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ------------------------------------------------------------
// NAZWY SEGMENTOW - kopia z SEG_NAMES w index.html (ten sam wzorzec
// swiadomej duplikacji co w recommendation_engine.js Marketplace).
// Potrzebne tu do budowania czytelnego kontekstu diagnozy w prompcie
// (patrz buildUserPrompt) bez odpytywania public.segments za kazdym razem.
// ------------------------------------------------------------
const SEG_NAMES = {
  moc: 'MOC',
  wytrzymalosc: 'WYTRZYMALOSC',
  fizycznosc: 'FIZYCZNOSC',
  techFund: 'TECHNIKA FUND.',
  techSpec: 'TECHNIKA SPEC.',
  regeneracja: 'REGENERACJA',
  odpornosc: 'ODPORNOSC',
  odzywianie: 'ODZYWIENIE',
  tolerancja: 'TOL. OBCIAZEN',
  koncentracja: 'KONCENTRACJA',
  mental: 'ODWAGA W GRZE',
  percepcja: 'PERCEPCJA',
  decyzja: 'SZYBK. DECYZJI',
};

// ------------------------------------------------------------
// WZGLEDNE WYKRYWANIE DEFICYTOW - swiadoma duplikacja getRelativeDeficits()
// z index.html (patrz POPRAWKA w naglowku pliku). Porownanie WYLACZNIE do
// wlasnych wynikow zawodnika (mediana +/- odchylenie), nie do sztywnego
// progu - dokladnie ta sama logika co w narzedziu ankiety, zeby "top
// deficyt" znaczyl to samo w obu miejscach systemu.
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

// Fallback gdy profil jest wyrownany (Scenariusz 2/3 w index.html) -
// zaden segment nie spelnia progu statystycznego. UPROSZCZENIE SWIADOME
// wzgledem index.html: tam istnieje bogatszy fallback pozycyjny
// (POSITION_PROFILES.tiers - segmenty "key" dla danej pozycji na boisku).
// Tu, na start (v1 mostu ankieta->system), bierzemy po prostu najnizej
// punktowany segment ogolem - prostsze, nie wymaga duplikowania calej
// tabeli 13x8 pozycji w tym pliku. Jesli w praktyce da to gorsze pierwsze
// rekomendacje niz warto, rozszerzyc o POSITION_PROFILES.tiers analogicznie
// do SEGMENT_TO_CATEGORY_CHRONIC w recommendation_engine.js.
function pickLowestScoringSegment(scores) {
  const entries = Object.entries(scores || {});
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  return entries[0][0];
}

// ------------------------------------------------------------
// Kategorie specjalistow - NIEUZYWANE bezposrednio w tym pliku, ale
// referencyjnie zgodne z recommendation_engine.js (Marketplace), gdyby
// przyszla rekomendacja typu specialist_referral miala kiedys czerpac
// z diagnozy zamiast tylko z pain_entries/injury_history.
// ------------------------------------------------------------

// ------------------------------------------------------------
// KONTROLA KOSZTOW
// Cztery niezalezne reguly - patrz ASYSTENT_SPORTOWCA_ARCHITEKTURA_
// TECHNICZNA.md, sekcja "Kontrola kosztow". Kazda zwraca
// { allowed, reason? }. Wolane w kolejnosci od najogolniejszej
// (twardy limit dobowy) do specyficznej dla typu - pierwsza blokada
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
    return { allowed: false, reason: 'Twardy limit bezpieczenstwa: 5 wywolan AI/dobe juz wykorzystane.' };
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
      reason: 'training_focus juz wygenerowany w ciagu ostatnich 24h (limit obowiazuje nawet przy zmianie celu priorytetowego).',
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
      reason: `Wciaz otwarte skierowanie (bez feedbacku) dla lokalizacji "${bodyLocation}" z ostatnich 14 dni.`,
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
// segmencie PO ostatniej eskalacji - patrz komentarz w architekturze.
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
    reason: `Eskalacja dla segmentu "${segmentId}" juz wystrzelona i nie zresetowana (brak feedbacku "done" od tego czasu).`,
  };
}

// ------------------------------------------------------------
// TON (Funkcja 3, sygnal 4) - WLASNA INTERPRETACJA PROGU, do korekty
// przez Kube jesli intuicja trenerska mowi inaczej (ten sam status co
// progi gotowosci w research_gotowosc_progi.md - logicznie dobrana
// wartosc startowa, nie bezposrednio zbadana liczba):
//   1 odrzucenie z rzedu  -> bez zmian (assertive)
//   2 odrzucenia z rzedu  -> ton pytajacy (questioning)
//   3+ odrzucenia z rzedu -> to juz nie jest kwestia tonu, tylko sygnal do
//     eskalacji (specialist_referral/feedback_escalation) - patrz
//     checkFeedbackEscalationNotYetFired wyzej. Ten silnik NIE wywoluje
//     eskalacji automatycznie w trakcie generowania training_focus (patrz
//     "CO SWIADOMIE NIE JEST TU ZROBIONE" na koncu pliku) - tylko liczy
//     streak pod katem tonu biezacej odpowiedzi.
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

// ------------------------------------------------------------
// KONTEKST ZAWODNIKA - dokladnie te kolumny/tabele co w rzeczywistym
// schemacie (zweryfikowane przez odczyt SQL, nie z pamieci):
// player_profiles (Domena 01), daily_logs + pain_entries (Domena 03),
// match_contexts (Domena 04).
//
// POPRAWKA (25.07.2026): dodano diagnostics (Domena 02, powiazane przez
// most z Domeny 15) i player_insights (tez Domena 15) - patrz uzasadnienie
// w naglowku pliku. Obie sa opcjonalne (moze nie byc jeszcze zadnej
// powiazanej ankiety, np. zawodnik zalozyl konto bez wczesniejszego
// wypelnienia formularza) - reszta silnika dziala identycznie jak wczesniej
// gdy ich brak, po prostu bez tej dodatkowej warstwy kontekstu.
// ------------------------------------------------------------
const INSIGHT_MAX_AGE_DAYS = 90; // ten sam prog i uzasadnienie co w index.html

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

async function fetchPlayerContext(supabase, userId) {
  const [profileRes, recentLogsRes, recentPainRes, recentMatchesRes, diagnosis, insights] = await Promise.all([
    supabase.from('player_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('daily_logs').select('entry_type, session_type, payload, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('pain_entries').select('body_location, side, intensity, excludes_from_training, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('match_contexts').select('game_type, own_score, opponent_score, role, minutes_played, match_rpe, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(3),
    fetchPlayerDiagnosis(supabase, userId),
    fetchPlayerInsights(supabase, userId),
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

// Dla training_focus segmentId powinien pochodzic z samego celu (goal),
// nie tylko z parametru wejsciowego - unika rozjazdu, jesli caller poda
// niespojna pare goalId/segmentId.
async function resolveGoalSegment(supabase, goalId) {
  if (!goalId) return null;
  const { data, error } = await supabase
  .from('goals').select('id, segment_id, status').eq('id', goalId).maybeSingle();
  if (error) throw new Error(`resolveGoalSegment: ${error.message}`);
  if (!data) throw new Error(`resolveGoalSegment: cel o id=${goalId} nie istnieje.`);
  // POPRAWKA (pelny audyt calosci): status byl pobierany, ale nigdy nie
// sprawdzany - silnik mogl wygenerowac rekomendacje "training_focus"
// dla celu, ktory zawodnik juz oznaczyl jako 'completed' albo
// 'abandoned' (asystent_sportowca_05_cele.sql: status IN ('active',
// 'completed', 'abandoned')). Realny scenariusz: zawodnik porzuca cel,
// ale zaplanowane/opoznione wywolanie silnika (albo przyszly cron)
// i tak generuje sugestie dotyczaca segmentu z NIEAKTUALNEGO juz celu -
// mylaca rekomendacja bez pokrycia w biezacych priorytetach zawodnika.
if (data.status !== 'active') {
  throw new Error(`resolveGoalSegment: cel o id=${goalId} nie jest aktywny (status=${data.status}).`);
}
  return data.segment_id;
}

// ------------------------------------------------------------
// PROMPT - filozofia i format wprost z Funkcji 3 dokumentu koncepcyjnego
// (ASYSTENT_SPORTOWCA_PROJEKT.md), nie wymyslone od nowa.
// ------------------------------------------------------------
function buildSystemPrompt({ recommendationType, knowledgeBaseContent, confidenceTone }) {
  const toneInstruction = confidenceTone === 'questioning'
  ? 'Zawodnik ostatnio kilka razy z rzedu odrzucil podobne sugestie jako "nie mialo sensu". Zlagodz ton - sformuluj rekomendacje jako pytanie/hipoteze, nie stanowcze stwierdzenie (np. "czy cos w Twojej sytuacji sprawia ze X sie nie sprawdza?"), zamiast byc w pelni asertywnym.'
    : 'Formuluj rekomendacje asertywnie i wprost, na podstawie danych.';

const kbBlock = knowledgeBaseContent
  ? `BAZA WIEDZY GAMECHANGE dla tego segmentu (zrodlo prawdy - nigdy jej nie neguj, nigdy nie proponuj czegos sprzecznego z nia):\n${knowledgeBaseContent}\n\n`
  : '';

const formatBlock = recommendationType === 'training_focus'
  ? '{"weekly_focus_text": "krotki naglowek priorytetu tygodnia", "recommendation_text": "konkretna, wykonalna rekomendacja dzialania", "rationale_text": "krotkie uzasadnienie oparte na danych zawodnika podanych nizej"}'
  : '{"recommendation_text": "rzeczowa, ostrozna sugestia rozmowy ze specjalista", "rationale_text": "krotkie wyjasnienie dlaczego, oparte na danych"}';

return `Jestes silnikiem Centrum Decyzji w aplikacji Gamechange dla mlodych pilkarzy.

FILOZOFIA (nienaruszalna, wprost z dokumentu koncepcyjnego Funkcji 3): Centrum Decyzji jest NAWIGATOREM, nie planista. Nie piszesz dokladnego planu treningowego - kierunkujesz i uzasadniasz. Zawodnik samodzielnie realizuje szczegoly (albo korzysta ze specjalisty z Marketplace).

${kbBlock}TON: ${toneInstruction}

${recommendationType === 'specialist_referral' ? 'WAZNE (dotyczy tylko skierowania do specjalisty): to ma byc OSTROZNA sugestia, nie alarm. Wzorzec bolu moze rownie dobrze wynikac ze zwyklego przetrenowania, nie nawrotu kontuzji - pisz "warto to sprawdzic", nigdy "prawdopodobnie masz nawrot kontuzji".\n\n' : ''}JEZYK: wylacznie polski, zwiezle, konkretnie, bez zargonu, zwracaj sie do zawodnika bezposrednio ("Ty").

FORMAT ODPOWIEDZI: zwroc WYLACZNIE poprawny JSON (bez markdown, bez blokow kodu, bez komentarzy) dokladnie w tym ksztalcie:
${formatBlock}`;
}

// POPRAWKA (25.07.2026): dodano blok "Z ANKIETY DIAGNOSTYCZNEJ" i
// "OBSERWACJE TRENERA/RODZICA" - dokladnie ten sam typ informacji, ktory
// _buildDiagData()/generateAIDiagnosis() w index.html juz od dawna
// wstrzykuje do SWOJEGO prompta AI przy generowaniu diagnozy. Tu robimy
// analogicznie dla Centrum Decyzji, zeby pierwsza (i kazda kolejna)
// rekomendacja uwzgledniala to, co system juz wie o zawodniku z ankiety,
// zamiast zaczynac wylacznie od Dziennika.
function buildUserPrompt({ recommendationType, referralReason, context, extra }) {
  const { profile, recentLogs, recentPain, recentMatches, diagnosis, insights } = context;
  const lines = [];
  lines.push(`Typ rekomendacji do wygenerowania: ${recommendationType}${referralReason ? ' / ' + referralReason : ''}.`);

if (profile) {
  lines.push(`Pozycja: ${profile.position_primary || 'nieznana'}. Poziom: ${profile.current_level || 'nieznany'}.`);
  if (profile.injury_mode_active) {
    lines.push(`UWAGA - Tryb kontuzji AKTYWNY (kategoria: ${profile.injury_mode_category || 'brak'}). Rekomendacja MUSI to uwzgledniac - zadnej sugestii intensywnego obciazenia w obszarze objetym kontuzja.`);
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
      : 'brak statystycznie istotnego waskiego gardla - profil wyrownany';
    const whenStr = diagnosis.created_at ? new Date(diagnosis.created_at).toLocaleDateString('pl-PL') : 'nieznana data';
    lines.push(`Z ANKIETY DIAGNOSTYCZNEJ (wypelniona ${whenStr}${diagnosis.diagnosis_type ? ', typ: ' + diagnosis.diagnosis_type : ''}): wykryte waskie gardla - ${deficitsStr}.`);
  }
} else {
  lines.push('Zawodnik nie ma jeszcze powiazanej ankiety diagnostycznej - nie zgaduj deficytow, bazuj wylacznie na danych nizej.');
}

if (insights && insights.length) {
  const insightLines = insights.slice(0, 5).map((ins) => {
    const who = ins.source === 'coach' ? 'Trener zaobserwowal' : ins.source === 'parent' ? 'Rodzic zaobserwowal' : 'Zawodnik potwierdzil';
    const segName = SEG_NAMES[ins.segment_id] || ins.segment_id;
    const detail = ins.response_comment || ins.response_value || '';
    return `${who} (obszar: ${segName}): ${detail}`.trim();
  });
  lines.push(`OBSERWACJE TRENERA/RODZICA (ostatnie ${INSIGHT_MAX_AGE_DAYS} dni):\n${insightLines.join('\n')}`);
}

if (recentLogs.length) {
  lines.push(`Ostatnie wpisy w Dzienniku (najnowsze pierwsze, max 10, skala pol 0-10): ${JSON.stringify(recentLogs)}`);
}
  if (recentPain.length) {
    lines.push(`Ostatnie zgloszenia bolu (najnowsze pierwsze, max 10): ${JSON.stringify(recentPain)}`);
  }
  if (recentMatches.length) {
    lines.push(`Ostatnie mecze (najnowsze pierwsze, max 3): ${JSON.stringify(recentMatches)}`);
  }
  if (extra && extra.painNote) lines.push(extra.painNote);
  if (extra && extra.goalNote) lines.push(extra.goalNote);

if (!recentLogs.length && !recentMatches.length && !recentPain.length && !(diagnosis && diagnosis.scores)) {
  lines.push('Brak dotychczasowych danych w Dzienniku/kontekscie meczowym/ankiecie - jesli to za malo do konkretnej rekomendacji, napisz to wprost zamiast zgadywac.');
}

return lines.join('\n');
}

// ------------------------------------------------------------
// WYWOLANIE ANTHROPIC API - TODO(Kuba): zadziala od razu, gdy
// ANTHROPIC_API_KEY trafi do zmiennych srodowiskowych Vercel. Do tego
// czasu rzuca czytelny blad zamiast cichego niepowodzenia.
// ------------------------------------------------------------
async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY nie skonfigurowany - silnik jest gotowy, brakuje tylko klucza (patrz "DO ZROBIENIA PRZEZ KUBE" w architekturze).');
  }
  // Nazwa modelu to placeholder - ZWERYFIKUJ aktualna nazwe modelu Anthropic
// przed pierwszym prawdziwym wdrozeniem (dokumentacja: docs.claude.com).
const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
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
  if (!textBlock) throw new Error('Odpowiedz Anthropic bez bloku tekstowego.');
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`Nie udalo sie sparsowac JSON z odpowiedzi AI: ${e.message}. Surowa odpowiedz (pierwsze 500 znakow): ${textBlock.text.slice(0, 500)}`);
  }
  return parsed;
}

// ------------------------------------------------------------
// ORKIESTRATOR - glowna funkcja silnika, do reuzycia przez ten plik
// (HTTP handler nizej) i przez kazdego przyszlego wywolujacego (cron,
// webhook feedbacku itd.) bez duplikowania logiki.
//
// drugi parametr (injectedSupabase) jest opcjonalny - do testow
// jednostkowych bez prawdziwego polaczenia z Supabase, oraz do
// przyszlego reuzycia gdy wywolujacy ma juz gotowego klienta.
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
    throw new Error(`generateRecommendation: nieprawidlowy recommendationType "${recommendationType}".`);
  }
  if (recommendationType === 'specialist_referral' && !['pain_pattern_match', 'feedback_escalation', 'other'].includes(referralReason)) {
    throw new Error(`generateRecommendation: nieprawidlowy referralReason "${referralReason}".`);
  }
  if (recommendationType === 'specialist_referral' && referralReason === 'pain_pattern_match' && !relatedBodyLocation) {
    throw new Error('generateRecommendation: pain_pattern_match wymaga relatedBodyLocation.');
  }
  if (recommendationType === 'specialist_referral' && referralReason === 'feedback_escalation' && !segmentId) {
    throw new Error('generateRecommendation: feedback_escalation wymaga segmentId.');
  }

const supabase = injectedSupabase || getAdminClient();

// training_focus: segmentId zawsze wyprowadzony z samego celu (goalId),
// nie z parametru wejsciowego - unika rozjazdu jesli caller poda
// niespojna pare goalId/segmentId.
if (recommendationType === 'training_focus') {
  if (!goalId) throw new Error('generateRecommendation: training_focus wymaga goalId.');
  segmentId = await resolveGoalSegment(supabase, goalId);
}

// --- 1. Kontrola kosztow, w kolejnosci od najogolniejszej ---
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

// --- 2. Kontekst + baza wiedzy ---
const context = await fetchPlayerContext(supabase, userId);
  const knowledgeBaseContent = await fetchKnowledgeBase(supabase, segmentId);

// --- 3. Ton - tylko training_focus ma tu sens (patrz komentarz wyzej) ---
let confidenceTone = 'assertive';
  if (recommendationType === 'training_focus' && segmentId) {
    const streak = await computeRejectionStreak(supabase, userId, segmentId);
    if (streak >= 2) confidenceTone = 'questioning';
  }

// --- 4. Prompt + wywolanie AI ---
const systemPrompt = buildSystemPrompt({ recommendationType, knowledgeBaseContent, confidenceTone });
  const userPrompt = buildUserPrompt({
    recommendationType,
    referralReason,
    context,
    extra: {
      painNote: relatedBodyLocation ? `Wzorzec bolu wykryty w lokalizacji: ${relatedBodyLocation}.` : null,
    },
  });
  const aiResult = await callAnthropic(systemPrompt, userPrompt);

if (!aiResult || !aiResult.recommendation_text) {
  throw new Error('Odpowiedz AI nie zawiera wymaganego pola recommendation_text.');
}

// --- 5. Zapis - dokladnie ksztalt, jakiego oczekuje gotowy frontend ---
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
};

const { data: inserted, error: insertError } = await supabase
  .from('decision_recommendations')
  .insert(row)
  .select()
  .single();
  if (insertError) throw new Error(`generateRecommendation(insert): ${insertError.message}`);
  return { ok: true, blocked: false, recommendation: inserted };
}

// ------------------------------------------------------------
// HTTP HANDLER (Vercel Function) - cienki wrapper, ten sam wzorzec co
// api_mark_booking_completed.js w Marketplace.
// ------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Ten endpoint NIE jest dla zawodnika - wywoluje go wylacznie zaufana
  // logika backendu (cron pierwszej rekomendacji z ankiety - patrz
  // api_cron_onboard_diagnosis.js, przyszla detekcja wzorca bolu/eskalacji),
  // nigdy bezposrednio frontend appki (koszt AI + zapis tresci rekomendacji
  // to uprawnienie wylacznie service role, patrz RLS w
  // asystent_sportowca_06_centrum_decyzji.sql). Ten sam wzorzec co
  // CRON_SECRET juz uzywany w Marketplace.
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
      // Zablokowane przez kontrole kosztow - to oczekiwany wynik, nie blad.
    return res.status(200).json(result);
    }
    return res.status(201).json(result);
  } catch (e) {
    console.error('generate-recommendation error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// Eksport do reuzycia przez przyszly cron/wyzwalacz bez duplikowania
// logiki (i do testow jednostkowych).
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
};

// ============================================================
// CO SWIADOMIE NIE JEST TU ZROBIONE (nie przeoczone - celowo poza
// zakresem tego szkieletu, bo wymaga decyzji/projektu, ktorych jeszcze
// nie ma, dokladnie ta sama dyscyplina co przy living_diagnosis_pulses
// i match_context_answers wczesniej w tym projekcie):
//
// 1. DETEKCJA KIEDY wygenerowac training_focus DLA ZAWODNIKA, KTORY JUZ MA
//    aktywny cel. Funkcja 2 mowi "priorytet rotuje dynamicznie" - ale
//    regula "kiedy dokladnie cos sie zmienilo na tyle, zeby uzasadnic nowe
//    wywolanie AI" to osobny algorytm (wazenie RPE/snu/kontekstu meczowego/
//    kalendarza), nie zbudowany. PIERWSZA rekomendacja (zaraz po ankiecie,
//    zanim zawodnik ma jeszcze jakikolwiek cel) ma juz swoj mechanizm -
//    patrz api_cron_onboard_diagnosis.js - ale to nie zastepuje biezacej
//    rotacji dla zawodnikow z historia.
//
// 2. LIVE-COMPUTATION GOTOWOSCI (Funkcja 8, trzy wymiary: fizyczny/
//    mentalny/meczowy) i WYKRYWANIE WZORCA BOLU (pain_pattern_match -
//    "bol w tej samej lokalizacji co historyczna kontuzja, powtarzajacy
//    sie"). Progi fizyczne maja juz robocza propozycje w
//    claude/research_gotowosc_progi.md, ale brak walidowanych progow dla
//    wymiaru mentalnego/meczowego, i sam mechanizm wykrywania wzorca bolu
//    (ile powtorzen, jakie okno czasowe) nie jest jeszcze zaprojektowany.
//    Ten plik zaklada ze cos innego juz wykrylo wzorzec i podaje
//    relatedBodyLocation/relatedInjuryHistoryId.
//
// 3. AUTOMATYCZNE WYWOLANIE ESKALACJI po 3+ odrzuceniach z rzedu.
//    computeRejectionStreak() istnieje i liczy streak poprawnie, ale
//    nic jeszcze nie wywoluje go automatycznie po PATCH feedbacku we
//    froncie (asystent_app.html submitFeedback dzis tylko zapisuje
//    feedback_response, nic wiecej). Osobny krok integracji - albo
//    wywolanie z frontendu po PATCH, albo trigger/webhook po stronie bazy.
//
// 4. CRON / HARMONOGRAM wywolujacy ten silnik okresowo dla WSZYSTKICH
//    aktywnych celow (rotacja biezaca, nie pierwsza rekomendacja) - nie
//    zbudowany, bo wymaga najpierw punktu 1. Wzorzec do nasladowania gdy
//    powstanie: api_cron_settlement.js + vercel.json z Marketplace
//    (Vercel Cron, patrz KROK 6 w MARKETPLACE_CHECKLISTA_WDROZENIA.md).
//
// 5. Dokladna nazwa modelu Anthropic (ANTHROPIC_MODEL) - placeholder,
//    zweryfikuj przed pierwszym wdrozeniem.
// ============================================================
