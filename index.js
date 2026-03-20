const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

// Config
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'seu-secret-aqui';
const API_KEY = process.env.API_KEY || 'sua-api-key-aqui';
const PORT = process.env.PORT || 3000;

let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected';

// Middleware de autenticação
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Enviar evento para webhook
async function sendWebhook(event, data) {
  if (!WEBHOOK_URL) {
    console.log('WEBHOOK_URL não configurada, pulando webhook');
    return;
  }
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': WEBHOOK_SECRET,
      },
      body: JSON.stringify({ event, data }),
    });
  } catch (err) {
    console.error('Erro ao enviar webhook:', err.message);
  }
}

// Iniciar sessão WhatsApp
async function startSession(sessionId = 'default') {
  const { state, saveCreds } = await useMultiFileAuthState(`./auth_sessions/${sessionId}`);
  const { version } = await fetchLatestBaileysVersion();
  console.log('Usando versão do WhatsApp:', version);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    version: version,
    logger: pino({ level: 'silent' }),
  });

  // Eventos de conexão
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
        console.log('Reconectando em 5s... (motivo:', reason, ')');
        setTimeout(() => startSession(sessionId), 5000);
      } else {
        console.log('Logout manual detectado, não reconectando.');
        sock = null;
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
      console.log('WhatsApp conectado!', user?.id);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      await sendWebhook('message', {
        session_id: sessionId,
        key: msg.key,
        remoteJid: msg.key.remoteJid,
        from: msg.key.remoteJid?.replace('@s.whatsapp.net', ''),
        pushName: msg.pushName,
        message: msg.message,
        messageTimestamp: msg.messageTimestamp,
      });
    }
  });
}

// === ROTAS DA API ===

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: connectionStatus });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
