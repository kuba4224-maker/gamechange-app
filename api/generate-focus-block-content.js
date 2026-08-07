// ============================================================
// GAMECHANGE — /api/generate-focus-block-content.js
// ============================================================
// Krok 5b (Blok Skupienia — Prowadzenie, PLAN_SPOJNEJ_SCIEZKI.md sekcja 3E,
// Fazy 2 "Praca" i 3 "Zamknięcie"). Dwie akcje AI połączone w JEDNYM pliku
// z dispatcherem `action`, celowo — żeby nie przekroczyć limitu 12
// Serverless Functions na Vercel Hobby (api/ miało 11/12 przed tym plikiem,
// patrz claude/SESJA_31_07_2026_UX_MOBILE_BLOK_SKUPIENIA_KROK5B_STATUS.md
// i reguła 14 w PLAN_ORKIESTRACJI_WIELOSESYJNEJ.md). Jeśli w przyszłości
// potrzebny kolejny endpoint AI dla Bloku Skupienia — dopisz kolejną
// wartość `action` tutaj, nie twórz nowego pliku w api/.
//
// action: 'checkin'        — Faza 2a: pytanie kontrolne o wybrany element
//                             (nie ogólne samopoczucie) + Faza 2b: dawkowana
//                             treść edukacyjna, gdy wypada moment (zmiana
//                             etapu progresji albo >=14 dni od ostatniej).
// action: 'closing_review' — Faza 3: krótkie podsumowanie zakończonego
//                             bloku na bazie zebranych sygnałów. NIE
//                             sugeruje decyzji — appka i tak pokazuje trzy
//                             równorzędne opcje (kontynuuj/nowy element/
//                             zamknij), to tylko pomoc w decyzji.
//
// Wywoływany wyłącznie z zaufanego kontekstu: appka mobilna (checkin —
// zawodnik odpowiada na już istniejące pytanie, appka woła to tylko żeby
// WYGENEROWAĆ treść) i/lub cron (runFocusBlockCheckins w
// cron-send-notifications.js, patrz tam). Wzorzec wywołania Anthropic i
// stripMarkdownJsonFence skopiowany 1:1 z api/generate-recommendation.js
// / api/validate-goal-refinement.js (żywo zweryfikowane przed napisaniem
// tego pliku, 31.07.2026).
//
// ------------------------------------------------------------
// PRAKTYKA A5 08.08.2026 — dawka przestaje być ulotna + podpowiedzi
// ------------------------------------------------------------
// DWIE ZMIANY, obie wyłącznie w ścieżce `action: 'checkin'` (Faza 2):
//
// 1. DAWKA TREŚCI JEST TERAZ ZAPISYWANA I ODCZYTYWANA.
//    Do tej pory `contentDose` wracał stąd do wołającego i przepadał —
//    `api/cron-send-notifications.js` (rytm 6) wstawiał do
//    `focus_block_checkins` sam `question_text`, a treść dawki nie miała
//    kolumny, w której mogłaby usiąść. Audyt nazywa to "dawka generowana
//    i gubiona" od bloku 1. Teraz `generateCheckin()`:
//      - CZYTA magazyn (`focus_blocks.content_doses`) ZANIM zawoła model,
//      - jeśli dawka dla TEGO etapu już jest i jest świeższa niż 14 dni,
//        NIE prosi modelu o nową — oddaje zapamiętaną,
//      - a świeżo wygenerowaną zapisuje, żeby zawodnik mógł do niej wrócić.
//    Wzorzec oszczędności 1:1 z `checkTrainingFocusCadence()` w
//    api/generate-recommendation.js — patrz lib/focus-block-content-store.js.
//
// 2. PROMPT FAZY 2 DOSTAJE PODPOWIEDZI Z MATERIAŁÓW KUBY.
//    `component_hints` (214 wierszy, runda 3) czytał dotąd wyłącznie
//    silnik rekomendacji. Blok Skupienia ma przewagę, której rekomendacja
//    nie ma: zna konkretny Element (`focus_blocks.component_id`) — więc
//    to TUTAJ po raz pierwszy zadziała 63 podpowiedzi przypiętych do
//    Elementu (znalezisko B24 z rundy 4). Bramka wiekowa A9 i filtr
//    odbiorcy działają przez TE SAME funkcje co w rundzie 4, nie kopie.
//    Podpowiedzi wchodzą do promptu WYŁĄCZNIE w turze, w której powstaje
//    dawka — tura z samym pytaniem kontrolnym ma prompt bez zmian, bo
//    nie ma w niej treści, którą można by na materiale oprzeć.
//
// ⚠️ CZEGO TE ZMIANY NIE RUSZAJĄ (sprawdzone pomiarem, nie założeniem —
//    raport rundy 5, sekcja 10): przy braku dawki w magazynie i braku
//    podpowiedzi prompt systemowy jest IDENTYCZNY CO DO ZNAKU z tym
//    sprzed tej rundy, a pola `contentDose` i `stageAtDose` w wyniku mają
//    dokładnie to samo znaczenie co dotąd — dlatego `api/cron-*` (pas C)
//    nie wymaga ani jednej zmiany. Nowe informacje jadą w NOWYCH polach,
//    które dzisiejszy wołający po prostu ignoruje.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
// PRAKTYKA A5 08.08.2026 — magazyn dawki + podpowiedzi. Cała nowa logika
// mieszka w lib/ (ograniczenie O1: api/ ma 12 z 12 plików, trzynasty
// zablokowałby deploy całego repo appki).
const {
  fetchDoseEnvelope,
  checkContentDoseCadence,
  normalizeDose,
  saveContentDose,
  describeDoseState,
  loadHintsForFocusBlock,
  buildHintPromptBlock,
  pickShowcaseHint,
} = require('../lib/focus-block-content-store');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Ten sam podział filarów co api/generate-focus-block-dosing.js (Krok 5a,
// żywo zweryfikowany 31.07.2026). Świadoma duplikacja — ten sam wzorzec co
// SEG_NAMES powielane w kilku miejscach tego projektu (patrz
// cron-send-notifications.js, SEGMENT_DISPLAY_NAME). Warto docelowo
// wydzielić do lib/, nie zrobione teraz żeby nie dotykać już działającego
// pliku Kroku 5a bez potrzeby.
const SEGMENTS_BY_PILLAR = [
  ['Filar 1 — Dominacja fizyczna', ['moc', 'wytrzymalosc', 'fizycznosc']],
  ['Filar 2 — Efektywność techniczna', ['techFund', 'techSpec']],
  ['Filar 3 — Trwałość organizmu', ['tolerancja', 'regeneracja', 'odpornosc', 'odzywianie']],
  ['Filar 4 — Mentalność', ['koncentracja', 'mental']],
  ['Filar 5 — Boiskowa mądrość', ['percepcja', 'decyzja']],
];
const SEG_PILLAR = Object.fromEntries(
  SEGMENTS_BY_PILLAR.flatMap(([pillar, segs]) => segs.map((id) => [id, pillar]))
);

async function fetchFocusBlock(supabase, focusBlockId) {
  const { data, error } = await supabase
    .from('focus_blocks')
    .select('id, user_id, segment_id, component_id, custom_description, pillar, status, stage, sessions_per_week, target_weeks, started_at, closed_at, last_content_dose_stage, last_content_dose_at')
    .eq('id', focusBlockId)
    .single();
  if (error || !data) throw new Error(`Nie znaleziono focus_block ${focusBlockId}: ${error?.message}`);
  return data;
}

async function fetchElementDescription(supabase, block) {
  if (block.component_id) {
    // component_id na focus_blocks jest TEXT (nie FK uuid) — potwierdzone
    // żywo w Kroku 5a. Dopasowanie po polu id w segment_components.
    const { data } = await supabase
      .from('segment_components')
      .select('name')
      .eq('id', block.component_id)
      .maybeSingle();
    if (data && data.name) return data.name;
  }
  return block.custom_description || 'wybrany element';
}

async function fetchKnowledgeSnippet(supabase, segmentId) {
  const { data } = await supabase
    .from('knowledge_base_entries')
    .select('content')
    .eq('segment_id', segmentId)
    .maybeSingle();
  return data ? data.content : null;
}

async function fetchRecentCheckins(supabase, focusBlockId) {
  const { data } = await supabase
    .from('focus_block_checkins')
    .select('question_text, answer_text, checkin_type, asked_at, answered_at')
    .eq('focus_block_id', focusBlockId)
    .order('asked_at', { ascending: false })
    .limit(5);
  return data || [];
}

// ------------------------------------------------------------
// Wywołanie Anthropic — 1:1 wzorzec z generate-recommendation.js /
// validate-goal-refinement.js (nazwa modelu, endpoint, nagłówki,
// stripMarkdownJsonFence — model regularnie owija JSON w blok markdown
// mimo instrukcji w promptcie, ten sam problem naprawiony tam dwukrotnie).
// ------------------------------------------------------------
async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY nie skonfigurowany.');
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'; // fallback zaktualizowany
  // 04.08.2026 (ten sam placeholder co w generate-coach-tip.js/generate-recommendation.js,
  // Pakiet 10 — przeoczony tam, poprawiony teraz przy okazji budowania testów).
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
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
    return JSON.parse(stripMarkdownJsonFence(textBlock.text));
  } catch (e) {
    throw new Error(`Nie udało się sparsować JSON z odpowiedzi AI: ${e.message}. Surowa odpowiedź (pierwsze 500 znaków): ${textBlock.text.slice(0, 500)}`);
  }
}

function stripMarkdownJsonFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

// ------------------------------------------------------------
// PRAKTYKA A5 08.08.2026 — prompt systemowy wydzielony z ciała
// generateCheckin() do osobnej, czystej funkcji. Powód: bez tego nie da
// się ZMIERZYĆ, że ścieżka bez podpowiedzi jest identyczna co do znaku
// z tą sprzed rundy — a to jedyny twardy dowód, że nic się nie zepsuło
// dla zawodników, dla których podpowiedzi jeszcze nie ma (ten sam dowód,
// który runda 4 dała dla silnika rekomendacji).
//
// ⚠️ Przy `hintBlock === ''` treść tej funkcji jest ZNAK W ZNAK tym, co
// stało tu przed 08.08.2026. Test `test-generate-focus-block-content.js`
// trzyma oczekiwaną długość i kształt obu wariantów.
// ------------------------------------------------------------
function buildCheckinSystemPrompt({ elementName, segmentId, stage, dueForContentDose, hintBlock = '' }) {
  const czyPodpowiedzi = typeof hintBlock === 'string' && hintBlock.length > 0;
  // Pole dokładane WYŁĄCZNIE wtedy, gdy podpowiedzi w ogóle poszły —
  // dokładnie ten sam warunek co przy `used_hint_klucz` w rundzie 4,
  // dzięki czemu ścieżka bez podpowiedzi zostaje bajt w bajt dzisiejsza.
  const formatDodatek = czyPodpowiedzi
    ? ', "used_hint_klucz": "klucz podpowiedzi z sekcji PODPOWIEDZI, na której oparłeś dawkę — dokładnie taki, jaki jest w nawiasie na początku linii; pomiń to pole, jeśli nie użyłeś żadnej"'
    : '';

  return `Jesteś asystentem sportowym systemu Gamechange. Piszesz krótkie,
konkretne pytanie kontrolne po polsku do zawodnika pracującego nad elementem
"${elementName}" (segment: ${segmentId}, etap progresji: ${stage}) w ramach
jego Bloku Skupienia. Pytanie MUSI dotyczyć WYŁĄCZNIE tego elementu — nie ogólnego
samopoczucia, nie innych celów. Ton rzeczowy, krótki (1 zdanie, max 2).
${dueForContentDose
    ? 'Dołącz też krótką dawkę treści edukacyjnej (2-4 zdania): "praktyczny krok" (zawsze) oraz opcjonalnie "dla chętnych" (głębsze wyjaśnienie, może być null jeśli wiedza źródłowa na to nie pozwala). Bazuj WYŁĄCZNIE na dostarczonej wiedzy źródłowej, nie zmyślaj.'
    : 'NIE dołączaj żadnej treści edukacyjnej w tej turze — zwróć contentDose: null.'}
${hintBlock}Zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu) w formacie:
{"question": "...", "contentDose": null lub {"practicalStep": "...", "forCurious": "..." lub null}${formatDodatek}}`;
}

