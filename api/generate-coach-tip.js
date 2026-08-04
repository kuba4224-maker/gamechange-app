// ============================================================
// GAMECHANGE — /api/generate-coach-tip.js
// ============================================================
// SILNIK FILARU A — NARZĘDZIE TRENERA (Domena 22), Droga 1 (proaktywna,
// podpowiedzi V1 przy planowaniu sesji). Wzorem `generate-recommendation.js`
// (Domena 06) — ten sam kształt: kontrola kosztów → kontekst + baza wiedzy
// → prompt → Anthropic → zapis. Współdzielony moduł (THREAD_LIBRARY,
// fetchAndAuthorizeTeam, fetchKnowledgeBaseForSegments, callAnthropic,
// getAdminClient) reużywany przez api/coach-chat.js (Droga 2) — patrz
// module.exports._internal na końcu.
//
// ŹRÓDŁA KONCEPCYJNE: NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md (Filar A,
// sekcja "Biblioteka wątków trenerskich"), NARZEDZIE_TRENERA_FINALNY_
// PAKIET_WDROZENIOWY.md (Krok 2), SESJA_START_NARZEDZIE_TRENERA.md.
//
// ZASADA NADRZĘDNA (obowiązuje w CAŁYM Narzędziu Trenera, nie tylko w
// Składzie Meczowym): narzędzie SYGNALIZUJE, nigdy nie wybiera/nie
// rankinguje. Żadnego połączonego wskaźnika "gotowość: 72/100", żadnej
// sugerowanej jedenastki, żadnego sortowania zawodników po ryzyku —
// wymuszone wprost w buildCoachSystemPrompt() niżej, w każdym kanale.
//
// GRANICA V1 (NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md, Filar A, "Etapy
// budowy"): "V1: podpowiedzi — konkretne, użyteczne wskazówki, NIE gotowe
// jednostki. V2 (cel): edytowalne przykładowe jednostki." — wymuszone
// wprost w prompcie systemowym, nie tylko w komentarzu tutaj.
//
// KOSZT: "Proaktywne komunikaty i podpowiedzi V1 pozostają zawsze darmowe"
// (decyzja produktowa Kuby, model biznesowy) — więc PONIŻEJ NIE MA
// twardego limitu produktowego jak przy Centrum Decyzji zawodnika (5/dobę).
// COACH_TIP_SOFT_DAILY_CAP to WYŁĄCZNIE inżynierska siatka bezpieczeństwa
// przeciw pętli/błędowi (np. frontend wywołujący silnik w kółko), nie
// produktowy limit — świadomie hojna liczba, do zmiany bez migracji,
// dokładnie ten sam status co ANTHROPIC_MODEL placeholder niżej.
//
// ============================================================

const { createClient } = require('@supabase/supabase-js');
// SCALENIE ENDPOINTÓW (04.08.2026, noc) — limit 12 Serverless Functions
// Vercel Hobby, opcja (b) z claude/INTEGRACJA_STRIPE_K2.md. Dawny osobny
// plik api/submit-coach-tip-feedback.js przeniesiony BEZ ZMIANY LOGIKI do
// lib/coach-tip-feedback.js, wołany stąd przez dispatch po `action` w
// body (patrz handler na końcu pliku). W pełni odwracalne — zero
// migracji/zmiany danych, patrz komentarz na górze lib/coach-tip-feedback.js.
const { handleSubmitCoachTipFeedback } = require('../lib/coach-tip-feedback.js');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ------------------------------------------------------------
// DWA WYMIARY TRYBU — NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md:
// "Faza sezonu — stan drużyny, zmieniany ręcznie przez trenera rzadko"
// (przechowywana w teams.season_phase, Domena 22 SQL) i "Typ jednostki —
// wybierany przy każdym planowaniu" (WYŁĄCZNIE parametr wywołania,
// świadomie NIE zapisywany na drużynie).
// ------------------------------------------------------------
const SEASON_PHASES = ['przygotowawcza', 'sezon_rozgrywkowy'];
const UNIT_TYPES = ['silowa', 'wytrzymalosciowa', 'techniczna', 'taktyczna'];

