/**
 * DoTheNeeds — Cloudflare Worker API
 * Product of EXADreams LLC
 *
 * Endpoints:
 *   POST   /api/declarations     Submit a new declaration
 *   GET    /api/declarations     Fetch declarations (filtered/paginated)
 *   POST   /api/updates          Add a story update to a declaration
 *   GET    /api/movements        Fetch movement aggregations by category
 *   GET    /api/search           Full-text search across declarations
 *   GET    /api/stats            Platform-level statistics
 */

// ─── CORS ────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function cors(headers = {}) {
  return { ...CORS, 'Content-Type': 'application/json', ...headers };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors() });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

// ─── MAIN HANDLER ────────────────────────────────────
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === '/api/declarations') {
        if (request.method === 'POST') return handlePostDeclaration(request, env);
        if (request.method === 'GET')  return handleGetDeclarations(request, env, url);
      }
      if (path === '/api/updates'   && request.method === 'POST') return handlePostUpdate(request, env);
      if (path === '/api/movements' && request.method === 'GET')  return handleGetMovements(request, env, url);
      if (path === '/api/search'    && request.method === 'GET')  return handleSearch(request, env, url);
      if (path === '/api/stats'     && request.method === 'GET')  return handleStats(request, env);

      return err('Not found', 404);
    } catch (e) {
      console.error('Worker error:', e);
      return err('Internal server error', 500);
    }
  }
};

// ══════════════════════════════════════════════════════
// POST /api/declarations
// ══════════════════════════════════════════════════════
async function handlePostDeclaration(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('Invalid JSON body');

  // ── Validate required fields ──
  const { name, age, anon, origin, residence, text, action, category, contributionType, tnc_agreed, email } = body;

  if (!text || text.trim().length < 20)    return err('Declaration must be at least 20 characters');
  if (!contributionType)                   return err('Contribution type is required');
  if (!tnc_agreed)                         return err('Terms of Service agreement is required', 403);
  if (!anon && (!name || !name.trim()))    return err('Name is required unless posting anonymously');

  const age_int = age ? parseInt(age) : null;
  if (age_int !== null && age_int < 13)    return err('Must be 13 or older to declare', 403);

  // ── Rate limiting check (Cloudflare IP) ──
  const ip_country = request.cf?.country || 'XX';
  const ip_hash    = await sha256(request.headers.get('cf-connecting-ip') || 'unknown');
  const rl_key     = `rl:${ip_hash.substring(0, 16)}:${new Date().toISOString().slice(0, 10)}`;

  const rl = await checkRateLimit(rl_key, 3, env); // max 3 per IP per day
  if (!rl.allowed) return err('Too many declarations from this address today. Try again tomorrow.', 429);

  // ── AI Moderation (Layer 2) ──
  let modResult = { pass: true, level: 'clear', category: category || null };
  if (env.CLAUDE_API_KEY) {
    modResult = await moderate(text, env);
    if (modResult.level === 'hard') {
      return err(`Declaration blocked: ${modResult.reason}`, 422);
    }
  }

  // ── Auto-categorise if not provided ──
  const final_category = category || modResult.category || autoCategory(text);

  // ── SHA-256 hash ──
  const ts   = new Date().toISOString();
  const id   = crypto.randomUUID();
  const hash = await sha256(`${text.trim()}|${ts}|${id}|${anon ? 'anonymous' : (name || '')}`);

  // ── Compute stage ──
  const stage = await getCategoryStage(final_category, env);

  // ── Insert declaration ──
  const declaration = {
    id,
    name:              anon ? null : (name || '').trim(),
    age:               age_int,
    anon:              !!anon,
    origin:            origin || null,
    residence:         residence || null,
    text:              text.trim(),
    action:            (action || '').trim() || null,
    category:          final_category,
    contribution_type: contributionType,
    hash,
    timestamp:         ts,
    location:          residence || (anon ? null : origin) || null,
    ip_country,
    email:             email || null,
    matches:           0,
    local_matches:     0,
    status:            modResult.level === 'soft' ? 'pending_review' : 'active',
    mod_level:         modResult.level,
  };

  const insertRes = await sbInsert(env, 'declarations', declaration);
  if (!insertRes.ok) {
    console.error('Supabase insert error:', await insertRes.text());
    return err('Failed to save declaration', 500);
  }

  // ── Log policy agreement ──
  await sbInsert(env, 'policy_agreements', {
    id:              crypto.randomUUID(),
    declaration_id:  id,
    agreed_at:       ts,
    policy_version:  env.POLICY_VERSION || 'v1.0-2026',
    ip_country,
  });

  // ── Increment rate limit counter ──
  await incrementRateLimit(rl_key, env);

  // ── Send confirmation email (if email provided) ──
  if (email && env.RESEND_API_KEY) {
    await sendConfirmationEmail({ ...declaration, stage }, env).catch(console.error);
  }

  return json({
    success:  true,
    id,
    hash,
    timestamp: ts,
    category:  final_category,
    stage:     stage.name,
    status:    declaration.status,
    message:   declaration.status === 'pending_review'
      ? 'Your declaration is under review and will appear shortly.'
      : 'Your declaration is live.',
  }, 201);
}

