require('dotenv').config();
const express = require('express');
const compression = require('compression');
const path = require('path');
const apiRouter = require('./routes/api');
const { THUMB_DIR } = require('../modules/thumbnails');

const app = express();
const PORT = parseInt(process.env.WEB_PORT, 10) || 3000;
const HOST = process.env.WEB_HOST || '127.0.0.1';

app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Thumbnails estáticos con cache largo
app.use('/thumbnails', express.static(THUMB_DIR, {
  maxAge: '7d',
  immutable: true,
  fallthrough: false,
}));

// Public estático
app.use(express.static(path.join(__dirname, 'public')));

// API
app.use('/api', apiRouter);

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n🌐 Web UI:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   (Ctrl+C para detener)\n`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Cerrando web...');
  server.close(() => process.exit(0));
});