// Mapowanie Typ jednostki → segmenty bazy wiedzy do wstrzyknięcia w prompt.
// Decyzja techniczna (nie z dokumentu źródłowego — tam nie ma tej tabeli
// wprost) — każdy typ jednostki pokrywa 2-3 segmenty najbliżej z nim
// związane z 13 istniejących (Domena 00), 'odzywianie' DOCHODZI ZAWSZE
// osobno (patrz fetchTipKnowledge niżej) pod gotowiec/notatkę żywieniową,
// niezależnie od typu jednostki — zgodnie z NARZEDZIE_TRENERA_DECYZJE_
// PROJEKTOWE.md, "ODŻYWIANIE DLA TRENERA", punkt 1: "Ten sam silnik...
// dodaje obok krótką notatkę żywieniową z tej samej bazy wiedzy".
const UNIT_TYPE_TO_SEGMENTS = {
  silowa: ['moc', 'fizycznosc', 'tolerancja'],
  wytrzymalosciowa: ['wytrzymalosc', 'tolerancja', 'regeneracja'],
  techniczna: ['techFund', 'techSpec', 'koncentracja'],
  taktyczna: ['decyzja', 'percepcja', 'koncentracja'],
};

const SEG_NAMES = {
  moc: 'MOC', wytrzymalosc: 'WYTRZYMAŁOŚĆ', fizycznosc: 'FIZYCZNOŚĆ',
  techFund: 'TECHNIKA FUND.', techSpec: 'TECHNIKA SPEC.', regeneracja: 'REGENERACJA',
  odpornosc: 'ODPORNOŚĆ', odzywianie: 'ODŻYWIENIE', tolerancja: 'TOL. OBCIĄŻEŃ',
  koncentracja: 'KONCENTRACJA', mental: 'ODWAGA W GRZE', percepcja: 'PERCEPCJA',
  decyzja: 'SZYBK. DECYZJI',
}; // Świadoma duplikacja z generate-recommendation.js/index.html — ten sam
   // status co SEG_NAMES tam (patrz komentarz w nagłówku tamtego pliku).

