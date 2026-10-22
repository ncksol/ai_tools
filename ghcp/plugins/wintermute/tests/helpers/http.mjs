import { createServer, request } from 'node:http';

/** GET with any Host header (fetch forbids setting Host). */
export function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A Server-Sent Events client that collects { event, data } entries. */
export function openEvents(port, path) {
  const events = [];
  let buffer = '';
  const req = request({ host: '127.0.0.1', port, path }, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event) events.push({ event, data: JSON.parse(data) });
      }
    });
  });
  req.on('error', () => {});
  req.end();
  async function waitFor(predicate, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`no matching event in ${JSON.stringify(events.map(entry => entry.event))}`);
  }
  return { events, waitFor, close: () => req.destroy() };
}

/** A port that was free a moment ago. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
