// ============================================================
// GAMECHANGE — /api/submit-coach-tip-feedback.js
// ============================================================
// Zapisuje lekki feedback trenera ("przydatne / nie teraz") na podpowiedzi
// wygenerowanej przez generate-coach-tip.js — NARZEDZIE_TRENERA_DECYZJE_
// PROJEKTOWE.md: "Lekki feedback trenera wbudowany od startu... żeby
// walidacja w praktyce dawała realny sygnał bez ankietowania trenerów."
//
// Ten sam wzorzec co api_submit_recommendation_feedback.js: frontend NIE
// robi bezpośredniego PATCH na coach_tips (brak polityki RLS na to,
// świadomie — patrz Domena 22 SQL), tylko woła ten endpoint, który
// sprawdza że podpowiedź faktycznie należy do podanego trenera zanim
// cokolwiek zapisze.
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

module.exports = async (req, res) => {
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
};
