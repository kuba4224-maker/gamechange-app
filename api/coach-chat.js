// ============================================================
// GAMECHANGE — /api/coach-chat.js
// ============================================================
// SILNIK FILARU A — NARZĘDZIE TRENERA (Domena 22), Droga 2 (konwersacyjna).
// "Trener zadaje pytanie w dowolnym momencie... dostaje odpowiedź z tego
// samego kontekstu" (NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md). Reużywa
// wspólny silnik z generate-coach-tip.js (_internal) zamiast duplikować —
// ten sam wzorzec co api_submit_recommendation_feedback.js importujące
// z generate-recommendation.js.
//
// GRANICA BEZPIECZEŃSTWA (odziedziczona z Asystenta AI zawodnika, F6,
// NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md): pytania treningowe i o
// zarządzanie drużyną — TAK, odpowiedź AI. Pytanie MEDYCZNE o KONKRETNEGO
// zawodnika — przekierowanie do Marketplace, NIE porada AI. Wymuszone
// wprost w system prompcie (buildChatSystemPrompt) + model zwraca
// ustrukturyzowaną flagę is_medical_redirect zamiast swobodnej odpowiedzi
// tekstowej, którą trzeba by parsować/zgadywać — bezpieczniejsze niż
// dopasowywanie słów kluczowych po stronie kodu (zbyt kruche dla granicy
// bezpieczeństwa, model rozumie kontekst pytania znacznie lepiej niż
// prosta lista słów).
// ============================================================

const {
  getAdminClient,
  UNIT_TYPES,
  fetchAndAuthorizeTeam,
  fetchKnowledgeBaseForSegments,
  buildKnowledgeBlock,
  buildThreadLibraryBlock,
  resolveGrowthSpurtContext,
  callAnthropic,
  THREAD_LIBRARY,
} = require('./generate-coach-tip')._internal;

// PAKIET 16 (04.08.2026) — parytet kanałów: wątki 1-7 biblioteki (detekcja
// automatyczna, patrz lib/coach-thread-library.js) mają teraz działać w OBU
// kanałach Filaru A, nie tylko w Drodze 1 (proaktywne podpowiedzi,
// generate-coach-tip.js). Wątek 8 (drużynowy) świadomie POMINIĘTY tutaj —
// Droga 2 to pytanie o KONKRETNEGO zawodnika (aboutPlayerUserId), wątek 8
// jest z natury drużynowy i nie pasuje do tego kontekstu; jest już pokryty
// w Drodze 1 (nutritionBlock w generate-coach-tip.js) i w statycznej karcie
// "Protokół meczowy" w coach.html — dublowanie go tutaj nie dodałoby
// wartości. Wątek 9 (skok wzrostowy) NIE jest zwracany przez
// detectPlayerThreadSignals (żyje osobno, patrz resolveGrowthSpurtContext
// wyżej) — zero ryzyka duplikatu tej samej wzmianki w promptcie.
const { detectPlayerThreadSignals } = require('../lib/coach-thread-library.js');

const COACH_CHAT_SOFT_DAILY_CAP = 50; // Siatka bezpieczeństwa inżynierska —
// NIE produktowy limit "hojnego darmowego limitu pytań tygodniowo"
// wspomnianego w NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md ("Model
// biznesowy") — konkretna liczba tamtego limitu to świadomie otwarta
// decyzja Kuby, nie ustalana tutaj. Ten sam status co COACH_TIP_SOFT_
// DAILY_CAP w generate-coach-tip.js.

async function checkCoachChatSoftCap(supabase, coachUserId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('coach_chat_exchanges').select('id', { count: 'exact', head: true })
    .eq('coach_user_id', coachUserId).gte('created_at', since);
  if (error) throw new Error(`checkCoachChatSoftCap: ${error.message}`);
  if ((count || 0) >= COACH_CHAT_SOFT_DAILY_CAP) {
    return { allowed: false, reason: `Siatka bezpieczeństwa: ${COACH_CHAT_SOFT_DAILY_CAP} pytań/dobę już wykorzystane (limit inżynierski — docelowy limit produktowy ustali Kuba).` };
  }
  return { allowed: true };
}

