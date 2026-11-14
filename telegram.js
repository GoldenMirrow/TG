/**
 * telegram.js — Cliente GramJS (MTProto userbot)
 *
 * Encapsula:
 *   - login interactivo (guarda StringSession en .session)
 *   - cliente con sesión reutilizable
 *   - listar dialogs, resolver entidades, leer mensajes
 *   - descargar media a disco con progreso
 */
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, '.session');

// ────────────────────────────────────────────────────────────
// CREDENCIALES
// ────────────────────────────────────────────────────────────
function getCredentials() {
  const apiId = process.env.API_ID;
  const apiHash = process.env.API_HASH;
  if (!apiId || !apiHash) {
    throw new Error(
      '❌ Faltan API_ID y/o API_HASH en .env.\n' +
      '   Sácalos de https://my.telegram.org/apps'
    );
  }
  return { apiId: parseInt(apiId, 10), apiHash };
}

// ────────────────────────────────────────────────────────────
// SESIÓN (persistencia)
// ────────────────────────────────────────────────────────────
function loadSession() {
  try {
    return fs.readFileSync(SESSION_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

function saveSession(str) {
  fs.writeFileSync(SESSION_PATH, str, { mode: 0o600 });
}

// ────────────────────────────────────────────────────────────
// LOGIN INTERACTIVO
// ────────────────────────────────────────────────────────────
async function interactiveLogin() {
  const { apiId, apiHash } = getCredentials();

  console.log('🔐 Iniciando sesión en Telegram');
  console.log('   (si ya tienes .session válida, se reutilizará)\n');

  const client = new TelegramClient(
    new StringSession(loadSession()),
    apiId,
    apiHash,
    { connectionRetries: 5, useWSS: true }
  );

  const input = require('input');

  await client.start({
    phoneNumber: async () => (await input.text('📱 Número (+53...): ')).trim(),
    phoneCode:   async () => (await input.text('🔑 Código OTP: ')).trim(),
    password:    async () => (await input.text('🔒 2FA (Enter si no tienes): ')).trim(),
    onError:     (err) => { throw err; },
  });

  const me = await client.getMe();
  saveSession(client.session.save());

  console.log(`\n✅ Sesión guardada en ${SESSION_PATH}`);
  console.log(
    `   Conectado como: ${me.firstName || ''} ${me.lastName || ''} (@${me.username || 'sin_user'})`
  );

  await client.disconnect();
}

// ────────────────────────────────────────────────────────────
// CLIENTE CON SESIÓN
// ────────────────────────────────────────────────────────────
async function withClient(fn) {
  const sessionStr = loadSession();
  if (!sessionStr) {
    throw new Error('❌ No hay sesión. Ejecuta primero: node index.js login');
  }

  const { apiId, apiHash } = getCredentials();
  const client = new TelegramClient(
    new StringSession(sessionStr),
    apiId,
    apiHash,
    { connectionRetries: 5, useWSS: true }
  );

  await client.connect();

  const ok = await client.checkAuthorization();
  if (!ok) {
    await client.disconnect();
    throw new Error('❌ Sesión inválida o expirada. Ejecuta: node index.js login');
  }

  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

// ────────────────────────────────────────────────────────────
// DIALOGS
// ────────────────────────────────────────────────────────────
async function getDialogs(client, limit = 500) {
  const dialogs = await client.getDialogs({ limit });
  return dialogs.filter(
    (d) => (d.isChannel || d.isGroup) && !d.isUser && d.entity
  );
}

// ────────────────────────────────────────────────────────────
// RESOLVER ENTIDADES
// ────────────────────────────────────────────────────────────
async function getEntity(client, chat) {
  if (typeof chat === 'number') return client.getEntity(chat);

  const s = String(chat).trim();

  // URL de t.me
  const m = s.match(/t\.me\/([^/?#]+)/i);
  if (m) return client.getEntity('@' + m[1]);

  // @username o username
  if (/^@?\w{4,}$/.test(s)) {
    try {
      return await client.getEntity(s.startsWith('@') ? s : '@' + s);
    } catch {
      // si falla, seguimos a buscar por título
    }
  }

  // ID numérico
  if (/^-?\d+$/.test(s)) {
    return client.getEntity(Number(s));
  }

  // Buscar por título entre los dialogs
  const dialogs = await client.getDialogs({ limit: 500 });
  const norm = (x) => (x || '').toLowerCase();
  const target = norm(s);
  const match = dialogs.find((d) => norm(d.title).includes(target));
  if (match) return match.entity;

  throw new Error(`No se encontró el chat: ${s}`);
}

async function resolveEntity(client, row) {
  if (row.access_hash) {
    return new Api.InputPeerChannel({
      channelId: BigInt(row.chat_id),
      accessHash: BigInt(row.access_hash),
    });
  }
  return client.getEntity(Number(row.chat_id));
}

// ────────────────────────────────────────────────────────────
// MENSAJES
// ────────────────────────────────────────────────────────────
async function fetchMessages(client, entity, { limit = 100, offsetId = 0 } = {}) {
  const opts = { limit };
  if (offsetId > 0) opts.offsetId = offsetId;
  return client.getMessages(entity, opts);
}

// ────────────────────────────────────────────────────────────
// DESCARGA
// ────────────────────────────────────────────────────────────
async function downloadMedia(client, entity, messageId, outputPath, onProgress) {
  const [msg] = await client.getMessages(entity, { ids: messageId });
  if (!msg) throw new Error(`Mensaje ${messageId} no encontrado`);
  if (!msg.media) throw new Error(`Mensaje ${messageId} no contiene media`);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await client.downloadMedia(msg, {
    outputFile: outputPath,
    progressCallback: (downloaded, total) => {
      if (onProgress) onProgress(downloaded, total);
    },
  });

  return outputPath;
}

// ────────────────────────────────────────────────────────────
module.exports = {
  interactiveLogin,
  withClient,
  getDialogs,
  getEntity,
  resolveEntity,
  fetchMessages,
  downloadMedia,
};
