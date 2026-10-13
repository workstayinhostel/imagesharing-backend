const supabase = require('../config/supabase');

/** Writes an audit-log row. Never throws, so logging can't break a request. */
async function logEvent(eventType, description) {
  try {
    const { error } = await supabase.from('system_logs').insert({ event_type: eventType, description });
    if (error) console.error('[log] insert failed:', error.message);
  } catch (e) {
    console.error('[log] unexpected error:', e.message);
  }
}

module.exports = { logEvent };
