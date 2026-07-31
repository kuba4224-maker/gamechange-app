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
// ============================================================

const { createClient } = require('@supabase/supabase-js');

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
// action: checkin — Faza 2a (pytanie kontrolne) + Faza 2b (dawka treści)
// ------------------------------------------------------------
async function generateCheckin({ focusBlockId }) {
  const supabase = getAdminClient();
  const block = await fetchFocusBlock(supabase, focusBlockId);
  const elementName = await fetchElementDescription(supabase, block);
  const knowledge = await fetchKnowledgeSnippet(supabase, block.segment_id);
  const recentCheckins = await fetchRecentCheckins(supabase, block.id);

  // Dawka treści wypada, gdy zmienił się etap (stage) od ostatniej dawki,
  // albo minęło >= 14 dni od ostatniej dawki (albo nigdy jej nie było).
  // Prosty, deterministyczny warunek liczony TUTAJ — AI dostaje już gotową
  // decyzję "czy dołączyć treść", nie liczy dat samo.
  const daysSinceLastDose = block.last_content_dose_at
    ? (Date.now() - new Date(block.last_content_dose_at).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;
  const stageChanged = block.last_content_dose_stage !== block.stage;
  const dueForContentDose = stageChanged || daysSinceLastDose >= 14;

  const systemPrompt = `Jesteś asystentem sportowym systemu Gamechange. Piszesz krótkie,
konkretne pytanie kontrolne po polsku do zawodnika pracującego nad elementem
"${elementName}" (segment: ${block.segment_id}, etap progresji: ${block.stage}) w ramach
jego Bloku Skupienia. Pytanie MUSI dotyczyć WYŁĄCZNIE tego elementu — nie ogólnego
samopoczucia, nie innych celów. Ton rzeczowy, krótki (1 zdanie, max 2).
${dueForContentDose
    ? 'Dołącz też krótką dawkę treści edukacyjnej (2-4 zdania): "praktyczny krok" (zawsze) oraz opcjonalnie "dla chętnych" (głębsze wyjaśnienie, może być null jeśli wiedza źródłowa na to nie pozwala). Bazuj WYŁĄCZNIE na dostarczonej wiedzy źródłowej, nie zmyślaj.'
    : 'NIE dołączaj żadnej treści edukacyjnej w tej turze — zwróć contentDose: null.'}
Zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu) w formacie:
{"question": "...", "contentDose": null lub {"practicalStep": "...", "forCurious": "..." lub null}}`;

  const userPrompt = `Element: ${elementName}
Wiedza źródłowa (może być pusta): ${knowledge || '(brak)'}
Ostatnie odpowiedzi zawodnika na wcześniejsze pytania kontrolne: ${JSON.stringify(recentCheckins.map((c) => c.answer_text).filter(Boolean))}`;

  const result = await callAnthropic(systemPrompt, userPrompt);

  return {
    ok: true,
    question: result.question,
    contentDose: dueForContentDose ? (result.contentDose || null) : null,
    stageAtDose: dueForContentDose ? block.stage : block.last_content_dose_stage,
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
};