// ══════════════════════════════════════════════════════
// GET /api/declarations
// ══════════════════════════════════════════════════════
async function handleGetDeclarations(request, env, url) {
  const category = url.searchParams.get('category') || null;
  const filter   = url.searchParams.get('filter') || 'trending';   // trending|recent|quickwins|factbased|global
  const page     = parseInt(url.searchParams.get('page') || '1');
  const limit    = Math.min(parseInt(url.searchParams.get('limit') || '24'), 100);
  const offset   = (page - 1) * limit;

  let query = `${env.SUPABASE_URL}/rest/v1/declarations?status=eq.active&select=*`;

  if (category) {
    query += `&category=eq.${encodeURIComponent(category)}`;
  }

  switch (filter) {
    case 'recent':    query += '&order=timestamp.desc';                    break;
    case 'global':    query += '&matches=gte.600&order=matches.desc';      break;
    case 'trending':  query += '&order=matches.desc,timestamp.desc';       break;
    default:          query += '&order=matches.desc,timestamp.desc';
  }

  query += `&limit=${limit}&offset=${offset}`;

  const res  = await sbFetch(env, query);
  const data = await res.json();

  // Compute stage per category (batch)
  const posts = Array.isArray(data) ? data : [];

  return json({ declarations: posts, page, limit, count: posts.length });
}

// ══════════════════════════════════════════════════════
// POST /api/updates
// ══════════════════════════════════════════════════════
async function handlePostUpdate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('Invalid JSON body');

  const { name, age, origin, residence, text, tnc_agreed } = body;

  if (!text || text.trim().length < 10) return err('Update must be at least 10 characters');
  if (!tnc_agreed) return err('Terms of Service agreement is required', 403);
  if (!name)       return err('Name is required to update your story');

  // Find the original declaration
  const findQuery = `${env.SUPABASE_URL}/rest/v1/declarations?status=eq.active&anon=eq.false&select=id,name,age,origin,residence,text&limit=1` +
    `&name=ilike.${encodeURIComponent(name.trim())}` +
    (age       ? `&age=eq.${parseInt(age)}`               : '') +
    (origin    ? `&origin=eq.${encodeURIComponent(origin)}` : '') +
    (residence ? `&residence=eq.${encodeURIComponent(residence)}` : '');

  const findRes  = await sbFetch(env, findQuery);
  const found    = await findRes.json();

  if (!Array.isArray(found) || found.length === 0) {
    return err('No declaration found matching those details. Check your name and age match exactly.', 404);
  }

  const declaration = found[0];
  const ts   = new Date().toISOString();
  const hash = await sha256(`${text.trim()}|${ts}|${declaration.id}`);

  const update = {
    id:             crypto.randomUUID(),
    declaration_id: declaration.id,
    text:           text.trim(),
    hash,
    created_at:     ts,
  };

  const insertRes = await sbInsert(env, 'declaration_updates', update);
  if (!insertRes.ok) return err('Failed to save update', 500);

  return json({ success: true, declaration_id: declaration.id, hash, timestamp: ts }, 201);
}

