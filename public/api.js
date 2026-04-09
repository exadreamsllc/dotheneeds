/**
 * DoTheNeeds — Frontend API Client
 * public/api.js
 *
 * Drop-in replacement for localStorage data layer.
 * Reads from / writes to the Cloudflare Worker API.
 * Falls back to localStorage if API is unavailable (dev/offline).
 *
 * Include AFTER the main app script in index.html:
 *   <script src="api.js"></script>
 */

const DTN_API = (() => {

  // ── Config ──────────────────────────────────────────────
  // In production this is the same origin (dotheneeds.com/api/...)
  // In development, set DTN_API_BASE in the console or via an env file.
  const BASE = (typeof DTN_API_BASE !== 'undefined' ? DTN_API_BASE : '') || '';
  const CACHE_TTL = 60_000; // 1 minute client-side cache for lists
  const LS_CACHE  = 'dtn_api_cache_v1';
  const LS_POSTS  = 'dtn_posts_v1';        // legacy localStorage key

  // ── In-memory cache ─────────────────────────────────────
  const _cache = {};

  function cacheSet(key, data) {
    _cache[key] = { data, ts: Date.now() };
  }
  function cacheGet(key) {
    const hit = _cache[key];
    if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
    return null;
  }
  function cacheInvalidate() {
    Object.keys(_cache).forEach(k => delete _cache[k]);
  }

  // ── Generic fetch wrapper ────────────────────────────────
  async function apiFetch(path, options = {}) {
    const url = `${BASE}${path}`;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new APIError(body.error || `HTTP ${res.status}`, res.status);
    }
    return res.json();
  }

  class APIError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  // ── loadPosts ────────────────────────────────────────────
  // Replaces: loadPosts() in the HTML
  // Returns combined API data + any locally-stored fresh posts
  async function loadPosts({ category, filter, page = 1, limit = 100 } = {}) {
    const cacheKey = `posts:${category}:${filter}:${page}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;

    try {
      const params = new URLSearchParams();
      if (category) params.set('category', category);
      if (filter)   params.set('filter', filter);
      params.set('page', page);
      params.set('limit', limit);

      const data = await apiFetch(`/api/declarations?${params}`);
      const apiPosts = data.declarations || [];

      // Merge with any "fresh" posts stored locally (just submitted, not yet in API cache)
      const local = loadLocalFresh();
      const merged = mergePosts(apiPosts, local);

      cacheSet(cacheKey, merged);
      return merged;
    } catch (e) {
      console.warn('API unavailable, falling back to localStorage:', e.message);
      return loadLocalFallback();
    }
  }

  // ── savePost ─────────────────────────────────────────────
  // Replaces: savePost(post) in the HTML
  // Sends to API; stores locally as "fresh" for immediate display
  async function savePost(post) {
    try {
      const result = await apiFetch('/api/declarations', {
        method: 'POST',
        body:   JSON.stringify(post),
      });

      // Merge server response (real id, hash, category, stage) back into local copy
      const enriched = {
        ...post,
        id:        result.id        || post.id,
        hash:      result.hash      || post.hash,
        timestamp: result.timestamp || post.ts,
        category:  result.category  || post.category || post.cat,
        status:    result.status    || 'active',
        stage:     result.stage     || 'Voice',
      };

      storeLocalFresh(enriched);
      cacheInvalidate();
      return { success: true, ...result };
    } catch (e) {
      console.warn('API save failed, storing locally:', e.message);
      storeLocalLegacy(post);
      return { success: false, offline: true, id: post.id };
    }
  }

  // ── saveUpdate ───────────────────────────────────────────
  // Replaces: saveUpdate(id, txt) in the HTML
  async function saveUpdate(declarationId, text, matchFields = {}) {
    try {
      const result = await apiFetch('/api/updates', {
        method: 'POST',
        body:   JSON.stringify({
          declaration_id: declarationId,
          text,
          tnc_agreed: true,
          ...matchFields,
        }),
      });

      cacheInvalidate();
      return { success: true, ...result };
    } catch (e) {
      console.warn('Update API failed, storing locally:', e.message);
      saveLocalUpdate(declarationId, text);
      return { success: false, offline: true };
    }
  }

  // ── fetchMovements ───────────────────────────────────────
  async function fetchMovements(sort = 'voices') {
    const hit = cacheGet(`movements:${sort}`);
    if (hit) return hit;

    try {
      const data = await apiFetch(`/api/movements?sort=${sort}`);
      const movements = data.movements || [];
      cacheSet(`movements:${sort}`, movements);
      return movements;
    } catch (e) {
      console.warn('Movements API unavailable:', e.message);
      return buildLocalMovements();
    }
  }

  // ── search ───────────────────────────────────────────────
  async function search(query, limit = 24) {
    if (!query || query.length < 2) return [];
    try {
      const data = await apiFetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      return data.results || [];
    } catch (e) {
      return searchLocal(query);
    }
  }

  // ── fetchStats ───────────────────────────────────────────
  async function fetchStats() {
    const hit = cacheGet('stats');
    if (hit) return hit;
    try {
      const data = await apiFetch('/api/stats');
      cacheSet('stats', data);
      return data;
    } catch { return null; }
  }

  // ── LOCAL STORAGE HELPERS ────────────────────────────────
  const LS_FRESH = 'dtn_fresh_v1';

  function loadLocalFresh() {
    try { return JSON.parse(localStorage.getItem(LS_FRESH) || '[]'); }
    catch { return []; }
  }

  function storeLocalFresh(post) {
    try {
      const existing = loadLocalFresh();
      const updated  = [post, ...existing.filter(p => p.id !== post.id)].slice(0, 50);
      localStorage.setItem(LS_FRESH, JSON.stringify(updated));
    } catch {}
  }

  function storeLocalLegacy(post) {
    try {
      const existing = JSON.parse(localStorage.getItem(LS_POSTS) || '[]');
      existing.push(post);
      localStorage.setItem(LS_POSTS, JSON.stringify(existing));
    } catch {}
  }

  function loadLocalFallback() {
    // During development / offline: return localStorage posts
    try {
      const fresh  = loadLocalFresh();
      const legacy = JSON.parse(localStorage.getItem(LS_POSTS) || '[]');
      return mergePosts(legacy, fresh);
    } catch { return []; }
  }

  function saveLocalUpdate(id, text) {
    try {
      const fresh = loadLocalFresh();
      const post  = fresh.find(p => p.id === id);
      if (post) {
        if (!post.updates) post.updates = [];
        post.updates.push({ text, ts: new Date().toISOString() });
        localStorage.setItem(LS_FRESH, JSON.stringify(fresh));
      }
    } catch {}
  }

  function mergePosts(base, extras) {
    const seen = new Set(base.map(p => p.id));
    return [...base, ...extras.filter(p => !seen.has(p.id))];
  }

  function buildLocalMovements() {
    const posts  = loadLocalFallback();
    const cats   = {};
    posts.forEach(p => {
      const c = p.category || p.cat || 'Other';
      if (!cats[c]) cats[c] = { category: c, count: 0, doers: 0, posts: [] };
      cats[c].count++;
      cats[c].posts.push(p);
      if (['build','fund','organize','educate','volunteer'].includes(p.contributionType)) cats[c].doers++;
    });
    return Object.values(cats).sort((a, b) => b.count - a.count);
  }

  function searchLocal(q) {
    const ql = q.toLowerCase();
    return loadLocalFallback().filter(p =>
      (p.text  || '').toLowerCase().includes(ql) ||
      (p.action|| p.cm || p.contribution || '').toLowerCase().includes(ql) ||
      (p.category || '').toLowerCase().includes(ql) ||
      (p.location || p.loc || '').toLowerCase().includes(ql)
    );
  }

  // ── Public API ───────────────────────────────────────────
  return { loadPosts, savePost, saveUpdate, fetchMovements, search, fetchStats, APIError };

})();

// ── Override the global functions used in index.html ────────
// These are called by the app — now they delegate to the API client.

async function loadPosts() {
  return DTN_API.loadPosts({ limit: 200 });
}

async function savePost(post) {
  return DTN_API.savePost(post);
}

async function saveUpdate(id, text) {
  return DTN_API.saveUpdate(id, text);
}
