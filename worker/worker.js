// 달빛 저수지 순자산 랭킹 서버
// GET  /top     → 상위 50명
// POST /submit  {token, name, worth, dex, best} → 내 기록 등록/갱신
// POST /mail    {token} → 나에게 온 선물 받기
// POST /admin   {password, action: reset | delete | gift}
//
// 랭킹 데이터는 Durable Object(Board) 한 곳에서만 읽고 쓴다.
// 예전에는 KV에 통째로 저장했는데, KV는 지역마다 최대 1분 늦게 맞춰져서
// 동시에 갱신하면 서로 덮어쓰고 순위가 왔다갔다했다.
// 플레이어 구분은 브라우저가 만든 비밀 토큰의 해시로 한다. 토큰 자체는 저장하지 않는다.

const MAX_ENTRIES = 300;
const MIN_GAP_MS = 8000;
const MAX_WORTH = 1e16;

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 랭킹 이름에 못 쓰는 말 (공백·기호를 빼고 비교)
const BAD = ['섹스', '쎅스', '섹쓰', '씨발', '시발', '씨팔', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '좆', '존나', 'ㅈㄴ', '개새', '새끼', '느금', '니애미', '니엄', '애미', '애비', '엠창', '창녀', '보지', '자지', '꼬추', '야르릉',
  'fuck', 'sex', 'shit', 'bitch', 'porn', 'dick', 'pussy'];
function isBad(name) {
  const flat = name.toLowerCase().replace(/[\s\-_.~!@#$%^&*()+=|\\/:;'"`,?0-9]/g, '');
  return BAD.some(w => flat.includes(w));
}

function cleanName(s) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
}

const clamp = (n, max) => Math.max(0, Math.min(max, Math.floor(Number(n) || 0)));
const pub = ({ id, name, worth, dex, best, at }) => ({ id, name, worth, dex, best, at });

// 랭킹 저장소. 요청은 하나씩 순서대로 처리되므로 덮어쓰기가 생기지 않는다.
export class Board {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async board() {
    let b = await this.ctx.storage.get('board');
    if (!b) {
      // 처음 한 번: 예전 KV 랭킹을 옮겨 온다
      b = (await this.env.RATE.get('moon:board', 'json')) || [];
      await this.ctx.storage.put('board', b);
    }
    return b;
  }

  async fetch(req) {
    const { op, d, ip, id } = await req.json();
    const out = (o, status = 200) => Response.json({ status, body: o });

    if (op === 'top') {
      const b = await this.board();
      return out(b.slice(0, 50).map(pub));
    }

    if (op === 'submit') {
      const last = (await this.ctx.storage.get('rl:' + id)) || 0;
      if (Date.now() - last < MIN_GAP_MS) return out({ error: 'slow' }, 429);
      await this.ctx.storage.put('rl:' + id, Date.now());
      const b = await this.board();
      const entry = { id, name: d.name, worth: d.worth, dex: d.dex, best: d.best, at: Date.now() };
      const i = b.findIndex(e => e.id === id);
      if (i >= 0) b[i] = entry; else b.push(entry);
      b.sort((x, y) => y.worth - x.worth || x.at - y.at);
      const trimmed = b.slice(0, MAX_ENTRIES);
      await this.ctx.storage.put('board', trimmed);
      const rank = trimmed.findIndex(e => e.id === id) + 1;
      return out({ ok: true, id, rank: rank || null });
    }

    // 선물·우편함 기능은 없앴다. 남아 있던 선물은 전부 지운다.
    if (op === 'purge') {
      const keys = [...(await this.ctx.storage.list({ prefix: 'mail:' })).keys()];
      let gifts = 0;
      for (const k of keys) { const box = (await this.ctx.storage.get(k)) || []; gifts += box.length; }
      if (keys.length) await this.ctx.storage.delete(keys);
      const old = (await this.env.RATE.list({ prefix: 'moon:mail:' })).keys.map(k => k.name);
      for (const k of old) await this.env.RATE.delete(k);
      return out({ ok: true, boxes: keys.length, gifts, oldKv: old.length });
    }

    if (op === 'admin') {
      const failKey = 'admfail:' + ip;
      const f = (await this.ctx.storage.get(failKey)) || { n: 0, at: 0 };
      if (Date.now() - f.at > 600000) { f.n = 0; }
      if (f.n >= 5) return out({ error: 'locked' }, 429);
      if (!this.env.ADMIN_PASSWORD || String(d.password || '') !== this.env.ADMIN_PASSWORD) {
        await this.ctx.storage.put(failKey, { n: f.n + 1, at: Date.now() });
        return out({ error: 'password' }, 403);
      }
      const b = await this.board();
      if (d.action === 'reset') {
        await this.ctx.storage.put('board', []);
        return out({ ok: true, removed: b.length });
      }
      if (d.action === 'delete') {
        const next = b.filter(e => e.id !== String(d.id || ''));
        await this.ctx.storage.put('board', next);
        return out({ ok: true, removed: b.length - next.length });
      }
      return out({ error: 'bad' }, 400);
    }

    return out({ error: 'not found' }, 404);
  }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
    };
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const stub = env.BOARD.get(env.BOARD.idFromName('main'));
    // 남아 있던 선물 지우기: 서버 비밀값을 아는 사람만 (점검 중에도 동작)
    if (url.pathname === '/purge-mail' && req.method === 'POST') {
      if (!env.ADMIN_PASSWORD || req.headers.get('X-Admin') !== env.ADMIN_PASSWORD) return json({ error: 'password' }, 403);
      const r = await stub.fetch('https://board/', { method: 'POST', body: JSON.stringify({ op: 'purge' }) });
      const { status, body } = await r.json();
      return json(body, status);
    }
    // 점검 중: 랭킹·관리자 요청을 모두 막는다 (데이터는 그대로)
    if (env.MAINTENANCE === '1') return json({ error: 'maintenance' }, 503);
    const call = async msg => {
      const r = await stub.fetch('https://board/', { method: 'POST', body: JSON.stringify(msg) });
      const { status, body } = await r.json();
      return json(body, status);
    };

    if (url.pathname === '/top' && req.method === 'GET') return call({ op: 'top' });

    if (req.method !== 'POST' || !['/submit', '/admin'].includes(url.pathname)) return json({ error: 'not found' }, 404);
    if (!okOrigin) return json({ error: 'origin' }, 403);
    let d;
    try { d = await req.json(); } catch { return json({ error: 'bad' }, 400); }

    if (url.pathname === '/submit') {
      const token = String(d.token || '');
      const name = cleanName(d.name);
      const worth = Math.floor(Number(d.worth));
      const dex = Math.floor(Number(d.dex));
      const best = Math.floor(Number(d.best));
      if (!/^[0-9a-f]{32,64}$/.test(token)) return json({ error: 'token' }, 400);
      if (!name) return json({ error: 'name' }, 400);
      if (isBad(name)) return json({ error: 'badname' }, 400);
      if (!Number.isFinite(worth) || worth < 0 || worth > MAX_WORTH) return json({ error: 'worth' }, 400);
      if (!(dex >= 0 && dex <= 1000) || !(best >= 0 && best <= 30)) return json({ error: 'bad' }, 400);
      const id = (await sha256('moonlake:' + token)).slice(0, 16);
      return call({ op: 'submit', id, d: { name, worth, dex, best } });
    }

    // /admin
    return call({ op: 'admin', d, ip: req.headers.get('CF-Connecting-IP') || 'x' });
  },
};
