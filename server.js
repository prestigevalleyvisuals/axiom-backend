require('dotenv').config();
const express = require('express');
const cors = require('cors');
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch(e) { 
  // Fallback if express-rate-limit not installed
  rateLimit = () => (req, res, next) => next();
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100kb' }));

// CORS
app.use(cors({
  origin: function(origin, callback) {
    // Always allow:
    // - No origin (mobile apps, curl, local files)
    // - Vercel deployments
    // - Localhost (development)
    // - null origin (local HTML files opened from file://)
    // Admin routes are protected by X-Admin-Key regardless of origin
    if (!origin || origin === 'null') return callback(null, true);
    if (origin.endsWith('.vercel.app') || origin.includes('localhost') ||
      (process.env.FRONTEND_URL && origin.startsWith(process.env.FRONTEND_URL)))
      return callback(null, true);
    // Allow local file origins (file://)
    if (origin.startsWith('file://') || origin === 'null') return callback(null, true);
    // Allow all for now — admin key provides security
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-ID', 'X-Admin-Key', 'X-Session-Token']
}));

const aiLimiter    = rateLimit({ windowMs: 60000, max: 60 });
const adminLimiter = rateLimit({ windowMs: 60000, max: 30 });
const loginLimiter = rateLimit({ windowMs: 60000, max: 10 });

// ── Platform Version ──────────────────────────
const PLATFORM_VERSION = {
  version: '1.3.0',
  releaseDate: '2026-03-19',
  releaseNotes: 'Added email AI handling, live analytics cache, per-client integrations, call routing',
  minClientVersion: '1.0.0'
};

// ── Admin Auth ────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!key || key !== process.env.ADMIN_SECRET_KEY)
    return res.status(403).json({ error: 'Forbidden — admin only' });
  next();
}

// ── Supabase ──────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function sb(method, table, body, params = '') {
  const s = getSupabase();
  if (!s) return { error: 'Supabase not configured' };
  const res = await fetch(`${s.url}/rest/v1/${table}${params}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': s.key,
      'Authorization': `Bearer ${s.key}`,
      'Prefer': 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

// ── Client Config Store ───────────────────────
const clientRegistry = {};

const DEFAULT_CONFIG = {
  productName: 'Axiom OS', logoInitials: 'AX', accentColor: '#0078ff',
  plan: 'growth', active: true, rolloutGroup: 'stable', clientVersion: '1.0.0',
  modules: { chat:true,strategy:true,calls:true,emails:true,invoices:true,
    content:true,coldcall:true,setup:true,reach:true,intel:true,n8n:true,
    contractor:true,realEstate:true,insurance:true,photo:true,food:true }
};

function getConfig(clientId) {
  const o = clientRegistry[clientId] || {};
  const m = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (o.modules) Object.assign(m.modules, o.modules);
  ['productName','logoInitials','accentColor','plan','rolloutGroup','active','backendUrl']
    .forEach(k => { if (o[k] !== undefined) m[k] = o[k]; });
  return m;
}

// ═══════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════
app.get('/', (req, res) => res.json({
  status: 'Axiom OS Control Server — Online',
  version: PLATFORM_VERSION.version,
  clients: Object.keys(clientRegistry).length,
  timestamp: new Date().toISOString()
}));

app.get('/health', (req, res) => res.json({ 
  ok: true, 
  version: PLATFORM_VERSION.version,
  uptime: Math.floor(process.uptime()),
  timestamp: new Date().toISOString()
}));

// ═══════════════════════════════════════════════
//  CLIENT CONFIG
// ═══════════════════════════════════════════════
app.get('/api/config/:clientId', async (req, res) => {
  const { clientId } = req.params;
  if (!clientRegistry[clientId])
    clientRegistry[clientId] = { firstSeen: new Date().toISOString() };
  clientRegistry[clientId].lastSeen = new Date().toISOString();

  // Also check Supabase for billing status
  let billingOk = true;
  const s = getSupabase();
  if (s) {
    try {
      const r = await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}&limit=1`, {
        headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` }
      });
      const data = await r.json();
      if (data && data[0]) {
        const c = data[0];
        if (c.billing_status === 'suspended' || c.billing_status === 'cancelled')
          billingOk = false;
        // Auto-check if payment is overdue
        if (c.billing_anchor && c.billing_status === 'active' && !c.stripe_sub) {
          const anchor = new Date(c.billing_anchor);
          const today = new Date();
          const daysSinceAnchor = Math.floor((today - anchor) / 86400000);
          const monthsPassed = Math.floor(daysSinceAnchor / 30);
          const nextDue = new Date(anchor);
          nextDue.setMonth(nextDue.getMonth() + monthsPassed + 1);
          const daysOverdue = Math.floor((today - nextDue) / 86400000);
          if (daysOverdue > (c.grace_period_days || 3)) {
            // Auto suspend
            await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
              method: 'PATCH',
              headers: { 'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal' },
              body: JSON.stringify({ billing_status:'suspended', suspended_reason:'Auto-suspended: payment overdue', updated_at: new Date().toISOString() })
            });
            billingOk = false;
          }
        }
      }
    } catch(e) {}
  }

  if (!billingOk)
    return res.status(402).json({ error: 'Account suspended', suspended: true, message: 'Contact your provider to reactivate.' });

  res.json({
    config: getConfig(clientId),
    platform: PLATFORM_VERSION,
    serverTime: new Date().toISOString()
  });
});

// ═══════════════════════════════════════════════
//  CUSTOMER LOGIN (Email + Code)
// ═══════════════════════════════════════════════

// Step 1: Request login code
app.post('/api/customer/login/request', loginLimiter, async (req, res) => {
  const { email, clientId } = req.body;
  if (!email || !clientId) return res.status(400).json({ error: 'Email and clientId required' });

  const s = getSupabase();
  if (!s) return res.status(503).json({ error: 'Database not connected' });

  try {
    // Find customer by email and clientId
    const r = await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}&login_email=eq.${encodeURIComponent(email)}&limit=1`, {
      headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` }
    });
    const data = await r.json();

    if (!data || data.length === 0)
      return res.status(404).json({ error: 'No account found with that email' });

    const customer = data[0];
    if (customer.billing_status === 'suspended')
      return res.status(402).json({ error: 'Account suspended. Contact your provider.' });

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60000).toISOString(); // 10 min

    // Save code to database
    await fetch(`${s.url}/rest/v1/customers?id=eq.${customer.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal' },
      body: JSON.stringify({ login_code: code, login_code_expires: expires })
    });

    // Send code via Resend if configured
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','Authorization':`Bearer ${resendKey}` },
        body: JSON.stringify({
          from: 'Axiom OS <noreply@resend.dev>',
          to: [email],
          subject: 'Your Axiom OS Login Code',
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:30px;background:#000;color:#fff;border-radius:12px;">
            <h2 style="color:#0078ff;margin-bottom:8px;">⬡ Axiom OS</h2>
            <p style="color:#aaa;margin-bottom:20px;">Your login code:</p>
            <div style="font-size:40px;font-weight:700;letter-spacing:.3em;color:#fff;padding:20px;background:#0d1520;border-radius:8px;text-align:center;">${code}</div>
            <p style="color:#666;font-size:12px;margin-top:16px;">Expires in 10 minutes. Don't share this code.</p>
          </div>`
        })
      });
    }

    console.log(`Login code for ${email}: ${code}`); // Shows in Railway logs
    res.json({ success: true, message: 'Code sent to your email', hint: resendKey ? null : code }); // hint only shown if no email configured
  } catch(e) {
    res.status(500).json({ error: 'Login request failed' });
  }
});

// Step 2: Verify code and create session
app.post('/api/customer/login/verify', loginLimiter, async (req, res) => {
  const { email, clientId, code } = req.body;
  if (!email || !clientId || !code) return res.status(400).json({ error: 'Email, clientId, and code required' });

  const s = getSupabase();
  if (!s) return res.status(503).json({ error: 'Database not connected' });

  try {
    const r = await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}&login_email=eq.${encodeURIComponent(email)}&limit=1`, {
      headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` }
    });
    const data = await r.json();
    if (!data || data.length === 0) return res.status(404).json({ error: 'Account not found' });

    const customer = data[0];

    // Check code and expiry
    if (customer.login_code !== code)
      return res.status(401).json({ error: 'Invalid code' });
    if (new Date() > new Date(customer.login_code_expires))
      return res.status(401).json({ error: 'Code expired — request a new one' });

    // Create 30-day session token
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await fetch(`${s.url}/rest/v1/customers?id=eq.${customer.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal' },
      body: JSON.stringify({ session_token: sessionToken, session_expires: sessionExpires, login_code: null, last_login: new Date().toISOString(), login_verified: true })
    });

    res.json({ success: true, sessionToken, expires: sessionExpires, customer: {
      name: customer.owner_name, business: customer.business_name,
      plan: customer.plan, monthlyPrice: customer.monthly_price
    }});
  } catch(e) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Step 3: Validate session (called on each app load)
app.post('/api/customer/session/validate', async (req, res) => {
  const { clientId, sessionToken } = req.body;
  if (!clientId || !sessionToken) return res.status(400).json({ valid: false });

  const s = getSupabase();
  if (!s) return res.json({ valid: true }); // fail open if no DB

  try {
    const r = await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}&session_token=eq.${sessionToken}&limit=1`, {
      headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` }
    });
    const data = await r.json();
    if (!data || data.length === 0) return res.json({ valid: false });

    const c = data[0];
    if (new Date() > new Date(c.session_expires)) return res.json({ valid: false, reason: 'expired' });
    if (c.billing_status === 'suspended') return res.json({ valid: false, reason: 'suspended' });

    res.json({ valid: true, customer: { name: c.owner_name, business: c.business_name, plan: c.plan }});
  } catch(e) {
    res.json({ valid: true }); // fail open
  }
});

