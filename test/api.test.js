'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDb, createApp } = require('../server');

async function withServer(fn) {
  const server = http.createServer(createApp(openDb(':memory:')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body, { auth = true } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

test('первичная настройка, вход и права', async () => {
  await withServer(async (call) => {
    assert.equal((await call('GET', '/api/meta')).body.needsSetup, true);
    assert.equal((await call('GET', '/api/projects', null, { auth: false })).status, 401);

    const setup = await call('POST', '/api/setup', { name: 'Рамазан', login: 'ramazan', password: 'secret1' });
    assert.equal(setup.status, 201);
    assert.equal(setup.body.me.role, 'admin');
    assert.equal((await call('POST', '/api/setup', { name: 'X', login: 'x', password: 'secret1' })).status, 409);

    const rasul = await call('POST', '/api/users', { name: 'Расул', login: 'rasul', password: 'secret2' });
    assert.equal(rasul.status, 201);
    assert.equal(rasul.body.role, 'member');

    assert.equal((await call('POST', '/api/login', { login: 'rasul', password: 'wrong' })).status, 401);
    assert.equal((await call('POST', '/api/login', { login: 'rasul', password: 'secret2' })).status, 200);
    assert.equal((await call('POST', '/api/users', { name: 'Y', login: 'y', password: 'secret3' })).status, 403);
  });
});

test('проекты: создание, смена стадии, история, комментарии', async () => {
  await withServer(async (call) => {
    await call('POST', '/api/setup', { name: 'Рамазан', login: 'ramazan', password: 'secret1' });
    const created = await call('POST', '/api/projects', { title: 'Кабель ВВГ', client: 'ERG', amount: '1 250 000', currency: 'KZT' });
    assert.equal(created.status, 201);
    assert.equal(created.body.amount, 1250000);
    assert.equal(created.body.stage, 'lead');

    const id = created.body.id;
    const moved = await call('PATCH', `/api/projects/${id}`, { stage: 'quote', next_step: 'Позвонить' });
    assert.equal(moved.body.stage, 'quote');
    assert.equal((await call('PATCH', `/api/projects/${id}`, { stage: 'nope' })).status, 400);

    await call('POST', `/api/projects/${id}/comments`, { text: 'КП отправлено на почту' });
    const events = (await call('GET', `/api/projects/${id}/events`)).body;
    assert.deepEqual(events.map((e) => e.kind), ['comment', 'edit', 'stage', 'created']);

    const list = (await call('GET', '/api/projects')).body;
    assert.equal(list[0].comments, 1);

    assert.equal((await call('DELETE', `/api/projects/${id}`)).status, 200);
    assert.equal((await call('GET', '/api/projects')).body.length, 0);
  });
});

test('мутации без JSON отклоняются', async () => {
  const server = http.createServer(createApp(openDb(':memory:')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=a&login=aa&password=123456',
  });
  assert.equal(res.status, 415);
  server.close();
});