function buildChatSystemPrompt({ knowledgeBlock }) {
  return `Jesteś silnikiem kanału konwersacyjnego Narzędzia Trenera w aplikacji Gamechange (piłka nożna, młodzi zawodnicy). Trener zadaje Ci pytanie w dowolnym momencie.

FILOZOFIA: jesteś NAWIGATOREM, nie planistą — kierunkujesz i uzasadniasz, nie piszesz gotowego, szczegółowego planu treningowego.

ZASADA NADRZĘDNA (obowiązuje zawsze): TYLKO SYGNALIZUJESZ, nigdy nie wybierasz ani nie rankingujesz. Nawet jeśli trener wprost zapyta "kogo wystawić" albo "który zawodnik jest gotowy" — NIGDY nie wskazuj konkretnego zawodnika ani nie twórz rankingu/wskaźnika gotowości. Zamiast tego wskaż JAKIE dane warto sprawdzić samodzielnie (np. Skład Meczowy w Panelu Trenera) i wprost przypomnij, że decyzja o składzie zawsze należy do trenera.

GRANICA BEZPIECZEŃSTWA — NAJWAŻNIEJSZA ZASADA TEGO KANAŁU: jeśli pytanie trenera dotyczy stanu ZDROWOTNEGO/MEDYCZNEGO konkretnego, wskazanego zawodnika (np. diagnoza bólu, czy uraz jest poważny, czy zawodnik powinien grać mimo kontuzji, interpretacja objawów) — NIE udzielaj porady medycznej. Ustaw is_medical_redirect=true i napisz krótką, empatyczną notatkę kierującą do specjalisty w Marketplace Gamechange zamiast odpowiedzi merytorycznej. Pytania TRENINGOWE i o ZARZĄDZANIE DRUŻYNĄ (planowanie, obciążenie, komunikacja z zawodnikami, organizacja sesji) są w pełni w zakresie — is_medical_redirect=false, odpowiadaj normalnie z użyciem bazy wiedzy niżej.

${knowledgeBlock}JĘZYK: wyłącznie polski, zwięźle, konkretnie, zwracaj się do trenera bezpośrednio ("Ty").

FORMAT ODPOWIEDZI: zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu):
{"answer_text": "odpowiedź na pytanie trenera, LUB jeśli is_medical_redirect=true — pusty string", "is_medical_redirect": true lub false, "redirect_note": "krótka notatka kierująca do Marketplace, tylko gdy is_medical_redirect=true, inaczej null"}`;
}

function buildChatUserPrompt({ questionText, seasonPhase, growthSpurtContext, playerThreadSituations }) {
  const lines = [];
  lines.push(`Pytanie trenera: ${questionText}`);
  if (seasonPhase) {
    lines.push(`Kontekst: drużyna jest dziś w fazie sezonu "${seasonPhase === 'sezon_rozgrywkowy' ? 'Sezon rozgrywkowy' : 'Faza przygotowawcza'}".`);
  }
  if (growthSpurtContext && growthSpurtContext.inGrowthSpurtAgeRange) {
    lines.push(`Kontekst o zawodniku, którego dotyczy pytanie: jest dziś w typowym wieku szczytowego tempa wzrostu (11-16 lat)${growthSpurtContext.heightGrowthRateElevated ? ', a jego tempo wzrostu jest podwyższone (>7,2 cm/rok wg ostatnich pomiarów)' : ''} — jeśli to pasuje do pytania, możesz wspomnieć że tymczasowy spadek koordynacji w tym okresie nie oznacza spadku umiejętności, i że warto uważać z obciążeniem plyometrycznym (reguła 48h między sesjami). Nie wspominaj o tym jeśli pytanie tego nie dotyczy.`);
  }
  // PAKIET 16 — dodatkowe sygnały biblioteki wątków (1-7) wykryte dla
  // zawodnika, którego dotyczy pytanie (jeśli aboutPlayerUserId podane).
  // Świadomie osobne zdanie na wątek, ta sama tonacja "warto rozważyć" co w
  // THREAD_LIBRARY — model dostaje je jako KONTEKST, nie jako gotową
  // odpowiedź, i ma wspomnieć o nich TYLKO jeśli pasują do pytania trenera
  // (ta sama instrukcja co przy kontekście skoku wzrostowego wyżej).
  if (playerThreadSituations && playerThreadSituations.length) {
    lines.push(`Dodatkowe sygnały wykryte dla zawodnika, którego dotyczy pytanie (wspomnij TYLKO jeśli pasują do pytania trenera, zawsze w tonacji "warto rozważyć", nigdy "na pewno dlatego"):`);
    playerThreadSituations.forEach((situation) => {
      lines.push(`- Warto rozważyć: ${situation}.`);
    });
  }
  return lines.join('\n');
}

