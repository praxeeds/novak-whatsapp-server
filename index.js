const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const API_KEY = process.env.API_KEY || '';
const PORT = process.env.PORT || 8080;

let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected';

function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function sendWebhook(event, data) {
  if (!WEBHOOK_URL) {
    console.log('WEBHOOK_URL não configurada, pulando webhook');
    return;
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (WEBHOOK_SECRET) headers['x-webhook-secret'] = WEBHOOK_SECRET;
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event, data }),
    });
    console.log(`Webhook ${event}: ${res.status}`);
  } catch (err) {
    console.error('Erro webhook:', err.message);
  }
}

// Buscar foto de perfil
async function getProfilePicture(jid) {
  try {
    if (!sock) return null;
    const url = await sock.profilePictureUrl(jid, 'image');
    return url || null;
  } catch {
    return null;
  }
}

async function startSession(sessionId = 'default') {
  const authDir = `./auth_sessions/${sessionId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log('Versão WhatsApp:', version);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    version: version,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      connectionStatus = 'qr_ready';
      await sendWebhook('qr', { session_id: sessionId, qr: currentQR });
      console.log('QR Code gerado!');
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      connectionStatus = 'disconnected';
      currentQR = null;
      await sendWebhook('disconnected', { session_id: sessionId, reason });

      if (reason !== DisconnectReason.loggedOut) {
        console.log('Reconectando em 3s...');
        setTimeout(() => startSession(sessionId), 3000);
      } else {
        console.log('Logout manual, limpando sessão...');
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
      }
    }

    if (connection === 'open') {
      currentQR = null;
      connectionStatus = 'connected';
      const user = sock.user;
      await sendWebhook('connected', {
        session_id: sessionId,
        phone_number: user?.id?.split(':')[0] || '',
        device_name: user?.name || 'WhatsApp',
      });
      console.log('Conectado!', user?.id);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      // Buscar foto de perfil do remetente
      let profilePicture = null;
      try {
        const senderJid = msg.key.remoteJid;
        profilePicture = await getProfilePicture(senderJid);
      } catch {}

      await sendWebhook('message', {
        session_id: sessionId,
        key: msg.key,
        remoteJid: msg.key.remoteJid,
        remoteJidAlt: msg.key.remoteJidAlt || '',
        from: msg.key.remoteJid,
        pushName: msg.pushName,
        message: msg.message,
        messageTimestamp: msg.messageTimestamp,
        profilePicture: profilePicture,
      });
    }
  });
}

// === ROTAS ===

app.post('/session/start', authMiddleware, async (req, res) => {
  try {
    const sessionId = req.body.session_id || 'default';
    await startSession(sessionId);
    res.json({ success: true, status: 'starting' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/session/disconnect', authMiddleware, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    connectionStatus = 'disconnected';
    currentQR = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/session/clear', authMiddleware, async (req, res) => {
  try {
    const sessionId = req.body.session_id || 'default';
    if (sock) { try { await sock.logout(); } catch {} sock = null; }
    const authDir = `./auth_sessions/${sessionId}`;
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
    connectionStatus = 'disconnected';
    currentQR = null;
    res.json({ success: true, message: 'Sessão limpa' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/session/status', authMiddleware, (req, res) => {
  res.json({ status: connectionStatus, qr: currentQR });
});

app.get('/session/qr', authMiddleware, (req, res) => {
  res.json({ qr: currentQR, status: connectionStatus });
});

app.post('/message/send', authMiddleware, async (req, res) => {
  try {
    if (!sock || connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }
    const { phone, message } = req.body;
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text: message });
    res.json({ success: true, message_id: result.key.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Buscar foto de perfil sob demanda
app.post('/contact/profile-picture', authMiddleware, async (req, res) => {
  try {
    if (!sock || connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }
    const { phone } = req.body;
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    const url = await getProfilePicture(jid);
    res.json({ success: true, profile_picture_url: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: connectionStatus });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
