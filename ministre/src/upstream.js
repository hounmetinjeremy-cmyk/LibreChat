// Client MCP minimal (streamable-http) vers les serveurs situés derrière le Ministre.
// Sans état : chaque opération ouvre sa propre session (initialize -> appel).

const PROTOCOL = '2025-03-26';

function parseSSE(text, id) {
  let last = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      const m = JSON.parse(data);
      if (m.id === id || m.result || m.error) last = m;
    } catch {
      /* ligne SSE non JSON, ignorée */
    }
  }
  return last;
}

async function rpc(up, body, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(up.headers || {}),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(up.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(up.timeout || 25000),
  });
  const sid = res.headers.get('Mcp-Session-Id') || sessionId;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const text = await res.text();
  if (!text) return { sid, msg: null };
  const ct = res.headers.get('Content-Type') || '';
  const msg = ct.includes('text/event-stream') ? parseSSE(text, body.id) : JSON.parse(text);
  return { sid, msg };
}

async function openSession(up) {
  const init = await rpc(up, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'ministre', version: '0.1.0' },
    },
  });
  if (init.msg && init.msg.error) throw new Error(init.msg.error.message);
  await rpc(up, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid).catch(() => {});
  return init.sid;
}

export async function listTools(up) {
  const sid = await openSession(up);
  const out = [];
  let cursor;
  do {
    const { msg } = await rpc(
      up,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: cursor ? { cursor } : {} },
      sid,
    );
    if (msg && msg.error) throw new Error(msg.error.message);
    out.push(...((msg && msg.result && msg.result.tools) || []));
    cursor = msg && msg.result && msg.result.nextCursor;
  } while (cursor);
  return out;
}

export async function callTool(up, name, args) {
  const sid = await openSession(up);
  const { msg } = await rpc(
    up,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args || {} } },
    sid,
  );
  if (msg && msg.error) throw new Error(msg.error.message);
  return msg && msg.result;
}
