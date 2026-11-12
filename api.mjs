/* API del prototipo Onboarding KYC STRADATA · Netlify Functions + Netlify Blobs
   - Panel del analista: requiere la clave definida en la variable de entorno CLAVE_ANALISTA (encabezado x-clave).
   - Portal del tercero: solo ve y modifica SU solicitud, identificada por el token único del enlace.
   Rutas (todas bajo /api):
     GET    /api/estado                         → {ok, panelConfigurado}
     GET    /api/sol            (panel)         → [{id, etag}]
     GET    /api/sol/:id        (panel)         → solicitud
     PUT    /api/sol/:id        (panel)         → guarda solicitud
     DELETE /api/sol/:id        (panel)
     GET    /api/t/:token                        → {sol} solicitud del token (o 404/410)
     PUT    /api/t/:token/sol                    → guarda la solicitud del token (no puede cambiar id ni token)
     GET|PUT /api/arch/:key     (panel)          → archivo (vista previa / original)
     GET|PUT /api/t/:token/arch/:key             → archivo de la solicitud del token (key = <id>__<doc>)
     GET    /api/f/:token                        → solicitud que contiene la firma adicional con ese token
     POST   /api/ia   (panel o x-token válido)   → lectura de documentos con Claude (requiere ANTHROPIC_API_KEY) */
import { getStore } from '@netlify/blobs';

const MAX = 5_500_000;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (s, m) => json({ error: m }, s);
const idOk = s => typeof s === 'string' && /^[A-Za-z0-9_\-]{3,80}$/.test(s);
const tokOk = s => typeof s === 'string' && /^[A-Za-z0-9]{16,64}$/.test(s);