// ═══════════════════════════════════════════════
//  AI PROXY
// ═══════════════════════════════════════════════
app.post('/api/ai', aiLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { messages, system, model, max_tokens = 1000 } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages array required' });

  const clientId = req.headers['x-client-id'];
  const clientConfig = clientId ? getConfig(clientId) : DEFAULT_CONFIG;
  const useModel = model || clientConfig.modules ? 'claude-haiku-4-5-20251001' : 'claude-haiku-4-5-20251001';

  try {
    const body = { model: useModel, max_tokens, messages };
    if (system) body.system = system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message });
    res.json(data);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ═══════════════════════════════════════════════
//  EMAIL & SMS
// ═══════════════════════════════════════════════
app.post('/api/email/send', aiLimiter, async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Email not configured', demo: true });
  const { to, subject, body, fromName } = req.body;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','Authorization':`Bearer ${apiKey}` },
      body: JSON.stringify({ from:`${fromName||'Axiom OS'} <noreply@resend.dev>`, to:[to], subject, text:body })
    });
    res.json({ success: true, id: (await r.json()).id });
  } catch(e) { res.status(500).json({ error: 'Email failed' }); }
});

app.post('/api/sms/send', aiLimiter, async (req, res) => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'SMS not configured', demo: true });
  const { to, message } = req.body;
  try {
    await fetch('https://api.telnyx.com/v2/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
      body: JSON.stringify({ from: process.env.TELNYX_NUMBER, to, text: message })
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'SMS failed' }); }
});

