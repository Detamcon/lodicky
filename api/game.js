// Battleship backend — single Vercel serverless function.
// State is stored in Redis (Upstash) so multiple players share the same game.
// No dependencies: uses the Upstash REST API over fetch (Node 18+ global fetch).

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const FLEET = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];
const TTL = 60 * 60 * 24; // rooms auto-expire after 24h

async function redis(args) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REST_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error('redis ' + res.status + ' ' + (await res.text()));
  const j = await res.json();
  return j.result;
}

const key = (code) => 'bs:' + code;
async function getRoom(code) {
  const s = await redis(['GET', key(code)]);
  return s ? JSON.parse(s) : null;
}
async function saveRoom(room) {
  await redis(['SET', key(room.code), JSON.stringify(room), 'EX', TTL]);
}

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function shotKey(r, c) {
  return r + ',' + c;
}

// All cells of a ship list, with hit/sunk info given the shots fired at them.
function sunkInfo(targetShips, shots) {
  const names = [];
  const cells = [];
  for (const ship of targetShips || []) {
    const sunk = ship.cells.every((cell) => shots[shotKey(cell[0], cell[1])] === 'hit');
    if (sunk) {
      names.push(ship.name);
      for (const cell of ship.cells) cells.push(cell);
    }
  }
  return { names, cells };
}

function allSunk(targetShips, shots) {
  if (!targetShips || !targetShips.length) return false;
  return targetShips.every((ship) =>
    ship.cells.every((cell) => shots[shotKey(cell[0], cell[1])] === 'hit')
  );
}

function phaseOf(room) {
  if (room.winner) return 'over';
  if (room.players.length < 2) return 'waiting';
  if (!room.players[0].ready || !room.players[1].ready) return 'placing';
  return 'playing';
}

// Build a view of the room that is safe to send to one specific player.
function viewFor(room, playerId) {
  const meIdx = room.players.findIndex((p) => p.id === playerId);
  const me = room.players[meIdx];
  const opp = room.players[meIdx === 0 ? 1 : 0]; // may be undefined
  const myShots = (me && me.shots) || {};
  const oppShots = (opp && opp.shots) || {};

  const oppSunk = opp ? sunkInfo(opp.ships, myShots) : { names: [], cells: [] };
  const mySunk = me ? sunkInfo(me.ships, oppShots) : { names: [], cells: [] };

  return {
    room: room.code,
    phase: phaseOf(room),
    players: room.players.length,
    winner: room.winner ? (room.winner === playerId ? 'you' : 'them') : null,
    yourTurn: room.turn === playerId,
    you: {
      name: me ? me.name : '',
      ready: me ? me.ready : false,
      ships: me ? me.ships || [] : [], // your own ships (safe to reveal to you)
      shotsOnYou: oppShots, // opponent's shots on your board: {"r,c":"hit"|"miss"}
      sunk: mySunk.names, // names of your ships that are sunk
    },
    opponent: opp ? { name: opp.name, ready: opp.ready } : null,
    yourShots: myShots, // your shots on opponent: {"r,c":"hit"|"miss"}
    oppSunkNames: oppSunk.names, // opponent ships you've sunk
    oppSunkCells: oppSunk.cells, // their cells (revealed only once fully sunk)
  };
}

