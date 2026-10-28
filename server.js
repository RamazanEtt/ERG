'use strict';

// Трекер проектов поставок. Без внешних зависимостей: node:http + node:sqlite.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tracker.db');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_DAYS = 30;
const PUBLIC_DIR = path.join(__dirname, 'public');

const STAGES = [
  { id: 'lead', name: 'Запрос' },
  { id: 'quote', name: 'КП отправлено' },
  { id: 'negotiation', name: 'Согласование' },
  { id: 'contract', name: 'Договор' },
  { id: 'payment', name: 'Оплата' },
  { id: 'procurement', name: 'Закупка' },
  { id: 'delivery', name: 'Доставка' },
  { id: 'done', name: 'Поставлено' },
  { id: 'lost', name: 'Отказ' },
];
const STAGE_IDS = new Set(STAGES.map((s) => s.id));
const CURRENCIES = ['KZT', 'USD', 'EUR', 'RUB', 'CNY'];
const DEFAULT_CLIENTS = ['ERG', 'Integra Holding', 'Integra Construction'];

// ---------- База ----------

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      client TEXT NOT NULL DEFAULT '',
      amount REAL,
      currency TEXT NOT NULL DEFAULT 'KZT',
      stage TEXT NOT NULL DEFAULT 'lead',
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deadline TEXT,
      next_step TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      stage_changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS events_project ON events(project_id, id);
  `);
  return db;
}

// ---------- Пароли и сессии ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  return [
    `sid=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    COOKIE_SECURE ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

// Простая защита от перебора паролей: не больше 10 попыток за 10 минут с одного IP.
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (loginAttempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  loginAttempts.set(ip, list);
  return list.length >= 10;
}
function recordFailedAttempt(ip) {
  loginAttempts.get(ip)?.push(Date.now()) ?? loginAttempts.set(ip, [Date.now()]);
}

