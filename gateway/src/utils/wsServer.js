const { WebSocketServer } = require('ws');

class WsServer {
  constructor() {
    this.clients = new Set();
    this.wss = null;
  }

  attach(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      this.clients.add(ws);
      console.log(`[WS] Client connected. Total: ${this.clients.size}`);

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[WS] Client disconnected. Total: ${this.clients.size}`);
      });

      ws.on('error', () => this.clients.delete(ws));
    });
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(msg, (err) => {
          if (err) this.clients.delete(client);
        });
      }
    }
  }

  broadcastStats(stats) {
    this.broadcast({ type: 'stats', data: stats });
  }
}

module.exports = { WsServer };
