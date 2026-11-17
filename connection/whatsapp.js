/**
 * connection.js — Cliente WhatsApp (Baileys) con pairing code
 *
 * Expone:
 *   - startWhatsApp({ phoneNumber, onMessage })
 *   - sendMessage(jid, text)
 *   - getSocket()
 *   - stopWhatsApp()
 */
const fs = require('fs');
const path = require('path');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const readline = require('readline');

const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, 'wa_auth');
const PHONE = process.env.WA_PHONE || null; // ej: 5351092358 (sin +, sin espacios)

let sock = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

// ────────────────────────────────────────────────────────────
// Utilidades
// ────────────────────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => {
    rl.close();
    resolve(ans.trim());
  }));
}

function formatJid(phone) {
  // Acepta +53..., 53..., espacios, guiones → solo dígitos
  return String(phone).replace(/\D/g, '');
}

// ────────────────────────────────────────────────────────────
// Conexión principal
// ────────────────────────────────────────────────────────────
async function startWhatsApp({ phoneNumber, onMessage } = {}) {
  if (sock) {
    console.log('⚠️  Ya hay una conexión de WhatsApp activa');
    return sock;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Versión de WhatsApp Web (opcional pero recomendable)
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📡 WhatsApp Web versión: ${version.join('.')}`);

  sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false, // ⚠️ Deprecado: no lo uses con pairing code
    browser: ['Ubuntu', 'Chrome', '110.0.5481.77'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // ── Guardar credenciales SIEMPRE que cambien
  sock.ev.on('creds.update', saveCreds);

  // ── Manejo de eventos
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Si NO está registrado y llega el QR → pedir pairing code
    if (qr && !sock.authState.creds.registered) {
      let numero = phoneNumber || PHONE;
      if (!numero) {
        numero = await ask('📱 Número de WhatsApp (con código país, sin +): ');
      }
      numero = formatJid(numero);

      try {
        const code = await sock.requestPairingCode(numero);
        console.log('\n🔑 CÓDIGO DE EMPAREJAMIENTO:', code);
        console.log('\n   En tu móvil: WhatsApp → Ajustes → Dispositivos vinculados');
        console.log('   → Vincular dispositivo → "Vincular con número de teléfono"');
        console.log('   → Introduce el código de 8 dígitos.\n');
      } catch (err) {
        console.error('❌ Error pidiendo pairing code:', err.message);
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      console.log('✅ WhatsApp conectado');
      console.log('   Usuario:', sock.user?.id || 'desconocido');
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log('🔴 Sesión cerrada (logged out). Borra wa_auth/ y vuelve a conectar.');
        sock = null;
        return;
      }

      if (reconnectAttempts >= MAX_RECONNECT) {
        console.error('❌ Demasiados reintentos. Abortando.');
        sock = null;
        return;
      }

      reconnectAttempts++;
      console.log(`🔄 Reconectando (${reconnectAttempts}/${MAX_RECONNECT})...`);
      setTimeout(() => {
        sock = null;
        startWhatsApp({ phoneNumber, onMessage }).catch(console.error);
      }, 2000);
    }
  });

  // ── Mensajes entrantes
  if (onMessage) {
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue; // ignorar los míos
        try {
          await onMessage(msg, sock);
        } catch (e) {
          console.error('⚠️  Error en onMessage:', e.message);
        }
      }
    });
  }

  return sock;
}

// ────────────────────────────────────────────────────────────
// Enviar mensaje
// ────────────────────────────────────────────────────────────
async function sendMessage(jid, text) {
  if (!sock) throw new Error('WhatsApp no está conectado');
  // jid: "5351092358@s.whatsapp.net" o grupo "123456789-123456@g.us"
  return sock.sendMessage(jid, { text });
}

// ────────────────────────────────────────────────────────────
// Cerrar
// ────────────────────────────────────────────────────────────
async function stopWhatsApp() {
  if (!sock) return;
  try {
    await sock.logout();
  } catch { /* ignorar */ }
  sock = null;
}

function getSocket() {
  return sock;
}

module.exports = {
  startWhatsApp,
  sendMessage,
  stopWhatsApp,
  getSocket,
};/* Conectar el bot con Whatsapp*/