export function crearApi(store, clave, ia = {}) {
  const panel = req => !!clave && req.headers.get('x-clave') === clave;
  const leerSol = id => store.get('sol/' + id, { type: 'json' });
  async function indexar(sol) { // token → id (activo, revocados y firmas adicionales)
    const w = [store.setJSON('tok/' + sol.token, { id: sol.id, estado: 'activo' })];
    (sol.tokensRevocados || []).forEach(t => tokOk(t) && w.push(store.setJSON('tok/' + t, { id: sol.id, estado: 'revocado' })));
    (sol.firmasAdicionales || []).forEach(f => f && tokOk(f.token) && w.push(store.setJSON('fir/' + f.token, { id: sol.id })));
    await Promise.all(w);
  }
  async function guardar(sol) { await store.setJSON('sol/' + sol.id, sol); await indexar(sol); }
  async function porToken(t) { if (!tokOk(t)) return null; const ix = await store.get('tok/' + t, { type: 'json' }); if (!ix) return null; const sol = await leerSol(ix.id); return sol ? { sol, revocado: ix.estado !== 'activo' || sol.token !== t } : null; }
  async function body(req) { const txt = await req.text(); if (txt.length > MAX) throw Object.assign(new Error('demasiado grande'), { s: 413 }); return JSON.parse(txt || 'null'); }

  return async function handler(req) {
    const url = new URL(req.url); const p = url.pathname.replace(/^\/(?:\.netlify\/functions\/api|api)\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); const m = req.method;
    try {
      if (p[0] === 'estado') return json({ ok: true, panelConfigurado: !!clave, panel: panel(req), ia: !!ia.key });
      if (p[0] === 'diag-ia' && m === 'GET') { // diagnóstico de la conexión con la IA (llamada mínima, sin datos)
        if (!ia.key) return json({ configurada: false });
        const base = (ia.base || 'https://api.anthropic.com').replace(/\/+$/, ''); const out = [];
        for (const model of [...new Set([ia.modelo, 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-5-20250929'].filter(Boolean))]) {
          const r = await (ia.fetch || fetch)(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ia.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Responde: ok' }] }) });
          out.push({ model, status: r.status, body: (await r.text()).slice(0, 300) }); if (r.ok) break;
        }
        return json({ configurada: true, gateway: !!ia.base, baseHost: ia.base ? new URL(base).host : 'api.anthropic.com', intentos: out });
      }
      if (p[0] === 'ia' && m === 'POST') {
        if (!ia.key) return err(501, 'Lectura con IA no configurada (ANTHROPIC_API_KEY).');
        const tk = req.headers.get('x-token'); const okTok = tk && tokOk(tk) && await store.get('tok/' + tk, { type: 'json' });
        if (!panel(req) && !okTok) return err(401, 'No autorizado.');
        const b = await body(req); if (!b || typeof b.prompt !== 'string' || b.prompt.length > 60000) return err(400, 'Solicitud inválida');
        const imgs = (Array.isArray(b.imagenes) ? b.imagenes : []).slice(0, 3).filter(x => x && /^image\/(jpeg|png|webp)$/.test(x.tipo) && typeof x.datos === 'string');
        const content = [...imgs.map(x => ({ type: 'image', source: { type: 'base64', media_type: x.tipo, data: x.datos } })), { type: 'text', text: b.prompt }];
        // Netlify AI Gateway inyecta ANTHROPIC_API_KEY y ANTHROPIC_BASE_URL; si no hay base, se usa la API de Anthropic directa
        const base = (ia.base || 'https://api.anthropic.com').replace(/\/+$/, '');
        const modelos = [...new Set([ia.modelo, 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-5-20250929'].filter(Boolean))];
        let ultimo = 0;
        for (const model of modelos) {
          const r = await (ia.fetch || fetch)(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ia.key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 1500, stream: true, messages: [{ role: 'user', content }] }) });
          if (r.ok) { // se reenvía el texto a medida que llega (el formulario se llena en vivo y no se agota el tiempo de la función)
            const enc = new TextEncoder(), dec = new TextDecoder();
            const flujo = new ReadableStream({ async start(ctrl) { const rd = r.body.getReader(); let buf = '';
              try { for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
                while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l.startsWith('data:')) continue; try { const ev = JSON.parse(l.slice(5)); if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) ctrl.enqueue(enc.encode(ev.delta.text)); } catch (e) {} } } }
              finally { ctrl.close(); } } });
            return new Response(flujo, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-modelo': model } });
          }
          ultimo = r.status; if (![400, 404].includes(r.status)) break; // modelo no disponible: se intenta el siguiente
        }
        return err(ultimo === 429 ? 429 : 502, 'El servicio de IA no respondió (' + ultimo + ').');
      }
      if (p[0] === 'sol') {
        if (!clave) return err(503, 'Falta configurar la variable de entorno CLAVE_ANALISTA en Netlify.');
        if (!panel(req)) return err(401, 'Clave del analista requerida.');
        if (!p[1] && m === 'GET') { const { blobs } = await store.list({ prefix: 'sol/' }); return json(blobs.map(b => ({ id: b.key.slice(4), etag: b.etag }))); }
        if (!idOk(p[1])) return err(400, 'id inválido');
        if (m === 'GET') { const s = await leerSol(p[1]); return s ? json(s) : err(404, 'no existe'); }
        if (m === 'PUT') { const s = await body(req); if (!s || s.id !== p[1] || !tokOk(s.token)) return err(400, 'solicitud inválida'); await guardar(s); return json({ ok: true }); }
        if (m === 'DELETE') { const s = await leerSol(p[1]); await store.delete('sol/' + p[1]); if (s) await store.delete('tok/' + s.token); return json({ ok: true }); }
      }
      if (p[0] === 'arch') {
        if (!panel(req)) return err(401, 'Clave del analista requerida.');
        if (!idOk(p[1])) return err(400, 'clave de archivo inválida');
        if (m === 'GET') { const a = await store.get('arch/' + p[1], { type: 'json' }); return a ? json(a) : err(404, 'no existe'); }
        if (m === 'PUT') { await store.setJSON('arch/' + p[1], await body(req)); return json({ ok: true }); }
      }
      if (p[0] === 't') {
        const r = await porToken(p[1]); if (!r) return err(404, 'Enlace no encontrado.');
        if (!p[2] && m === 'GET') return json({ sol: r.sol, revocado: r.revocado });
        if (p[2] === 'sol' && m === 'PUT') {
          if (r.revocado) return err(410, 'Este enlace fue reemplazado por uno nuevo.');
          const s = await body(req); if (!s || s.id !== r.sol.id || s.token !== r.sol.token) return err(400, 'No se puede cambiar la identidad de la solicitud.');
          if (['Aprobado', 'Rechazado', 'Cancelado'].includes(r.sol.estado) && s.estado !== r.sol.estado) return err(409, 'La solicitud está cerrada.');
          await guardar(s); return json({ ok: true });
        }
        if (p[2] === 'arch' && idOk(p[3]) && p[3].startsWith(r.sol.id + '__')) {
          if (m === 'GET') { const a = await store.get('arch/' + p[3], { type: 'json' }); return a ? json(a) : err(404, 'no existe'); }
          if (m === 'PUT') { if (r.revocado) return err(410, 'Enlace reemplazado.'); await store.setJSON('arch/' + p[3], await body(req)); return json({ ok: true }); }
        }
        return err(400, 'Ruta no válida');
      }
      if (p[0] === 'f' && m === 'GET') {
        if (!tokOk(p[1])) return err(404, 'Enlace no encontrado.'); const ix = await store.get('fir/' + p[1], { type: 'json' }); const s = ix && await leerSol(ix.id);
        return s ? json({ sol: s }) : err(404, 'Enlace no encontrado.');
      }
      return err(404, 'Ruta no encontrada');
    } catch (e) { return err(e.s || 500, e.s ? e.message : 'Error interno'); }
  };
}

export default async (req) => crearApi(getStore({ name: 'kyc-onboarding', consistency: 'strong' }), process.env.CLAVE_ANALISTA || '', { key: process.env.ANTHROPIC_API_KEY || '', base: process.env.ANTHROPIC_BASE_URL || '', modelo: process.env.MODELO_IA || '' })(req);
export const config = { path: '/api/*' };