// ---------- HTTP-утилиты ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  // Мутации принимаются только как JSON: межсайтовая форма такой запрос без preflight не отправит.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Ожидается JSON');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Не найдено' });
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA: неизвестные пути отдают главную страницу.
      if (!path.extname(rel)) return serveIndex(res);
      return sendJson(res, 404, { error: 'Не найдено' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function serveIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
    if (err) return sendJson(res, 500, { error: 'Нет index.html' });
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- Валидация ----------

function str(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

function cleanProjectFields(body, partial) {
  const out = {};
  if (!partial || 'title' in body) {
    out.title = str(body.title, 200);
    if (!out.title) throw new HttpError(400, 'Укажите название проекта');
  }
  if ('client' in body) out.client = str(body.client, 120);
  if ('amount' in body) {
    if (body.amount === null || body.amount === '') out.amount = null;
    else {
      const n = Number(String(body.amount).replace(/[\s ]/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Некорректная сумма');
      out.amount = n;
    }
  }
  if ('currency' in body) {
    if (!CURRENCIES.includes(body.currency)) throw new HttpError(400, 'Неизвестная валюта');
    out.currency = body.currency;
  }
  if ('stage' in body) {
    if (!STAGE_IDS.has(body.stage)) throw new HttpError(400, 'Неизвестная стадия');
    out.stage = body.stage;
  }
  if ('owner_id' in body) out.owner_id = body.owner_id ? Number(body.owner_id) : null;
  if ('deadline' in body) {
    const d = str(body.deadline, 10);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'Дата в формате ГГГГ-ММ-ДД');
    out.deadline = d || null;
  }
  if ('next_step' in body) out.next_step = str(body.next_step, 300);
  if ('notes' in body) out.notes = str(body.notes, 5000);
  return out;
}

// ---------- Приложение ----------

function createApp(db) {
  const q = {
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),
    userById: db.prepare('SELECT id, name, login, role FROM users WHERE id = ?'),
    users: db.prepare('SELECT id, name, login, role FROM users ORDER BY id'),
    insertUser: db.prepare('INSERT INTO users (name, login, pass_hash, role) VALUES (?, ?, ?, ?)'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare(`
      SELECT u.id, u.name, u.login, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    projects: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC'),
    project: db.prepare('SELECT * FROM projects WHERE id = ?'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    events: db.prepare(`
      SELECT e.id, e.kind, e.data, e.created_at, e.user_id, u.name AS user_name
      FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.project_id = ? ORDER BY e.id DESC LIMIT 200`),
    insertEvent: db.prepare('INSERT INTO events (project_id, user_id, kind, data) VALUES (?, ?, ?, ?)'),
    lastComments: db.prepare(`
      SELECT project_id, COUNT(*) AS n FROM events WHERE kind = 'comment' GROUP BY project_id`),
  };

  function logEvent(projectId, userId, kind, data) {
    q.insertEvent.run(projectId, userId, kind, JSON.stringify(data));
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    return q.sessionUser.get(token, Date.now()) || null;
  }

  function startSession(res, userId) {
    q.purgeSessions.run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    q.insertSession.run(token, userId, Date.now() + SESSION_DAYS * 86400_000);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
  }

  function requireAdmin(user) {
    if (user.role !== 'admin') throw new HttpError(403, 'Нужны права администратора');
  }

  function validateNewUser(body) {
    const name = str(body.name, 80);
    const login = str(body.login, 40).toLowerCase();
    const password = String(body.password ?? '');
    if (!name) throw new HttpError(400, 'Укажите имя');
    if (!/^[a-z0-9._-]{2,40}$/.test(login)) throw new HttpError(400, 'Логин: латиница, цифры, . _ -');
    if (password.length < 6) throw new HttpError(400, 'Пароль — минимум 6 символов');
    if (q.userByLogin.get(login)) throw new HttpError(409, 'Такой логин уже есть');
    return { name, login, password };
  }

  function projectRow(p, commentCounts) {
    return { ...p, comments: commentCounts.get(p.id) || 0 };
  }

  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) =>
    routes.push({ method, pattern, handler, auth });

  route('GET', /^\/api\/meta$/, (req, res, { user }) => {
    sendJson(res, 200, {
      stages: STAGES,
      currencies: CURRENCIES,
      defaultClients: DEFAULT_CLIENTS,
      needsSetup: q.userCount.get().n === 0,
      me: user,
    });
  }, { auth: false });

  route('POST', /^\/api\/setup$/, async (req, res) => {
    const body = await readJson(req);
    if (q.userCount.get().n > 0) throw new HttpError(409, 'Уже настроено');
    const u = validateNewUser(body);
    const { lastInsertRowid } = q.insertUser.run(u.name, u.login, hashPassword(u.password), 'admin');
    startSession(res, Number(lastInsertRowid));
    sendJson(res, 201, { me: q.userById.get(lastInsertRowid) });
  }, { auth: false });

  route('POST', /^\/api\/login$/, async (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (tooManyAttempts(ip)) throw new HttpError(429, 'Слишком много попыток, подождите 10 минут');
    const body = await readJson(req);
    const row = q.userByLogin.get(str(body.login, 40).toLowerCase());
    if (!row || !verifyPassword(String(body.password ?? ''), row.pass_hash)) {
      recordFailedAttempt(ip);
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    startSession(res, row.id);
    sendJson(res, 200, { me: q.userById.get(row.id) });
  }, { auth: false });

  route('POST', /^\/api\/logout$/, (req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) q.deleteSession.run(token);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }, { auth: false });

  route('GET', /^\/api\/users$/, (req, res) => sendJson(res, 200, q.users.all()));

  route('POST', /^\/api\/users$/, async (req, res, { user }) => {
    requireAdmin(user);
    const body = await readJson(req);
    const u = validateNewUser(body);
    const role = body.role === 'admin' ? 'admin' : 'member';
    const { lastInsertRowid } = q.insertUser.run(u.name, u.login, hashPassword(u.password), role);
    sendJson(res, 201, q.userById.get(lastInsertRowid));
  });

  route('DELETE', /^\/api\/users\/(\d+)$/, (req, res, { user, params }) => {
    requireAdmin(user);
    const id = Number(params[0]);
    if (id === user.id) throw new HttpError(400, 'Нельзя удалить самого себя');
    q.deleteUser.run(id);
    sendJson(res, 200, { ok: true });
  });

  route('POST', /^\/api\/me\/password$/, async (req, res, { user }) => {
    const body = await readJson(req);
    const row = q.userByLogin.get(user.login);
    if (!verifyPassword(String(body.current ?? ''), row.pass_hash)) throw new HttpError(400, 'Текущий пароль неверный');
    const next = String(body.next ?? '');
    if (next.length < 6) throw new HttpError(400, 'Пароль — минимум 6 символов');
    q.setPassword.run(hashPassword(next), user.id);
    sendJson(res, 200, { ok: true });
  });

  route('GET', /^\/api\/projects$/, (req, res) => {
    const counts = new Map(q.lastComments.all().map((r) => [r.project_id, r.n]));
    sendJson(res, 200, q.projects.all().map((p) => projectRow(p, counts)));
  });

  route('POST', /^\/api\/projects$/, async (req, res, { user }) => {
    const f = cleanProjectFields(await readJson(req), false);
    const row = {
      client: '', amount: null, currency: 'KZT', stage: 'lead', owner_id: user.id,
      deadline: null, next_step: '', notes: '', ...f,
    };
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO projects (title, client, amount, currency, stage, owner_id, deadline, next_step, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.title, row.client, row.amount, row.currency, row.stage, row.owner_id,
      row.deadline, row.next_step, row.notes, user.id,
    );
    const id = Number(lastInsertRowid);
    logEvent(id, user.id, 'created', { stage: row.stage });
    sendJson(res, 201, { ...q.project.get(id), comments: 0 });
  });

  route('PATCH', /^\/api\/projects\/(\d+)$/, async (req, res, { user, params }) => {
    const id = Number(params[0]);
    const before = q.project.get(id);
    if (!before) throw new HttpError(404, 'Проект не найден');
    const f = cleanProjectFields(await readJson(req), true);
    const keys = Object.keys(f).filter((k) => f[k] !== before[k]);
    if (keys.length) {
      const sets = keys.map((k) => `${k} = ?`);
      sets.push("updated_at = datetime('now')");
      if (keys.includes('stage')) sets.push("stage_changed_at = datetime('now')");
      db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
      if (keys.includes('stage')) logEvent(id, user.id, 'stage', { from: before.stage, to: f.stage });
      const edited = keys.filter((k) => k !== 'stage');
      if (edited.length) logEvent(id, user.id, 'edit', { fields: edited });
    }
    const counts = new Map(q.lastComments.all().map((r) => [r.project_id, r.n]));
    sendJson(res, 200, projectRow(q.project.get(id), counts));
  });

  route('DELETE', /^\/api\/projects\/(\d+)$/, (req, res, { user, params }) => {
    const p = q.project.get(Number(params[0]));
    if (!p) throw new HttpError(404, 'Проект не найден');
    if (user.role !== 'admin' && p.created_by !== user.id) throw new HttpError(403, 'Удалить может автор или админ');
    q.deleteProject.run(p.id);
    sendJson(res, 200, { ok: true });
  });

  route('GET', /^\/api\/projects\/(\d+)\/events$/, (req, res, { params }) => {
    const rows = q.events.all(Number(params[0])).map((e) => ({ ...e, data: JSON.parse(e.data) }));
    sendJson(res, 200, rows);
  });

  route('POST', /^\/api\/projects\/(\d+)\/comments$/, async (req, res, { user, params }) => {
    const id = Number(params[0]);
    if (!q.project.get(id)) throw new HttpError(404, 'Проект не найден');
    const text = str((await readJson(req)).text, 3000);
    if (!text) throw new HttpError(400, 'Пустой комментарий');
    logEvent(id, user.id, 'comment', { text });
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id);
    sendJson(res, 201, { ok: true });
  });

  return async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
        return serveStatic(req, res);
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.pattern);
        if (!m) continue;
        const user = currentUser(req);
        if (r.auth && !user) throw new HttpError(401, 'Нужно войти');
        return await r.handler(req, res, { user, params: m.slice(1) });
      }
      throw new HttpError(404, 'Не найдено');
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (String(err.message).includes('FOREIGN KEY')) return sendJson(res, 400, { error: 'Неизвестный ответственный' });
      console.error(err);
      sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  };
}

if (require.main === module) {
  const db = openDb(DB_PATH);
  http.createServer(createApp(db)).listen(PORT, HOST, () => {
    console.log(`Трекер поставок: http://localhost:${PORT}  (база: ${DB_PATH})`);
  });
}

module.exports = { openDb, createApp, STAGES };
