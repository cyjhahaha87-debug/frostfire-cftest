// SD Robot Battle - Multiplayer Server
// Authoritative-ish server: tracks positions, handles shot validation, broadcasts snapshots

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20; // 20Hz snapshot broadcast
const MAX_HP = 100;
const RESPAWN_DELAY = 2000;
const SHOT_DAMAGE = 12;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ===== Game state =====
const players = new Map(); // id -> player state

const SPAWN_POINTS = [
  { x: 0, z: 0 },
  { x: 20, z: -20 },
  { x: -20, z: 20 },
  { x: 25, z: 25 },
  { x: -25, z: -25 },
  { x: 30, z: 0 },
  { x: -30, z: 0 },
  { x: 0, z: 30 }
];

const COLOR_PRESETS = [
  { primary: 0xffffff, secondary: 0x1a4d8c, accent: 0x00ddff, name: 'Blue' },
  { primary: 0xffe0a0, secondary: 0x994400, accent: 0xff8800, name: 'Orange' },
  { primary: 0xffffff, secondary: 0x228822, accent: 0x66ff66, name: 'Green' },
  { primary: 0xffaaaa, secondary: 0x992222, accent: 0xff4444, name: 'Red' },
  { primary: 0xddaaff, secondary: 0x662288, accent: 0xdd66ff, name: 'Purple' },
  { primary: 0xffff99, secondary: 0xaa8800, accent: 0xffee00, name: 'Yellow' },
  { primary: 0xaaffff, secondary: 0x226688, accent: 0x00ffff, name: 'Cyan' },
  { primary: 0xffaacc, secondary: 0x882255, accent: 0xff66aa, name: 'Pink' }
];

let nextId = 1;
let colorIdx = 0;

function pickSpawn() {
  return SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
}

function createPlayer(ws, name) {
  const id = nextId++;
  const color = COLOR_PRESETS[colorIdx % COLOR_PRESETS.length];
  colorIdx++;
  const spawn = pickSpawn();
  const player = {
    id,
    ws,
    name: name || `Pilot${id}`,
    color,
    x: spawn.x, y: 0.4, z: spawn.z,
    rotY: 0,
    hp: MAX_HP,
    alive: true,
    lastInput: 0,
    respawnAt: 0
  };
  players.set(id, player);
  return player;
}

function broadcast(msg, exceptId = null) {
  const json = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === p.ws.OPEN) {
      p.ws.send(json);
    }
  }
}

function sendTo(player, msg) {
  if (player.ws.readyState === player.ws.OPEN) {
    player.ws.send(JSON.stringify(msg));
  }
}

// ===== Connection handling =====
wss.on('connection', (ws) => {
  let player = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'join') {
      player = createPlayer(ws, msg.name);
      console.log(`[+] ${player.name} (id=${player.id}) joined. Total: ${players.size}`);

      // Send welcome with own ID and current world
      sendTo(player, {
        type: 'welcome',
        id: player.id,
        color: player.color,
        spawn: { x: player.x, y: player.y, z: player.z },
        players: [...players.values()].map(p => ({
          id: p.id, name: p.name, color: p.color,
          x: p.x, y: p.y, z: p.z, rotY: p.rotY, hp: p.hp, alive: p.alive
        }))
      });

      // Tell others someone joined
      broadcast({
        type: 'player_joined',
        player: {
          id: player.id, name: player.name, color: player.color,
          x: player.x, y: player.y, z: player.z, rotY: player.rotY,
          hp: player.hp, alive: player.alive
        }
      }, player.id);
      return;
    }

    if (!player) return; // must join first

    if (msg.type === 'state') {
      // Client sends its own position + rotation
      // Basic sanity check: clamp coordinates
      if (typeof msg.x === 'number' && typeof msg.z === 'number') {
        player.x = Math.max(-150, Math.min(150, msg.x));
        player.y = Math.max(0, Math.min(50, msg.y || 0.4));
        player.z = Math.max(-150, Math.min(150, msg.z));
        player.rotY = msg.rotY || 0;
        player.lastInput = Date.now();
      }
    }
    else if (msg.type === 'shoot') {
      // Client reports a shot. Server validates hit.
      if (!player.alive) return;
      broadcast({
        type: 'shoot_fx',
        shooterId: player.id,
        origin: msg.origin,
        target: msg.target,
        hit: msg.hitId || null
      });
      // Simple hit resolution: if shooter claims a hit, verify distance
      if (msg.hitId && players.has(msg.hitId)) {
        const victim = players.get(msg.hitId);
        if (!victim.alive) return;
        const dx = victim.x - msg.target.x;
        const dy = victim.y + 1 - msg.target.y;
        const dz = victim.z - msg.target.z;
        const distSq = dx*dx + dy*dy + dz*dz;
        // Accept hit if claimed target is within 3 units of actual position
        if (distSq < 9) {
          victim.hp -= SHOT_DAMAGE;
          broadcast({
            type: 'damage',
            targetId: victim.id,
            hp: victim.hp,
            shooterId: player.id
          });
          if (victim.hp <= 0) {
            victim.alive = false;
            victim.hp = 0;
            victim.respawnAt = Date.now() + RESPAWN_DELAY;
            broadcast({
              type: 'death',
              victimId: victim.id,
              killerId: player.id
            });
          }
        }
      }
    }
  });

  ws.on('close', () => {
    if (player) {
      console.log(`[-] ${player.name} (id=${player.id}) left. Total: ${players.size - 1}`);
      players.delete(player.id);
      broadcast({ type: 'player_left', id: player.id });
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ===== Tick: broadcast snapshots & handle respawns =====
setInterval(() => {
  const now = Date.now();

  // Respawn dead players
  for (const p of players.values()) {
    if (!p.alive && now >= p.respawnAt) {
      const spawn = pickSpawn();
      p.x = spawn.x;
      p.y = 0.4;
      p.z = spawn.z;
      p.hp = MAX_HP;
      p.alive = true;
      broadcast({
        type: 'respawn',
        id: p.id,
        x: p.x, y: p.y, z: p.z,
        hp: p.hp
      });
    }
  }

  // Snapshot
  const snapshot = [];
  for (const p of players.values()) {
    snapshot.push({
      id: p.id,
      x: +p.x.toFixed(2),
      y: +p.y.toFixed(2),
      z: +p.z.toFixed(2),
      rotY: +p.rotY.toFixed(3),
      hp: p.hp,
      alive: p.alive
    });
  }
  broadcast({ type: 'snapshot', t: now, players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
