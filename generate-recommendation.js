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
//   2. Zbiera kontekst zawodnika (profil, Dziennik, ból, kontekst meczowy)
//      i wstrzykuje właściwy wpis z `knowledge_base_entries` do prompta.
//   3. Woła Anthropic API (miejsce jasno oznaczone — dziś zwróci czytelny
//      błąd, bo ANTHROPIC_API_KEY jeszcze nie ustawiony, patrz DO ZROBIENIA
//      PRZEZ KUBĘ w architekturze).
//   4. Zapisuje wynik do `decision_recommendations` w dokładnie takim
//      kształcie, jakiego już oczekuje gotowy, przetestowany frontend
//      (Czwarty ekran — Centrum Decyzji w asystent_app.html).
//
// CO ŚWIADOMIE NIE JEST TU ZROBIONE (świadomie odłożone, nie przeoczone
// — patrz sekcja na końcu pliku "CO ŚWIADOMIE NIE JEST TU ZROBIONE"):
//   - Detekcja KIEDY wygenerować training_focus (rotacja celu priorytetowego
//     z Funkcji 2, "priorytet rotuje dynamicznie").
//   - Live-computation Gotowości (Funkcja 8, trzy wymiary) i wykrywanie
//     wzorca bólu (pain_pattern_match).
//   - Automatyczne wyzwolenie eskalacji po 3+ odrzuceniach z rzędu.
//   - Cron/harmonogram wywołujący ten silnik okresowo.
// Ten plik zakłada, że coś innego (na razie nieistniejące) już zdecydowało
// CO i DLACZEGO wygenerować, i przekazuje mu gotowe parametry.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

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