// ------------------------------------------------------------
// BIBLIOTEKA 9 WĄTKÓW TRENERSKICH — kopia 1:1 tabeli z
// NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md, sekcja "Biblioteka wątków
// trenerskich". KONFIGURACJA/DANE, NIE tabela SQL (SESJA_START_NARZEDZIE_
// TRENERA.md, Krok 2.6: "dokładnie wzorem istniejącej sieci zależności
// segmentów `from`/`to`/`weight`/`ai`") — dostępna w OBU kanałach Filaru A
// (patrz buildThreadLibraryBlock, wołane i tu, i w coach-chat.js).
//
// ŚWIADOMA GRANICA V1 (udokumentowana wprost, nie przeoczona): w
// odróżnieniu od pięciu flag Składu Meczowego (Domena 21), dokument
// źródłowy NIE podaje liczbowych progów dla żadnego z 9 wątków — same
// opisy jakościowe ("częsty trening własny", "wysoki odsetek",
// "seria odrzuceń"). Automatyczna, deterministyczna detekcja "ten wątek
// jest aktywny DLA TEGO zawodnika" (analogicznie do get_pre_match_signals)
// wymagałaby najpierw konkretnych progów od Kuby dla każdego z 9 wątków —
// to nie jest tu zgadywane. W V1 biblioteka działa jako TREŚĆ REFERENCYJNA
// wstrzyknięta do promptu AI (ten sam mechanizm co pole `ai` w
// DEPENDENCY_NETWORK — tekst-wskazówka, nie samodzielnie odpalany warunek
// SQL) — model sam rozpoznaje, czy dany wątek pasuje do danych zawodnika/
// drużyny opisanych w reszcie prompta, zawsze w duchu "warto rozważyć",
// nigdy "na pewno dlatego" (zasada wspólna biblioteki, wymuszona w
// systemowym prompcie niżej).
//
// WYJĄTEK — WĄTEK 9: jedyny z dziewięciu z W PEŁNI jednoznacznym,
// policzalnym źródłem danych (height_logs + users.birth_year, ten sam
// mechanizm co growth_spurt_typical_age_range w get_parent_report, Domena
// 21) — automatyczna detekcja ZAIMPLEMENTOWANA (resolveGrowthSpurtContext
// niżej), wołana z coach-chat.js gdy pytanie dotyczy konkretnego zawodnika.
const THREAD_LIBRARY = [
  {
    id: 1,
    signals: 'Częsty trening własny + podwyższone zmęczenie (silnik gotowości)',
    situation: 'Zawodnik wygląda słabiej w meczu, choć pracuje najwięcej — ryzyko błędnej oceny jako "słabszy", gdy to zmęczenie',
  },
  {
    id: 2,
    signals: 'Częsty trening własny + seria odrzuceń sugestii systemu (F23)',
    situation: 'Bardzo zaangażowany zawodnik może kierować się czymś czego system nie widzi, warto zapytać co faktycznie robi',
  },
  {
    id: 3,
    signals: 'Wcześniej regularny trening własny, nagły spadek częstotliwości (bez zmiany w klubowym)',
    situation: 'Sygnał o czymś co PRZESTAŁO się dziać — trudny do zauważenia bez danych, możliwy spadek motywacji lub problem poza boiskiem',
  },
  {
    id: 4,
    signals: 'Powtarzający się ból tej samej lokalizacji (istniejący mechanizm trendu) + trening własny nieredukowany',
    situation: 'Zawodnik "gra przez ból" zamiast ograniczyć aktywność — inny typ ryzyka niż jednorazowe zgłoszenie',
  },
  {
    id: 5,
    signals: 'Wysoka mood_motivation w Dzienniku + niski odsetek zrealizowanych zaplanowanych treningów',
    situation: 'Rozjazd między deklarowanym zaangażowaniem a rzeczywistym zachowaniem — trener może błędnie odbierać zawodnika jako w pełni zaangażowanego',
  },
  {
    id: 6,
    signals: 'Segment kluczowy dla pozycji = główny deficyt + brak aktywnego celu w tym segmencie od wielu tygodni',
    situation: 'Krytyczna dla roli słabość stoi bez pracy nad nią, łatwe do przeoczenia na poziomie pojedynczego zawodnika mimo mapy cieplnej drużyny',
  },
  {
    id: 7,
    signals: 'Podwyższone zmęczenie bez wytłumaczenia treningowego (brak nadmiernej objętości, brak urazu) + niski wynik segmentu odżywianie w diagnozie',
    situation: 'Zanim trener pomyśli "kondycja" albo "zaangażowanie", warto rozważyć czy to nie kwestia jedzenia/nawodnienia',
  },
  {
    id: 8,
    signals: 'Odżywianie jako częsty wspólny deficyt na mapie cieplnej całej drużyny',
    situation: 'Sygnał żeby użyć gotowca żywieniowego dla całej grupy naraz — problem częściej organizacyjny niż indywidualny',
  },
  {
    id: 9,
    signals: 'Zawodnik wszedł w okres szczytowego tempa wzrostu (wzrost zgłoszony w profilu, height_logs)',
    situation: 'Tymczasowy spadek koordynacji nie oznacza spadku umiejętności — okres podwyższonej wrażliwości na przeciążenia, warto uważać z obciążeniem plyometrycznym (reguła 48h między sesjami)',
    autoDetected: true,
  },
];

function buildThreadLibraryBlock() {
  const lines = THREAD_LIBRARY.map((t) =>
    `${t.id}. Sygnały: ${t.signals}. Sytuacja którą koryguje: ${t.situation}.`);
  return 'BIBLIOTEKA WĄTKÓW TRENERSKICH (materiał referencyjny — wspomnij o wątku WYŁĄCZNIE jeśli jego sygnały faktycznie pasują do danych podanych niżej w tej wiadomości, nigdy na wyrost): każda pozycja to WZORZEC do rozważenia, nie reguła diagnostyczna — ta sama sytuacja bywa dwoma różnymi, słusznymi wnioskami naraz. Formułuj zawsze jako "warto rozważyć", nigdy "na pewno dlatego".\n'
    + lines.join('\n');
}

