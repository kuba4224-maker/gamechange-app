// ============================================================
// GAMECHANGE — lib/coach-tip-feedback.js
// ============================================================
// PRZENIESIONE z api/submit-coach-tip-feedback.js (04.08.2026, noc) —
// scalenie endpointów, żeby zmieścić się w limicie 12 Serverless Functions
// Vercel Hobby (opcja (b) z claude/INTEGRACJA_STRIPE_K2.md, wybrana przez
// Kubę zamiast płatnego upgrade'u na Vercel Pro). ZERO zmiany logiki —
// dokładnie ta sama funkcja, tylko w innym pliku i innym miejscu w
// łańcuchu wywołań: teraz wołana z api/generate-coach-tip.js (jedyny
// pozostały plik Vercel Function dla obu funkcji), po `action:
// "submit_feedback"` w body zapytania — patrz dispatch na końcu
// generate-coach-tip.js.
//
// PEŁNA REWERSYBILNOŚĆ: to czysto routingowa zmiana, zero migracji/danych.
// Żeby wrócić do osobnego endpointu (np. po przejściu na Vercel Pro):
// (1) skopiować tę funkcję z powrotem do nowego api/submit-coach-tip-
// feedback.js, (2) usunąć dispatch w generate-coach-tip.js, (3) w
// coach.html zmienić fetch('/api/generate-coach-tip', {..., action:
// 'submit_feedback'}) z powrotem na fetch('/api/submit-coach-tip-
// feedback', {...}) bez pola action. Żadnego wpływu na bazę/schemat.
//
// Oryginalny opis (bez zmian): zapisuje lekki feedback trenera
// ("przydatne / nie teraz") na podpowiedzi wygenerowanej przez
// generate-coach-tip.js — NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md: "Lekki
// feedback trenera wbudowany od startu... żeby walidacja w praktyce dawała
// realny sygnał bez ankietowania trenerów." Ten sam wzorzec co
// api_submit_recommendation_feedback.js: frontend NIE robi bezpośredniego
// PATCH na coach_tips (brak polityki RLS na to, świadomie — patrz Domena
// 22 SQL), tylko woła ten handler, który sprawdza że podpowiedź faktycznie
// należy do podanego trenera zanim cokolwiek zapisze.
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

const ALLOWED_RESPONSES = ['useful', 'not_now'];

async function handleSubmitCoachTipFeedback(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { coachUserId, tipId, response } = req.body || {};
  if (!coachUserId || !tipId || !ALLOWED_RESPONSES.includes(response)) {
    return res.status(400).json({ error: 'Brak wymaganych danych albo nieprawidłowa odpowiedź.' });
  }

  const supabase = getAdminClient();

  try {
    const { data: tip, error: tipError } = await supabase
      .from('coach_tips').select('id, coach_user_id, feedback_response').eq('id', tipId).maybeSingle();
    if (tipError) throw new Error(`fetch tip: ${tipError.message}`);
    if (!tip || tip.coach_user_id !== coachUserId) {
      return res.status(404).json({ error: 'Nie znaleziono podpowiedzi.' });
    }
    if (tip.feedback_response) {
      return res.status(409).json({ error: 'Ta podpowiedź ma już zapisaną odpowiedź.' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('coach_tips')
      .update({ feedback_response: response, feedback_at: new Date().toISOString() })
      .eq('id', tipId).select().single();
    if (updateError) throw new Error(`update tip: ${updateError.message}`);

    return res.status(200).json({ ok: true, tip: updated });
  } catch (e) {
    console.error('submit-coach-tip-feedback error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = handleSubmitCoachTipFeedback;
module.exports.handleSubmitCoachTipFeedback = handleSubmitCoachTipFeedback;
module.exports._internal = { getAdminClient, ALLOWED_RESPONSES };