// ══════════════════════════════════════════════════════
// GET /api/movements
// ══════════════════════════════════════════════════════
async function handleGetMovements(request, env, url) {
  const sort = url.searchParams.get('sort') || 'voices'; // voices|doers|alpha

  // Aggregate by category
  const query = `${env.SUPABASE_URL}/rest/v1/declarations?status=eq.active&select=category,contribution_type,residence,text,matches,timestamp&limit=1000`;
  const res   = await sbFetch(env, query);
  const posts = await res.json();

  if (!Array.isArray(posts)) return json({ movements: [] });

  const clusters = {};
  posts.forEach(p => {
    if (!clusters[p.category]) {
      clusters[p.category] = { cat: p.category, posts: [], doers: 0 };
    }
    clusters[p.category].posts.push(p);
    if (DOER_TYPES.includes(p.contribution_type)) clusters[p.category].doers++;
  });

  let movements = Object.values(clusters).map(mv => {
    const count    = mv.posts.length;
    const doerPct  = count ? Math.round(mv.doers / count * 100) : 0;
    const stage    = getStage(count);
    const scope    = computeScope(mv.posts);
    const topPosts = [...mv.posts].sort((a, b) => (b.matches || 0) - (a.matches || 0)).slice(0, 3);

    return {
      category:    mv.cat,
      count,
      doers:       mv.doers,
      doer_pct:    doerPct,
      stage:       stage.name,
      stage_icon:  stage.icon,
      stage_desc:  stage.desc,
      stage_next:  stage.next,
      stage_next_name: stage.nextName,
      stage_pct:   stageProgress(count),
      scope:       scope.name,
      scope_icon:  scope.icon,
      scope_desc:  scope.desc,
      snippets:    topPosts.map(p => p.text.substring(0, 120)),
    };
  });

  if (sort === 'doers')  movements.sort((a, b) => b.doers - a.doers);
  else if (sort === 'alpha') movements.sort((a, b) => a.category.localeCompare(b.category));
  else movements.sort((a, b) => b.count - a.count);

  return json({ movements, total: movements.length });
}

// ══════════════════════════════════════════════════════
// GET /api/search
// ══════════════════════════════════════════════════════
async function handleSearch(request, env, url) {
  const q      = (url.searchParams.get('q') || '').trim();
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  if (!q || q.length < 2) return json({ results: [], query: q });

  // Supabase full-text search using ilike (simple) — upgrade to pg_trgm later
  const escaped = encodeURIComponent(`%${q}%`);
  const query = `${env.SUPABASE_URL}/rest/v1/declarations?status=eq.active&select=*` +
    `&or=(text.ilike.${escaped},action.ilike.${escaped},category.ilike.${escaped},location.ilike.${escaped})` +
    `&order=matches.desc&limit=${limit}`;

  const res     = await sbFetch(env, query);
  const results = await res.json();

  return json({ results: Array.isArray(results) ? results : [], query: q, count: results.length || 0 });
}

// ══════════════════════════════════════════════════════
// GET /api/stats
// ══════════════════════════════════════════════════════
async function handleStats(request, env) {
  const query = `${env.SUPABASE_URL}/rest/v1/declarations?status=eq.active&select=contribution_type,residence,category&limit=5000`;
  const res   = await sbFetch(env, query);
  const posts = await res.json();

  if (!Array.isArray(posts)) return json({ total: 0, doers: 0, countries: 0 });

  const doers     = posts.filter(p => DOER_TYPES.includes(p.contribution_type)).length;
  const countries = new Set(posts.map(p => p.residence).filter(Boolean)).size;
  const doerPct   = posts.length ? Math.round(doers / posts.length * 100) : 0;

  return json({
    total:     posts.length,
    doers,
    countries,
    doer_pct:  doerPct,
    platform:  'DoTheNeeds',
    company:   'EXADreams LLC',
  });
}

