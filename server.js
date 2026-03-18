require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  AXIOM OS — CENTRALIZED CONTROL SERVER
//  v1.0.0 — Built for Cory Hernandez
//  This server IS the control layer for all clients
// ─────────────────────────────────────────────

app.use(express.json({ limit: '100kb' }));

// CORS — allow all .vercel.app + configured frontend
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (
      !origin ||
      origin.endsWith('.vercel.app') ||
      origin.includes('localhost') ||
      (process.env.FRONTEND_URL && origin.startsWith(process.env.FRONTEND_URL))
    ) return callback(null, true);
    callback(new Error('Not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-ID', 'X-Admin-Key']
}));

// Rate limiting
const aiLimiter = rateLimit({ windowMs: 60000, max: 60 });
const adminLimiter = rateLimit({ windowMs: 60000, max: 30 });

// ─────────────────────────────────────────────
//  ADMIN AUTH MIDDLEWARE
//  Only you can hit admin routes
// ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden — admin only' });
  }
  next();
}

// ─────────────────────────────────────────────
//  IN-MEMORY CLIENT CONFIG STORE
//  In production, replace with Supabase
//  Format: clients[clientId] = { ...config }
// ─────────────────────────────────────────────

// Master platform version — YOU control this
const PLATFORM_VERSION = {
  version: '1.0.0',
  releaseDate: '2026-03-17',
  releaseNotes: 'Initial production release — dynamic data, all industry suites',
  minClientVersion: '1.0.0' // clients older than this get force-updated
};

// Default config all clients inherit
const DEFAULT_CLIENT_CONFIG = {
  // Branding
  productName: 'Axiom OS',
  logoInitials: 'AX',
  accentColor: '#0078ff',
  logoGradient: ['#1a7fff', '#0040cc'],

  // Plan tier: starter | growth | team | enterprise
  plan: 'growth',

  // Feature flags — which modules are enabled
  modules: {
    chat: true,
    strategy: true,
    calls: true,
    emails: true,
    invoices: true,
    content: true,
    coldcall: true,
    setup: true,
    reach: true,
    intel: true,
    n8n: true,
    // Industry suites — auto-detected from industry selection
    contractor: true,
    realEstate: true,
    insurance: true,
    photo: true,
    food: true,
  },

  // AI model allocation per plan
  aiModels: {
    fast: 'claude-haiku-4-5-20251001',
    smart: 'claude-sonnet-4-6',
    useSmartFor: ['strategy', 'cma', 'contracts'] // which features get the better model
  },

  // Usage limits per plan
  limits: {
    aiCallsPerDay: 100,
    maxInvoices: 999,
    maxContacts: 999,
    maxProjects: 999
  },

  // Rollout group for staged updates
  rolloutGroup: 'stable', // 'beta' | 'stable' | 'legacy'

  // Client version tracking
  clientVersion: '1.0.0',
  lastSeen: null,
  active: true,

  // Custom backend URL (for white-label clients with their own Railway)
  backendUrl: null
};

// Client registry — in production this lives in Supabase
// Key = clientId (short slug), Value = config object
const clientRegistry = {};

// Helper: get merged config (default + client overrides)
function getClientConfig(clientId) {
  const override = clientRegistry[clientId] || {};
  const merged = JSON.parse(JSON.stringify(DEFAULT_CLIENT_CONFIG));
  // Deep merge overrides
  if (override.modules) Object.assign(merged.modules, override.modules);
  if (override.limits) Object.assign(merged.limits, override.limits);
  if (override.aiModels) Object.assign(merged.aiModels, override.aiModels);
  // Shallow merge top-level
  const topLevel = ['productName','logoInitials','accentColor','logoGradient','plan','rolloutGroup','clientVersion','lastSeen','active','backendUrl'];
  topLevel.forEach(k => { if (override[k] !== undefined) merged[k] = override[k]; });
  return merged;
}

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ 
    status: 'Axiom OS Control Server — Online',
    version: PLATFORM_VERSION.version,
    clients: Object.keys(clientRegistry).length,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => res.json({ ok: true, version: PLATFORM_VERSION.version }));

