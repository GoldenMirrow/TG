#!/usr/bin/env node
/**
 * wa-cli.js — REPL interactivo de WhatsApp con Baileys
 *
 * Comandos:
 *   chats                          → listar chats conocidos
 *   send <numero|jid> <texto>      → enviar mensaje (verifica antes)
 *   img <numero|jid> <ruta> [txt]  → enviar imagen
 *   doc <numero|jid> <ruta>        → enviar documento
 *   me                             → info de tu cuenta
 *   whois <numero>                 → verificar si existe en WhatsApp
 *   check <numero>                 → igual que whois pero más detalle
 *   history on|off                 → activar sync completo (reinicia)
 *   help                           → ayuda
 *   exit                           → salir
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { startWhatsApp, sendMessage, stopWhatsApp, getSocket } = require('./connection');

let sock = null;
const chats = new Map();
let online = false;

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
function stripNum(s) {
  return String(s).replace(/\D/g, '');
}

function fmtJid(jid) {
  if (jid.endsWith('@lid')) return `LID:${jid.replace('@lid', '')}`;
  if (jid.endsWith('@g.us')) return `GRUPO:${jid.replace('@g.us', '')}`;
  return jid.replace('@s.whatsapp.net', '');
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * Resuelve un número a JID real. Maneja:
 *   - Números normales (PN): 5351092358@s.whatsapp.net
 *   - Contactos migrados a LID: 54035654647831@lid
 *   - Variantes mexicanas: 52 / 521
 *
 * @returns {{ jid, tipo, num, intentos } | null}
 */
