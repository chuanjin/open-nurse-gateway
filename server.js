const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // Built-in node crypto to generate unique IDs

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
});

const wss = new WebSocketServer({ server });
const connectedNurses = new Map(); // Changed from Set to Map to store Client IDs

wss.on('connection', (ws) => {
  // Generate a unique client ID for each window browser instance
  const clientId = crypto.randomUUID();
  connectedNurses.set(clientId, ws);
  console.log(`[System Sync] Client connected: ${clientId}. Total active: ${connectedNurses.size}`);

  // Send back the assigned ID to the client immediately upon connection
  ws.send(JSON.stringify({ type: 'welcome', clientId: clientId }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Broadcast WebRTC signaling packets to everyone EXCEPT the sender
      if (data.type === 'offer' || data.type === 'answer' || data.type === 'candidate') {
        broadcastRaw(clientId, JSON.stringify(data));
      }
    } catch (e) {
      console.error("Malformed packet dropped:", e);
    }
  });

  ws.on('close', () => {
    connectedNurses.delete(clientId);
    console.log(`[System Sync] Client disconnected: ${clientId}. Total active: ${connectedNurses.size}`);
  });
});

// Broadcast telemetries (like Bed Emergency) to all clients
function broadcastToNurses(payload) {
  const jsonString = JSON.stringify(payload);
  connectedNurses.forEach(ws => {
    if (ws.readyState === 1) ws.send(jsonString);
  });
}

// Custom selective broadcaster to prevent loops
function broadcastRaw(senderId, rawStr) {
  connectedNurses.forEach((ws, clientId) => {
    // CRITICAL FIX: Only forward message if it's NOT the originating client
    if (clientId !== senderId && ws.readyState === 1) {
      ws.send(rawStr);
    }
  });
}

// PoC Simulator Trigger
setInterval(() => {
  if (connectedNurses.size > 0) {
    const mockBeds = ["102", "205", "301"];
    const randomBed = mockBeds[Math.floor(Math.random() * mockBeds.length)];
    console.log(`[PoC Mock Injection] Legacy RS485 interrupt: Room ${randomBed} calling...`);
    broadcastToNurses({ bed: randomBed, type: "Emergency", timestamp: Date.now() });
  }
}, 15000);

server.listen(3000, () => {
  console.log('====================================================================');
  console.log('🚀 Open Nurse Gateway Engine initialized successfully!');
  console.log('👉 Dashboard URL: http://localhost:3000');
  console.log('====================================================================');
});