// ═══════════════════════════════════════════════
//  STRIPE — FLEXIBLE PAYMENT LINKS
// ═══════════════════════════════════════════════
app.post('/api/invoice/payment-link', async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Payments not configured', demo: true });
  const { amount, clientEmail, description, invoiceId } = req.body;
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:'POST',
      headers:{'Authorization':`Bearer ${stripeKey}`,'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        'payment_method_types[]':'card',
        'line_items[0][price_data][currency]':'usd',
        'line_items[0][price_data][product_data][name]': description||'Invoice Payment',
        'line_items[0][price_data][unit_amount]': Math.round(amount*100),
        'line_items[0][quantity]':'1',
        'mode':'payment',
        'customer_email': clientEmail||'',
        'metadata[invoiceId]': invoiceId||'',
        'success_url':`${process.env.FRONTEND_URL||'https://axiomhq.vercel.app'}?paid=1`,
        'cancel_url':`${process.env.FRONTEND_URL||'https://axiomhq.vercel.app'}?cancelled=1`
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.error?.message });
    res.json({ url: d.url });
  } catch(e) { res.status(500).json({ error: 'Payment link failed' }); }
});

// Generate setup fee payment link for a customer
app.post('/admin/customer/:clientId/setup-link', adminLimiter, adminAuth, async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const { clientId } = req.params;
  const { amount, email, businessName, setupPrice } = req.body;

  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured', demo: true, message: 'Add STRIPE_SECRET_KEY to Railway Variables' });

  const price = setupPrice || amount || 0;
  if (!price || price <= 0) return res.status(400).json({ error: 'Setup price required' });

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:'POST',
      headers:{'Authorization':`Bearer ${stripeKey}`,'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        'payment_method_types[]':'card',
        'line_items[0][price_data][currency]':'usd',
        'line_items[0][price_data][product_data][name]': `Axiom OS Setup — ${businessName||clientId}`,
        'line_items[0][price_data][product_data][description]': 'One-time setup & onboarding fee',
        'line_items[0][price_data][unit_amount]': Math.round(price*100),
        'line_items[0][quantity]':'1',
        'mode':'payment',
        'customer_email': email||'',
        'metadata[clientId]': clientId,
        'metadata[type]': 'setup_fee',
        'success_url':`${process.env.FRONTEND_URL||'https://axiomhq.vercel.app'}?client=${clientId}&setup_paid=1`,
        'cancel_url':`${process.env.FRONTEND_URL||'https://axiomhq.vercel.app'}?client=${clientId}`
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.error?.message });

    // Save link to Supabase
    const s = getSupabase();
    if (s) {
      await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
        body: JSON.stringify({ stripe_setup_link: d.url })
      });
    }

    res.json({ success: true, url: d.url, amount: price });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Generate monthly subscription link
app.post('/admin/customer/:clientId/subscription-link', adminLimiter, adminAuth, async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const { clientId } = req.params;
  const { monthlyPrice, email, businessName } = req.body;

  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured', demo: true });

  try {
    // Create a recurring price and subscription checkout
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:'POST',
      headers:{'Authorization':`Bearer ${stripeKey}`,'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        'payment_method_types[]':'card',
        'line_items[0][price_data][currency]':'usd',
        'line_items[0][price_data][product_data][name]': `Axiom OS — ${businessName||clientId}`,
        'line_items[0][price_data][product_data][description]': 'Monthly subscription',
        'line_items[0][price_data][unit_amount]': Math.round(monthlyPrice*100),
        'line_items[0][price_data][recurring][interval]': 'month',
        'line_items[0][quantity]':'1',
        'mode':'subscription',
        'customer_email': email||'',
        'metadata[clientId]': clientId,
        'metadata[type]': 'monthly_sub',
        'success_url':`${process.env.FRONTEND_URL||'https://axiomhq.vercel.app'}?client=${clientId}&subscribed=1`,
        'cancel_url':`${process.env.FRONTEND_URL||'https://axiomhq.vercel.app'}?client=${clientId}`
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.error?.message });

    // Save to Supabase + activate account + set billing anchor
    const s = getSupabase();
    if (s) {
      await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
        body: JSON.stringify({
          stripe_sub_link: d.url, monthly_price: monthlyPrice,
          billing_anchor: new Date().toISOString().split('T')[0],
          billing_day: new Date().getDate()
        })
      });
    }

    res.json({ success: true, url: d.url, monthlyPrice });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
//  STRIPE WEBHOOKS — Auto billing events
// ═══════════════════════════════════════════════
app.post('/webhooks/stripe', express.raw({type:'application/json'}), async (req, res) => {
  const payload = req.body;
  let event;
  try { event = JSON.parse(payload); }
  catch(e) { return res.status(400).json({ error: 'Invalid payload' }); }

  const s = getSupabase();
  const clientId = event.data?.object?.metadata?.clientId;
  const amount = (event.data?.object?.amount_total || event.data?.object?.amount || 0) / 100;
  const email = event.data?.object?.customer_email || event.data?.object?.customer_details?.email;
  const type = event.data?.object?.metadata?.type;

  console.log(`Stripe event: ${event.type} | client: ${clientId} | $${amount}`);

  if (s && clientId) {
    // Log the event
    await fetch(`${s.url}/rest/v1/stripe_events`, {
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
      body: JSON.stringify({
        stripe_event_id: event.id, event_type: event.type,
        client_id: clientId, customer_email: email,
        amount, status: 'processed',
        raw_payload: event
      })
    });

    // Handle specific events
    if (event.type === 'checkout.session.completed') {
      if (type === 'setup_fee') {
        // Setup paid — mark setup as paid
        await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
          method:'PATCH',
          headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
          body: JSON.stringify({ setup_paid: true, updated_at: new Date().toISOString() })
        });
      } else if (type === 'monthly_sub') {
        // Subscription started — activate account
        await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
          method:'PATCH',
          headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
          body: JSON.stringify({
            billing_status: 'active',
            stripe_sub: event.data?.object?.subscription,
            billing_anchor: new Date().toISOString().split('T')[0],
            billing_day: new Date().getDate(),
            updated_at: new Date().toISOString()
          })
        });
      }
    }

    if (event.type === 'invoice.paid') {
      // Monthly payment received — keep active
      await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
        body: JSON.stringify({ billing_status:'active', payment_failed_at: null, updated_at: new Date().toISOString() })
      });
    }

    if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
      // Payment failed or cancelled — suspend
      await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
        body: JSON.stringify({
          billing_status: 'suspended',
          payment_failed_at: new Date().toISOString(),
          suspended_reason: event.type === 'invoice.payment_failed' ? 'Payment failed' : 'Subscription cancelled',
          updated_at: new Date().toISOString()
        })
      });
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════
//  DATA SYNC (Supabase CRUD)
// ═══════════════════════════════════════════════
const ALLOWED_TABLES = ['calls','emails','invoices','contacts','projects','activity','customers','payments'];