// ------------------------------------------------------------
// action: checkin — Faza 2a (pytanie kontrolne) + Faza 2b (dawka treści)
//
// PRAKTYKA A5 08.08.2026: drugi parametr `deps` jest OPCJONALNY i służy
// wyłącznie testom (wstrzyknięcie atrapy Supabase i atrapy wywołania
// modelu) — dokładnie ten sam wzorzec co `injectedSupabase` w
// generateFocusBlockDosing()/generateRecommendation(). Wołający z crona
// (`generateCheckin({ focusBlockId })`) nie zmienia ani znaku i dostaje
// dokładnie to samo zachowanie co dotąd.
// ------------------------------------------------------------
async function generateCheckin({ focusBlockId }, deps = {}) {
  const supabase = deps.supabase || getAdminClient();
  const callModel = deps.callModel || callAnthropic;
  const now = deps.now || new Date();

  const block = await fetchFocusBlock(supabase, focusBlockId);
  const elementName = await fetchElementDescription(supabase, block);
  const knowledge = await fetchKnowledgeSnippet(supabase, block.segment_id);
  const recentCheckins = await fetchRecentCheckins(supabase, block.id);

  // Dawka treści wypada, gdy zmienił się etap (stage) od ostatniej dawki,
  // albo minęło >= 14 dni od ostatniej dawki (albo nigdy jej nie było).
  // Prosty, deterministyczny warunek liczony TUTAJ — AI dostaje już gotową
  // decyzję "czy dołączyć treść", nie liczy dat samo.
  const daysSinceLastDose = block.last_content_dose_at
    ? (now.getTime() - new Date(block.last_content_dose_at).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;
  const stageChanged = block.last_content_dose_stage !== block.stage;
  const dueRaw = stageChanged || daysSinceLastDose >= 14;

  // PRAKTYKA A5 08.08.2026 — ODCZYT PRZED WYWOŁANIEM MODELU.
  // To jest ta sama oszczędność, którą daje checkTrainingFocusCadence()
  // w silniku rekomendacji: zanim zapłacimy za wygenerowanie, sprawdzamy,
  // czy już tego nie mamy. Nigdy nie przerywa pytania kontrolnego —
  // magazyn niedostępny znaczy "zachowaj się dokładnie jak przed rundą 5".
  let magazyn = { envelope: { wersja: 1, dawki: [] }, stanKolumny: 'nie_sprawdzano', stanKoperty: 'pusta' };
  let kadencja = { allowed: true, reason: 'magazyn_niedostepny' };
  try {
    magazyn = await fetchDoseEnvelope(supabase, block.id);
    kadencja = checkContentDoseCadence({ envelope: magazyn.envelope, stage: block.stage, now });
  } catch (e) {
    console.error('[dawka] odczyt magazynu nieudany, generuję jak przed rundą 5:', e.message);
  }
  const dawkaZMagazynu = kadencja.allowed ? null : (kadencja.dawka || null);
  const dueForContentDose = dueRaw && !dawkaZMagazynu;

  // PRAKTYKA A5 08.08.2026 — podpowiedzi z materiałów, TYLKO w turze,
  // w której powstaje dawka. Blok Skupienia celuje w konkretny Element
  // (`focus_blocks.component_id`), nie tylko w segment — to jest ta
  // przewaga, której nie ma silnik rekomendacji (znalezisko B24).
  // Nigdy nie rzuca: brak tabeli/kolumny to stan, nie awaria.
  let hinty = null;
  if (dueForContentDose) {
    try {
      hinty = await loadHintsForFocusBlock(supabase, {
        segmentId: block.segment_id,
        componentId: block.component_id,
        userId: block.user_id,
        now,
      });
      console.log(hinty.log);
    } catch (e) {
      console.error('[podpowiedzi] odczyt nieudany, prompt bez podpowiedzi:', e.message);
      hinty = null;
    }
  }
  const hintBlock = hinty ? buildHintPromptBlock(hinty.selection) : '';

  const systemPrompt = buildCheckinSystemPrompt({
    elementName,
    segmentId: block.segment_id,
    stage: block.stage,
    dueForContentDose,
    hintBlock,
  });

  const userPrompt = `Element: ${elementName}
Wiedza źródłowa (może być pusta): ${knowledge || '(brak)'}
Ostatnie odpowiedzi zawodnika na wcześniejsze pytania kontrolne: ${JSON.stringify(recentCheckins.map((c) => c.answer_text).filter(Boolean))}`;

  const result = await callModel(systemPrompt, userPrompt);

  // PRAKTYKA A5 08.08.2026 — ZAPIS. Bez tego kroku wszystko powyżej jest
  // tylko lepszym promptem, a dawka nadal ginie (reguła R1: zadanie nie
  // jest skończone, dopóki człowiek tego nie widzi).
  let nowaDawka = null;
  let zapis = { stan: 'nic_do_zapisania' };
  if (dueForContentDose && result && result.contentDose) {
    const sourceHint = hinty
      ? pickShowcaseHint(hinty.selection, result.used_hint_klucz || null)
      : null;
    nowaDawka = normalizeDose(result.contentDose, {
      focusBlockId: block.id,
      stage: block.stage,
      segmentId: block.segment_id,
      componentId: block.component_id,
      sourceHint,
      now,
    });
    if (nowaDawka) {
      try {
        zapis = await saveContentDose(supabase, { focusBlockId: block.id, dose: nowaDawka });
      } catch (e) {
        zapis = { stan: 'blad', blad: e.message };
        console.error('[dawka] zapis nieudany:', e.message);
      }
    }
  }
  console.log(describeDoseState({
    stanKolumny: magazyn.stanKolumny,
    stanKoperty: magazyn.stanKoperty,
    kadencja,
    zapis: zapis.stan,
    liczbaDawek: (magazyn.envelope.dawki || []).length,
  }));

  return {
    ok: true,
    question: result.question,
    // --- POLA O NIEZMIENIONYM ZNACZENIU ---
    // `contentDose` nadal znaczy dokładnie jedno: "w TEJ turze powstała
    // NOWA dawka". Cron (pas C) opiera się na tym, żeby zaktualizować
    // last_content_dose_stage/at — dawka odczytana z magazynu NIE może
    // tu wejść, bo zresetowałaby zegar kadencji za coś, czego nie było.
    contentDose: dueForContentDose ? (result.contentDose || null) : null,
    stageAtDose: dueForContentDose ? block.stage : block.last_content_dose_stage,
    // --- PRAKTYKA A5 08.08.2026: NOWE POLA, tylko dokładane ---
    // Dzisiejszy wołający ich nie zna i po prostu je ignoruje.
    contentDoseZrodlo: nowaDawka ? 'model' : (dawkaZMagazynu ? 'magazyn' : 'brak'),
    contentDoseZapisana: nowaDawka,
    contentDoseZapamietana: dawkaZMagazynu,
    zapisDawki: zapis.stan,
    podpowiedzi: hinty
      ? {
        wstrzykniete: hinty.selection.hints.length,
        stanTabeli: hinty.stanTabeli,
        stanCelowania: hinty.stanCelowania,
        wycelowaneWElement: hinty.selection.wycelowaneWCel,
        wiekNieznany: hinty.selection.wiekNieznany,
        ukryteZPowoduWieku: hinty.selection.ukryteZPowoduWieku,
      }
      : null,
  };
}

// ------------------------------------------------------------
// action: closing_review — Faza 3 (przegląd na koniec bloku)
// ------------------------------------------------------------
async function generateClosingReview({ focusBlockId }) {
  const supabase = getAdminClient();
  const block = await fetchFocusBlock(supabase, focusBlockId);
  const elementName = await fetchElementDescription(supabase, block);
  const checkins = await fetchRecentCheckins(supabase, focusBlockId);

  const { data: events } = await supabase
    .from('calendar_events')
    .select('status')
    .eq('focus_block_id', focusBlockId);
  const completedCount = (events || []).filter((e) => e.status === 'completed').length;
  const totalCount = (events || []).length;

  const systemPrompt = `Jesteś asystentem sportowym systemu Gamechange. Piszesz krótkie
podsumowanie (3-5 zdań, po polsku, rzeczowy ale ciepły ton) zakończonego Bloku Skupienia
zawodnika nad elementem "${elementName}". Bazuj WYŁĄCZNIE na dostarczonych danych, nie
zmyślaj konkretów, których nie masz. NIE sugeruj jednej konkretnej decyzji na koniec —
appka i tak pokaże trzy równorzędne opcje (kontynuuj / nowy element w tym filarze / zamknij
wątek), Twoje podsumowanie ma tylko pomóc zawodnikowi zdecydować, nie decydować za niego.
Zwróć WYŁĄCZNIE poprawny JSON (bez markdown): {"summary": "..."}`;

  const userPrompt = `Element: ${elementName}
Zrealizowane sesje kalendarzowe: ${completedCount}/${totalCount}
Odpowiedzi na pytania kontrolne w trakcie bloku: ${JSON.stringify(checkins.map((c) => ({ pytanie: c.question_text, odpowiedz: c.answer_text })))}`;

  const result = await callAnthropic(systemPrompt, userPrompt);

  return {
    ok: true,
    summary: result.summary,
    stats: { completedCount, totalCount },
    options: ['continue', 'new_element', 'close'],
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, focusBlockId } = req.body || {};
  if (!focusBlockId) {
    return res.status(400).json({ ok: false, error: 'Brak focusBlockId w treści żądania.' });
  }

  try {
    if (action === 'checkin') {
      return res.status(200).json(await generateCheckin({ focusBlockId }));
    }
    if (action === 'closing_review') {
      return res.status(200).json(await generateClosingReview({ focusBlockId }));
    }
    return res.status(400).json({ ok: false, error: `Nieznana akcja: ${action}. Oczekiwano 'checkin' lub 'closing_review'.` });
  } catch (e) {
    console.error('generate-focus-block-content error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// Eksport do reużycia przez cron (runFocusBlockCheckins w
// cron-send-notifications.js) bez duplikowania logiki, i do testów.
module.exports._internal = {
  generateCheckin,
  generateClosingReview,
  fetchFocusBlock,
  fetchElementDescription,
  stripMarkdownJsonFence,
  SEG_PILLAR,
  // PRAKTYKA A5 08.08.2026 — wystawione, żeby dało się ZMIERZYĆ, że
  // prompt bez podpowiedzi jest identyczny co do znaku ze stanem sprzed
  // tej rundy (dowód, nie deklaracja — raport rundy 5, sekcja 10 i 12).
  buildCheckinSystemPrompt,
  fetchKnowledgeSnippet,
  fetchRecentCheckins,
};
