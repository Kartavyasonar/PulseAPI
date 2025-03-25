const { WebSocketServer } = require('ws');

class WsServer {
  constructor() {
    this.clients = new Set();
  }

  attach(server) {
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', ws => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
    console.log('[WS] server attached at /ws');
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(msg, err => { if (err) this.clients.delete(client); });
    }
  }

  broadcastStats(stats) {
    this.broadcast({ type: 'stats', data: stats });
  }
}

module.exports = { WsServer };
