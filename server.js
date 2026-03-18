const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  AXIOM OS — CENTRALIZED CONTROL SERVER v1.0.0
// ─────────────────────────────────────────────

app.use(express.json({ limit: '100kb' }));

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || origin.endsWith('.vercel.app') || origin.includes('localhost')) {
      return callback(null, true);
    }
    const allowed = process.env.FRONTEND_URL;
    if (allowed && origin.startsWith(allowed)) return callback(null, true);
    callback(new Error('Not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-ID', 'X-Admin-Key']
}));

const aiLimiter = rateLimit({ windowMs: 60000, max: 60 });
const adminLimiter = rateLimit({ windowMs: 60000, max: 30 });

// Admin auth
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Platform version
const PLATFORM_VERSION = {
  version: '1.0.0',
  releaseDate: '2026-03-17',
  releaseNotes: 'Initial production release',
  minClientVersion: '1.0.0'
};

// Client registry (in-memory — upgrade to Supabase later)
const clientRegistry = {};

const DEFAULT_CONFIG = {
  productName: 'Axiom OS',
  logoInitials: 'AX',
  accentColor: '#0078ff',
  plan: 'growth',
  modules: {
    chat:true,strategy:true,calls:true,emails:true,invoices:true,
    content:true,coldcall:true,setup:true,reach:true,intel:true,n8n:true,
    contractor:true,realEstate:true,insurance:true,photo:true,food:true
  },
  aiModels: { fast:'claude-haiku-4-5-20251001', smart:'claude-sonnet-4-6' },
  limits: { aiCallsPerDay:100, maxInvoices:999 },
  rolloutGroup: 'stable',
  active: true
};

function getConfig(clientId) {
  const override = clientRegistry[clientId] || {};
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (override.modules) Object.assign(merged.modules, override.modules);
  if (override.limits) Object.assign(merged.limits, override.limits);
  ['productName','logoInitials','accentColor','plan','rolloutGroup','active','backendUrl'].forEach(k => {
    if (override[k] !== undefined) merged[k] = override[k];
  });
  return merged;
}

// ── Health ────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'Axiom OS Control Server — Online',
  version: PLATFORM_VERSION.version,
  clients: Object.keys(clientRegistry).length,
  timestamp: new Date().toISOString()
}));

app.get('/health', (req, res) => res.json({ ok: true, version: PLATFORM_VERSION.version }));

// ── Client Config ─────────────────────────────
app.get('/api/config/:clientId', (req, res) => {
  const { clientId } = req.params;
  if (!clientRegistry[clientId]) clientRegistry[clientId] = { firstSeen: new Date().toISOString() };
  clientRegistry[clientId].lastSeen = new Date().toISOString();
  res.json({
    config: getConfig(clientId),
    platform: PLATFORM_VERSION,
    serverTime: new Date().toISOString()
  });
});

// ── AI Proxy ──────────────────────────────────
app.post('/api/ai', aiLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });

  const { messages, system, model = 'claude-haiku-4-5-20251001', max_tokens = 1000 } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

  try {
    const body = { model, max_tokens, messages };
    if (system) body.system = system;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'AI failed' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Email (Resend) ────────────────────────────
app.post('/api/email/send', aiLimiter, async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Email not configured', demo: true });
  const { to, subject, body, fromName } = req.body;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
      body:JSON.stringify({ from:`${fromName||'Axiom OS'} <noreply@resend.dev>`, to:[to], subject, text:body })
    });
    const d = await r.json();
    res.json({ success:true, id:d.id });
  } catch(e) { res.status(500).json({ error:'Email failed' }); }
});

// ── SMS (Telnyx) ──────────────────────────────
app.post('/api/sms/send', aiLimiter, async (req, res) => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'SMS not configured', demo: true });
  const { to, message } = req.body;
  try {
    await fetch('https://api.telnyx.com/v2/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
      body:JSON.stringify({ from:process.env.TELNYX_NUMBER, to, text:message })
    });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'SMS failed' }); }
});