async function readBody(req) {
  if (req.body) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Použi POST' });
  }
  if (!REST_URL || !REST_TOKEN) {
    return res.status(500).json({
      error:
        'Úložisko nie je nastavené. V paneli Vercel pridaj v sekcii Storage databázu Upstash Redis a nasaď znova.',
    });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Chybné telo požiadavky' });
  }

  const action = body.action;

  try {
    if (action === 'create') {
      const name = (body.name || 'Hráč 1').slice(0, 16);
      let code;
      // find an unused code
      for (let i = 0; i < 5; i++) {
        code = newCode();
        if (!(await getRoom(code))) break;
      }
      const playerId = (globalThis.crypto && crypto.randomUUID && crypto.randomUUID()) ||
        Math.random().toString(36).slice(2);
      const room = {
        code,
        createdAt: Date.now(),
        players: [{ id: playerId, name, ready: false, ships: [], shots: {} }],
        turn: null,
        winner: null,
      };
      await saveRoom(room);
      return res.status(200).json({ room: code, playerId, view: viewFor(room, playerId) });
    }

    if (action === 'join') {
      const code = (body.room || '').toUpperCase();
      const name = (body.name || 'Hráč 2').slice(0, 16);
      const room = await getRoom(code);
      if (!room) return res.status(404).json({ error: 'Miestnosť sa nenašla' });
      if (room.players.length >= 2) {
        return res.status(403).json({ error: 'Miestnosť je plná' });
      }
      const playerId = (globalThis.crypto && crypto.randomUUID && crypto.randomUUID()) ||
        Math.random().toString(36).slice(2);
      room.players.push({ id: playerId, name, ready: false, ships: [], shots: {} });
      await saveRoom(room);
      return res.status(200).json({ room: code, playerId, view: viewFor(room, playerId) });
    }

    // everything below needs an existing room + player
    const code = (body.room || '').toUpperCase();
    const playerId = body.playerId;
    const room = await getRoom(code);
    if (!room) return res.status(404).json({ error: 'Miestnosť sa nenašla' });
    const me = room.players.find((p) => p.id === playerId);
    if (!me) return res.status(403).json({ error: 'Nie si v tejto miestnosti' });

    if (action === 'state') {
      return res.status(200).json({ view: viewFor(room, playerId) });
    }

    if (action === 'place') {
      const ships = body.ships || [];
      // light sanity check; client enforces valid placement
      const okCount = ships.length === FLEET.length;
      const okSizes = ships.every(
        (s, i) => Array.isArray(s.cells) && s.cells.length === FLEET[i].size
      );
      if (!okCount || !okSizes) {
        return res.status(400).json({ error: 'Neplatné rozmiestnenie flotily' });
      }
      me.ships = ships;
      me.ready = true;
      // start the game when both players are ready
      if (
        room.players.length === 2 &&
        room.players[0].ready &&
        room.players[1].ready &&
        !room.turn
      ) {
        room.turn = room.players[0].id;
      }
      await saveRoom(room);
      return res.status(200).json({ view: viewFor(room, playerId) });
    }

    if (action === 'fire') {
      if (phaseOf(room) !== 'playing') {
        return res.status(400).json({ error: 'Hra neprebieha' });
      }
      if (room.turn !== playerId) {
        return res.status(400).json({ error: 'Nie je tvoj ťah' });
      }
      const r = body.r,
        c = body.c;
      if (r == null || c == null || r < 0 || r > 9 || c < 0 || c > 9) {
        return res.status(400).json({ error: 'Neplatná súradnica' });
      }
      const k = shotKey(r, c);
      if (me.shots[k]) {
        return res.status(400).json({ error: 'Sem si už strieľal(a)' });
      }
      const oppIdx = room.players.findIndex((p) => p.id !== playerId);
      const opp = room.players[oppIdx];
      const hit = (opp.ships || []).some((ship) =>
        ship.cells.some((cell) => cell[0] === r && cell[1] === c)
      );
      me.shots[k] = hit ? 'hit' : 'miss';
      if (allSunk(opp.ships, me.shots)) {
        room.winner = playerId;
      } else {
        room.turn = opp.id; // classic rules: one shot, then turn passes
      }
      await saveRoom(room);
      return res.status(200).json({ view: viewFor(room, playerId) });
    }

    if (action === 'rematch') {
      for (const p of room.players) {
        p.ready = false;
        p.ships = [];
        p.shots = {};
      }
      room.turn = null;
      room.winner = null;
      await saveRoom(room);
      return res.status(200).json({ view: viewFor(room, playerId) });
    }

    return res.status(400).json({ error: 'Neznáma akcia' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