// ------------------------------------------------------------
// WĄTEK 9 — jedyna zautomatyzowana detekcja (patrz uzasadnienie wyżej).
// Ten sam próg co growth_spurt_typical_age_range / height_growth_rate_
// elevated w get_parent_report (Domena 21, CZĘŚĆ 3) — świadomie
// zduplikowane tutaj (Node, nie SQL) zamiast wołania funkcji SQL przez
// dodatkowy round-trip, ten sam status jak inne udokumentowane duplikacje
// w projekcie (SEG_NAMES itd.).
// ------------------------------------------------------------
async function resolveGrowthSpurtContext(supabase, playerUserId) {
  const { data: user, error: userError } = await supabase
    .from('users').select('birth_year').eq('id', playerUserId).maybeSingle();
  if (userError) throw new Error(`resolveGrowthSpurtContext(user): ${userError.message}`);

  const currentAge = user && user.birth_year
    ? new Date().getUTCFullYear() - user.birth_year
    : null;
  const inGrowthSpurtAgeRange = currentAge !== null && currentAge >= 11 && currentAge <= 16;

  const { data: heights, error: heightsError } = await supabase
    .from('height_logs').select('height_cm, measured_at')
    .eq('user_id', playerUserId).order('measured_at', { ascending: false }).limit(2);
  if (heightsError) throw new Error(`resolveGrowthSpurtContext(heights): ${heightsError.message}`);

  let heightGrowthRateElevated = false;
  if (heights && heights.length === 2) {
    const [latest, prior] = heights;
    const gapDays = (new Date(latest.measured_at) - new Date(prior.measured_at)) / (1000 * 60 * 60 * 24);
    if (gapDays >= 60) {
      const rate = ((latest.height_cm - prior.height_cm) / gapDays) * 365.25;
      heightGrowthRateElevated = rate > 7.2;
    }
  }

  return { inGrowthSpurtAgeRange, heightGrowthRateElevated };
}

// ------------------------------------------------------------
// AUTORYZACJA — ten sam trust-boundary co api_submit_recommendation_
// feedback.js (już przyjęty wzorzec w projekcie, patrz komentarz tam):
// caller podaje coachUserId, endpoint sprawdza że drużyna FAKTYCZNIE
// należy do tego trenera zanim cokolwiek zrobi. Świadomie bez pełnej
// weryfikacji access_token — ten sam, już zaakceptowany kompromis.
// ------------------------------------------------------------
async function fetchAndAuthorizeTeam(supabase, teamId, coachUserId) {
  if (!teamId || !coachUserId) throw new Error('fetchAndAuthorizeTeam: brak teamId/coachUserId.');
  const { data: team, error } = await supabase
    .from('teams').select('id, coach_user_id, season_phase').eq('id', teamId).maybeSingle();
  if (error) throw new Error(`fetchAndAuthorizeTeam: ${error.message}`);
  if (!team || team.coach_user_id !== coachUserId) {
    return { authorized: false, team: null };
  }
  return { authorized: true, team };
}

async function fetchKnowledgeBaseForSegments(supabase, segmentIds) {
  if (!segmentIds || !segmentIds.length) return {};
  const { data, error } = await supabase
    .from('knowledge_base_entries').select('segment_id, content').in('segment_id', segmentIds);
  if (error) throw new Error(`fetchKnowledgeBaseForSegments: ${error.message}`);
  const bySegment = {};
  (data || []).forEach((row) => { bySegment[row.segment_id] = row.content; });
  return bySegment;
}

function buildKnowledgeBlock(segmentIds, kbBySegment) {
  const parts = segmentIds
    .filter((id) => kbBySegment[id])
    .map((id) => `--- ${SEG_NAMES[id] || id} ---\n${kbBySegment[id]}`);
  if (!parts.length) return '';
  return `BAZA WIEDZY GAMECHANGE (segmenty istotne dla wybranego typu jednostki — źródło prawdy, nigdy jej nie neguj):\n${parts.join('\n\n')}\n\n`;
}

// ------------------------------------------------------------
// KOSZT — patrz komentarz w nagłówku pliku (siatka bezpieczeństwa
// inżynierska, NIE produktowy limit).
// ------------------------------------------------------------
const COACH_TIP_SOFT_DAILY_CAP = 60;

