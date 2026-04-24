// SD Robot Battle - Multiplayer Server
// Authoritative-ish server: tracks positions, handles shot validation, broadcasts snapshots

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20; // 20Hz snapshot broadcast
const MAX_HP = 250;
const RESPAWN_DELAY = 2000;
const SHOT_DAMAGE = 12;

// Shared obstacle list (must match client's addBox calls)
const OBSTACLES = [
  { x: 15, z: 10, w: 5, h: 4, d: 5 },
  { x: -12, z: 15, w: 6, h: 6, d: 6 },
  { x: 0, z: -20, w: 10, h: 3, d: 10 },
  { x: 25, z: -15, w: 4, h: 8, d: 4 },
  { x: -25, z: -8, w: 7, h: 5, d: 4 },
  { x: -30, z: 25, w: 8, h: 4, d: 8 },
  { x: 30, z: 30, w: 5, h: 6, d: 5 }
];

// Returns true if a segment from (ax,ay,az) to (bx,by,bz) hits any obstacle (2D check in XZ, with Y range)
function segmentBlocked(ax, ay, az, bx, by, bz) {
  // Slab method for AABB-ray intersection, but for segment
  for (const ob of OBSTACLES) {
    const minX = ob.x - ob.w/2, maxX = ob.x + ob.w/2;
    const minZ = ob.z - ob.d/2, maxZ = ob.z + ob.d/2;
    const minY = 0, maxY = ob.h;

    const dx = bx - ax, dy = by - ay, dz = bz - az;
    let tMin = 0, tMax = 1;

    // X slab
    if (Math.abs(dx) < 1e-6) {
      if (ax < minX || ax > maxX) continue;
    } else {
      const t1 = (minX - ax) / dx;
      const t2 = (maxX - ax) / dx;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMin > tMax) continue;
    }
    // Y slab
    if (Math.abs(dy) < 1e-6) {
      if (ay < minY || ay > maxY) continue;
    } else {
      const t1 = (minY - ay) / dy;
      const t2 = (maxY - ay) / dy;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMin > tMax) continue;
    }
    // Z slab
    if (Math.abs(dz) < 1e-6) {
      if (az < minZ || az > maxZ) continue;
    } else {
      const t1 = (minZ - az) / dz;
      const t2 = (maxZ - az) / dz;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMin > tMax) continue;
    }
    // If segment overlaps the box (t in [0,1]) -> blocked
    if (tMax >= 0 && tMin <= 1) return true;
  }
  return false;
}

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
    respawnAt: 0,
    // Melee state (server-side)
    stagger: 0,          // ms remaining
    meleeHitCount: 0,
    lastMeleeHitAt: 0,
    knockedDown: false,
    knockdownUntil: 0,
    invulUntil: 0
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
    else if (msg.type === 'melee') {
      if (!player.alive) return;
      if (!msg.hitId || !players.has(msg.hitId)) return;
      const victim = players.get(msg.hitId);
      if (!victim.alive) return;
      // Check invul
      const now = Date.now();
      if (victim.invulUntil > now) return;
      // Distance check (melee range + a bit for lag)
      const dx = victim.x - player.x;
      const dz = victim.z - player.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      if (dist > 8) return; // too far to be a valid melee

      // Wall check: can't melee through obstacles
      if (segmentBlocked(player.x, player.y + 1, player.z, victim.x, victim.y + 1, victim.z)) {
        return;
      }

      const MELEE_DAMAGE = 25;
      victim.hp -= MELEE_DAMAGE;

      // Stagger
      victim.stagger = 1000; // 1 second
      // Count consecutive hits
      if (now - victim.lastMeleeHitAt > 5000) {
        victim.meleeHitCount = 0;
      }
      victim.meleeHitCount += 1;
      victim.lastMeleeHitAt = now;

      broadcast({
        type: 'melee_hit',
        attackerId: player.id,
        victimId: victim.id,
        hp: victim.hp,
        hitCount: victim.meleeHitCount
      });

      // 4th hit -> knockdown
      if (victim.meleeHitCount >= 4 && victim.hp > 0) {
        victim.knockedDown = true;
        victim.knockdownUntil = now + 2000; // 2s down
        victim.invulUntil = now + 2300;     // invul covers knockdown + small margin
        victim.meleeHitCount = 0;
        broadcast({
          type: 'knockdown',
          victimId: victim.id,
          attackerId: player.id
        });
      }

      if (victim.hp <= 0) {
        victim.alive = false;
        victim.hp = 0;
        victim.respawnAt = now + RESPAWN_DELAY;
        broadcast({
          type: 'death',
          victimId: victim.id,
          killerId: player.id
        });
      }
    }
    else if (msg.type === 'shoot') {
      if (!player.alive) return;
      const weapon = msg.weapon === 3 ? 3 : 2; // 2 = MG, 3 = beam cannon
      const damage = weapon === 3 ? 50 : 5;
      const hitRange = weapon === 3 ? 100 : 50;

      broadcast({
        type: 'shoot_fx',
        shooterId: player.id,
        weapon: weapon,
        origin: msg.origin,
        target: msg.target,
        hit: msg.hitId || null
      });
      if (msg.hitId && players.has(msg.hitId)) {
        const victim = players.get(msg.hitId);
        if (!victim.alive) return;
        // Check range: shooter to victim
        const sdx = victim.x - player.x;
        const sdy = victim.y - player.y;
        const sdz = victim.z - player.z;
        const shotDist = Math.sqrt(sdx*sdx + sdy*sdy + sdz*sdz);
        if (shotDist > hitRange + 5) return; // out of range

        // Line of sight check
        if (segmentBlocked(player.x, player.y + 1, player.z, victim.x, victim.y + 1, victim.z)) {
          return; // obstacle blocks the shot
        }

        const dx = victim.x - msg.target.x;
        const dy = victim.y + 1 - msg.target.y;
        const dz = victim.z - msg.target.z;
        const distSq = dx*dx + dy*dy + dz*dz;
        if (distSq < 9) {
          victim.hp -= damage;
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
      p.stagger = 0;
      p.meleeHitCount = 0;
      p.knockedDown = false;
      p.invulUntil = 0;
      broadcast({
        type: 'respawn',
        id: p.id,
        x: p.x, y: p.y, z: p.z,
        hp: p.hp
      });
    }
    // Knockdown expiry
    if (p.knockedDown && now >= p.knockdownUntil) {
      p.knockedDown = false;
      broadcast({ type: 'getup', id: p.id });
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