app.get('/api/data/health', async (req, res) => {
  const s = getSupabase();
  if (!s) return res.json({ connected: false });
  try {
    await sb('GET', 'businesses', null, '?limit=1');
    res.json({ connected: true });
  } catch(e) { res.json({ connected: false }); }
});

app.get('/api/data/:table/:clientId', async (req, res) => {
  const { table, clientId } = req.params;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });
  try {
    const data = await sb('GET', table, null, `?client_id=eq.${clientId}&order=created_at.desc&limit=500`);
    res.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:table', async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });
  const record = req.body;
  if (!record.client_id) return res.status(400).json({ error: 'client_id required' });
  try {
    const data = await sb('POST', table, record, record.id ? `?id=eq.${record.id}` : '');
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/data/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });
  try {
    const data = await sb('PATCH', table, req.body, `?id=eq.${id}`);
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/data/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });
  try {
    await sb('DELETE', table, null, `?id=eq.${id}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/business', async (req, res) => {
  const { clientId, ...bizData } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  try {
    const data = await sb('POST', 'businesses', { client_id: clientId, ...bizData }, '?on_conflict=client_id');
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/business/:clientId', async (req, res) => {
  try {
    const data = await sb('GET', 'businesses', null, `?client_id=eq.${req.params.clientId}&limit=1`);
    res.json({ success: true, data: Array.isArray(data) ? data[0] : data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
//  ADMIN PIN LOGIN
// ═══════════════════════════════════════════════
app.post('/admin/login', adminLimiter, adminAuth, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  const s = getSupabase();
  if (!s) {
    const hardcoded = {
      'CORY2026':   { name:'Cory Hernandez', role:'architect', display_name:'Cory', permissions:{canDeleteClients:true,canViewAdminKey:true,canEditBilling:true,canEditRoles:true}},
      'TREBOR2026': { name:'Trebor Acuna',   role:'director',  display_name:'Trebor',permissions:{canDeleteClients:false,canViewAdminKey:false,canEditBilling:false,canEditRoles:false}}
    };
    const member = hardcoded[pin.toUpperCase()];
    if (!member) return res.status(401).json({ error: 'Invalid PIN' });
    return res.json({ success: true, member });
  }

  try {
    const verifyUrl = `${s.url}/rest/v1/rpc/verify_admin_pin`;
    const r = await fetch(verifyUrl, {
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`},
      body: JSON.stringify({ input_pin: pin })
    });
    const member = await r.json();
    if (!member || (Array.isArray(member) && member.length === 0) || member.error)
      return res.status(401).json({ error: 'Invalid PIN' });

    const memberData = Array.isArray(member) ? member[0] : member;

    await fetch(`${s.url}/rest/v1/team_members?id=eq.${memberData.id}`, {
      method:'PATCH',
      headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
      body: JSON.stringify({ last_login: new Date().toISOString() })
    });

    console.log(`Admin login: ${memberData.name} (${memberData.role})`);
    res.json({ success:true, member:{ name:memberData.name, display_name:memberData.display_name, role:memberData.role, email:memberData.email, permissions:memberData.permissions }});
  } catch(e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ═══════════════════════════════════════════════
//  ADMIN — CLIENT MANAGEMENT
// ═══════════════════════════════════════════════
app.get('/admin/stats', adminLimiter, adminAuth, async (req, res) => {
  const clients = Object.entries(clientRegistry);
  const byGroup = {}, byPlan = {};
  clients.forEach(([id]) => {
    const c = getConfig(id);
    byGroup[c.rolloutGroup] = (byGroup[c.rolloutGroup]||0)+1;
    byPlan[c.plan] = (byPlan[c.plan]||0)+1;
  });

  // Get live customer stats from Supabase
  let customerStats = { total:0, active:0, trial:0, mrr:0 };
  const s = getSupabase();
  if (s) {
    try {
      const r = await fetch(`${s.url}/rest/v1/customers?select=billing_status,monthly_price`, {
        headers:{'apikey':s.key,'Authorization':`Bearer ${s.key}`}
      });
      const data = await r.json();
      if (Array.isArray(data)) {
        customerStats.total = data.length;
        customerStats.active = data.filter(c=>c.billing_status==='active').length;
        customerStats.trial = data.filter(c=>c.billing_status==='trial').length;
        customerStats.mrr = data.filter(c=>c.billing_status==='active').reduce((s,c)=>s+(c.monthly_price||0),0);
      }
    } catch(e){}
  }

  res.json({
    totalClients: clients.length, activeClients: clients.filter(([,c])=>c.active!==false).length,
    platformVersion: PLATFORM_VERSION.version, byGroup, byPlan,
    serverUptime: process.uptime(), customers: customerStats
  });
});

app.get('/admin/clients', adminLimiter, adminAuth, (req, res) => {
  const list = Object.entries(clientRegistry).map(([id,data]) => ({ id, ...getConfig(id), rawData:data }));
  res.json({ count:list.length, clients:list });
});

app.get('/admin/client/:id', adminLimiter, adminAuth, (req, res) =>
  res.json({ id:req.params.id, config:getConfig(req.params.id), raw:clientRegistry[req.params.id]||{} }));

app.post('/admin/client/:id', adminLimiter, adminAuth, (req, res) => {
  const { id } = req.params;
  if (!clientRegistry[id]) clientRegistry[id] = { createdAt:new Date().toISOString() };
  Object.assign(clientRegistry[id], req.body);
  clientRegistry[id].updatedAt = new Date().toISOString();
  res.json({ success:true, id, config:getConfig(id) });
});

app.post('/admin/client/:id/suspend', adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  const s = getSupabase();
  if (s) await fetch(`${s.url}/rest/v1/customers?client_id=eq.${id}`, {
    method:'PATCH', headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
    body: JSON.stringify({ billing_status:'suspended', suspended_reason:'Manually suspended by admin', updated_at:new Date().toISOString() })
  });
  if (!clientRegistry[id]) clientRegistry[id] = {};
  clientRegistry[id].active = false;
  res.json({ success:true, message:`${id} suspended` });
});

