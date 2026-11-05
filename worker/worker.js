// 달빛 저수지 순자산 랭킹 서버
// GET  /top     → 상위 50명
// POST /submit  {token, name, worth, dex, best} → 내 기록 등록/갱신
// 플레이어 구분은 브라우저가 만든 비밀 토큰의 해시로 한다. 토큰 자체는 저장하지 않는다.

const BOARD_KEY = 'moon:board';
const MAX_ENTRIES = 300;
const MIN_GAP_MS = 8000;

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
    };
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);

    if (url.pathname === '/top' && req.method === 'GET') {
      const board = (await env.RATE.get(BOARD_KEY, 'json')) || [];
      return json(board.slice(0, 50).map(({ id, name, worth, dex, best, at }) => ({ id, name, worth, dex, best, at })));
    }

    if (url.pathname === '/submit' && req.method === 'POST') {
      if (!okOrigin) return json({ error: 'origin' }, 403);
      let d;
      try { d = await req.json(); } catch { return json({ error: 'bad' }, 400); }
      const token = String(d.token || '');
      const name = cleanName(d.name);
      const worth = Math.floor(Number(d.worth));
      const dex = Math.floor(Number(d.dex));
      const best = Math.floor(Number(d.best));
      if (!/^[0-9a-f]{32,64}$/.test(token)) return json({ error: 'token' }, 400);
      if (!name) return json({ error: 'name' }, 400);
      if (isBad(name)) return json({ error: 'badname' }, 400);
      if (!Number.isFinite(worth) || worth < 0 || worth > 1e12) return json({ error: 'worth' }, 400);
      if (!(dex >= 0 && dex <= 1000) || !(best >= 0 && best <= 30)) return json({ error: 'bad' }, 400);

      const id = (await sha256('moonlake:' + token)).slice(0, 16);
      const rlKey = 'moon:rl:' + id;
      const last = Number(await env.RATE.get(rlKey)) || 0;
      if (Date.now() - last < MIN_GAP_MS) return json({ error: 'slow' }, 429);
      await env.RATE.put(rlKey, String(Date.now()), { expirationTtl: 60 });

      const board = (await env.RATE.get(BOARD_KEY, 'json')) || [];
      const entry = { id, name, worth, dex, best, at: Date.now() };
      const i = board.findIndex(e => e.id === id);
      if (i >= 0) board[i] = entry; else board.push(entry);
      board.sort((a, b) => b.worth - a.worth || a.at - b.at);
      const trimmed = board.slice(0, MAX_ENTRIES);
      await env.RATE.put(BOARD_KEY, JSON.stringify(trimmed));
      const rank = trimmed.findIndex(e => e.id === id) + 1;
      return json({ ok: true, id, rank: rank || null });
    }

    // 관리자: 항목 삭제 / 전체 초기화. 비밀번호는 Cloudflare 비밀값 ADMIN_PASSWORD.
    if (url.pathname === '/admin' && req.method === 'POST') {
      if (!okOrigin) return json({ error: 'origin' }, 403);
      const ip = req.headers.get('CF-Connecting-IP') || 'x';
      const failKey = 'moon:admfail:' + ip;
      const fails = Number(await env.RATE.get(failKey)) || 0;
      if (fails >= 5) return json({ error: 'locked' }, 429);
      let d;
      try { d = await req.json(); } catch { return json({ error: 'bad' }, 400); }
      if (!env.ADMIN_PASSWORD || String(d.password || '') !== env.ADMIN_PASSWORD) {
        await env.RATE.put(failKey, String(fails + 1), { expirationTtl: 600 });
        return json({ error: 'password' }, 403);
      }
      const board = (await env.RATE.get(BOARD_KEY, 'json')) || [];
      if (d.action === 'reset') {
        await env.RATE.put(BOARD_KEY, '[]');
        return json({ ok: true, removed: board.length });
      }
      if (d.action === 'delete') {
        const next = board.filter(e => e.id !== String(d.id || ''));
        await env.RATE.put(BOARD_KEY, JSON.stringify(next));
        return json({ ok: true, removed: board.length - next.length });
      }
      return json({ error: 'bad' }, 400);
    }

    return json({ error: 'not found' }, 404);
  },
};