async function runCoachChat(params, injectedSupabase) {
  const { coachUserId, teamId, questionText, aboutPlayerUserId } = params || {};
  if (!coachUserId) throw new Error('runCoachChat: brak coachUserId.');
  if (!teamId) throw new Error('runCoachChat: brak teamId.');
  if (!questionText || !questionText.trim()) throw new Error('runCoachChat: brak questionText.');

  const supabase = injectedSupabase || getAdminClient();

  const { authorized, team } = await fetchAndAuthorizeTeam(supabase, teamId, coachUserId);
  if (!authorized) {
    return { ok: false, blocked: true, reason: 'Brak uprawnień: podana drużyna nie należy do tego trenera.' };
  }

  const softCap = await checkCoachChatSoftCap(supabase, coachUserId);
  if (!softCap.allowed) return { ok: false, blocked: true, reason: softCap.reason };

  // Jeśli pytanie dotyczy konkretnego zawodnika I ten zawodnik faktycznie
  // należy do tej drużyny — wątek 9 (jedyny automatycznie wykrywany, patrz
  // generate-coach-tip.js) dorzucony jako dodatkowy kontekst. Świadomie
  // BEZ weryfikacji przynależności zawodnika do drużyny tutaj (defensywnie
  // niekrytyczne — resolveGrowthSpurtContext tylko CZYTA dane, nie
  // ujawnia niczego poza wiekowym zakresem/tempem wzrostu, i tak samo
  // dostępne trenerowi wprost we wpisach Profilu gdyby miał tam dostęp).
  let growthSpurtContext = null;
  // PAKIET 16 — wątki 1-7 biblioteki dla tego samego zawodnika, ten sam
  // brak weryfikacji przynależności do drużyny co przy growthSpurtContext
  // wyżej (patrz komentarz), i ten sam powód: WYŁĄCZNIE odczyt, nic nie
  // ujawnia poza tym co trener i tak widzi mając dostęp do zawodnika w UI.
  // Owinięte w try/catch — nieblokujące: błąd detekcji (np. brak jeszcze
  // diagnoz/dziennika dla tego zawodnika) nie może wywrócić odpowiedzi na
  // pytanie trenera.
  let playerThreadSituations = [];
  if (aboutPlayerUserId) {
    growthSpurtContext = await resolveGrowthSpurtContext(supabase, aboutPlayerUserId);
    try {
      const threads = await detectPlayerThreadSignals(supabase, aboutPlayerUserId);
      playerThreadSituations = threads
        .filter((t) => t.active)
        .map((t) => {
          const def = THREAD_LIBRARY.find((lib) => lib.id === t.id);
          return def ? def.situation : null;
        })
        .filter(Boolean);
    } catch (e) {
      console.error('runCoachChat: detectPlayerThreadSignals nie powiodło się (pomijam dodatkowe sygnały):', e);
    }
  }

  const segmentIds = ['odzywianie']; // baza ogólna zawsze; typ jednostki nieznany w Drodze 2 (pytanie swobodne)
  const kbBySegment = await fetchKnowledgeBaseForSegments(supabase, segmentIds);
  const knowledgeBlock = `${buildKnowledgeBlock(segmentIds, kbBySegment)}${buildThreadLibraryBlock()}\n\n`;

  const systemPrompt = buildChatSystemPrompt({ knowledgeBlock });
  const userPrompt = buildChatUserPrompt({ questionText, seasonPhase: team.season_phase, growthSpurtContext, playerThreadSituations });
  const aiResult = await callAnthropic(systemPrompt, userPrompt);

  if (!aiResult || typeof aiResult.is_medical_redirect !== 'boolean') {
    throw new Error('Odpowiedź AI nie zawiera wymaganego pola is_medical_redirect.');
  }
  if (!aiResult.is_medical_redirect && !aiResult.answer_text) {
    throw new Error('Odpowiedź AI nie zawiera wymaganego pola answer_text (is_medical_redirect=false).');
  }

  const answerText = aiResult.is_medical_redirect
    ? (aiResult.redirect_note || 'To pytanie dotyczy stanu zdrowotnego konkretnego zawodnika — najlepiej skonsultować je ze specjalistą. Znajdziesz odpowiednią kategorię w Marketplace Gamechange.')
    : aiResult.answer_text;

  const row = {
    coach_user_id: coachUserId,
    team_id: teamId,
    about_player_user_id: aboutPlayerUserId || null,
    question_text: questionText,
    answer_text: answerText,
    redirected_to_marketplace: !!aiResult.is_medical_redirect,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('coach_chat_exchanges').insert(row).select().single();
  if (insertError) throw new Error(`runCoachChat(insert): ${insertError.message}`);

  return { ok: true, blocked: false, exchange: inserted };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { coachUserId, teamId, questionText, aboutPlayerUserId } = req.body || {};

  try {
    const result = await runCoachChat({ coachUserId, teamId, questionText, aboutPlayerUserId });
    if (!result.ok) {
      return res.status(200).json(result);
    }
    return res.status(201).json(result);
  } catch (e) {
    console.error('coach-chat error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.runCoachChat = runCoachChat;
module.exports._internal = { buildChatSystemPrompt, buildChatUserPrompt, checkCoachChatSoftCap };