// ── Stripe Payment Link ───────────────────────
app.post('/api/invoice/payment-link', async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Payments not configured', demo: true });
  const { amount, clientEmail, description, invoiceId } = req.body;
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${stripeKey}`, 'Content-Type':'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'payment_method_types[]':'card',
        'line_items[0][price_data][currency]':'usd',
        'line_items[0][price_data][product_data][name]':description||'Invoice',
        'line_items[0][price_data][unit_amount]':Math.round(amount*100),
        'line_items[0][quantity]':'1',
        'mode':'payment',
        'customer_email':clientEmail||'',
        'success_url':`${process.env.FRONTEND_URL||'https://project-3zt9m.vercel.app'}?paid=1`,
        'cancel_url':`${process.env.FRONTEND_URL||'https://project-3zt9m.vercel.app'}?cancelled=1`
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error:d.error?.message });
    res.json({ url:d.url });
  } catch(e) { res.status(500).json({ error:'Payment failed' }); }
});

// ═══════════════════════════════════════════════
//  ADMIN ROUTES — PROTECTED BY ADMIN_SECRET_KEY
// ═══════════════════════════════════════════════

app.get('/admin/stats', adminLimiter, adminAuth, (req, res) => {
  const clients = Object.entries(clientRegistry);
  res.json({
    totalClients: clients.length,
    activeClients: clients.filter(([,c])=>c.active!==false).length,
    platformVersion: PLATFORM_VERSION.version,
    byGroup: clients.reduce((a,[,c])=>{ const g=c.rolloutGroup||'stable'; a[g]=(a[g]||0)+1; return a; },{}),
    byPlan: clients.reduce((a,[,c])=>{ const p=c.plan||'growth'; a[p]=(a[p]||0)+1; return a; },{}),
    serverUptime: process.uptime()
  });
});

app.get('/admin/clients', adminLimiter, adminAuth, (req, res) => {
  res.json({ count:Object.keys(clientRegistry).length, clients:Object.entries(clientRegistry).map(([id,data])=>({ id,...getConfig(id),rawData:data })) });
});

app.get('/admin/client/:id', adminLimiter, adminAuth, (req, res) => {
  res.json({ id:req.params.id, config:getConfig(req.params.id), raw:clientRegistry[req.params.id]||{} });
});

app.post('/admin/client/:id', adminLimiter, adminAuth, (req, res) => {
  const { id } = req.params;
  if (!clientRegistry[id]) clientRegistry[id] = { createdAt:new Date().toISOString() };
  Object.assign(clientRegistry[id], req.body);
  clientRegistry[id].updatedAt = new Date().toISOString();
  res.json({ success:true, id, config:getConfig(id) });
});

app.post('/admin/client/:id/suspend', adminLimiter, adminAuth, (req, res) => {
  if (!clientRegistry[req.params.id]) clientRegistry[req.params.id]={};
  clientRegistry[req.params.id].active = false;
  res.json({ success:true });
});

app.post('/admin/client/:id/activate', adminLimiter, adminAuth, (req, res) => {
  if (!clientRegistry[req.params.id]) clientRegistry[req.params.id]={};
  clientRegistry[req.params.id].active = true;
  res.json({ success:true });
});

app.post('/admin/version', adminLimiter, adminAuth, (req, res) => {
  const { version, releaseNotes, minClientVersion } = req.body;
  if (version) PLATFORM_VERSION.version = version;
  if (releaseNotes) PLATFORM_VERSION.releaseNotes = releaseNotes;
  if (minClientVersion) PLATFORM_VERSION.minClientVersion = minClientVersion;
  res.json({ success:true, platform:PLATFORM_VERSION });
});

app.post('/admin/rollout', adminLimiter, adminAuth, (req, res) => {
  const { group, updates } = req.body;
  let updated = 0;
  Object.entries(clientRegistry).forEach(([id]) => {
    const config = getConfig(id);
    if (group==='all' || config.rolloutGroup===group || id===group) {
      Object.assign(clientRegistry[id], updates);
      updated++;
    }
  });
  res.json({ success:true, group, updated });
});

app.post('/admin/broadcast', adminLimiter, adminAuth, (req, res) => {
  const { message, type='info', expiresIn=3600 } = req.body;
  const broadcast = { id:Date.now(), message, type, expires:new Date(Date.now()+expiresIn*1000).toISOString() };
  Object.keys(clientRegistry).forEach(id => {
    if (!clientRegistry[id].broadcasts) clientRegistry[id].broadcasts=[];
    clientRegistry[id].broadcasts.push(broadcast);
  });
  res.json({ success:true, broadcast });
});

app.listen(PORT, () => {
  console.log(`Axiom OS Backend v${PLATFORM_VERSION.version} running on port ${PORT}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`ADMIN_SECRET_KEY: ${process.env.ADMIN_SECRET_KEY ? 'SET ✓' : 'NOT SET ✗'}`);
});