async function checkCoachTipSoftCap(supabase, teamId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('coach_tips').select('id', { count: 'exact', head: true })
    .eq('team_id', teamId).gte('created_at', since);
  if (error) throw new Error(`checkCoachTipSoftCap: ${error.message}`);
  if ((count || 0) >= COACH_TIP_SOFT_DAILY_CAP) {
    return { allowed: false, reason: `Siatka bezpieczeństwa: ${COACH_TIP_SOFT_DAILY_CAP} podpowiedzi/dobę dla tej drużyny już wykorzystane (limit inżynierski, nie produktowy — zgłoś jeśli to za mało w praktyce).` };
  }
  return { allowed: true };
}

// ------------------------------------------------------------
// PROMPT — wspólny szkielet dla obu kanałów Filaru A, patrz też
// coach-chat.js (Droga 2), który importuje i rozszerza ten system prompt
// o granicę bezpieczeństwa medycznego.
// ------------------------------------------------------------
function nutritionFramingForSeasonPhase(seasonPhase) {
  return seasonPhase === 'sezon_rozgrywkowy'
    ? 'Sezon rozgrywkowy: akcent na nawodnienie i tankowanie energii wokół częstych meczów.'
    : 'Faza przygotowawcza: akcent na odżywianie pod regenerację przy cięższym bloku siłowym/wytrzymałościowym.';
}

function buildCoachSystemPrompt({ knowledgeBlock, nutritionBlock, includeThreadLibrary }) {
  const threadBlock = includeThreadLibrary ? `${buildThreadLibraryBlock()}\n\n` : '';
  return `Jesteś silnikiem podpowiedzi Narzędzia Trenera w aplikacji Gamechange (piłka nożna, młodzi zawodnicy).

FILOZOFIA (nienaruszalna, ten sam duch co Centrum Decyzji zawodnika): jesteś NAWIGATOREM, nie planistą. Podpowiedzi V1 to konkretne, użyteczne WSKAZÓWKI — NIE gotowe jednostki treningowe z dokładnym rozpisaniem serii/powtórzeń/czasu (to V2, świadomie poza tym silnikiem). Trener samodzielnie układa szczegóły sesji.

ZASADA NADRZĘDNA (obowiązuje w całym Narzędziu Trenera): TYLKO SYGNALIZUJESZ, nigdy nie wybierasz ani nie rankingujesz. Nigdy nie podawaj połączonego wskaźnika typu "gotowość drużyny: 72/100", nigdy nie sugeruj składu/jedenastki, nigdy nie sortuj ani nie porównuj zawodników względem siebie po ryzyku czy formie.

${knowledgeBlock}${threadBlock}NOTATKA ŻYWIENIOWA: ${nutritionBlock} Dołącz krótką (2-3 zdania), praktyczną notatkę żywieniową osobno od głównej podpowiedzi treningowej — z bazy wiedzy wyżej, nie zmyśloną. Zakres wyłącznie "energia do gry" (nawodnienie, tankowanie, regeneracja pokarmowa) — NIGDY kontrola wagi/sylwetki (istotne przy nieletnich zawodnikach). Stany kliniczne (alergie, zaburzenia odżywiania) zawsze poza zakresem — nie dotykaj tego tematu.

JĘZYK: wyłącznie polski, zwięźle, konkretnie, bez żargonu, zwracaj się do trenera bezpośrednio ("Ty").

FORMAT ODPOWIEDZI: zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu):
{"tip_text": "konkretna, użyteczna wskazówka do rozważenia przy planowaniu tej jednostki", "nutrition_note_text": "krótka notatka żywieniowa jak opisano wyżej"}`;
}

