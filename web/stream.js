/**
 * web/stream.js — Cliente Telegram singleton para streaming
 *
 * Mantiene UNA conexión abierta para todos los streams del navegador.
 * El logger silencioso incluye info/getChild/setLevel para que GramJS
 * no explote en iterDownload().
 */
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

let _client = null;
let _connecting = null;

function makeSilentLogger() {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    canSend: false,
    setLevel: noop,
    getChild() { return logger; },
  };
  return logger;
}

async function getStreamClient() {
  if (_client && _client.connected) return _client;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    try {
      const sessionPath = process.env.SESSION_PATH || path.join(__dirname, '..', '.session');
      const sessionStr = fs.readFileSync(sessionPath, 'utf8').trim();
      if (!sessionStr) throw new Error('No hay .session');

      const client = new TelegramClient(
        new StringSession(sessionStr),
        parseInt(process.env.API_ID, 10),
        process.env.API_HASH,
        {
          connectionRetries: 3,
          autoReconnect: true,
          useWSS: true,
          baseLogger: makeSilentLogger(),
        }
      );

      await client.connect();
      const ok = await client.checkAuthorization();
      if (!ok) {
        await client.disconnect();
        throw new Error('Sesión inválida');
      }

      _client = client;
      console.log('📡 Cliente de streaming conectado');
      return client;
    } finally {
      _connecting = null;
    }
  })();

  return _connecting;
}

module.exports = { getStreamClient };