// ══════════════════════════════════════════════════════
// SUPABASE HELPERS
// ══════════════════════════════════════════════════════
function sbHeaders(env, useService = false) {
  return {
    'apikey':        env.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${useService ? env.SUPABASE_SERVICE_KEY : env.SUPABASE_ANON_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
  };
}

async function sbFetch(env, url) {
  return fetch(url, { headers: sbHeaders(env, false) });
}

async function sbInsert(env, table, data) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: sbHeaders(env, true),
    body:    JSON.stringify(data),
  });
}

// ══════════════════════════════════════════════════════
// RATE LIMITING (using Cloudflare KV if available)
// ══════════════════════════════════════════════════════
async function checkRateLimit(key, max, env) {
  if (!env.DTN_KV) return { allowed: true }; // Skip if KV not configured
  try {
    const current = parseInt(await env.DTN_KV.get(key) || '0');
    return { allowed: current < max, current };
  } catch { return { allowed: true }; }
}

async function incrementRateLimit(key, env) {
  if (!env.DTN_KV) return;
  try {
    const current = parseInt(await env.DTN_KV.get(key) || '0');
    await env.DTN_KV.put(key, String(current + 1), { expirationTtl: 86400 }); // 24h TTL
  } catch {}
}

// ══════════════════════════════════════════════════════
// AI MODERATION
// ══════════════════════════════════════════════════════
async function moderate(text, env) {
  const defaultResult = { pass: true, level: 'clear', category: null, reason: '' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [{
          role:    'user',
          content: `You moderate declarations on DoTheNeeds — a platform for systemic change (not personal complaints). Evaluate this declaration ONLY for: (1) personal targeting of named individuals with threats, (2) hate speech/slurs, (3) calls to violence, (4) spam/promotional content. Also suggest the best category.

Declaration: "${text}"

RESPOND IN VALID JSON ONLY, no other text:
{"pass":true,"level":"clear","reason":"","category":"Health & Wellbeing"}

Level must be one of: "clear" (post normally), "soft" (flag for review, still post), "hard" (block entirely).
Category must be one of: Environment & Climate, Education & Learning, Health & Wellbeing, Technology & AI, Economy & Finance, Social Justice & Equity, Politics & Governance, Science & Research, Arts & Culture, Local Community, Human Rights, Food & Agriculture, Housing & Urban, Transportation, Animal Rights, Other`,
        }],
      }),
    });

    if (!res.ok) return defaultResult;
    const data   = await res.json();
    const raw    = data.content?.[0]?.text || '{}';
    const parsed = JSON.parse(raw.trim());
    return { pass: parsed.level !== 'hard', level: parsed.level || 'clear', reason: parsed.reason || '', category: parsed.category || null };
  } catch {
    return defaultResult; // Fail open — never block on API error
  }
}

// ══════════════════════════════════════════════════════
// AUTO-CATEGORISATION (keyword fallback)
// ══════════════════════════════════════════════════════
function autoCategory(text) {
  const t = text.toLowerCase();
  if (/climate|pollution|carbon|ocean|forest|renewable|peatland|amazon/.test(t))     return 'Environment & Climate';
  if (/school|teacher|curriculum|learning|university|literacy|education/.test(t))    return 'Education & Learning';
  if (/health|mental|loneliness|hospital|medicine|insulin|addiction|suicide/.test(t)) return 'Health & Wellbeing';
  if (/ai|artificial intelligence|tech|algorithm|digital|deepfake|automation/.test(t)) return 'Technology & AI';
  if (/wage|poverty|income|economic|financial|tax|inequality|wealth|debt/.test(t))   return 'Economy & Finance';
  if (/women|gender|race|equality|justice|discrimination|femicide|lgbtq/.test(t))    return 'Social Justice & Equity';
  if (/government|politics|election|democracy|corrupt|vote|parliament/.test(t))      return 'Politics & Governance';
  if (/science|research|open access|neglected|clinical/.test(t))                     return 'Science & Research';
  if (/art|music|culture|creative|film|literature|artist/.test(t))                   return 'Arts & Culture';
  if (/neighborhood|local|community|city|street|park|town/.test(t))                  return 'Local Community';
  if (/animal|wildlife|factory farm|vegan|cruelty/.test(t))                          return 'Animal Rights';
  if (/food|farming|agriculture|hunger|nutrition|smallholder|waste/.test(t))         return 'Food & Agriculture';
  if (/housing|home|rent|homeless|affordable|shelter|zoning/.test(t))                return 'Housing & Urban';
  if (/human rights|torture|freedom|refugee|press|journalist/.test(t))               return 'Human Rights';
  return 'Other';
}