function buildCoachTipUserPrompt({ seasonPhase, unitType }) {
  const seasonLabel = seasonPhase === 'sezon_rozgrywkowy' ? 'Sezon rozgrywkowy' : 'Faza przygotowawcza';
  const unitLabel = { silowa: 'Siłowa', wytrzymalosciowa: 'Wytrzymałościowa', techniczna: 'Techniczna', taktyczna: 'Taktyczna (gierka zadaniowa)' }[unitType] || unitType;
  return `Trener planuje jednostkę treningową.\nFaza sezonu drużyny: ${seasonLabel}.\nTyp planowanej jednostki: ${unitLabel}.\n\nWygeneruj jedną konkretną podpowiedź V1 (nie gotową jednostkę) trafną dla tej kombinacji fazy sezonu i typu jednostki, plus notatkę żywieniową.`;
}

// ------------------------------------------------------------
// WYWOŁANIE ANTHROPIC — identyczny wzorzec co generate-recommendation.js.
// Współdzieli ten sam status: zadziała od razu gdy ANTHROPIC_API_KEY
// trafi do zmiennych środowiskowych Vercel (JUŻ czeka na to Centrum
// Decyzji zawodnika — to NIE jest nowa blokada wprowadzona przez ten
// plik, tylko ta sama, już znana Kubie).
// ------------------------------------------------------------
async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY nie skonfigurowany — silnik jest gotowy, brakuje tylko klucza (ten sam, już znany brak co przy Centrum Decyzji zawodnika).');
  }
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
  try {
    return JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`Nie udało się sparsować JSON z odpowiedzi AI: ${e.message}. Surowa odpowiedź (pierwsze 500 znaków): ${textBlock.text.slice(0, 500)}`);
  }
}