app.post('/admin/client/:id/activate', adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  const s = getSupabase();
  if (s) await fetch(`${s.url}/rest/v1/customers?client_id=eq.${id}`, {
    method:'PATCH', headers:{'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal'},
    body: JSON.stringify({ billing_status:'active', suspended_reason:null, updated_at:new Date().toISOString() })
  });
  if (!clientRegistry[id]) clientRegistry[id] = {};
  clientRegistry[id].active = true;
  res.json({ success:true, message:`${id} activated` });
});

// Delete all customer data (GDPR/legal compliance)
app.delete('/admin/client/:id/data', adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  const s = getSupabase();
  if (s) {
    const tables = ['calls','emails','invoices','contacts','projects','activity','businesses'];
    for (const table of tables) {
      await fetch(`${s.url}/rest/v1/${table}?client_id=eq.${id}`, {
        method:'DELETE', headers:{'apikey':s.key,'Authorization':`Bearer ${s.key}`}
      });
    }
    await fetch(`${s.url}/rest/v1/customers?client_id=eq.${id}`, {
      method:'DELETE', headers:{'apikey':s.key,'Authorization':`Bearer ${s.key}`}
    });
  }
  delete clientRegistry[id];
  res.json({ success:true, message:`All data for ${id} permanently deleted` });
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
    const c = getConfig(id);
    if (group==='all' || c.rolloutGroup===group || id===group) {
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
    if (!clientRegistry[id].broadcasts) clientRegistry[id].broadcasts = [];
    clientRegistry[id].broadcasts.push(broadcast);
  });
  res.json({ success:true, broadcast });
});