// ══════════════════════════════════════════════════════
// STAGE SYSTEM
// ══════════════════════════════════════════════════════
const STAGES = [
  { name: 'Voice',    icon: '🎤', min: 1,   max: 9,          next: 10,  nextName: 'Echo',     desc: 'A need is named.' },
  { name: 'Echo',     icon: '🔊', min: 10,  max: 99,         next: 100, nextName: 'Movement', desc: 'The signal is real.' },
  { name: 'Movement', icon: '✊', min: 100, max: 499,        next: 500, nextName: 'Force',    desc: 'Critical mass.' },
  { name: 'Force',    icon: '🌍', min: 500, max: Infinity,   next: null, nextName: null,      desc: 'Undeniable.' },
];

const SCOPE_LEVELS = [
  { name: 'Community', icon: '🏘️', minC: 1, minL: 1, desc: 'Same city or neighbourhood' },
  { name: 'Regional',  icon: '🗺️', minC: 1, minL: 3, desc: 'Same region or state' },
  { name: 'National',  icon: '🏴', minC: 1, minL: 6, desc: 'Across one country' },
  { name: 'Global',    icon: '🌐', minC: 3, minL: 5, desc: 'Multiple countries' },
];

const DOER_TYPES = ['build', 'fund', 'organize', 'educate', 'volunteer'];

function getStage(count) {
  return STAGES.find(s => count >= s.min && count <= s.max) || STAGES[0];
}

function stageProgress(count) {
  const s = getStage(count);
  if (!s.next) return 100;
  return Math.min(100, Math.round((count - s.min) / (s.next - s.min) * 100));
}

function computeScope(posts) {
  const countries = new Set(posts.map(p => p.residence).filter(Boolean)).size;
  const locs      = new Set(posts.map(p => p.location || p.residence).filter(Boolean)).size;
  if (countries >= 3 || locs >= 5) return SCOPE_LEVELS[3];
  if (locs >= 6)                   return SCOPE_LEVELS[2];
  if (locs >= 3)                   return SCOPE_LEVELS[1];
  return SCOPE_LEVELS[0];
}

async function getCategoryStage(category, env) {
  try {
    const query = `${env.SUPABASE_URL}/rest/v1/declarations?status=eq.active&category=eq.${encodeURIComponent(category)}&select=id`;
    const res   = await sbFetch(env, query);
    const data  = await res.json();
    const count = Array.isArray(data) ? data.length : 0;
    return getStage(count);
  } catch {
    return STAGES[0];
  }
}