// ------------------------------------------------------------
// ORKIESTRATOR
// ------------------------------------------------------------
async function generateCoachTip(params, injectedSupabase) {
  const { coachUserId, teamId, unitType } = params || {};
  if (!coachUserId) throw new Error('generateCoachTip: brak coachUserId.');
  if (!teamId) throw new Error('generateCoachTip: brak teamId.');
  if (!UNIT_TYPES.includes(unitType)) {
    throw new Error(`generateCoachTip: nieprawidłowy unitType "${unitType}".`);
  }

  const supabase = injectedSupabase || getAdminClient();

  const { authorized, team } = await fetchAndAuthorizeTeam(supabase, teamId, coachUserId);
  if (!authorized) {
    return { ok: false, blocked: true, reason: 'Brak uprawnień: podana drużyna nie należy do tego trenera.' };
  }

  const softCap = await checkCoachTipSoftCap(supabase, teamId);
  if (!softCap.allowed) return { ok: false, blocked: true, reason: softCap.reason };

  const seasonPhase = team.season_phase;
  const segmentIds = [...UNIT_TYPE_TO_SEGMENTS[unitType], 'odzywianie'];
  const kbBySegment = await fetchKnowledgeBaseForSegments(supabase, segmentIds);
  const knowledgeBlock = buildKnowledgeBlock(segmentIds.filter((s) => s !== 'odzywianie'), kbBySegment);
  const nutritionBlock = `${nutritionFramingForSeasonPhase(seasonPhase)}${kbBySegment.odzywianie ? `\nBaza wiedzy ODŻYWIENIE:\n${kbBySegment.odzywianie}` : ''}`;

  const systemPrompt = buildCoachSystemPrompt({ knowledgeBlock, nutritionBlock, includeThreadLibrary: true });
  const userPrompt = buildCoachTipUserPrompt({ seasonPhase, unitType });
  const aiResult = await callAnthropic(systemPrompt, userPrompt);

  if (!aiResult || !aiResult.tip_text) {
    throw new Error('Odpowiedź AI nie zawiera wymaganego pola tip_text.');
  }

  const row = {
    coach_user_id: coachUserId,
    team_id: teamId,
    season_phase: seasonPhase,
    unit_type: unitType,
    tip_text: aiResult.tip_text,
    nutrition_note_text: aiResult.nutrition_note_text || null,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('coach_tips').insert(row).select().single();
  if (insertError) throw new Error(`generateCoachTip(insert): ${insertError.message}`);

  return { ok: true, blocked: false, tip: inserted };
}

// ------------------------------------------------------------
// HTTP HANDLER — wołany BEZPOŚREDNIO z coach.html (przeglądarka), nie
// backend-do-backend jak generate-recommendation.js — dlatego BEZ
// x-engine-secret (ten sekret nigdy nie może trafić do przeglądarki).
// Trust boundary opisany przy fetchAndAuthorizeTeam wyżej.
// ------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Dispatch dla scalonego endpointu feedbacku (patrz komentarz przy
  // require('../lib/coach-tip-feedback.js') na górze pliku) — musi być
  // PRZED odczytem coachUserId/teamId/unitType niżej, bo to inny kształt
  // body (coachUserId/tipId/response, nie coachUserId/teamId/unitType).
  if (req.body && req.body.action === 'submit_feedback') {
    return handleSubmitCoachTipFeedback(req, res);
  }

  const { coachUserId, teamId, unitType } = req.body || {};

  try {
    const result = await generateCoachTip({ coachUserId, teamId, unitType });
    if (!result.ok) {
      return res.status(200).json(result);
    }
    return res.status(201).json(result);
  } catch (e) {
    console.error('generate-coach-tip error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.generateCoachTip = generateCoachTip;
module.exports._internal = {
  getAdminClient,
  SEASON_PHASES,
  UNIT_TYPES,
  UNIT_TYPE_TO_SEGMENTS,
  SEG_NAMES,
  THREAD_LIBRARY,
  buildThreadLibraryBlock,
  resolveGrowthSpurtContext,
  fetchAndAuthorizeTeam,
  fetchKnowledgeBaseForSegments,
  buildKnowledgeBlock,
  nutritionFramingForSeasonPhase,
  buildCoachSystemPrompt,
  callAnthropic,
  // Dwie poniższe DOPISANE 04.08.2026 (noc, druga runda) — istniały już w
  // pliku, ale nie były eksportowane, bo coach-chat.js (jedyny dotychczasowy
  // konsument tego _internal) ma własne odpowiedniki (buildChatUserPrompt/
  // checkCoachChatSoftCap) i ich nie potrzebuje. Dopisane WYŁĄCZNIE po to,
  // żeby dało się je pokryć testem (tests/test-generate-coach-tip.js) —
  // czysto addytywne, zero zmiany istniejącego zachowania.
  buildCoachTipUserPrompt,
  checkCoachTipSoftCap,
};

// ============================================================
// CO ŚWIADOMIE NIE JEST TU ZROBIONE
//
// 1. Automatyczna detekcja wątków 1-8 biblioteki (patrz uzasadnienie przy
//    THREAD_LIBRARY wyżej) — wymaga od Kuby konkretnych progów liczbowych
//    dla każdego wątku, których dokument źródłowy nie podaje (w
//    odróżnieniu od w pełni policzalnych 5 flag Składu Meczowego).
// 2. Mapa cieplna / sygnały gotowości drużyny jako wejście silnika
//    (NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md wymienia to jako możliwe
//    wejście, "jeśli dane istnieją") — pominięte w V1. AKTUALIZACJA
//    04.08.2026: blocker opisany wcześniej w tym punkcie już nie
//    obowiązuje — TEAM_AGGREGATE_MIN_SIZE=8 zostało potwierdzone jako
//    istniejące i poprawnie wdrożone w panel_trenera.html (przy okazji
//    K3/4.3). Wejście mapy cieplnej do tego silnika wciąż NIE jest
//    zbudowane — to nadal osobna decyzja projektowa (kształt promptu,
//    kiedy sygnał jest istotny), nie mechaniczna poprawka — ale bez
//    przeszkody technicznej, która wcześniej to blokowała. V1.1 kandydat.
// 3. V2: edytowalne przykładowe jednostki (zamiast samych wskazówek) —
//    wprost odłożone do V2 w dokumencie źródłowym, nie tu.
// 4. Nazwa modelu Anthropic (ANTHROPIC_MODEL) — fallback zaktualizowany
//    04.08.2026 na 'claude-sonnet-5' (aktualny wg docs.claude.com w tym
//    dniu). Używany tylko, gdy zmienna środowiskowa ANTHROPIC_MODEL nie
//    jest ustawiona w Vercel — nazwy modeli zmieniają się z czasem, więc
//    warto to sprawdzić ponownie, jeśli minie dużo miesięcy bez wdrożenia.
// ============================================================