// ------------------------------------------------------------
// KONTEKST ZAWODNIKA — dokładnie te kolumny/tabele co w rzeczywistym
// schemacie (zweryfikowane przez odczyt SQL, nie z pamięci):
// player_profiles (Domena 01), daily_logs + pain_entries (Domena 03),
// match_contexts (Domena 04).
// ------------------------------------------------------------
async function fetchPlayerContext(supabase, userId) {
  const [profileRes, recentLogsRes, recentPainRes, recentMatchesRes] = await Promise.all([
    supabase.from('player_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('daily_logs').select('entry_type, session_type, payload, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('pain_entries').select('body_location, side, intensity, excludes_from_training, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('match_contexts').select('game_type, own_score, opponent_score, role, minutes_played, match_rpe, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(3),
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
function buildSystemPrompt({ recommendationType, knowledgeBaseContent, confidenceTone }) {
  const toneInstruction = confidenceTone === 'questioning'
    ? 'Zawodnik ostatnio kilka razy z rzędu odrzucił podobne sugestie jako "nie miało sensu". Złagodź ton — sformułuj rekomendację jako pytanie/hipotezę, nie stanowcze stwierdzenie (np. "czy coś w Twojej sytuacji sprawia że X się nie sprawdza?"), zamiast być w pełni asertywnym.'
    : 'Formułuj rekomendację asertywnie i wprost, na podstawie danych.';

  const kbBlock = knowledgeBaseContent
    ? `BAZA WIEDZY GAMECHANGE dla tego segmentu (źródło prawdy — nigdy jej nie neguj, nigdy nie proponuj czegoś sprzecznego z nią):\n${knowledgeBaseContent}\n\n`
    : '';

  const formatBlock = recommendationType === 'training_focus'
    ? '{"weekly_focus_text": "krótki nagłówek priorytetu tygodnia", "recommendation_text": "konkretna, wykonalna rekomendacja działania", "rationale_text": "krótkie uzasadnienie oparte na danych zawodnika podanych niżej"}'
    : '{"recommendation_text": "rzeczowa, ostrożna sugestia rozmowy ze specjalistą", "rationale_text": "krótkie wyjaśnienie dlaczego, oparte na danych"}';

  return `Jesteś silnikiem Centrum Decyzji w aplikacji Gamechange dla młodych piłkarzy.

FILOZOFIA (nienaruszalna, wprost z dokumentu koncepcyjnego Funkcji 3): Centrum Decyzji jest NAWIGATOREM, nie planistą. Nie piszesz dokładnego planu treningowego — kierunkujesz i uzasadniasz. Zawodnik samodzielnie realizuje szczegóły (albo korzysta ze specjalisty z Marketplace).

${kbBlock}TON: ${toneInstruction}

${recommendationType === 'specialist_referral' ? 'WAŻNE (dotyczy tylko skierowania do specjalisty): to ma być OSTROŻNA sugestia, nie alarm. Wzorzec bólu może równie dobrze wynikać ze zwykłego przetrenowania, nie nawrotu kontuzji — pisz "warto to sprawdzić", nigdy "prawdopodobnie masz nawrót kontuzji".\n\n' : ''}JĘZYK: wyłącznie polski, zwięźle, konkretnie, bez żargonu, zwracaj się do zawodnika bezpośrednio ("Ty").

FORMAT ODPOWIEDZI: zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu, bez komentarzy) dokładnie w tym kształcie:
${formatBlock}`;
}

function buildUserPrompt({ recommendationType, referralReason, context, extra }) {
  const { profile, recentLogs, recentPain, recentMatches } = context;
  const lines = [];
  lines.push(`Typ rekomendacji do wygenerowania: ${recommendationType}${referralReason ? ' / ' + referralReason : ''}.`);

  if (profile) {
    lines.push(`Pozycja: ${profile.position_primary || 'nieznana'}. Poziom: ${profile.current_level || 'nieznany'}.`);
    if (profile.injury_mode_active) {
      lines.push(`UWAGA — Tryb kontuzji AKTYWNY (kategoria: ${profile.injury_mode_category || 'brak'}). Rekomendacja MUSI to uwzględniać — żadnej sugestii intensywnego obciążenia w obszarze objętym kontuzją.`);
    }
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
  if (extra && extra.painNote) lines.push(extra.painNote);
  if (extra && extra.goalNote) lines.push(extra.goalNote);

  if (!recentLogs.length && !recentMatches.length && !recentPain.length) {
    lines.push('Brak dotychczasowych danych w Dzienniku/kontekście meczowym — jeśli to za mało do konkretnej rekomendacji, napisz to wprost zamiast zgadywać.');
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
  // Nazwa modelu to placeholder — ZWERYFIKUJ aktualną nazwę modelu Anthropic
  // przed pierwszym prawdziwym wdrożeniem (dokumentacja: docs.claude.com).
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
  if (!textBlock) throw new Error('Odpowiedź Anthropic bez bloku tekstowego.');
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`Nie udało się sparsować JSON z odpowiedzi AI: ${e.message}. Surowa odpowiedź (pierwsze 500 znaków): ${textBlock.text.slice(0, 500)}`);
  }
  return parsed;
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

  // --- 2. Kontekst + baza wiedzy ---
  const context = await fetchPlayerContext(supabase, userId);
  const knowledgeBaseContent = await fetchKnowledgeBase(supabase, segmentId);

  // --- 3. Ton — tylko training_focus ma tu sens (patrz komentarz wyżej) ---
  let confidenceTone = 'assertive';
  if (recommendationType === 'training_focus' && segmentId) {
    const streak = await computeRejectionStreak(supabase, userId, segmentId);
    if (streak >= 2) confidenceTone = 'questioning';
  }

  // --- 4. Prompt + wywołanie AI ---
  const systemPrompt = buildSystemPrompt({ recommendationType, knowledgeBaseContent, confidenceTone });
  const userPrompt = buildUserPrompt({
    recommendationType,
    referralReason,
    context,
    extra: {
      painNote: relatedBodyLocation ? `Wzorzec bólu wykryty w lokalizacji: ${relatedBodyLocation}.` : null,
    },
  });
  const aiResult = await callAnthropic(systemPrompt, userPrompt);

  if (!aiResult || !aiResult.recommendation_text) {
    throw new Error('Odpowiedź AI nie zawiera wymaganego pola recommendation_text.');
  }

  // --- 5. Zapis — dokładnie kształt, jakiego oczekuje gotowy frontend ---
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
// HTTP HANDLER (Vercel Function) — cienki wrapper, ten sam wzorzec co
// api_mark_booking_completed.js w Marketplace.
// ------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Ten endpoint NIE jest dla zawodnika — wywołuje go wyłącznie zaufana
  // logika backendu (przyszły cron rotacji celu, przyszła detekcja wzorca
  // bólu/eskalacji), nigdy bezpośrednio frontend appki (koszt AI + zapis
  // treści rekomendacji to uprawnienie wyłącznie service role, patrz RLS
  // w asystent_sportowca_06_centrum_decyzji.sql). Ten sam wzorzec co
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
  fetchKnowledgeBase,
  resolveGoalSegment,
  buildSystemPrompt,
  buildUserPrompt,
};

// ============================================================
// CO ŚWIADOMIE NIE JEST TU ZROBIONE (nie przeoczone — celowo poza
// zakresem tego szkieletu, bo wymaga decyzji/projektu, których jeszcze
// nie ma, dokładnie ta sama dyscyplina co przy living_diagnosis_pulses
// i match_context_answers wcześniej w tym projekcie):
//
// 1. DETEKCJA KIEDY wygenerować training_focus. Funkcja 2 mówi "priorytet
//    rotuje dynamicznie" — ale reguła "kiedy dokładnie coś się zmieniło
//    na tyle, żeby uzasadnić nowe wywołanie AI" to osobny algorytm
//    (ważenie RPE/snu/kontekstu meczowego/kalendarza), nie zbudowany.
//    Ten plik zakłada że coś innego już zdecydowało i podaje goalId.
//
// 2. LIVE-COMPUTATION GOTOWOŚCI (Funkcja 8, trzy wymiary: fizyczny/
//    mentalny/meczowy) i WYKRYWANIE WZORCA BÓLU (pain_pattern_match —
//    "ból w tej samej lokalizacji co historyczna kontuzja, powtarzający
//    się"). Progi fizyczne mają już roboczą propozycję w
//    claude/research_gotowosc_progi.md, ale brak walidowanych progów dla
//    wymiaru mentalnego/meczowego, i sam mechanizm wykrywania wzorca bólu
//    (ile powtórzeń, jakie okno czasowe) nie jest jeszcze zaprojektowany.
//    Ten plik zakłada że coś innego już wykryło wzorzec i podaje
//    relatedBodyLocation/relatedInjuryHistoryId.
//
// 3. AUTOMATYCZNE WYWOŁANIE ESKALACJI po 3+ odrzuceniach z rzędu.
//    computeRejectionStreak() istnieje i liczy streak poprawnie, ale
//    nic jeszcze nie wywołuje go automatycznie po PATCH feedbacku we
//    froncie (asystent_app.html submitFeedback dziś tylko zapisuje
//    feedback_response, nic więcej). Osobny krok integracji — albo
//    wywołanie z frontendu po PATCH, albo trigger/webhook po stronie bazy.
//
// 4. CRON / HARMONOGRAM wywołujący ten silnik okresowo dla wszystkich
//    aktywnych celów — nie zbudowany, bo wymaga najpierw punktu 1.
//    Wzorzec do naśladowania gdy powstanie: api_cron_settlement.js +
//    vercel.json z Marketplace (Vercel Cron, patrz KROK 6 w
//    MARKETPLACE_CHECKLISTA_WDROZENIA.md).
//
// 5. Dokładna nazwa modelu Anthropic (ANTHROPIC_MODEL) — placeholder,
//    zweryfikuj przed pierwszym wdrożeniem.
// ============================================================