async function resolverJid(input) {
  // Si ya es un JID completo, usar directo
  if (input.includes('@')) {
    return { jid: input, tipo: 'directo', num: input.split('@')[0], intentos: [input] };
  }

  const num = stripNum(input);
  const variantes = [num];

  // México: probar 52 ↔ 521
  if (num.startsWith('52') && !num.startsWith('521')) {
    variantes.push('521' + num.slice(2));
  }
  if (num.startsWith('521')) {
    variantes.push('52' + num.slice(3));
  }

  // Brasil: 55 necesita a veces 9to dígito
  if (num.startsWith('55') && num.length === 12) {
    variantes.push(num.slice(0, 4) + '9' + num.slice(4));
  }
  if (num.startsWith('55') && num.length === 13 && num[4] === '9') {
    variantes.push(num.slice(0, 4) + num.slice(5));
  }

  for (const v of variantes) {
    try {
      const results = await sock.onWhatsApp(v);
      if (results && results.length) {
        const r = results[0];
        return {
          jid: r.jid,
          tipo: r.jid.endsWith('@lid') ? 'lid' : 'pn',
          num: v,
          intentos: variantes,
        };
      }
    } catch (e) {
      // continuar con siguiente variante
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Iniciando WhatsApp CLI...\n');

  sock = await startWhatsApp();

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout esperando conexión (60s)')), 60000);
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'open') { online = true; clearTimeout(t); resolve(); }
      if (u.connection === 'close') online = false;
    });
  });

  // Capturar chats (Baileys 7.x no tiene store persistente)
  sock.ev.on('chats.upsert', (list) => {
    for (const c of list) chats.set(c.id, c);
  });
  sock.ev.on('chats.set', ({ chats: list }) => {
    for (const c of list) chats.set(c.id, c);
  });
  sock.ev.on('contacts.upsert', () => { /* ignorar */ });
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (!chats.has(jid)) chats.set(jid, { id: jid, name: m.pushName || null });
    }
  });

  // Esperar chats iniciales
  await new Promise(r => setTimeout(r, 3000));

  console.log(`\n✅ WhatsApp listo (${chats.size} chats cargados)`);
  console.log('   Escribe "help" para ver comandos.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'wa> ',
    historySize: 200,
  });

  const HELP = `
╔══════════════════════════════════════════════════════════════╗
║  COMANDOS DISPONIBLES                                        ║
╚══════════════════════════════════════════════════════════════╝

  📋  chats                      Lista chats cargados
  ✉️   send <num|jid> <texto>    Envía mensaje (verifica primero)
  🖼️   img <num|jid> <ruta> [c]  Envía imagen con caption opcional
  📄  doc <num|jid> <ruta>       Envía documento
  👤  me                         Info de tu cuenta
  🔍  whois <num>                Verifica si existe en WhatsApp
  ❓  help                       Esta ayuda
  🚪  exit                       Salir

  ── Ejemplos ─────────────────────────────────────────────────
  send 5351092358 Hola bro
  send 527221113955 Hola
  send 123456789-987654@g.us Hola grupo
  img 5351092358 ./foto.jpg mira esto
  doc 5351092358 ./manual.pdf
  whois 527221113955

  ── Notas ────────────────────────────────────────────────────
  • El número debe llevar código país, sin + ni espacios
  • "send" verifica primero que el número exista
  • Si el contacto migró a LID, envía al JID correcto automático
  • Acepta JIDs completos (xxx@s.whatsapp.net, xxx@lid, xxx@g.us)
`;

  rl.prompt();

  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();
    if (!line) { rl.prompt(); return; }

    // Parser simple que respeta comillas
    const parts = line.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));

    try {
      switch (cmd) {

        // ─── HELP ───
        case 'help':
        case '?':
          console.log(HELP);
          break;

        // ─── ME ───
        case 'me':
          console.log(`👤 Usuario: ${sock.user?.id || 'desconocido'}`);
          console.log(`   Nombre:  ${sock.user?.name || '-'}`);
          console.log(`   Estado:  ${online ? '🟢 online' : '🔴 offline'}`);
          console.log(`   Chats:   ${chats.size} cargados`);
          break;

        // ─── CHATS ───
        case 'chats': {
          if (!chats.size) {
            console.log('📭 Sin chats cargados todavía.');
            console.log('   💡 Pide a alguien que te escriba, o escribe tú desde el móvil.');
            console.log('   💡 Para cargar historial completo, edita connection.js → syncFullHistory: true');
            break;
          }
          const sorted = [...chats.values()].sort(
            (a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0)
          );
          console.log(`\n📋 ${sorted.length} chats:\n`);
          console.log('   ' + 'TIPO'.padEnd(8) + 'NOMBRE'.padEnd(28) + 'JID'.padEnd(35) + 'ÚLTIMO');
          console.log('   ' + '─'.repeat(8) + ' ' + '─'.repeat(28) + ' ' + '─'.repeat(35) + ' ' + '─'.repeat(15));
          for (const c of sorted.slice(0, 50)) {
            const tipo = c.id.endsWith('@g.us') ? '👥 grupo' : c.id.endsWith('@lid') ? '🔑 LID' : '👤 user';
            const name = (c.name || '(sin nombre)').slice(0, 26).padEnd(28);
            const jid = fmtJid(c.id).slice(0, 33).padEnd(35);
            const time = fmtTime(c.conversationTimestamp);
            console.log(`   ${tipo.padEnd(8)}${name}${jid}${time}`);
          }
          if (sorted.length > 50) console.log(`\n   ... y ${sorted.length - 50} chats más`);
          break;
        }

        // ─── WHOIS ───
        case 'whois':
        case 'check': {
          if (!args[0]) { console.log('Uso: whois <numero>'); break; }
          const num = stripNum(args[0]);
          console.log(`🔍 Consultando ${num}...`);

          const info = await resolverJid(num);
          if (!info) {
            console.log(`\n❌ ${num} NO está registrado en WhatsApp`);
            console.log(`   Verifica:`);
            console.log(`   • Que el número sea correcto (con código país)`);
            console.log(`   • Que la persona tenga WhatsApp activo`);
            console.log(`   • Que no esté bloqueado`);
            break;
          }

          console.log(`\n✅ Existe en WhatsApp`);
          console.log(`   JID:  ${info.jid}`);
          console.log(`   Tipo: ${info.tipo === 'lid' ? '🔑 LID (migrado al nuevo sistema)' : '👤 PN (teléfono normal)'}`);
          if (info.num !== num) {
            console.log(`   ⚠️  Se resolvió con variante: ${info.num} (original: ${num})`);
          }
          console.log(`\n💡 Para enviar: send ${info.jid} Hola`);
          break;
        }

        // ─── SEND ───
        case 'send': {
          if (args.length < 2) { console.log('Uso: send <numero|jid> <texto>'); break; }
          const input = args[0];
          const texto = args.slice(1).join(' ');

          // Si es JID completo → enviar directo sin verificar
          if (input.includes('@')) {
            console.log(`📤 Enviando a ${input}...`);
            await sock.sendMessage(input, { text: texto });
            console.log(`✅ Enviado a ${input}`);
            break;
          }

          // Si es número → verificar primero
          console.log(`🔍 Verificando ${stripNum(input)}...`);
          const info = await resolverJid(input);

          if (!info) {
            console.log(`\n❌ ${stripNum(input)} NO existe en WhatsApp. No se envió nada.`);
            console.log(`   Usa "whois ${stripNum(input)}" para más detalle.`);
            break;
          }

          if (info.num !== stripNum(input)) {
            console.log(`   ⚠️  Resuelto como: ${info.num}`);
          }
          if (info.tipo === 'lid') {
            console.log(`   🔑 Contacto migrado a LID: ${info.jid}`);
          }

          console.log(`📤 Enviando a ${info.jid}...`);
          const result = await sock.sendMessage(info.jid, { text: texto });
          console.log(`✅ Enviado (ID: ${result?.key?.id || 'ok'})`);
          break;
        }

        // ─── IMG ───
        case 'img':
        case 'image': {
          if (args.length < 2) { console.log('Uso: img <numero|jid> <ruta> [caption]'); break; }
          const input = args[0];
          const filePath = path.resolve(args[1]);
          const caption = args.slice(2).join(' ') || undefined;

          if (!fs.existsSync(filePath)) {
            console.log(`❌ No existe: ${filePath}`);
            break;
          }

          let jid = input;
          if (!input.includes('@')) {
            const info = await resolverJid(input);
            if (!info) { console.log(`❌ ${input} no existe en WhatsApp`); break; }
            jid = info.jid;
          }

          console.log(`📤 Enviando imagen a ${jid}...`);
          await sock.sendMessage(jid, {
            image: fs.readFileSync(filePath),
            caption,
          });
          console.log(`✅ Imagen enviada (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`);
          break;
        }

        // ─── DOC ───
        case 'doc':
        case 'document': {
          if (args.length < 2) { console.log('Uso: doc <numero|jid> <ruta>'); break; }
          const input = args[0];
          const filePath = path.resolve(args[1]);

          if (!fs.existsSync(filePath)) {
            console.log(`❌ No existe: ${filePath}`);
            break;
          }

          let jid = input;
          if (!input.includes('@')) {
            const info = await resolverJid(input);
            if (!info) { console.log(`❌ ${input} no existe en WhatsApp`); break; }
            jid = info.jid;
          }

          const stat = fs.statSync(filePath);
          console.log(`📤 Enviando documento (${(stat.size / 1024 / 1024).toFixed(2)} MB)...`);
          await sock.sendMessage(jid, {
            document: fs.readFileSync(filePath),
            fileName: path.basename(filePath),
            mimetype: 'application/octet-stream',
          });
          console.log(`✅ Documento enviado a ${jid}`);
          break;
        }

        // ─── EXIT ───
        case 'exit':
        case 'quit':
        case 'q':
          rl.close();
          return;

        // ─── DESCONOCIDO ───
        default:
          console.log(`❓ Comando desconocido: "${cmd}". Escribe "help".`);
      }
    } catch (e) {
      console.error(`❌ Error: ${e.message}`);
      if (process.env.DEBUG) console.error(e.stack);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    console.log('\n👋 Cerrando conexión...');
    await stopWhatsApp();
    process.exit(0);
  });

  process.on('SIGINT', () => rl.close());
}

main().catch((err) => {
  console.error('💥', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
