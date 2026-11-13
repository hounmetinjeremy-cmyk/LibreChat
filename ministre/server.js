// Serveur Node du Ministre : adapte le code (écrit comme un Worker) à un simple serveur HTTP local.
// Écoute sur 127.0.0.1 uniquement : seul LibreChat, dans le même conteneur, peut l'appeler.
import http from 'node:http';
import worker from './src/index.js';

const PORT = Number(process.env.MINISTRE_PORT || 3090);
const HOST = process.env.MINISTRE_HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0;
    const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await worker.fetch(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('[ministre] erreur', e && e.message);
    res.writeHead(500);
    res.end('ministre error');
  }
});

server.on('error', (e) => console.error('[ministre] arrêt :', e && e.message));
server.listen(PORT, HOST, () => console.log(`[ministre] à l'écoute sur http://${HOST}:${PORT}`));
