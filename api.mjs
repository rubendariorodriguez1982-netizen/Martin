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
     GET    /api/f/:token                        → solicitud que contiene la firma adicional con ese token */
import { getStore } from '@netlify/blobs';

const MAX = 5_500_000;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (s, m) => json({ error: m }, s);
const idOk = s => typeof s === 'string' && /^[A-Za-z0-9_\-]{3,80}$/.test(s);
const tokOk = s => typeof s === 'string' && /^[A-Za-z0-9]{16,64}$/.test(s);

export function crearApi(store, clave) {
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
      if (p[0] === 'estado') return json({ ok: true, panelConfigurado: !!clave, panel: panel(req) });
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

export default async (req) => crearApi(getStore({ name: 'kyc-onboarding', consistency: 'strong' }), process.env.CLAVE_ANALISTA || '')(req);
export const config = { path: '/api/*' };