// ─────────────────────────────────────────────
//  CLIENT CONFIG ENDPOINT
//  Clients call this on load to get their config
//  GET /api/config/:clientId
// ─────────────────────────────────────────────
app.get('/api/config/:clientId', (req, res) => {
  const { clientId } = req.params;

  // Register new client on first request
  if (!clientRegistry[clientId]) {
    clientRegistry[clientId] = { firstSeen: new Date().toISOString() };
    console.log(`New client registered: ${clientId}`);
  }

  // Update last seen
  clientRegistry[clientId].lastSeen = new Date().toISOString();

  const config = getClientConfig(clientId);

  // Check if client needs to update
  const needsUpdate = PLATFORM_VERSION.minClientVersion > (config.clientVersion || '0.0.0');

  res.json({
    config,
    platform: PLATFORM_VERSION,
    needsUpdate,
    serverTime: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────
//  AI PROXY
//  POST /api/ai
//  Body: { messages, system, model, max_tokens }
//  Header: X-Client-ID: clientId
// ─────────────────────────────────────────────
app.post('/api/ai', aiLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const clientId = req.headers['x-client-id'];
  
  // Check client is active
  if (clientId && clientRegistry[clientId]) {
    const config = getClientConfig(clientId);
    if (!config.active) return res.status(403).json({ error: 'Account suspended' });
  }

  const { messages, system, model, max_tokens = 1000 } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Determine model — use client config if available
  const clientConfig = clientId ? getClientConfig(clientId) : DEFAULT_CLIENT_CONFIG;
  const useModel = model || clientConfig.aiModels.fast;

  try {
    const body = { model: useModel, max_tokens, messages };
    if (system) body.system = system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'AI failed' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────
//  EMAIL SEND (Resend)
// ─────────────────────────────────────────────
app.post('/api/email/send', aiLimiter, async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Email not configured', demo: true });
  const { to, subject, body, fromName } = req.body;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ from: `${fromName||'Axiom OS'} <noreply@resend.dev>`, to:[to], subject, text:body })
    });
    const d = await r.json();
    res.json({ success: true, id: d.id });
  } catch (e) { res.status(500).json({ error: 'Email failed' }); }
});

// ─────────────────────────────────────────────
//  SMS SEND (Telnyx)
// ─────────────────────────────────────────────
app.post('/api/sms/send', aiLimiter, async (req, res) => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'SMS not configured', demo: true });
  const { to, message } = req.body;
  try {
    const r = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ from: process.env.TELNYX_NUMBER, to, text: message })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'SMS failed' }); }
});

// ─────────────────────────────────────────────
//  STRIPE PAYMENT LINK
// ─────────────────────────────────────────────
app.post('/api/invoice/payment-link', async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Payments not configured', demo: true });
  const { amount, clientEmail, description, invoiceId } = req.body;
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'payment_method_types[]': 'card',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': description||'Invoice Payment',
        'line_items[0][price_data][unit_amount]': Math.round(amount*100),
        'line_items[0][quantity]': '1',
        'mode': 'payment',
        'customer_email': clientEmail||'',
        'metadata[invoiceId]': invoiceId||'',
        'success_url': `${process.env.FRONTEND_URL||'https://axiom-os.vercel.app'}?paid=1`,
        'cancel_url': `${process.env.FRONTEND_URL||'https://axiom-os.vercel.app'}?cancelled=1`
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.error?.message });
    res.json({ url: d.url });
  } catch (e) { res.status(500).json({ error: 'Payment failed' }); }
});

// ═════════════════════════════════════════════
//  ADMIN ROUTES — ONLY YOU CAN ACCESS THESE
//  All require X-Admin-Key header
// ═════════════════════════════════════════════


