const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

// Service-role client: bypasses RLS. Server-side only.
const supabase = createClient(env.supabase.url, env.supabase.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = supabase;