// ══════════════════════════════════════════════════════
// SHA-256 (Web Crypto — identical to browser impl)
// ══════════════════════════════════════════════════════
async function sha256(message) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ══════════════════════════════════════════════════════
// EMAIL (Resend)
// ══════════════════════════════════════════════════════
async function sendConfirmationEmail(declaration, env) {
  const { name, anon, text, action, category, hash, timestamp, id, stage } = declaration;
  const displayName = anon ? 'Anonymous' : name;

  await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    'DoTheNeeds <noreply@dotheneeds.com>',
      to:      declaration.email,
      subject: 'Your declaration is permanent. This is your proof.',
      html: `
<!DOCTYPE html>
<html>
<body style="font-family:Georgia,serif;background:#FAF5EC;padding:32px;max-width:560px;margin:0 auto;">
  <div style="background:#241408;padding:20px 24px;border-radius:10px 10px 0 0;text-align:center;">
    <p style="font-family:serif;font-size:1.5rem;color:#B85C38;margin:0;letter-spacing:-0.5px;">dotheneeds</p>
    <p style="font-size:0.72rem;color:rgba(255,255,255,0.45);margin:4px 0 0;letter-spacing:2px;">EXADREAMS LLC</p>
  </div>
  <div style="background:white;padding:28px;border:1px solid #EAD9BF;">
    <h2 style="font-family:serif;font-size:1.3rem;color:#241408;margin:0 0 6px;">Declared. Signed. Witnessed.</h2>
    <p style="color:#7A5530;font-size:0.88rem;margin:0 0 20px;">Your certificate of declaration — your permanent proof of authorship.</p>

    <div style="background:#FAF5EC;border-left:3px solid #B85C38;padding:14px 16px;margin-bottom:16px;font-style:italic;font-size:0.96rem;color:#241408;line-height:1.75;">
      "${text}"
    </div>

    ${action ? `<div style="background:#F0F5EA;border-left:2.5px solid #506840;padding:10px 14px;margin-bottom:16px;font-size:0.85rem;color:#4A2C10;">
      <span style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.06em;color:#A88060;display:block;margin-bottom:4px;">My move</span>
      ${action}
    </div>` : ''}

    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <tr>
        <td style="padding:8px;background:#FAF5EC;font-size:0.75rem;color:#A88060;">Declared by</td>
        <td style="padding:8px;background:#FAF5EC;font-size:0.82rem;color:#241408;">${displayName}</td>
      </tr>
      <tr>
        <td style="padding:8px;font-size:0.75rem;color:#A88060;">Category</td>
        <td style="padding:8px;font-size:0.82rem;color:#241408;">${category}</td>
      </tr>
      <tr>
        <td style="padding:8px;background:#FAF5EC;font-size:0.75rem;color:#A88060;">Stage</td>
        <td style="padding:8px;background:#FAF5EC;font-size:0.82rem;color:#241408;">${stage?.icon || ''} ${stage?.name || 'Voice'}</td>
      </tr>
      <tr>
        <td style="padding:8px;font-size:0.75rem;color:#A88060;">Timestamp (UTC)</td>
        <td style="padding:8px;font-family:monospace;font-size:0.75rem;color:#241408;">${timestamp}</td>
      </tr>
      <tr>
        <td style="padding:8px;background:#FAF5EC;font-size:0.75rem;color:#A88060;">Declaration ID</td>
        <td style="padding:8px;font-family:monospace;font-size:0.75rem;color:#241408;">${id}</td>
      </tr>
    </table>

    <div style="background:#FAF5EC;padding:12px 14px;border-radius:8px;margin-bottom:16px;">
      <span style="font-size:0.67rem;text-transform:uppercase;letter-spacing:0.06em;color:#A88060;display:block;margin-bottom:6px;">SHA-256 Hash — your digital fingerprint</span>
      <span style="font-family:monospace;font-size:0.68rem;color:#7A5530;word-break:break-all;line-height:1.6;">${hash}</span>
    </div>

    <p style="font-size:0.75rem;color:#A88060;font-style:italic;line-height:1.6;margin:0 0 20px;">
      Keep this hash. If anyone ever claims your idea as theirs — this timestamp and this hash, independently verifiable — proves it came from you first.
    </p>

    <a href="https://dotheneeds.com#voices" style="display:block;background:#B85C38;color:white;text-align:center;padding:12px;border-radius:10px;text-decoration:none;font-family:serif;font-size:0.95rem;">
      See all voices on the wall →
    </a>
  </div>
  <div style="background:#F3E9D5;padding:14px 24px;border-radius:0 0 10px 10px;text-align:center;">
    <p style="font-size:0.7rem;color:#A88060;margin:0;">DoTheNeeds · EXADreams LLC · dotheneeds.com</p>
    <p style="font-size:0.68rem;color:#A88060;margin:4px 0 0;">No advertising. No data selling. Your declaration is yours, forever.</p>
    <p style="font-size:0.68rem;color:#A88060;margin:4px 0 0;"><a href="https://dotheneeds.com/unsubscribe?id=${id}" style="color:#B85C38;">Unsubscribe from notifications</a></p>
  </div>
</body>
</html>`,
    }),
  });
}
