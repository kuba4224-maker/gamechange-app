// ============================================================
// GAMECHANGE — lib/focus-block-adaptation.js
// ============================================================
// Krok 5b (Blok Skupienia — Prowadzenie, PLAN_SPOJNEJ_SCIEZKI.md sekcja 3E,
// Faza 2c "adaptacja po sygnale bólu/zmęczenia"). Świadomie BEZ wywołania
// Anthropic API — czysto progowa/deterministyczna decyzja. Wołana
// WYŁĄCZNIE in-process przez cron (runFocusBlockAdaptation w
// cron-send-notifications.js, ten sam wzorzec co require('./send-push')
// tam) — to NIE jest route HTTP w api/, więc nie liczy się do limitu 12
// Serverless Functions na Vercel Hobby.
//
// Reużywa DOKŁADNIE tej samej logiki gotowości co Centrum Decyzji
// (api/generate-recommendation.js, _internal: fetchReadinessWindowLogs,
// computeReadinessSignals) — świadomie NIE przelicza własnym wzorem, żeby
// "zmęczenie" znaczyło to samo tutaj i tam. Sygnatury i kształt wyniku
// computeReadinessSignals() zweryfikowane żywo z repo 31.07.2026 przed
// napisaniem tego pliku.
// ============================================================

const { _internal } = require('../api/generate-recommendation');
const { fetchReadinessWindowLogs, computeReadinessSignals } = _internal;

const ADAPTATION_COOLDOWN_DAYS = 5;
// Ostatnie 3 dni — świeży, aktywny ból wykluczający trening. Krótsze okno
// niż readiness (30 dni), bo to sygnał "teraz", nie trend.
const PAIN_LOOKBACK_DAYS = 3;

async function fetchActivePainSignal(supabase, userId) {
  const since = new Date(Date.now() - PAIN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('pain_entries')
    .select('id, body_location, intensity, excludes_from_training, created_at')
    .eq('user_id', userId)
    .eq('excludes_from_training', true)
    .gte('created_at', since);
  if (error) {
    console.error('focus-block-adaptation: fetchActivePainSignal error:', error);
    return [];
  }
  return data || [];
}

// Decyduje, czy sygnały zawodnika (ból LUB zmęczenie z Centrum Decyzji)
// uzasadniają adaptację jego aktywnych Bloków TERAZ. Zwraca powód, żeby
// dało się to zalogować/pokazać zawodnikowi bez zgadywania.
async function shouldAdapt(supabase, userId) {
  const activePain = await fetchActivePainSignal(supabase, userId);
  if (activePain.length > 0) {
    return { adapt: true, reason: 'pain', detail: activePain };
  }

  const windowLogs = await fetchReadinessWindowLogs(supabase, userId);
  const signals = computeReadinessSignals(windowLogs);
  if (signals.sleepFlag && signals.sleepFlag.active) {
    return { adapt: true, reason: 'fatigue_sleep', detail: signals.sleepFlag };
  }
  if (signals.coldStartOrBaseline && signals.coldStartOrBaseline.tired) {
    return { adapt: true, reason: 'fatigue_load', detail: signals.coldStartOrBaseline };
  }
  return { adapt: false };
}

// Poniedziałek-niedziela w UTC (kalendarz appki i tak operuje na datach,
// nie godzinach — patrz Krok 0 punktu startowego Kroku 5a — więc granica
// dnia w UTC jest wystarczająco dokładna dla tygodniowego okna).
function currentWeekBounds(now) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0 = niedziela
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

// Odwołuje (status='cancelled') pozostałe ZAPLANOWANE sesje TEGO bloku w
// bieżącym tygodniu kalendarzowym — nie usuwa wierszy, nie rusza przeszłych
///zrealizowanych sesji. Cooldown ADAPTATION_COOLDOWN_DAYS między kolejnymi
// adaptacjami tego samego bloku (last_adaptation_at na focus_blocks, kolumna
// z migracji Krok 5b), żeby nie odwoływać w kółko przy uporczywym sygnale.
async function adaptFocusBlock(supabase, block, now) {
  if (block.last_adaptation_at) {
    const daysSince = (now.getTime() - new Date(block.last_adaptation_at).getTime()) / (24 * 60 * 60 * 1000);
    if (daysSince < ADAPTATION_COOLDOWN_DAYS) {
      return { adapted: false, reason: 'cooldown' };
    }
  }

  const { start, end } = currentWeekBounds(now);
  const { data: cancelled, error } = await supabase
    .from('calendar_events')
    .update({ status: 'cancelled' })
    .eq('focus_block_id', block.id)
    .eq('status', 'scheduled')
    .gte('scheduled_date', start)
    .lte('scheduled_date', end)
    .select('id');
  if (error) {
    throw new Error(`adaptFocusBlock: ${error.message}`);
  }

  const { error: updateError } = await supabase
    .from('focus_blocks')
    .update({ last_adaptation_at: now.toISOString() })
    .eq('id', block.id);
  if (updateError) {
    console.error(`focus-block-adaptation: nie udało się zapisać last_adaptation_at dla ${block.id}:`, updateError);
  }

  return { adapted: true, cancelledCount: (cancelled || []).length };
}

// Główna funkcja wołana przez cron — sprawdza WSZYSTKIE aktywne bloki,
// per zawodnik (jeden zawodnik może mieć wiele aktywnych bloków, po jednym
// na filar — patrz unique index z Kroku 5a). `results`, jeśli podany,
// dostaje przyrost licznika `focus_block_adaptation` (ten sam wzorzec co
// obiekt `results` w cron-send-notifications.js).
async function runFocusBlockAdaptation(supabase, results) {
  const { data: blocks, error } = await supabase
    .from('focus_blocks')
    .select('id, user_id, last_adaptation_at')
    .eq('status', 'active');
  if (error || !blocks || blocks.length === 0) return;

  const now = new Date();
  for (const block of blocks) {
    try {
      const check = await shouldAdapt(supabase, block.user_id);
      if (!check.adapt) continue;
      const result = await adaptFocusBlock(supabase, block, now);
      if (result.adapted && results) {
        results.focus_block_adaptation = (results.focus_block_adaptation || 0) + 1;
      }
    } catch (e) {
      console.error(`focus-block-adaptation: błąd dla bloku ${block.id}:`, e);
    }
  }
}

module.exports = {
  shouldAdapt,
  adaptFocusBlock,
  runFocusBlockAdaptation,
  currentWeekBounds,
};