// Get all customers with full billing details (for admin panel)
app.get('/admin/customers', adminLimiter, adminAuth, async (req, res) => {
  const s = getSupabase();
  if (!s) return res.json({ customers: [] });
  try {
    const r = await fetch(`${s.url}/rest/v1/customers?order=created_at.desc`, {
      headers:{'apikey':s.key,'Authorization':`Bearer ${s.key}`}
    });
    const data = await r.json();
    res.json({ customers: Array.isArray(data) ? data : [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save/update customer record
app.post('/admin/customers', adminLimiter, adminAuth, async (req, res) => {
  const s = getSupabase();
  if (!s) return res.status(503).json({ error: 'Database not connected' });
  try {
    const data = await sb('POST', 'customers', req.body, '?on_conflict=client_id');
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get payment history for a customer
app.get('/admin/customers/:clientId/payments', adminLimiter, adminAuth, async (req, res) => {
  const s = getSupabase();
  if (!s) return res.json({ payments: [] });
  try {
    const r = await fetch(`${s.url}/rest/v1/stripe_events?client_id=eq.${req.params.clientId}&order=processed_at.desc`, {
      headers:{'apikey':s.key,'Authorization':`Bearer ${s.key}`}
    });
    res.json({ payments: await r.json() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Customer cancellation request ────────────
app.post('/api/customer/cancel', async (req, res) => {
  const { clientId, reason } = req.body;
  const sessionToken = req.headers['x-session-token'];
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const s = getSupabase();
  if (s) {
    try {
      // Log cancellation request
      await fetch(`${s.url}/rest/v1/cancellation_requests`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal' },
        body: JSON.stringify({ client_id: clientId, reason: reason || 'Customer requested', confirmed: true })
      });
      // Update customer billing status to 'cancelled'
      await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type':'application/json','apikey':s.key,'Authorization':`Bearer ${s.key}`,'Prefer':'return=minimal' },
        body: JSON.stringify({ billing_status: 'cancelled', updated_at: new Date().toISOString() })
      });
      console.log(`Cancellation submitted: ${clientId}`);
    } catch(e) { console.error('Cancel error:', e); }
  }
  res.json({ success: true, message: 'Cancellation recorded. Account active until billing period ends.' });
});


// ═══════════════════════════════════════════════
//  TELNYX — CALLS & AI RECEPTIONIST
// ═══════════════════════════════════════════════

// Outbound call via Telnyx
app.post('/api/calls/outbound', async (req, res) => {
  const telnyxKey = process.env.TELNYX_API_KEY;
  const telnyxNumber = process.env.TELNYX_NUMBER;
  const { to, clientName } = req.body;
  const clientId = req.headers['x-client-id'];

  if (!telnyxKey || !telnyxNumber) {
    return res.status(503).json({ 
      error: 'Telnyx not configured', 
      demo: true,
      message: 'Add TELNYX_API_KEY and TELNYX_NUMBER to Railway Variables'
    });
  }

  try {
    const r = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${telnyxKey}` },
      body: JSON.stringify({
        // Use AI assistant connection if configured, otherwise standard SIP
        ...(process.env.TELNYX_APP_ID ? { application_id: process.env.TELNYX_APP_ID } : {}),
        ...(process.env.TELNYX_CONNECTION_ID ? { connection_id: process.env.TELNYX_CONNECTION_ID } : {}),
        to: to.startsWith('+') ? to : '+1' + to.replace(/[^0-9]/g, ''),
        from: telnyxNumber,
        webhook_url: 'https://axiom-backend-production-0618.up.railway.app/webhooks/telnyx',
        client_state: Buffer.from(JSON.stringify({ clientId, clientName })).toString('base64')
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.errors?.[0]?.detail || 'Call failed' });

    // Log to Supabase
    const s = getSupabase();
    if (s && clientId) {
      await fetch(`${s.url}/rest/v1/calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          client_id: clientId,
          name: clientName || to,
          phone: to,
          status: 'outbound',
          call_id: d.data?.call_control_id,
          created_at: new Date().toISOString()
        })
      });
    }

    console.log(`Call initiated: ${clientId} → ${to}`);
    res.json({ success: true, callId: d.data?.call_control_id });
  } catch(e) {
    console.error('Call error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Telnyx webhook — call events (answered, ended, recording ready)
app.post('/webhooks/telnyx', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try { event = JSON.parse(req.body); } catch(e) { return res.status(400).send('Bad payload'); }

  const eventType = event.data?.event_type;
  const payload = event.data?.payload;
  let clientState = {};
  
  try {
    if (payload?.client_state) {
      clientState = JSON.parse(Buffer.from(payload.client_state, 'base64').toString());
    }
  } catch(e) {}

  const clientId = clientState.clientId;
  console.log(`Telnyx event: ${eventType} | client: ${clientId}`);

  const s = getSupabase();

  if (eventType === 'call.answered' && s && clientId) {
    await fetch(`${s.url}/rest/v1/calls?call_id=eq.${payload.call_control_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'answered', answered_at: new Date().toISOString() })
    });
  }

  if (eventType === 'call.hangup' && s && clientId) {
    const duration = payload?.hangup_cause === 'normal_clearing' ? (payload?.duration_seconds || 0) : 0;
    await fetch(`${s.url}/rest/v1/calls?call_id=eq.${payload.call_control_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ 
        status: 'completed', 
        duration: `${Math.floor(duration/60)}:${(duration%60).toString().padStart(2,'0')}`,
        ended_at: new Date().toISOString()
      })
    });
  }

  // AI Receptionist transcript (if using Telnyx AI)
  if (eventType === 'ai.gather.ended' && s && clientId) {
    const transcript = payload?.transcript || '';
    const callerInfo = payload?.collected_inputs || {};
    
    await fetch(`${s.url}/rest/v1/calls?call_id=eq.${payload.call_control_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ 
        transcript,
        caller_info: JSON.stringify(callerInfo),
        status: 'ai_handled'
      })
    });

    console.log(`AI call handled for ${clientId}: ${transcript.substring(0, 100)}`);
  }

  res.json({ received: true });
});

// Get call history for a client
app.get('/api/calls/:clientId', async (req, res) => {
  const s = getSupabase();
  if (!s) return res.json({ calls: [] });
  try {
    const r = await fetch(`${s.url}/rest/v1/calls?client_id=eq.${req.params.clientId}&order=created_at.desc&limit=50`, {
      headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` }
    });
    res.json({ calls: await r.json() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SMS via Telnyx
app.post('/api/sms/send', async (req, res) => {
  const telnyxKey = process.env.TELNYX_API_KEY;
  const telnyxNumber = process.env.TELNYX_NUMBER;
  const { to, message } = req.body;

  if (!telnyxKey || !telnyxNumber) {
    return res.status(503).json({ error: 'Telnyx not configured', demo: true });
  }

  try {
    const r = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${telnyxKey}` },
      body: JSON.stringify({
        from: telnyxNumber,
        to: to.startsWith('+') ? to : '+1' + to.replace(/\D/g, ''),
        text: message
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.errors?.[0]?.detail });
    res.json({ success: true, messageId: d.data?.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});



// ═══════════════════════════════════════════════
//  EMAIL FORWARDING & AI HANDLING
//  Works for every client via client_id routing
// ═══════════════════════════════════════════════

// Inbound email webhook (Resend, SendGrid, or any provider posts here)
// Set your email provider's inbound webhook to:
// POST https://axiom-backend-production-0618.up.railway.app/webhooks/email/inbound
app.post('/webhooks/email/inbound', async (req, res) => {
  res.json({ received: true }); // Respond immediately so provider doesn't retry

  const { from, to, subject, text, html, headers } = req.body;
  if (!from || !to) return;

  // Route to correct client by the "to" address
  // Each client gets a forwarding address like: pvv@mail.axiomhq.app
  // Extract client_id from the "to" address prefix
  const toAddress = Array.isArray(to) ? to[0] : to;
  const localPart = toAddress.split('@')[0]; // e.g. "pvv" from pvv@mail.axiomhq.app
  const clientId = localPart.replace(/[^a-z0-9-]/gi, '');

  const s = getSupabase();
  if (!s || !clientId) return;

  // Prevent duplicate emails
  const msgId = (headers?.['message-id'] || `${from}-${Date.now()}`).replace(/[<>]/g, '');

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let aiSummary = '', aiCategory = 'inquiry', aiPriority = 'normal', aiDraft = '', aiSentiment = 'neutral';

    // AI processing — categorize and draft reply
    if (apiKey && text) {
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{
              role: 'user',
              content: `Analyze this email and return JSON only (no markdown):
From: ${from}
Subject: ${subject}
Body: ${text?.substring(0, 800)}

Return: {"summary":"2 sentence summary","category":"lead|inquiry|complaint|spam|internal|billing","priority":"urgent|high|normal|low","sentiment":"positive|neutral|negative","draft":"brief professional reply draft (2-3 sentences max)"}`
            }]
          })
        });
        const aiData = await aiRes.json();
        const raw = aiData.content?.[0]?.text || '{}';
        const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        aiSummary = parsed.summary || '';
        aiCategory = parsed.category || 'inquiry';
        aiPriority = parsed.priority || 'normal';
        aiDraft = parsed.draft || '';
        aiSentiment = parsed.sentiment || 'neutral';
      } catch(e) { console.log('AI email processing failed:', e.message); }
    }

    // Save to email_inbox
    await fetch(`${s.url}/rest/v1/email_inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        client_id: clientId,
        message_id: msgId,
        from_email: from,
        from_name: from.split('<')[0].trim() || from,
        to_email: toAddress,
        subject: subject || '(no subject)',
        body_text: text?.substring(0, 5000),
        body_html: html?.substring(0, 10000),
        ai_summary: aiSummary,
        ai_category: aiCategory,
        ai_priority: aiPriority,
        ai_draft_reply: aiDraft,
        ai_sentiment: aiSentiment,
        status: aiCategory === 'spam' ? 'spam' : 'unread',
        received_at: new Date().toISOString()
      })
    });

    // If urgent, log activity
    if (aiPriority === 'urgent') {
      console.log(`URGENT email for ${clientId}: ${subject} from ${from}`);
    }

    console.log(`Email processed for ${clientId}: ${subject} [${aiCategory}/${aiPriority}]`);
  } catch(e) {
    console.error('Email inbound error:', e.message);
  }
});

// Get email inbox for a client
app.get('/api/email/inbox/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { status, limit = 50 } = req.query;
  const s = getSupabase();
  if (!s) return res.json({ emails: [] });

  try {
    let url = `${s.url}/rest/v1/email_inbox?client_id=eq.${clientId}&order=received_at.desc&limit=${limit}`;
    if (status) url += `&status=eq.${status}`;
    const r = await fetch(url, { headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` } });
    res.json({ emails: await r.json() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send reply to an email
app.post('/api/email/reply', async (req, res) => {
  const { clientId, emailId, to, subject, body, fromName } = req.body;
  const resendKey = process.env.RESEND_API_KEY;
  const s = getSupabase();

  if (!resendKey) return res.status(503).json({ error: 'Email not configured' });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
      body: JSON.stringify({
        from: `${fromName || 'Axiom OS'} <noreply@resend.dev>`,
        to: [to],
        subject: subject?.startsWith('Re:') ? subject : `Re: ${subject}`,
        text: body
      })
    });
    const d = await r.json();

    // Mark email as replied
    if (s && emailId) {
      await fetch(`${s.url}/rest/v1/email_inbox?id=eq.${emailId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'replied', replied_at: new Date().toISOString(), reply_sent: body })
      });
    }

    res.json({ success: true, id: d.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
//  LIVE DATA ANALYTICS — Cached, on-demand refresh
//  API keys only used when user clicks Refresh
// ═══════════════════════════════════════════════

// Check if cached data is still fresh
async function getCachedData(clientId, dataType, maxAgeMinutes = 60) {
  const s = getSupabase();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/rest/v1/live_data_cache?client_id=eq.${clientId}&data_type=eq.${dataType}&limit=1`, {
      headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` }
    });
    const data = await r.json();
    if (!data?.length) return null;
    const cached = data[0];
    const age = (Date.now() - new Date(cached.fetched_at).getTime()) / 60000;
    return age < maxAgeMinutes ? cached.payload : null;
  } catch(e) { return null; }
}

// Save data to cache
async function setCachedData(clientId, dataType, payload, ttlMinutes = 60) {
  const s = getSupabase();
  if (!s) return;
  await fetch(`${s.url}/rest/v1/live_data_cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      client_id: clientId, data_type: dataType, payload,
      fetched_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttlMinutes * 60000).toISOString()
    })
  }).catch(e => console.log('Cache save error:', e.message));
}

// Get live market data — cached for 2 hours by default
// Clients provide their own API keys via client_integrations table
app.get('/api/analytics/live/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { type, forceRefresh } = req.query;
  const s = getSupabase();

  // Check cache first (don't burn API keys on every load)
  if (!forceRefresh) {
    const cached = await getCachedData(clientId, type || 'dashboard', 60);
    if (cached) return res.json({ data: cached, cached: true, source: 'cache' });
  }

  // Get client's integrations and API keys
  let integration = null;
  if (s) {
    try {
      const r = await fetch(`${s.url}/rest/v1/client_integrations?client_id=eq.${clientId}&limit=1`, {
        headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` }
      });
      const d = await r.json();
      integration = d?.[0] || null;
    } catch(e) {}
  }

  const data = { type, clientId, timestamp: new Date().toISOString(), sources: [] };

  try {
    // ── Instagram Analytics (if token available) ──
    if (type === 'instagram' || type === 'social') {
      const token = integration?.instagram_token;
      if (token && token !== 'manual') {
        try {
          const igR = await fetch(`https://graph.instagram.com/me?fields=followers_count,media_count,biography&access_token=${token}`);
          const ig = await igR.json();
          data.instagram = { followers: ig.followers_count, posts: ig.media_count, bio: ig.biography };
          data.sources.push('instagram');
        } catch(e) { data.instagram = { error: 'Token expired — reconnect in Social settings' }; }
      } else {
        data.instagram = { status: 'not_connected' };
      }
    }

    // ── Real Estate Market Data (Zillow/Attom/local) ──
    if (type === 'real_estate' || type === 'market') {
      // Use AI to generate market insights based on business location
      const biz = await fetch(`${s?.url}/rest/v1/businesses?client_id=eq.${clientId}&limit=1`, {
        headers: { 'apikey': s?.key, 'Authorization': `Bearer ${s?.key}` }
      }).then(r => r.json()).then(d => d?.[0]).catch(() => null);

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey && biz?.location) {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 500,
            messages: [{ role: 'user', content: `Generate realistic current real estate market stats for ${biz.location} as JSON: {"median_home_price":"$XXX,XXX","price_change_pct":"+X.X%","days_on_market":XX,"active_listings":XXX,"market_temp":"hot|warm|cool","insight":"1 sentence local market insight"}` }]
          })
        });
        const aiD = await aiRes.json();
        const raw = aiD.content?.[0]?.text || '{}';
        try { data.market = JSON.parse(raw.replace(/```json|```/g,'').trim()); data.sources.push('ai_market'); } catch(e) {}
      }
    }

    // ── Weather (free, no API key needed) ──
    if (type === 'weather') {
      const biz = await fetch(`${s?.url}/rest/v1/businesses?client_id=eq.${clientId}&limit=1`, {
        headers: { 'apikey': s?.key, 'Authorization': `Bearer ${s?.key}` }
      }).then(r => r.json()).then(d => d?.[0]).catch(() => null);

      // McAllen TX coordinates as default, override with business location
      const lat = biz?.latitude || 26.2034;
      const lon = biz?.longitude || -98.2300;
      const wx = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m&temperature_unit=fahrenheit&windspeed_unit=mph`);
      const wxData = await wx.json();
      data.weather = {
        temp: Math.round(wxData.current?.temperature_2m) + '°F',
        feels_like: Math.round(wxData.current?.apparent_temperature) + '°F',
        wind: Math.round(wxData.current?.windspeed_10m) + ' mph',
        code: wxData.current?.weathercode
      };
      data.sources.push('open-meteo');
    }

    // ── Business Dashboard Summary ──
    if (type === 'dashboard' || !type) {
      if (s) {
        const [callsR, emailsR, invR, contactsR] = await Promise.all([
          fetch(`${s.url}/rest/v1/calls?client_id=eq.${clientId}&select=status`, { headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` } }),
          fetch(`${s.url}/rest/v1/email_inbox?client_id=eq.${clientId}&select=status,ai_category`, { headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` } }),
          fetch(`${s.url}/rest/v1/invoices?client_id=eq.${clientId}&select=status,amount`, { headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` } }),
          fetch(`${s.url}/rest/v1/contacts?client_id=eq.${clientId}&select=id,stage`, { headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` } })
        ]);
        const [calls, emails, invoices, contacts] = await Promise.all([callsR.json(), emailsR.json(), invR.json(), contactsR.json()]);

        data.dashboard = {
          calls_total: calls?.length || 0,
          calls_ai_handled: calls?.filter(c => c.status === 'ai_handled').length || 0,
          emails_unread: emails?.filter(e => e.status === 'unread').length || 0,
          emails_leads: emails?.filter(e => e.ai_category === 'lead').length || 0,
          invoices_pending: invoices?.filter(i => i.status === 'pending').length || 0,
          invoices_total_value: invoices?.reduce((s, i) => s + (i.amount || 0), 0) || 0,
          contacts_total: contacts?.length || 0,
          contacts_hot: contacts?.filter(c => c.stage === 'hot').length || 0,
        };
        data.sources.push('supabase');
      }
    }

    // Cache the result
    await setCachedData(clientId, type || 'dashboard', data, 60);
    res.json({ data, cached: false, source: 'live' });

  } catch(e) {
    console.error('Analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Save client integration settings (called from Axiom OS settings)
app.post('/api/integrations/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const s = getSupabase();
  if (!s) return res.status(503).json({ error: 'Database not connected' });

  try {
    // Upsert the integration record
    await fetch(`${s.url}/rest/v1/client_integrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ client_id: clientId, ...req.body, updated_at: new Date().toISOString() })
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get client integration settings
app.get('/api/integrations/:clientId', async (req, res) => {
  const s = getSupabase();
  if (!s) return res.json({ integration: null });
  try {
    const r = await fetch(`${s.url}/rest/v1/client_integrations?client_id=eq.${req.params.clientId}&limit=1`, {
      headers: { 'apikey': s.key, 'Authorization': `Bearer ${s.key}` }
    });
    const d = await r.json();
    // Never return raw tokens to the client — only hints
    const integration = d?.[0] ? {
      ...d[0],
      instagram_token: d[0].instagram_token ? '••••' + d[0].instagram_token.slice(-4) : null,
      facebook_token: d[0].facebook_token ? '••••' + d[0].facebook_token.slice(-4) : null,
      google_calendar_token: d[0].google_calendar_token ? '••••connected' : null,
    } : null;
    res.json({ integration });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Assign Telnyx number to a client (called from admin panel)
app.post('/admin/client/:clientId/assign-phone', adminLimiter, adminAuth, async (req, res) => {
  const { clientId } = req.params;
  const { telnyxNumber, assistantId } = req.body;
  const s = getSupabase();
  if (!s) return res.status(503).json({ error: 'Database not connected' });

  try {
    await fetch(`${s.url}/rest/v1/client_integrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        client_id: clientId,
        telnyx_number: telnyxNumber,
        telnyx_assistant_id: assistantId,
        calls_enabled: true,
        updated_at: new Date().toISOString()
      })
    });

    // Also update the main customers table
    await fetch(`${s.url}/rest/v1/customers?client_id=eq.${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ updated_at: new Date().toISOString() })
    });

    console.log(`Phone assigned: ${clientId} → ${telnyxNumber}`);
    res.json({ success: true, clientId, telnyxNumber });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set up email forwarding for a client
app.post('/admin/client/:clientId/setup-email', adminLimiter, adminAuth, async (req, res) => {
  const { clientId } = req.params;
  const { businessEmail, aiAutoReply, replyTone } = req.body;

  // Generate a unique forwarding address for this client
  // They set up forwarding in their email provider to send to this address
  const forwardingAddress = `${clientId}@mail.axiomhq.app`;

  const s = getSupabase();
  if (s) {
    await fetch(`${s.url}/rest/v1/client_integrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': s.key, 'Authorization': `Bearer ${s.key}`, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        client_id: clientId,
        email_forwarding_address: forwardingAddress,
        email_connected_address: businessEmail,
        email_enabled: true,
        email_ai_auto_reply: aiAutoReply || false,
        email_ai_reply_tone: replyTone || 'professional',
        updated_at: new Date().toISOString()
      })
    });
  }

  res.json({
    success: true,
    forwardingAddress,
    instructions: [
      `Tell ${clientId} to forward their email to: ${forwardingAddress}`,
      'In Gmail: Settings → Forwarding → Add forwarding address',
      'In Outlook: Settings → Mail → Forwarding',
      'Axiom OS will then receive, analyze, and manage all their emails'
    ]
  });
});


// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  // Don't exit - keep server running
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  // Don't exit - keep server running  
});

app.listen(PORT, () => {
  console.log(`Axiom OS v${PLATFORM_VERSION.version} — port ${PORT}`);
});