// ─────────────────────────────────────────────
//  ADMIN PIN LOGIN
//  POST /admin/login
//  Body: { pin }
//  Header: X-Admin-Key (master key for server access)
//  Looks up PIN in Supabase team_members
//  Returns the member's role + permissions
// ─────────────────────────────────────────────
app.post('/admin/login', adminLimiter, adminAuth, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  const sb = getSupabase();
  if (!sb) {
    // No Supabase yet — use hardcoded fallback
    const hardcoded = {
      'CORY2026':   { name: 'Cory Hernandez',  role: 'architect', display_name: 'Cory',   permissions: { canDeleteClients: true,  canViewAdminKey: true,  canEditBilling: true,  canEditRoles: true  } },
      'TREBOR2026': { name: 'Trebor Acuna',     role: 'director',  display_name: 'Trebor', permissions: { canDeleteClients: false, canViewAdminKey: false, canEditBilling: false, canEditRoles: false } }
    };
    const member = hardcoded[pin.toUpperCase()];
    if (!member) return res.status(401).json({ error: 'Invalid PIN' });
    return res.json({ success: true, member });
  }

  try {
    // Look up PIN in Supabase
    const url = `${sb.url}/rest/v1/team_members?login_pin=eq.${pin.toUpperCase()}&active=eq.true&limit=1`;
    const r = await fetch(url, {
      headers: { 'apikey': sb.key, 'Authorization': `Bearer ${sb.key}` }
    });
    const data = await r.json();

    if (!data || data.length === 0) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const member = data[0];

    // Update last login
    await fetch(`${sb.url}/rest/v1/team_members?id=eq.${member.id}`, {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json',
        'apikey': sb.key, 
        'Authorization': `Bearer ${sb.key}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ last_login: new Date().toISOString() })
    });

    console.log(`Admin login: ${member.name} (${member.role}) at ${new Date().toISOString()}`);

    res.json({
      success: true,
      member: {
        name: member.name,
        display_name: member.display_name,
        role: member.role,
        email: member.email,
        permissions: member.permissions
      }
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /admin/clients — list all clients
app.get('/admin/clients', adminLimiter, adminAuth, (req, res) => {
  const list = Object.entries(clientRegistry).map(([id, data]) => ({
    id,
    ...getClientConfig(id),
    rawData: data
  }));
  res.json({ count: list.length, clients: list });
});

// GET /admin/client/:id — get one client
app.get('/admin/client/:id', adminLimiter, adminAuth, (req, res) => {
  const config = getClientConfig(req.params.id);
  res.json({ id: req.params.id, config, raw: clientRegistry[req.params.id] || {} });
});

// POST /admin/client/:id — create or update client config
app.post('/admin/client/:id', adminLimiter, adminAuth, (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  if (!clientRegistry[id]) clientRegistry[id] = { createdAt: new Date().toISOString() };
  
  // Merge updates
  Object.assign(clientRegistry[id], updates);
  clientRegistry[id].updatedAt = new Date().toISOString();
  
  console.log(`Admin updated client: ${id}`, Object.keys(updates));
  res.json({ success: true, id, config: getClientConfig(id) });
});

// DELETE /admin/client/:id/module/:module — disable a module for a client
app.delete('/admin/client/:id/module/:module', adminLimiter, adminAuth, (req, res) => {
  const { id, module } = req.params;
  if (!clientRegistry[id]) clientRegistry[id] = {};
  if (!clientRegistry[id].modules) clientRegistry[id].modules = {};
  clientRegistry[id].modules[module] = false;
  res.json({ success: true, message: `Module ${module} disabled for ${id}` });
});

// POST /admin/client/:id/suspend — suspend a client
app.post('/admin/client/:id/suspend', adminLimiter, adminAuth, (req, res) => {
  const { id } = req.params;
  if (!clientRegistry[id]) clientRegistry[id] = {};
  clientRegistry[id].active = false;
  clientRegistry[id].suspendedAt = new Date().toISOString();
  res.json({ success: true, message: `Client ${id} suspended` });
});

// POST /admin/client/:id/activate — reactivate a client
app.post('/admin/client/:id/activate', adminLimiter, adminAuth, (req, res) => {
  const { id } = req.params;
  if (!clientRegistry[id]) clientRegistry[id] = {};
  clientRegistry[id].active = true;
  delete clientRegistry[id].suspendedAt;
  res.json({ success: true, message: `Client ${id} activated` });
});

// POST /admin/version — update the platform version
app.post('/admin/version', adminLimiter, adminAuth, (req, res) => {
  const { version, releaseNotes, minClientVersion } = req.body;
  if (version) PLATFORM_VERSION.version = version;
  if (releaseNotes) PLATFORM_VERSION.releaseNotes = releaseNotes;
  if (minClientVersion) PLATFORM_VERSION.minClientVersion = minClientVersion;
  PLATFORM_VERSION.releaseDate = new Date().toISOString().split('T')[0];
  console.log(`Platform version updated to ${PLATFORM_VERSION.version}`);
  res.json({ success: true, platform: PLATFORM_VERSION });
});

// POST /admin/rollout — push config update to a rollout group
app.post('/admin/rollout', adminLimiter, adminAuth, (req, res) => {
  const { group, updates } = req.body;
  // group: 'all' | 'beta' | 'stable' | 'legacy' | specific clientId
  let updated = 0;
  
  Object.entries(clientRegistry).forEach(([id, data]) => {
    const config = getClientConfig(id);
    if (group === 'all' || config.rolloutGroup === group || id === group) {
      Object.assign(clientRegistry[id], updates);
      updated++;
    }
  });
  
  console.log(`Rollout to group "${group}": updated ${updated} clients`);
  res.json({ success: true, group, updated, updates });
});

// POST /admin/broadcast — send a message to all clients (shown in app)
app.post('/admin/broadcast', adminLimiter, adminAuth, (req, res) => {
  const { message, type = 'info', expiresIn = 3600 } = req.body;
  const broadcast = {
    id: Date.now(),
    message,
    type, // info | warning | update
    expires: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
  
  // Store broadcast in all active clients
  Object.keys(clientRegistry).forEach(id => {
    if (!clientRegistry[id].broadcasts) clientRegistry[id].broadcasts = [];
    clientRegistry[id].broadcasts.push(broadcast);
  });
  
  res.json({ success: true, broadcast });
});

// GET /admin/stats — platform-wide stats
app.get('/admin/stats', adminLimiter, adminAuth, (req, res) => {
  const clients = Object.entries(clientRegistry);
  const active = clients.filter(([,c]) => c.active !== false).length;
  const byGroup = {};
  const byPlan = {};
  
  clients.forEach(([id, data]) => {
    const config = getClientConfig(id);
    byGroup[config.rolloutGroup] = (byGroup[config.rolloutGroup] || 0) + 1;
    byPlan[config.plan] = (byPlan[config.plan] || 0) + 1;
  });
  
  res.json({
    totalClients: clients.length,
    activeClients: active,
    platformVersion: PLATFORM_VERSION.version,
    byGroup,
    byPlan,
    serverUptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`Axiom OS Control Server v${PLATFORM_VERSION.version} — port ${PORT}`);
  console.log(`Admin endpoint active — protect with ADMIN_SECRET_KEY env var`);
});

// ─────────────────────────────────────────────
//  SUPABASE DATA SYNC ENDPOINTS
//  These replace localStorage with cloud storage
//  The Railway backend is the only thing that touches Supabase
//  Frontend sends data here → Railway saves to Supabase
// ─────────────────────────────────────────────

// Lazy-load Supabase client only if keys are configured
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  // Simple fetch-based Supabase client (no SDK needed)
  return { url, key };
}

async function supabaseQuery(method, table, body, params = '') {
  const sb = getSupabase();
  if (!sb) return { error: 'Supabase not configured' };
  const url = `${sb.url}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': sb.key,
      'Authorization': `Bearer ${sb.key}`,
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  return data;
}

// ── Business Profile ──────────────────────────
// POST /api/data/business — save/update business profile
app.post('/api/data/business', async (req, res) => {
  const { clientId, ...bizData } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  try {
    const data = await supabaseQuery('POST', 'businesses',
      { client_id: clientId, ...bizData },
      '?on_conflict=client_id'
    );
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/data/business/:clientId
app.get('/api/data/business/:clientId', async (req, res) => {
  try {
    const data = await supabaseQuery('GET', 'businesses', null,
      `?client_id=eq.${req.params.clientId}&limit=1`
    );
    res.json({ success: true, data: Array.isArray(data) ? data[0] : data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Generic CRUD for all tables ───────────────
// GET  /api/data/:table/:clientId  — load all records
// POST /api/data/:table            — save a record
// DELETE /api/data/:table/:id      — delete a record

const ALLOWED_TABLES = ['calls','emails','invoices','contacts','projects','activity'];

// Load all records for a client
app.get('/api/data/:table/:clientId', async (req, res) => {
  const { table, clientId } = req.params;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });
  try {
    const data = await supabaseQuery('GET', table, null,
      `?client_id=eq.${clientId}&order=created_at.desc&limit=500`
    );
    res.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save/upsert a record
app.post('/api/data/:table', async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });
  const record = req.body;
  if (!record.client_id) return res.status(400).json({ error: 'client_id required' });
  try {
    const data = await supabaseQuery('POST', table,
      record,
      record.id ? `?id=eq.${record.id}` : ''
    );
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a record
app.patch('/api/data/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });
  try {
    const data = await supabaseQuery('PATCH', table, req.body, `?id=eq.${id}`);
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a record
app.delete('/api/data/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });
  try {
    await supabaseQuery('DELETE', table, null, `?id=eq.${id}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Supabase health check ─────────────────────
app.get('/api/data/health', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.json({ connected: false, message: 'Supabase not configured' });
  try {
    const data = await supabaseQuery('GET', 'businesses', null, '?limit=1');
    res.json({ connected: true, message: 'Supabase connected', tables: 'ok' });
  } catch (e) {
    res.json({ connected: false, message: e.message });
  }
});
