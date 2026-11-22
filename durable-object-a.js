// durable-object.js
// ALONE multiplayer server: one Durable Object per room, plus one registry object ('__room_registry__').
//
// Key differences from the previous version:
//  - Joining works (finishJoin bug gone; world is generated synchronously on first join).
//  - Placement no longer crashes (type/x/y were used before being declared).
//  - Movement accepts the client's { keys: { KeyW: true, ... } } input and is collision-checked.
//  - Chest transfers use the client's message shape (chestX/chestY/fromKind/fromIdx/toKind/toIdx).
//  - A restored room regenerates TERRAIN ONLY and keeps its saved trees/chests/buildings (no duplicates).
//  - Disconnected players are marked offline, so empty rooms stop ticking and leave the room list.
//  - Room registry endpoints (?rooms, ?create, ?prune) are implemented.
//  - World data is stored in small chunks (Durable Object values have size limits).
//  - Resource nodes carry ids and changes are sent as 'world:patch' deltas, not the whole node list.
//  - Fully server-authoritative: hunger, warmth, seasons, thermal stones, darkness, torches, wolves,
//    death/respawn, day/night, crafting, eating, planting and combat are simulated here.
//  - Mobs are synced per player (only nearby ones, only what changed) via 'world:mobs'.
//  - Terrain v2: land defaults to DESERT, with plains/forest/mountain painted on top. Older rooms keep v1.

const MAX_PLAYERS = 16;
const CELL_SIZE = 40;
const MOB_SIZE = CELL_SIZE;
const GREG_SIZE = CELL_SIZE * 3;
const GREG_DEATH_ANIMATION_MS = 6000;
const GREG_CHEST_FADE_MS = 2000;
const ALPHA_WOLF_HP = 1250;
const ALPHA_WOLF_SUMMON_INTERVAL = 7;
const ALPHA_WOLF_STUN_DURATION = 5;
const ALPHA_WOLF_SUMMON_COUNT = 6;
const ALPHA_WOLF_SUMMON_HP = 45;
const ALPHA_WOLF_SUMMON_SPEED = 130;
const ALPHA_WOLF_SUMMON_DAMAGE = 8;
const ALPHA_WOLF_SUMMON_BITE_MS = 1400;
const WORLD_TOKEN_NODES = {
    ivory: { type: 'ivory_token', icon: '🦷' },
    wolf: { type: 'wolf_token', icon: '🐺' }
};
const ALPHA_WOLF_SIZE = 100;
const mobCenter = mob => ({
    x: mob.x + (mob.type === 'greg' ? GREG_SIZE : MOB_SIZE) / 2,
    y: mob.y + (mob.type === 'greg' ? GREG_SIZE : MOB_SIZE) / 2
});
const TICK_INTERVAL_MS = 50;           // 20 ticks per second
const PERSIST_INTERVAL_MS = 5000;
const MOB_SYNC_MS = 100;              // how often nearby mob changes are sent to each player
const MOB_VIEW_X = 1400;              // px: mobs farther than this from a player are not sent to them
const MOB_VIEW_Y = 1000;
const INVENTORY_SLOTS = 15;
const CHEST_SLOTS = 10;
const PLACE_REACH = 450;          // px. The client lets you aim anywhere on screen.
const HARVEST_REACH = 80;         // px: you must be standing next to it (the client walks you there first)
const ATTACK_REACH = 100;         // px
const SHAKES_PER_DAY = 3;         // per tree
const SHAKE_TWIG_CHANCE = 0.33;
const SHAKE_ACORN_CHANCE = 0.10;
const HAMMER_DAMAGE = 50;         // per hit; walls have 500 hp, chests 400
const BREAK_COOLDOWN_MS = 230;
// The one always-listed public server. Its world uses the fixed settings below no matter who joins first,
// and (like every room) the world only advances while somebody is in it.
const OFFICIAL_ROOM_CODE = 'PUBLIC';
const OFFICIAL_ROOM_NAME = 'ALONE PUBLIC SERVER';
const OFFICIAL_SEED = 'EEBBEBAFJJEA' + 'K7M2P9Q4R8T3V6W5';   // normal settings, normal ruins, not creative
const HARVEST_COOLDOWN_MS = 110;
const LAB_RADIUS = 180;           // px, distance to a Science Machine / Kitchen
const PLAYER_SPEED = 270;         // px/s (client: 4.5 px/frame at 60 fps)
const OFFLINE_PLAYER_TTL_MS = 24 * 60 * 60 * 1000;

// World generation version. Rooms created before v2 keep the old terrain so their saved entities still line up.
const GEN_VERSION = 2;
// v2 terrain: land starts as DESERT, then plains, forests and mountains are painted on as blobs.
// Counts are per 520x520 map at slider value 1.0 and scale with map area (forest/mountain also with their sliders).
const GEN_V2 = { plainsBlobs: 210, forestBlobs: 90, mountainBlobs: 50, plainsRadius: [14, 20] };

// true: a new player's starting inventory comes from their join message (needed for importing saves).
// false: everyone starts empty. Flip this off if you don't want players importing items.
const ALLOW_CLIENT_INVENTORY = true;

// Survival tuning (all simulated on the server so every screen agrees).
const HUNGER_PER_SECOND = 100 / 600;      // a full bar lasts 10 minutes at Hunger Speed 1.0
const STARVE_DAMAGE_PER_SECOND = 1;
const REGEN_HP_PER_SECOND = 1 / 3;        // only while hunger >= 50 and not recently hurt
const REGEN_DELAY_MS = 5000;
const DARKNESS_GRACE_SECONDS = 8;         // unprotected time at night before the darkness hurts
const DARKNESS_DAMAGE_PER_SECOND = 7;
const TORCH_FRAMES_PER_SECOND = 60;       // Light fuel is stored in 60 fps "frames".
const WINTER_BODY_HEAT_LOSS = 5;
const WINTER_HEAT_GAIN = 18;
const WINTER_COLD_DAMAGE_PER_SECOND = 4;
const THERMAL_STONE_HEAT_RATE = 12;
const THERMAL_STONE_COOL_RATE = 0.003;
const THERMAL_STONE_RANGE = 100;
const WOLF_FIRST_DAY = 4;
const WOLF_CAP_PER_PLAYER = 4;
const MAX_WOLVES = 12;
const WOLF_BITE_MS = 1000;

// A wave is 1 wolf per player (2 from day 9, 3 from day 14...) times the Wildlife setting. They are slower than you.
function wolfCountForDay(day, wildlife) {
    if (!(wildlife > 0) || day < WOLF_FIRST_DAY) return 0;
    const base = 1 + Math.floor((day - WOLF_FIRST_DAY) / 5);
    return Math.min(WOLF_CAP_PER_PLAYER, Math.max(1, Math.round(base * wildlife)));
}
function wolfHpForDay(day) { return Math.min(30, Math.round(10 + day * 1.5)); }
function wolfDamageForDay(day) { return Math.min(5, 3 + Math.floor(day / 8)); }
function wolfSpeedForDay(day) { return Math.min(150, (1.7 + 0.04 * day) * 60); }       // px/s (you run at 270)

// ----- ruin chests: better loot, and sometimes tools -----
// [type, min, max, weight]
const RUIN_LOOT_POOL = [
    ['wood', 8, 20, 10], ['stone', 6, 16, 9], ['twigs', 4, 10, 8], ['flint', 3, 8, 8],
    ['berries', 4, 10, 7], ['carrots', 3, 8, 6], ['acorn', 2, 5, 4], ['iron', 2, 6, 5], ['paste', 1, 3, 3]
];
// [type, weight]  (found tools are a bit worn: 50-100% durability)
const RUIN_TOOL_POOL = [['axe', 24], ['pickaxe', 24], ['torch', 22], ['shovel', 14], ['hammer', 16]];
const LOSE_INVENTORY_ON_DEATH = false;    // true: dying wipes your inventory

const SEED_SETTINGS_LENGTH = 12;
const SEED_RANDOM_LENGTH = 16;
const SEED_TOTAL_LENGTH = SEED_SETTINGS_LENGTH + SEED_RANDOM_LENGTH;
const SEED_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DEFAULT_WORLD_CONFIG = {
    resMult: 1, foodMult: 1, dayMult: 1, nightMult: 1, hungerMult: 1,
    worldSizeMult: 1, mapPreset: 'standard', oceanMult: 1, forestMult: 1,
    mountainMult: 1, wildlifeMult: 1, ruinsMult: 1, winterLengthDays: 8, mildLengthDays: 8,
    creative: false, cavesEnabled: true,
    firstPerson3D: false
};
const MAP_PRESETS = ['standard', 'inland', 'dry', 'riverlands', 'islands'];

const LIQUIDS = new Set(['OCEAN', 'LAKE', 'RIVER', 'BAY', 'GULF', 'SHALLOW_WATER']);
const SLOW_BIOMES = new Set(['LAKE', 'RIVER', 'SHALLOW_WATER']);

const PLAYER_EMOJIS = ['🤠', '😃', '🙃', '🙂', '😑', '😐', '🫤', '🌱', '🧱', '🐺', '🌙', '🦇', '💼', '🏆', '👑', '☠️'];
const ITEM_TYPES = new Set(['wood', 'stone', 'iron', 'amber', 'twigs', 'flint', 'axe', 'pickaxe', 'sword', 'wooden_shield', 'iron_shield', 'ivory_shield', 'torch', 'lantern', 'shovel', 'hammer', 'berries', 'carrots', 'paste', 'acorn', 'thermal_stone']);
const DURABILITY = { axe: 40, pickaxe: 40, sword: 160, wooden_shield: 225, iron_shield: 600, ivory_shield: 1500, shovel: 30, hammer: 80, torch: 3600, lantern: 8 * 60 * 60 };
const SHIELD_PROTECTION = { wooden_shield: 0.6, iron_shield: 0.8, ivory_shield: 0.9 };
const NON_STACKABLE_ITEMS = new Set(['thermal_stone', ...Object.keys(SHIELD_PROTECTION)]);
const FOOD = { berries: 15, carrots: 15, paste: 30 };
const FOOD_HEALING = { berries: 5, carrots: 5, paste: 10 };

// Costs mirror BUILDINGS in Alone.html. Keep both in sync when you change one.
const RECIPES = {
    // items (crafted into the inventory)
    axe:      { item: true, cost: { twigs: 2, flint: 1 } },
    pickaxe:  { item: true, cost: { twigs: 1, flint: 2 } },
    sword:    { item: true, cost: { iron: 5, twigs: 2 } },
    wooden_shield: { item: true, cost: { wood: 20 } },
    iron_shield: { item: true, cost: { wood: 10, iron: 10 } },
    torch:    { item: true, cost: { twigs: 2, wood: 5 } },
    lantern:  { item: true, cost: { iron: 2, twigs: 4, torch: 1 } },
    thermal_stone: { item: true, cost: { stone: 10, iron: 2 }, lab: true },
    shovel:   { item: true, cost: { twigs: 2, wood: 4, stone: 4 } },        // was 10 wood + 10 stone + 5 iron, lab only
    hammer:   { item: true, cost: { wood: 4, stone: 4, twigs: 2 } },        // breaks buildings
    paste:    { item: true, cost: { wood: 15 }, kitchen: true },
    // structures (placed in the world)
    campfire: { cost: { wood: 30 }, hp: 100, lifeSeconds: 360 },
    wall:     { cost: { wood: 5 }, hp: 500 },
    boat:     { cost: { wood: 12, flint: 2 }, hp: 100 },
    sign:     { cost: { wood: 4 }, hp: 200 },
    chest:    { cost: { wood: 12, stone: 8 }, hp: 400, lab: true },
    research: { cost: { wood: 40, stone: 40 }, hp: 400 },
    extractor:{ cost: { iron: 15, stone: 15 }, hp: 200, lab: true },
    cooking:  { cost: { wood: 15 }, hp: 300, lab: true },
    door:     { cost: { iron: 10, wood: 10 }, hp: 450, lab: true }
};

// Which tool each harvestable node needs (same rules as handleHarvest in the client).
const NODE_TOOL = {
    wood: 'axe', tree: 'axe',
    big_rock: 'pickaxe', flint_node: 'pickaxe', rock: 'pickaxe', stone: 'pickaxe', iron: 'pickaxe',
    stump: 'shovel'
};
const TOOL_HINT = { axe: 'Select an Axe (🪓) on the hotbar.', pickaxe: 'Select a Pickaxe (⛏️) on the hotbar.', shovel: 'Select a Shovel on the hotbar.' };

const idleInput = () => ({ up: false, down: false, left: false, right: false });
const emptyPlayerSlot = () => ({ type: null, count: 0, duration: 0, maxDuration: 0 });
const emptyChestSlot = () => ({ type: null, count: 0 });
const emptyChest = () => Array.from({ length: CHEST_SLOTS }, emptyChestSlot);

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function wrap(value, limit) { return value < 0 ? limit + value : value >= limit ? value - limit : value; }
// Names are rendered with innerHTML by the client's chat, so strip markup characters.
function cleanName(value, fallback, max) {
    const s = String(value ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, max);
    return s || fallback;
}
function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cleanColor(value, fallback) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(value)) ? String(value) : fallback;
}

function rollRuinLoot(rnd) {
    const slots = [];
    const total = RUIN_LOOT_POOL.reduce((sum, e) => sum + e[3], 0);
    const stacks = 4 + Math.floor(rnd() * 3);                 // 4-6 different stacks
    const used = new Set();
    for (let guard = 0; slots.length < stacks && guard < 60; guard++) {
        let roll = rnd() * total, entry = RUIN_LOOT_POOL[0];
        for (const e of RUIN_LOOT_POOL) { roll -= e[3]; if (roll <= 0) { entry = e; break; } }
        if (used.has(entry[0])) continue;
        used.add(entry[0]);
        slots.push({ type: entry[0], count: entry[1] + Math.floor(rnd() * (entry[2] - entry[1] + 1)) });
    }

    // 45% of chests also hold a tool; a third of those hold two.
    const toolCount = rnd() < 0.45 ? (rnd() < 0.33 ? 2 : 1) : 0;
    const toolTotal = RUIN_TOOL_POOL.reduce((sum, e) => sum + e[1], 0);
    for (let i = 0; i < toolCount; i++) {
        let roll = rnd() * toolTotal, type = RUIN_TOOL_POOL[0][0];
        for (const [name, weight] of RUIN_TOOL_POOL) { roll -= weight; if (roll <= 0) { type = name; break; } }
        const max = DURABILITY[type];
        slots.push({ type, count: 1, duration: Math.max(1, Math.round(max * (0.5 + rnd() * 0.5))), maxDuration: max });
    }
    return slots;
}

function packNode(n) {
    return [n.id, n.x, n.y, n.type, n.icon ?? null, n.hp ?? null, n.maxHp ?? null, n.pickup ? 1 : 0, n.plantedDay ?? null, n.biome ?? null, n.shakes ?? null, n.shakeDay ?? null];
}
function unpackNode(a) {
    const n = { id: a[0], x: a[1], y: a[2], type: a[3], icon: a[4] };
    if (a[5] != null) n.hp = a[5];
    if (a[6] != null) n.maxHp = a[6];
    if (a[7]) n.pickup = true;
    if (a[8] != null) n.plantedDay = a[8];
    if (a[9] != null) n.biome = a[9];
    if (a[10] != null) n.shakes = a[10];
    if (a[11] != null) n.shakeDay = a[11];
    return n;
}


export class MyDurableObject {

    constructor(state, env) {
        this.state = state;
        this.env = env;

        this.sessions = new Map();          // WebSocket -> { playerId }

        this.roomId = null;
        this.roomName = '';
        this.visibility = 'public';
        this.ownerId = null;
        this.achievementsDisabled = false;
        this.regenConfirmations = new Map();
        this.worldImportBuffers = new Map();

        this.seed = '';
        this.worldConfig = { ...DEFAULT_WORLD_CONFIG };
        this.worldSeed = 0;
        this.currentRandomState = 0;

        this.ROWS = 0;
        this.COLS = 0;
        this.worldWidth = 0;
        this.worldHeight = 0;
        this.worldGrid = [];
        this.activeLayer = 'surface';
        this.worldLayers = { surface: null, caves: null };
        this.discoveryMaps = { surface: null, caves: null };
        this.savedDiscoveryMaps = null;
        this.cavesEnabled = true;
        this.gregDefeated = false;
        this.gregDefeatedDay = null;
        this.alphaWolfDefeated = false;
        this.worldTokenInventory = { ivory: 0, wolf: 0 };
        this.worldTokenDrops = { ivory: false, wolf: false };
        this.alphaWolfStartDay = null;
        this.gregArena = null;
        this.gregArenaLocked = false;
        this.caveResourcesVersion = 0;
        this.creativeFreezeTime = false;
        this.worldBuilt = false;            // terrain grid exists in memory
        this.entitiesGenerated = false;     // the initial trees/mobs/ruins were generated once, ever
        this.spawn = { x: 0, y: 0 };

        this.resourceNodes = [];
        this.nodeById = new Map();
        this.nextNodeId = 1;
        this.genVersion = GEN_VERSION;
        this.nextMobId = 1;
        this.mobs = [];
        this.buildings = [];
        this.wallCells = new Set();

        this.players = new Map();
        this.dayCount = 1;
        this.gameTime = 0;                  // seconds into the current day cycle
        this.season = 'mild';
        this.seasonDaysRemaining = 8;

        this.lastTick = Date.now();
        this.lastPersist = 0;
        this.lastMobSync = 0;
        this.lastPhase = 'DAY';
        this.tickTimer = null;
        this.persistChain = Promise.resolve();
        this.dirty = { meta: false, players: false, nodes: false, buildings: false, mobs: false, caves: false, discovery: false };
        this.nodePatchSet = new Map();
        this.nodePatchDel = new Set();
        this.buildingPatchSet = new Map();
        this.buildingPatchDel = new Set();
        this.official = false;
        this.errorThrottle = new Map();

        this.ready = this.state.blockConcurrencyWhile(() => this.restore());
    }


    // =========================================================
    // HTTP
    // =========================================================

    async fetch(request) {
        await this.ready;
        const url = new URL(request.url);

        // The router forwards ?room=CODE (websocket) and ?code=CODE (status checks): that is how we learn our own name.
        const roomParam = url.searchParams.get('room') || url.searchParams.get('code') || '';
        if (roomParam === OFFICIAL_ROOM_CODE && !this.official) {
            this.official = true;
            this.dirty.meta = true;
        }

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: this.corsHeaders() });
        }

        // Registry endpoints (the router sends these to '__room_registry__').
        if (url.searchParams.has('rooms')) return this.registryList();
        if (url.searchParams.has('create')) return this.registryCreate(request);
        if (url.searchParams.has('prune')) return this.registryPrune(url);

        if (url.searchParams.has('status')) {
            return this.json({ roomId: this.roomId, players: this.onlineCount() });
        }

        if (url.pathname === '/ws') {
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('WebSocket upgrade required', { status: 426, headers: this.corsHeaders() });
            }
            const pair = new WebSocketPair();
            const client = pair[0];
            const server = pair[1];
            this.state.acceptWebSocket(server);
            this.sessions.set(server, { playerId: null });
            return new Response(null, { status: 101, webSocket: client });
        }

        return this.json({ roomId: this.roomId, players: this.onlineCount() });
    }


    // =========================================================
    // ROOM REGISTRY (only used by the '__room_registry__' object)
    // =========================================================

    async registryList() {
        const registry = (await this.state.storage.get('registry')) || {};
        const rooms = Object.values(registry)
            .filter(r => r.visibility === 'public')
            .map(r => ({ code: r.code, name: r.name, players: 0, maxPlayers: MAX_PLAYERS }));
        return this.json(rooms);
    }

    async registryCreate(request) {
        if (request.method !== 'POST') return this.json({ error: 'POST required.' }, 405);

        let body;
        try { body = await request.json(); } catch { return this.json({ error: 'Invalid JSON.' }, 400); }

        const registry = (await this.state.storage.get('registry')) || {};

        // Keep the registry bounded: drop the oldest entries.
        const entries = Object.values(registry).sort((a, b) => a.createdAt - b.createdAt);
        while (entries.length >= 300) delete registry[entries.shift().code];

        let code;
        do { code = this.randomCode(6); } while (registry[code]);

        const room = {
            code,
            name: cleanName(body?.name, 'Survivor game', 40),
            visibility: body?.visibility === 'private' ? 'private' : 'public',
            createdAt: Date.now()
        };
        registry[code] = room;
        await this.state.storage.put('registry', registry);

        return this.json({ code: room.code, name: room.name, visibility: room.visibility });
    }

    async registryPrune(url) {
        const codes = String(url.searchParams.get('prune') || '').split(',').map(s => s.trim()).filter(Boolean);
        if (codes.length) {
            const registry = (await this.state.storage.get('registry')) || {};
            const now = Date.now();
            for (const code of codes) {
                // A room that was just created has no players until its creator finishes connecting,
                // so the router's "empty room" cleanup must not delete it during that window.
                if (registry[code] && now - registry[code].createdAt < 120000) continue;
                delete registry[code];
            }
            await this.state.storage.put('registry', registry);
        }
        return this.json({ ok: true });
    }

    randomCode(length) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        let out = '';
        for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
        return out;
    }


    // =========================================================
    // STORAGE (chunked so no single value gets too large)
    // =========================================================

    async readList(name) {
        const count = (await this.state.storage.get(`${name}#n`)) || 0;
        const out = [];
        for (let start = 0; start < count; start += 100) {
            const keys = [];
            for (let i = start; i < Math.min(count, start + 100); i++) keys.push(`${name}#${i}`);
            const got = await this.state.storage.get(keys);
            for (const key of keys) {
                const chunk = got.get(key);
                if (Array.isArray(chunk)) for (const item of chunk) out.push(item);
            }
        }
        return out;
    }

    getDiscoveryMap(layer = this.activeLayer) {
        const mapLength = this.COLS * this.ROWS;
        if (!mapLength) return new Uint8Array();
        if (!this.discoveryMaps[layer] || this.discoveryMaps[layer].length !== mapLength) {
            let map = new Uint8Array(mapLength);
            const encoded = this.savedDiscoveryMaps?.[layer];
            if (typeof encoded === 'string') {
                try {
                    const binary = atob(encoded);
                    if (binary.length === mapLength) {
                        map = Uint8Array.from(binary, char => char.charCodeAt(0));
                    } else {
                        console.error(`Stored ${layer} map discovery data has an invalid length.`);
                    }
                } catch (error) {
                    console.error(`Could not restore ${layer} map discovery data:`, error);
                }
            }
            this.discoveryMaps[layer] = map;
        }
        return this.discoveryMaps[layer];
    }

    encodeDiscoveryMap(map) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < map.length; i += chunkSize) {
            binary += String.fromCharCode(...map.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    decodeDiscoveryMap(encoded, layer) {
        if (typeof encoded !== 'string') return new Uint8Array(this.COLS * this.ROWS);
        let binary;
        try {
            binary = atob(encoded);
        } catch {
            throw new Error(`Invalid ${layer} map discovery data.`);
        }
        if (binary.length !== this.COLS * this.ROWS) {
            throw new Error(`Invalid ${layer} map discovery data length.`);
        }
        return Uint8Array.from(binary, char => char.charCodeAt(0));
    }

    handleDiscoveredUpdate(ws, message) {
        const player = this.getSessionPlayer(ws);
        if (!player || !Array.isArray(message.tiles) || message.tiles.length > 10000) return;
        const layer = this.worldLayerForPlayer(player);
        const map = this.getDiscoveryMap(layer);
        const changed = [];
        for (const value of message.tiles) {
            if (!Number.isInteger(value) || value < 0 || value >= map.length || map[value]) continue;
            map[value] = 1;
            changed.push(value);
        }
        if (!changed.length) return;
        this.dirty.discovery = true;
        this.broadcast({ type: 'map:tiles', layer, tiles: changed });
        this.flush(false);
    }

    async writeList(name, list, chunkSize) {
        const previous = (await this.state.storage.get(`${name}#n`)) || 0;
        const chunks = Math.ceil(list.length / chunkSize);
        const entries = { [`${name}#n`]: chunks };
        for (let i = 0; i < chunks; i++) entries[`${name}#${i}`] = list.slice(i * chunkSize, (i + 1) * chunkSize);

        const keys = Object.keys(entries);
        for (let i = 0; i < keys.length; i += 100) {
            const batch = {};
            for (const key of keys.slice(i, i + 100)) batch[key] = entries[key];
            await this.state.storage.put(batch);
        }

        if (previous > chunks) {
            const stale = [];
            for (let i = chunks; i < previous; i++) stale.push(`${name}#${i}`);
            for (let i = 0; i < stale.length; i += 100) await this.state.storage.delete(stale.slice(i, i + 100));
        }
    }

    markAllDirty() {
        for (const key of Object.keys(this.dirty)) this.dirty[key] = true;
    }

    // Serialised so two writes never interleave.
    flush(force = false) {
        this.persistChain = this.persistChain
            .then(() => this.persistNow(force))
            .catch(err => console.error('persist failed:', err));
        return this.persistChain;
    }

    async persistNow(force) {
        const now = Date.now();
        if (!force && now - this.lastPersist < PERSIST_INTERVAL_MS) return;
        const d = this.dirty;
        if (!force && !Object.values(d).some(Boolean)) return;
        this.dirty = { meta: false, players: false, nodes: false, buildings: false, mobs: false, caves: false, discovery: false };
        this.lastPersist = now;

        if (d.meta || force) {
            await this.state.storage.put('meta', {
                roomId: this.roomId,
                roomName: this.roomName,
                visibility: this.visibility,
                ownerId: this.ownerId,
                seed: this.seed,
                dayCount: this.dayCount,
                gameTime: this.gameTime,
                season: this.season,
                seasonDaysRemaining: this.seasonDaysRemaining,
                winterLengthDays: this.worldConfig.winterLengthDays,
                mildLengthDays: this.worldConfig.mildLengthDays,
                nextNodeId: this.nextNodeId,
                nextMobId: this.nextMobId,
                genVersion: this.genVersion,
                official: this.official,
                entitiesGenerated: this.entitiesGenerated,
                cavesEnabled: this.cavesEnabled,
                firstPerson3D: !!this.worldConfig.firstPerson3D,
                achievementsDisabled: this.achievementsDisabled,
                gregDefeated: this.gregDefeated,
                gregDefeatedDay: this.gregDefeatedDay,
                alphaWolfDefeated: this.alphaWolfDefeated,
                worldTokenInventory: this.worldTokenInventory,
                worldTokenDrops: this.worldTokenDrops,
                alphaWolfStartDay: this.alphaWolfStartDay,
                gregArena: this.gregArena,
                gregArenaLocked: this.gregArenaLocked,
                caveResourcesVersion: this.caveResourcesVersion,
                creativeFreezeTime: this.creativeFreezeTime
            });
        }
        if (d.players) {
            await this.writeList('players', Array.from(this.players.values()).map(p => this.storedPlayer(p)), 20);
        }
        if (d.nodes) await this.writeList('nodes', this.resourceNodes.map(packNode), 800);
        if (d.buildings) await this.writeList('buildings', this.buildings, 300);
        if (d.mobs) await this.writeList('mobs', this.mobs.filter(m => m.type !== 'wolf' || m.summonedByAlpha), 300);
        if (d.caves || force) {
            const caves = this.worldLayers.caves;
            if (caves) {
                await this.writeList('cave_nodes', caves.resourceNodes.map(packNode), 800);
                await this.writeList('cave_buildings', caves.buildings, 300);
                await this.writeList('cave_mobs', caves.mobs.filter(m => m.type !== 'wolf' || m.summonedByAlpha), 300);
            }
        }
        if (d.discovery || force) {
            for (const layer of ['surface', 'caves']) {
                const encoded = this.encodeDiscoveryMap(this.getDiscoveryMap(layer));
                const chunks = encoded.match(/.{1,48000}/g) || [];
                await this.writeList(`discovery_${layer}`, chunks, 1);
            }
        }
    }

    async restore() {
        const meta = await this.state.storage.get('meta');

        if (meta) {
            this.roomId = meta.roomId ?? null;
            this.roomName = meta.roomName || '';
            this.visibility = meta.visibility || 'public';
            this.ownerId = meta.ownerId || null;
            this.seed = meta.seed || '';
            this.dayCount = meta.dayCount || 1;
            this.gameTime = meta.gameTime || 0;
            this.season = meta.season === 'winter' ? 'winter' : 'mild';
            this.seasonDaysRemaining = Number.isInteger(meta.seasonDaysRemaining)
                ? clamp(meta.seasonDaysRemaining, 0, 30)
                : 8;
            this.nextNodeId = meta.nextNodeId || 1;
            this.nextMobId = meta.nextMobId || 1;
            this.genVersion = meta.genVersion || 1;      // rooms from before v2 keep their old terrain
            this.official = !!meta.official;
            this.entitiesGenerated = !!meta.entitiesGenerated;

            if (this.seed) {
                try {
                    this.worldConfig = this.decodeWorldSettings(this.seed);
                    this.worldConfig.firstPerson3D = !!(meta.firstPerson3D ?? meta.thirdPerson3D);
                    this.worldConfig = this.normalizeWorldConfig({
                        ...this.worldConfig,
                        winterLengthDays: meta.winterLengthDays ?? DEFAULT_WORLD_CONFIG.winterLengthDays,
                        mildLengthDays: meta.mildLengthDays ?? DEFAULT_WORLD_CONFIG.mildLengthDays
                    });
                } catch (err) {
                    console.error('Stored seed is invalid:', err);
                    this.seed = '';
                }
            }

            this.normalizeSeasonSchedule();
            this.cavesEnabled = meta.cavesEnabled !== false;
            this.gregDefeated = !!meta.gregDefeated;
            this.alphaWolfDefeated = !!meta.alphaWolfDefeated;
            this.worldTokenInventory = {
                ivory: meta.worldTokenInventory?.ivory === 1 ? 1 : 0,
                wolf: meta.worldTokenInventory?.wolf === 1 ? 1 : 0
            };
            this.worldTokenDrops = {
                ivory: !!meta.worldTokenDrops?.ivory || this.worldTokenInventory.ivory === 1,
                wolf: !!meta.worldTokenDrops?.wolf || this.worldTokenInventory.wolf === 1
            };
            this.alphaWolfStartDay = Number.isInteger(meta.alphaWolfStartDay) && meta.alphaWolfStartDay >= 9 && meta.alphaWolfStartDay <= 12
                ? meta.alphaWolfStartDay
                : null;
            this.gregArenaLocked = !!meta.gregArenaLocked && !this.gregDefeated;
            this.gregDefeatedDay = this.gregDefeated
                ? (Number.isInteger(meta.gregDefeatedDay) && meta.gregDefeatedDay > 0 ? meta.gregDefeatedDay : this.dayCount)
                : null;
            this.gregArena = meta.gregArena && Number.isInteger(meta.gregArena.x) && Number.isInteger(meta.gregArena.y)
                ? meta.gregArena
                : null;
            this.caveResourcesVersion = Number(meta.caveResourcesVersion) || 0;
            this.creativeFreezeTime = !!meta.creativeFreezeTime;
            this.achievementsDisabled = !!meta.achievementsDisabled || !!this.worldConfig.creative;
            const [players, nodes, buildings, mobs, caveNodes, caveBuildings, caveMobs, surfaceDiscovery, caveDiscovery] = await Promise.all([
                this.readList('players'), this.readList('nodes'), this.readList('buildings'), this.readList('mobs'),
                this.readList('cave_nodes'), this.readList('cave_buildings'), this.readList('cave_mobs'),
                this.readList('discovery_surface'), this.readList('discovery_caves')
            ]);
            this.savedDiscoveryMaps = {
                surface: surfaceDiscovery.length ? surfaceDiscovery.join('') : null,
                caves: caveDiscovery.length ? caveDiscovery.join('') : null
            };
            this.savedCaveEntities = { nodes: caveNodes, buildings: caveBuildings, mobs: caveMobs };

            for (const p of players) {
                if (p?.id) {
                    this.players.set(p.id, {
                        ...p,
                        bodyHeat: clamp(Number(p.bodyHeat ?? 100), 0, 100),
                        shield: this.sanitizeShield(p.shield),
                        firstPerson3D: typeof p.firstPerson3D === 'boolean' ? p.firstPerson3D : typeof p.thirdPerson3D === 'boolean' ? p.thirdPerson3D : null,
                        yaw: Number.isFinite(p.yaw) ? p.yaw : -Math.PI / 2,
                        isOp: !!p.isOp || p.id === this.ownerId,
                        speedPercent: clamp(Number(p.speedPercent ?? 100), 0, 100),
                        creativePanelEnabled: !!p.creativePanelEnabled,
                        ohkoEnabled: !!p.ohkoEnabled,
                        creativeSpeedMult: clamp(Number(p.creativeSpeedMult ?? 1), 0.5, 8),
                        creativeNoclip: !!p.creativeNoclip,
                        creativeInvulnerable: p.creativeInvulnerable !== false,
                        input: idleInput(),
                        online: false,
                        selected: 0,
                        exposure: 0,
                        lastDamageAt: 0,
                        seenMobs: new Map()
                    });
                }
            }
            this.resourceNodes = nodes.map(unpackNode);
            this.buildings = buildings;
            for (const b of this.buildings) if (!b.id) b.id = crypto.randomUUID();
            this.mobs = mobs;
            for (const m of this.mobs) if (m.id == null) m.id = this.nextMobId++;
            this.lastPhase = this.phaseInfo().phase;
        }

        // Sockets that survived hibernation keep their player id in an attachment.
        for (const ws of this.state.getWebSockets()) {
            let attachment = null;
            try { attachment = ws.deserializeAttachment(); } catch {}
            if (attachment?.playerId) this.sessions.set(ws, { playerId: attachment.playerId });
        }
        for (const session of this.sessions.values()) {
            const p = this.players.get(session.playerId);
            if (p) p.online = true;
        }

        if (this.sessions.size > 0 && this.seed) {
            try {
                this.ensureWorld();
            } catch (err) {
                console.error('World rebuild failed:', err);
                return;
            }
            this.startTicking();
        }
    }


    // =========================================================
    // WEBSOCKET EVENTS
    // =========================================================

    async webSocketMessage(ws, message) {
        let data;
        try {
            const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
            if (text.length > 60000) return;
            data = JSON.parse(text);
        } catch {
            this.send(ws, { type: 'error', message: 'Invalid message.' });
            return;
        }

        try {
            switch (data.type) {
                case 'join': await this.handleJoin(ws, data); break;
                case 'input:update': this.handleInputUpdate(ws, data); break;
                case 'player:update': this.handlePlayerUpdate(ws, data); break;
                case 'chat:send': this.handleChat(ws, data); break;
                case 'world:action': await this.handleWorldAction(ws, data); break;
                case 'admin:command': await this.handleAdminCommand(ws, data); break;
                case 'achievement:disable': await this.handleAchievementDisable(ws); break;
                case 'discovered:update': this.handleDiscoveredUpdate(ws, data); break;
                case 'leave': await this.removeSocket(ws); break;
                default:
                    this.send(ws, { type: 'error', message: `Unknown message type: ${data.type}` });
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            this.send(ws, { type: 'error', message: error?.message || 'Server error.' });
        }
    }

    async webSocketClose(ws) { await this.removeSocket(ws); }

    disableAchievements(reason) {
        if (this.achievementsDisabled) return;
        this.achievementsDisabled = true;
        this.dirty.meta = true;
        this.broadcast({ type: 'achievements:disabled', reason, roomId: this.roomId });
    }

    async handleAchievementDisable(ws) {
        if (!this.getSessionPlayer(ws)) return;
        this.disableAchievements('admin-console');
        await this.flush(true);
    }
    async webSocketError(ws) { await this.removeSocket(ws); }

    getSessionPlayer(ws) {
        let session = this.sessions.get(ws);
        if (!session) {
            let attachment = null;
            try { attachment = ws.deserializeAttachment(); } catch {}
            if (attachment?.playerId) {
                session = { playerId: attachment.playerId };
                this.sessions.set(ws, session);
            }
        }
        if (!session?.playerId) return null;
        return this.players.get(session.playerId) || null;
    }


    // =========================================================
    // JOIN
    // =========================================================

    async handleJoin(ws, message) {
        const playerId = String(message.playerId || crypto.randomUUID()).slice(0, 64);
        const existing = this.players.get(playerId);

        // A character is claimed by the secret token its owner's browser keeps. The id alone (which every client
        // can see) is not enough to take it over. Checked before anything else so nobody can kick the owner off.
        const token = typeof message.token === 'string' ? message.token.slice(0, 64) : '';
        if (existing && existing.token && existing.token !== token) {
            this.send(ws, { type: 'error', message: 'That character belongs to someone else.' });
            try { ws.close(1008, 'Character belongs to someone else'); } catch {}
            return;
        }

        if (this.onlineCount() >= MAX_PLAYERS && !existing?.online) {
            this.send(ws, { type: 'error', message: 'Room is full.' });
            try { ws.close(1008, 'Room full'); } catch {}
            return;
        }

        // First player defines the world.
        if (!this.seed) {
            const incomingSeed = this.normalizeSeed(message.seed);
            const incomingConfig = this.normalizeWorldConfig(message.worldConfig || message.config);
            // The public server always gets the same settings, whatever the first visitor picked.
            const seed = this.official ? OFFICIAL_SEED : (incomingSeed || this.createFallbackSeed(incomingConfig));

            let config;
            try {
                config = this.decodeWorldSettings(seed);
            } catch (error) {
                this.send(ws, { type: 'error', message: `Invalid world seed: ${error.message}` });
                try { ws.close(1008, 'Invalid world seed'); } catch {}
                return;
            }

            this.seed = seed;
            this.genVersion = GEN_VERSION;
            this.worldConfig = config;
            this.worldConfig = this.normalizeWorldConfig({
                ...this.worldConfig,
                winterLengthDays: this.official
                    ? DEFAULT_WORLD_CONFIG.winterLengthDays
                    : incomingConfig.winterLengthDays,
                mildLengthDays: this.official
                    ? DEFAULT_WORLD_CONFIG.mildLengthDays
                    : incomingConfig.mildLengthDays
            });
            this.initializeSeasonSchedule();
            this.worldConfig.firstPerson3D = !this.official && incomingConfig.firstPerson3D;
            this.achievementsDisabled = !!config.creative;
            this.roomId = this.official ? OFFICIAL_ROOM_CODE : String(message.roomId || 'public').slice(0, 32);
            this.roomName = this.official ? OFFICIAL_ROOM_NAME : cleanName(message.roomName, '', 80);
            this.visibility = this.official ? 'public' : (message.visibility === 'private' ? 'private' : 'public');
            this.markAllDirty();
        }

        try {
            this.ensureWorld();
        } catch (error) {
            console.error('World generation failed:', error);
            this.send(ws, { type: 'error', message: 'World generation failed.' });
            try { ws.close(1011, 'World generation failed'); } catch {}
            return;
        }

        // Same player reconnecting (page reload): drop the stale socket.
        for (const [otherWs, session] of this.sessions) {
            if (otherWs !== ws && session.playerId === playerId) {
                this.sessions.delete(otherWs);
                try { otherWs.close(1000, 'Replaced by a new connection'); } catch {}
            }
        }

        this.pruneOfflinePlayers();

        if (!this.ownerId && !this.official) {
            this.ownerId = playerId;
            this.dirty.meta = true;
        }

        let player = existing;
        if (!player) {
            player = this.sanitizePlayer(message.player, playerId);
            player.x = this.spawn.x;
            player.y = this.spawn.y;
            this.players.set(playerId, player);
        } else {
            // Reconnect: keep authoritative state, refresh cosmetics only.
            player.name = cleanName(message.player?.name, player.name, 16);
            player.emoji = PLAYER_EMOJIS.includes(message.player?.emoji) ? message.player.emoji : player.emoji;
            player.color = cleanColor(message.player?.color, player.color);
        }
        if (typeof player.firstPerson3D !== 'boolean') {
            player.firstPerson3D = typeof message.player?.firstPerson3D === 'boolean'
                ? message.player.firstPerson3D
                : !!this.worldConfig.firstPerson3D;
        }
        if (Number.isFinite(message.player?.yaw)) {
            player.yaw = ((message.player.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        }
        if (!player.token) player.token = token;
        if (player.id === this.ownerId) player.isOp = true;
        player.online = true;
        if (player.layer === 'caves' && (!this.cavesEnabled || !this.worldLayers.caves)) player.layer = 'surface';
        player.input = idleInput();
        player.lastSeen = Date.now();

        this.sessions.set(ws, { playerId });
        try { ws.serializeAttachment({ playerId }); } catch {}

        this.send(ws, {
            type: 'room:init',
            roomId: this.roomId,
            roomName: this.roomName,
            visibility: this.visibility,
            isOp: !!player.isOp,
            seed: this.seed,
            worldConfig: this.worldConfig,
            achievementsDisabled: this.achievementsDisabled,
            world: this.getWorldSnapshot(player),
            playerId,
            isOwner: player.id === this.ownerId,
            playerCount: this.onlineCount(),
            players: this.onlinePlayers()
                .filter(p => this.worldLayerForPlayer(p) === this.worldLayerForPlayer(player))
                .map(p => this.publicPlayer(p))
        });

        // Full (private) state for the joining player: inventory, hp, hunger.
        this.sendPlayer(player);

        this.broadcast({ type: 'player:joined', player: this.publicPlayer(player) }, ws);

        this.dirty.players = true;
        this.dirty.meta = true;
        await this.flush(true);
        this.startTicking();
    }


    // =========================================================
    // PLAYER MESSAGES
    // =========================================================

    // Position is server-controlled now; clients may only change cosmetics.
    handlePlayerUpdate(ws, message) {
        const player = this.getSessionPlayer(ws);
        if (!player) return;
        const incoming = message.player || message.state;
        if (!incoming) return;

        if (PLAYER_EMOJIS.includes(incoming.emoji)) player.emoji = incoming.emoji;
        if (typeof incoming.color === 'string') player.color = cleanColor(incoming.color, player.color);
        if (typeof incoming.name === 'string') player.name = cleanName(incoming.name, player.name, 16);
        this.dirty.players = true;
    }

    handleInputUpdate(ws, message) {
        const player = this.getSessionPlayer(ws);
        if (!player) return;

        const input = message.input || {};
        const k = input.keys || {};
        player.input = {
            up: !!(input.up || k.KeyW || k.ArrowUp),
            down: !!(input.down || k.KeyS || k.ArrowDown),
            left: !!(input.left || k.KeyA || k.ArrowLeft),
            right: !!(input.right || k.KeyD || k.ArrowRight)
        };
        if (Number.isFinite(input.yaw)) player.yaw = ((input.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        // The hotbar slot the player is holding (tools, torches and weapons use it).
        if (Number.isInteger(input.selected) && input.selected >= 0 && input.selected < INVENTORY_SLOTS) {
            player.selected = input.selected;
        }
    }

    handleChat(ws, message) {
        const player = this.getSessionPlayer(ws);
        if (!player) return;

        const now = Date.now();
        if (now - (player.chatAt || 0) < 400) return;
        player.chatAt = now;

        const text = escapeHtml(String(message.text || '').trim().slice(0, 180));
        if (!text) return;

        // The sender already shows their own line locally, so skip them.
        this.broadcast({ type: 'chat:message', name: player.name || 'PLAYER', text, color: player.color || '#fff' }, ws);
    }

    async handleAdminCommand(ws, message) {
        const player = this.getSessionPlayer(ws);
        if (!player) return;

        const commandLine = String(message.command || '').trim().slice(0, 300);
        if (commandLine) {
            this.disableAchievements('admin-console');
            await this.flush(true);
        }
        const [command = '', ...args] = commandLine.split(/\s+/);
        const reply = text => this.sendToPlayer(player.id, { type: 'admin:result', text: String(text) });

        if (command.toLowerCase() === 'auth') {
            const configuredToken = typeof this.env?.OFFICIAL_OP_TOKEN === 'string'
                ? this.env.OFFICIAL_OP_TOKEN
                : '';
            if (!this.official || !configuredToken || args.join(' ') !== configuredToken) {
                return reply('Authentication failed. Official-server admin access must be configured by the server operator.');
            }
            player.isOp = true;
            this.dirty.players = true;
            this.sendPlayer(player);
            this.sendToPlayer(player.id, { type: 'admin:status', isOp: true });
            return reply('Admin access granted for this character.');
        }

        if (!player.isOp) return reply('Admin permission denied.');
        if (!command) return;

        switch (command.toLowerCase()) {
            case 'help':
                return reply('Commands: help, players, give <item> <count> [durability 0-100], speed <0-100>, op <player name>, creative <player name>, ohko <player name>, firstperson <player name> [on|off|toggle], heal [player name], tp <player name>, day, night, say <message>, regen, confirm. creative, ohko, and firstperson toggle for the named player by default. Official admins: auth <server token>.');
            case 'players':
                return reply(this.onlinePlayers().map(p => `${p.name}${p.isOp ? ' (OP)' : ''}`).join(', ') || 'No players online.');
            case 'give': {
                const type = String(args[0] || '').toLowerCase();
                const count = Number(args[1]);
                const durabilityPercent = args[2] === undefined ? 100 : Number(args[2]);
                if (!ITEM_TYPES.has(type) || !Number.isInteger(count) || count < 1 || count > 999 ||
                    !Number.isFinite(durabilityPercent) || durabilityPercent < 0 || durabilityPercent > 100) {
                    return reply('Usage: give <item> <count> [durability 0-100].');
                }
                if (DURABILITY[type] && count > INVENTORY_SLOTS) return reply(`Tool count must be ${INVENTORY_SLOTS} or less.`);
                if (!this.canGive(player, type, count)) return reply('Not enough inventory space.');
                this.giveItem(player, type, count);
                if (DURABILITY[type]) {
                    for (const slot of player.inventory.filter(item => item.type === type).slice(-count)) {
                        slot.duration = Math.max(1, Math.round(slot.maxDuration * durabilityPercent / 100));
                    }
                }
                this.sendPlayer(player);
                return reply(`Gave ${count} ${type}${DURABILITY[type] ? ` at ${durabilityPercent}% durability` : ''}.`);
            }
            case 'speed': {
                const percent = Number(args[0]);
                if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
                    return reply('Usage: speed <0-100>. This is a percentage of normal movement speed.');
                }
                player.speedPercent = percent;
                this.sendPlayer(player);
                return reply(`Movement speed set to ${percent}% of normal.`);
            }
            case 'op': {
                const name = args.join(' ').toLowerCase();
                const target = Array.from(this.players.values()).find(p => p.name.toLowerCase() === name);
                if (!target) return reply('Player not found. Use players to see exact names.');
                target.isOp = true;
                this.dirty.players = true;
                this.sendPlayer(target);
                this.sendToPlayer(target.id, { type: 'admin:status', isOp: true });
                return reply(`${target.name} is now an admin.`);
            }
            case 'creative':
            case 'ohko': {
                const name = args.join(' ').trim().toLocaleLowerCase();
                if (!name) return reply(`Usage: ${command.toLowerCase()} <player name>.`);
                const target = Array.from(this.players.values()).find(p => p.name.toLocaleLowerCase() === name);
                if (!target) return reply('Player not found. Use players to see exact names.');
                const property = command.toLowerCase() === 'creative' ? 'creativePanelEnabled' : 'ohkoEnabled';
                target[property] = !target[property];
                this.sendPlayer(target);
                const state = target[property] ? 'enabled' : 'disabled';
                return reply(`${command.toLowerCase() === 'creative' ? 'Creative panel' : 'OHKO mode'} ${state} for ${target.name}.`);
            }
            case 'firstperson':
            case 'thirdperson': {
                const match = String(message.command || '').trim().match(/^(?:firstperson|thirdperson)\s+(.+?)(?:\s+(on|off|toggle))?$/i);
                const name = match?.[1]?.trim().toLocaleLowerCase();
                if (!name) return reply('Usage: firstperson <player name> [on|off|toggle].');
                const target = Array.from(this.players.values()).find(p => p.name.toLocaleLowerCase() === name);
                if (!target) return reply('Player not found. Use players to see exact names.');
                const requested = (match[2] || 'toggle').toLowerCase();
                const current = typeof target.firstPerson3D === 'boolean'
                    ? target.firstPerson3D
                    : !!this.worldConfig.firstPerson3D;
                target.firstPerson3D = requested === 'toggle' ? !current : requested === 'on';
                this.sendPlayer(target);
                this.broadcast({ type: 'player:update', playerId: target.id, player: this.publicPlayer(target) });
                return reply(`First-person mode ${target.firstPerson3D ? 'enabled' : 'disabled'} for ${target.name}.`);
            }
            case 'heal': {
                const name = args.join(' ').toLowerCase();
                const target = name
                    ? Array.from(this.players.values()).find(p => p.name.toLowerCase() === name)
                    : player;
                if (!target) return reply('Player not found. Use players to see exact names.');
                target.hp = 100;
                target.hunger = 100;
                target.isDowned = false;
                this.sendPlayer(target);
                return reply(`${target.name} restored to full health and hunger.`);
            }
            case 'tp': {
                const name = args.join(' ').toLowerCase();
                const target = Array.from(this.players.values()).find(p => p.name.toLowerCase() === name);
                if (!target) return reply('Player not found. Use players to see exact names.');
                player.x = target.x;
                player.y = target.y;
                player.inBoat = target.inBoat;
                player.boatId = target.boatId;
                this.sendPlayer(player);
                return reply(`Teleported to ${target.name}.`);
            }
            case 'day':
            case 'night': {
                const { DAY, DUSK } = this.cycleLengths();
                this.gameTime = command.toLowerCase() === 'day' ? 0 : DAY + DUSK;
                this.lastPhase = command.toLowerCase() === 'night' ? 'DUSK' : 'NIGHT';
                this.dirty.meta = true;
                return reply(`Time changed to ${command.toLowerCase()}.`);
            }
            case 'say': {
                const text = escapeHtml(args.join(' ').trim().slice(0, 180));
                if (!text) return reply('Usage: say <message>.');
                this.broadcast({ type: 'chat:message', name: 'ADMIN', text, color: '#ffcc00' });
                return reply('Announcement sent.');
            }
            case 'regen':
                this.regenConfirmations.set(player.id, { count: 0, expiresAt: Date.now() + 120000 });
                return reply('DANGER: This replaces the world and resets every player’s inventory and status. Type "confirm" three times within 2 minutes to proceed.');
            case 'confirm': {
                const pending = this.regenConfirmations.get(player.id);
                if (!pending || pending.expiresAt < Date.now()) {
                    this.regenConfirmations.delete(player.id);
                    return reply('No active regeneration request. Type regen to start one.');
                }
                pending.count++;
                if (pending.count < 3) return reply(`Regeneration confirmation ${pending.count}/3. Type confirm again to continue.`);
                this.regenConfirmations.delete(player.id);
                await this.regenerateWorld();
                return reply('World regenerated. All connected players were reset.');
            }
            default:
                return reply(`Unknown command: ${command}. Type help for commands.`);
        }
    }

    async regenerateWorld() {
        this.seed = this.createFallbackSeed(this.worldConfig);
        this.genVersion = GEN_VERSION;
        this.worldBuilt = false;
        this.entitiesGenerated = false;
        this.gregDefeated = false;
        this.gregDefeatedDay = null;
        this.alphaWolfDefeated = false;
        this.worldTokenInventory = { ivory: 0, wolf: 0 };
        this.worldTokenDrops = { ivory: false, wolf: false };
        this.alphaWolfStartDay = 9 + Math.floor(Math.random() * 4);
        this.gregArena = null;
        this.gregArenaLocked = false;
        this.dayCount = 1;
        this.gameTime = 0;
        this.season = 'mild';
        this.initializeSeasonSchedule();
        this.lastPhase = 'DAY';
        this.worldGrid = [];
        this.activeLayer = 'surface';
        this.worldLayers = { surface: null, caves: null };
        this.resourceNodes = [];
        this.nodeById.clear();
        this.mobs = [];
        this.buildings = [];
        this.nextNodeId = 1;
        this.nextMobId = 1;
        this.nodePatchSet.clear();
        this.nodePatchDel.clear();
        this.buildingPatchSet.clear();
        this.buildingPatchDel.clear();
        this.markAllDirty();
        this.ensureWorld();

        for (const current of this.players.values()) {
            current.x = this.spawn.x;
            current.y = this.spawn.y;
            current.hp = 100;
            current.hunger = 100;
            current.bodyHeat = 100;
            current.inventory = Array.from({ length: INVENTORY_SLOTS }, emptyPlayerSlot);
            current.inBoat = false;
            current.boatId = null;
            current.layer = 'surface';
            current.caveEntranceId = null;
            current.exposure = 0;
            current.isDowned = false;
            current.speedPercent = 100;
            current.input = idleInput();
            current.seenMobs = new Map();
            this.sendPlayer(current);
        }

        for (const current of this.onlinePlayers()) {
            this.sendToPlayer(current.id, {
                type: 'world:reset',
                seed: this.seed,
                worldConfig: this.worldConfig,
                achievementsDisabled: this.achievementsDisabled,
                dayCount: this.dayCount,
                gameTime: this.gameTime,
                season: this.season,
                seasonDaysRemaining: this.seasonDaysRemaining,
                world: this.getWorldSnapshot(current)
            });
        }
        for (const current of this.onlinePlayers()) {
            this.broadcast({ type: 'player:update', playerId: current.id, player: this.publicPlayer(current) });
        }
        await this.flush(true);
    }

    async removeSocket(ws) {
        const session = this.sessions.get(ws);
        if (!session) return;
        this.sessions.delete(ws);
        try { ws.close(); } catch {}

        const playerId = session.playerId;
        if (!playerId) return;

        // The player may already have reconnected on another socket.
        for (const other of this.sessions.values()) {
            if (other.playerId === playerId) return;
        }

        const player = this.players.get(playerId);
        if (player) {
            player.online = false;
            player.lastSeen = Date.now();
            player.input = idleInput();
        }
        this.refreshGregArenaLock();

        this.broadcast({ type: 'player:left', playerId });
        this.dirty.players = true;
        this.dirty.meta = true;

        if (this.onlineCount() === 0) {
            this.stopTicking();
            this.dirty.nodes = this.dirty.buildings = this.dirty.mobs = true;
            await this.flush(true);
        }
    }


    // =========================================================
    // WORLD ACTIONS
    // =========================================================

    async handleWorldAction(ws, message) {
        const player = this.getSessionPlayer(ws);
        if (!player) return;

        const action = message.action || {};
        const payload = action.payload || {};

        if (action.type === 'cave_enter') return this.actionEnterCave(player, payload);
        if (action.type === 'cave_exit') return this.actionExitCave(player, payload);
        if (action.type === 'world_save_export') return this.actionExportWorldSave(player, payload);
        if (action.type === 'world_save_import') return this.actionImportWorldSave(player, payload);
        if (action.type === 'creative_panel') {
            return this.withLayer(this.worldLayerForPlayer(player), () => this.actionCreativePanel(player, payload));
        }

        return this.withLayer(this.worldLayerForPlayer(player), () => {
        switch (action.type) {
            case 'place': this.actionPlace(player, payload); break;
            case 'harvest': this.actionHarvest(player, payload); break;
            case 'attack': this.actionAttack(player, payload); break;
            case 'break': this.actionBreak(player, payload); break;
            case 'sign_write': this.actionSignWrite(player, payload); break;
            case 'craft': this.actionCraft(player, payload); break;
            case 'extract_amber': this.actionExtractAmber(player, payload); break;
            case 'lantern_refuel': this.actionLanternRefuel(player, payload); break;
            case 'eat': this.actionEat(player, payload); break;
            case 'chest_transfer': this.actionChestTransfer(player, payload); break;
            case 'equip_shield': this.actionEquipShield(player, payload); break;
            case 'board': this.actionBoard(player, payload); break;
            case 'disembark': this.actionDisembark(player); break;
            default: this.worldError(player, `Unknown world action: ${action.type}`);
        }
        });
    }

    actionExportWorldSave(player, payload) {
        if (!player.isOp || this.official) return this.sendToPlayer(player.id, { type: 'world:save:error', message: 'Only the owner of a non-official world can export it.' });
        const exportLayer = layer => this.withLayer(layer, () => ({
            resourceNodes: this.resourceNodes.map(node => [
                node.x, node.y, node.type, node.hp, node.maxHp, node.pickup ? 1 : 0,
                node.icon || null, node.plantedDay ?? null, node.shakes ?? null, node.shakeDay ?? null
            ]),
            buildings: this.buildings.map(building => this.serializeBuilding(building)),
            mobs: this.mobs.map(mob => ({ ...mob })),
            discoveredGrid: this.encodeDiscoveryMap(this.getDiscoveryMap(layer))
        }));
        const save = {
            version: 10,
            genVersion: this.genVersion,
            seed: this.worldSeed,
            seedString: this.seed,
            config: { ...this.worldConfig },
            achievementsDisabled: this.achievementsDisabled,
            dayCount: this.dayCount,
            season: this.season,
            seasonDaysRemaining: this.seasonDaysRemaining,
            currentPhase: this.phaseInfo().phase,
            phaseTimeLeft: this.phaseInfo().phaseTimeLeft * 60,
            gregDefeated: this.gregDefeated,
            gregDefeatedDay: this.gregDefeatedDay,
            alphaWolfDefeated: this.alphaWolfDefeated,
            worldTokenInventory: { ...this.worldTokenInventory },
            worldTokenDrops: { ...this.worldTokenDrops },
            alphaWolfStartDay: this.alphaWolfStartDay,
            gregArenaLocked: this.gregArenaLocked,
            currentLayer: this.worldLayerForPlayer(player),
            discoveredGrid: this.encodeDiscoveryMap(this.getDiscoveryMap(this.worldLayerForPlayer(player))),
            gregArena: this.gregArena,
            surfaceLayer: exportLayer('surface'),
            caves: this.cavesEnabled ? { ...exportLayer('caves'), gregArena: this.gregArena, resourceVersion: 1 } : null,
            player: {
                ...this.privatePlayer(player),
                caveReturn: player.caveReturn ? { ...player.caveReturn } : null
            }
        };
        const serialized = JSON.stringify(save);
        if (serialized.length > 12_000_000) {
            return this.sendToPlayer(player.id, { type: 'world:save:error', message: 'This world is too large to export as one save.' });
        }
        const transferId = crypto.randomUUID();
        const chunkSize = 38_000;
        const total = Math.ceil(serialized.length / chunkSize);
        this.sendToPlayer(player.id, { type: 'world:save:export_start', transferId, total });
        for (let index = 0; index < total; index++) {
            this.sendToPlayer(player.id, {
                type: 'world:save:export_chunk',
                transferId,
                index,
                chunk: serialized.slice(index * chunkSize, (index + 1) * chunkSize)
            });
        }
        this.sendToPlayer(player.id, { type: 'world:save:export_end', transferId });
    }

    actionImportWorldSave(player, payload) {
        const sendError = message => this.sendToPlayer(player.id, { type: 'world:save:error', message });
        if (!player.isOp || this.official) return sendError('Only the owner of a non-official world can import a saved world.');
        const transferId = String(payload.transferId || '');
        if (!/^[\w-]{1,80}$/.test(transferId)) return sendError('Invalid save transfer.');
        if (payload.stage === 'start') {
            const total = Number(payload.total);
            if (!Number.isInteger(total) || total < 1 || total > 400) return sendError('Invalid save size.');
            this.worldImportBuffers.set(player.id, { transferId, total, chunks: [], size: 0, startedAt: Date.now() });
            return;
        }
        const transfer = this.worldImportBuffers.get(player.id);
        if (!transfer || transfer.transferId !== transferId || Date.now() - transfer.startedAt > 120_000) {
            this.worldImportBuffers.delete(player.id);
            return sendError('No matching save import is active.');
        }
        if (payload.stage === 'chunk') {
            const index = Number(payload.index);
            if (index !== transfer.chunks.length || index >= transfer.total || typeof payload.chunk !== 'string' ||
                payload.chunk.length > 38_000 || transfer.size + payload.chunk.length > 12_000_000) {
                this.worldImportBuffers.delete(player.id);
                return sendError('Invalid or out-of-order save data.');
            }
            transfer.chunks.push(payload.chunk);
            transfer.size += payload.chunk.length;
            return;
        }
        if (payload.stage !== 'finish' || transfer.chunks.length !== transfer.total) {
            this.worldImportBuffers.delete(player.id);
            return sendError('The save transfer was incomplete.');
        }
        this.worldImportBuffers.delete(player.id);
        let save;
        try {
            save = JSON.parse(transfer.chunks.join(''));
        } catch {
            return sendError('The save file is invalid.');
        }
        try {
            this.installImportedWorld(save, player);
        } catch (error) {
            return sendError(`Could not import world: ${error.message}`);
        }
        this.sendToPlayer(player.id, { type: 'world:save:imported', message: 'Saved world imported.' });
    }

    installImportedWorld(save, player) {
        if (!save || ![7, 8, 9, 10].includes(save.version) || save.seedString !== this.seed) {
            throw new Error('This save does not match the room seed.');
        }
        const importLayer = (name, layer) => {
            if (!layer || !Array.isArray(layer.resourceNodes) || !Array.isArray(layer.buildings) || !Array.isArray(layer.mobs)) {
                if (name === 'caves' && !this.cavesEnabled) return;
                throw new Error(`Missing ${name} world data.`);
            }
            return this.withLayer(name, () => {
                if (layer.resourceNodes.length > 30000 || layer.buildings.length > 10000 || layer.mobs.length > 1000) {
                    throw new Error('Saved world contains too many entities.');
                }
                this.resourceNodes = layer.resourceNodes.map(node => {
                    const values = Array.isArray(node)
                        ? node
                        : [node?.x, node?.y, node?.type, node?.hp, node?.maxHp, node?.pickup ? 1 : 0, node?.icon, node?.plantedDay, node?.shakes, node?.shakeDay];
                    if (!Number.isFinite(Number(values[0])) || !Number.isFinite(Number(values[1])) ||
                        typeof values[2] !== 'string' || !ITEM_TYPES.has(values[2]) && !['wood', 'tree', 'stump', 'sapling', 'big_rock', 'rock', 'flint_node', 'stone', 'iron', 'berries', 'carrots', 'twigs', 'acorn', 'ivory_token', 'wolf_token'].includes(values[2])) {
                        throw new Error('Invalid resource node.');
                    }
                    const imported = {
                        id: this.nextNodeId++, x: Number(values[0]), y: Number(values[1]), type: values[2],
                        hp: Number(values[3]) || 1, maxHp: Number(values[4]) || Number(values[3]) || 1,
                        pickup: !!values[5], icon: values[6] || null
                    };
                    if (values[7] != null) imported.plantedDay = Number(values[7]);
                    if (values[8] != null) imported.shakes = Number(values[8]);
                    if (values[9] != null) imported.shakeDay = Number(values[9]);
                    return imported;
                });
                this.nextNodeId = Math.max(this.nextNodeId, 1);
                this.nodeById = new Map(this.resourceNodes.map(node => [node.id, node]));
                this.buildings = layer.buildings.map(building => {
                    const copy = { ...building, id: building.id || crypto.randomUUID() };
                    if (copy.type === 'campfire' && copy.life && !copy.expiresAt) copy.expiresAt = Date.now() + Number(copy.life) / 60 * 1000;
                    delete copy.life;
                    return copy;
                });
                this.mobs = layer.mobs.map(mob => ({ ...mob, id: this.nextMobId++ }));
                this.rebuildBuildingIndex();
                this.dirty.nodes = this.dirty.buildings = this.dirty.mobs = true;
                this.flushPatches();
            });
        };
        this.nextNodeId = 1;
        this.nextMobId = 1;
        importLayer('surface', save.surfaceLayer);
        if (this.cavesEnabled && save.caves) {
            importLayer('caves', save.caves);
            this.gregArena = save.caves.gregArena || save.gregArena || null;
            this.dirty.meta = true;
        }
        const allImportedNodes = [
            ...this.resourceNodes,
            ...(this.worldLayers.caves?.resourceNodes || [])
        ];
        this.discoveryMaps.surface = this.decodeDiscoveryMap(
            save.surfaceLayer?.discoveredGrid || (save.currentLayer !== 'caves' ? save.discoveredGrid : null),
            'surface'
        );
        this.discoveryMaps.caves = this.decodeDiscoveryMap(
            save.caves?.discoveredGrid || (save.currentLayer === 'caves' ? save.discoveredGrid : null),
            'caves'
        );
        this.savedDiscoveryMaps = null;
        this.dirty.discovery = true;
        this.dayCount = Math.max(1, Math.floor(Number(save.dayCount) || 1));
        this.season = save.season === 'winter' ? 'winter' : 'mild';
        this.worldConfig = this.normalizeWorldConfig({ ...this.worldConfig, ...(save.config || {}) });
        this.seasonDaysRemaining = Number.isInteger(save.seasonDaysRemaining)
            ? clamp(save.seasonDaysRemaining, 0, 30)
            : this.seasonDurationDays(this.season);
        this.normalizeSeasonSchedule();
        const { DAY, DUSK, NIGHT } = this.cycleLengths();
        const phase = ['DAY', 'DUSK', 'NIGHT'].includes(save.currentPhase) ? save.currentPhase : 'DAY';
        const phaseTimeLeft = clamp(Number(save.phaseTimeLeft) || DAY * 60, 0, (phase === 'DAY' ? DAY : phase === 'DUSK' ? DUSK : NIGHT) * 60) / 60;
        this.gameTime = phase === 'DAY' ? DAY - phaseTimeLeft
            : phase === 'DUSK' ? DAY + DUSK - phaseTimeLeft
                : DAY + DUSK + NIGHT - phaseTimeLeft;
        this.lastPhase = phase;
        this.gregDefeated = !!save.gregDefeated;
        this.alphaWolfDefeated = !!save.alphaWolfDefeated;
        const savedTokenInventory = save.worldTokenInventory || save.soloTokenInventory || {};
        this.worldTokenInventory = {
            ivory: savedTokenInventory.ivory === 1 ? 1 : 0,
            wolf: savedTokenInventory.wolf === 1 ? 1 : 0
        };
        const savedTokenDrops = save.worldTokenDrops || save.soloTokenDrops || {};
        this.worldTokenDrops = {
            ivory: !!savedTokenDrops.ivory || this.worldTokenInventory.ivory === 1,
            wolf: !!savedTokenDrops.wolf || this.worldTokenInventory.wolf === 1
        };
        if (allImportedNodes.some(node => node.type === 'ivory_token')) this.worldTokenDrops.ivory = true;
        if (allImportedNodes.some(node => node.type === 'wolf_token')) this.worldTokenDrops.wolf = true;
        this.alphaWolfStartDay = Number.isInteger(save.alphaWolfStartDay) && save.alphaWolfStartDay >= 9 && save.alphaWolfStartDay <= 12
            ? save.alphaWolfStartDay
            : 9 + Math.floor(Math.random() * 4);
        this.gregArenaLocked = !!save.gregArenaLocked && !this.gregDefeated;
        this.gregDefeatedDay = this.gregDefeated
            ? (Number.isInteger(save.gregDefeatedDay) && save.gregDefeatedDay > 0 ? save.gregDefeatedDay : this.dayCount)
            : null;
        const savedPlayer = save.player || {};
        player.inventory = this.sanitizeInventory(savedPlayer.inventory);
        player.shield = this.sanitizeShield(savedPlayer.shield);
        player.bodyHeat = clamp(Number(savedPlayer.bodyHeat ?? 100), 0, 100);
        player.hp = clamp(Number(savedPlayer.hp ?? 100), 1, 100);
        player.hunger = clamp(Number(savedPlayer.hunger ?? 100), 0, 100);
        player.inBoat = !!savedPlayer.inBoat;
        player.boatId = savedPlayer.boatId || null;
        player.layer = (savedPlayer.layer || save.currentLayer) === 'caves' && this.cavesEnabled ? 'caves' : 'surface';
        player.caveReturn = savedPlayer.caveReturn && Number.isFinite(savedPlayer.caveReturn.x) && Number.isFinite(savedPlayer.caveReturn.y)
            ? { ...savedPlayer.caveReturn }
            : null;
        if (Number.isFinite(savedPlayer.x) && Number.isFinite(savedPlayer.y)) {
            player.x = clamp(savedPlayer.x, 0, this.worldWidth - CELL_SIZE);
            player.y = clamp(savedPlayer.y, 0, this.worldHeight - CELL_SIZE);
        }
        this.dirty.meta = true;
        this.rebuildIndexes();
        this.achievementsDisabled = this.achievementsDisabled || !!save.achievementsDisabled || !!this.worldConfig.creative;
        this.broadcast({ type: 'world:reset', reason: 'import', seed: this.seed, worldConfig: this.worldConfig, achievementsDisabled: this.achievementsDisabled, world: this.getWorldSnapshot(player), dayCount: this.dayCount, gameTime: this.gameTime, season: this.season, seasonDaysRemaining: this.seasonDaysRemaining });
        for (const current of this.onlinePlayers()) this.sendLayerTransition(current);
        this.sendPlayer(player);
        this.markAllDirty();
    }

    actionCreativePanel(player, payload) {
        const result = text => this.sendToPlayer(player.id, { type: 'creative:result', text });
        if (!player.creativePanelEnabled) return result('Creative panel access is not enabled for this player.');

        switch (payload.action) {
            case 'phase': {
                const phase = String(payload.phase || '').toUpperCase();
                if (!['DAY', 'DUSK', 'NIGHT'].includes(phase)) return result('Invalid time phase.');
                const { DAY, DUSK } = this.cycleLengths();
                this.gameTime = phase === 'DAY' ? 0 : phase === 'DUSK' ? DAY : DAY + DUSK;
                this.lastPhase = phase;
                this.dirty.meta = true;
                return result(`Time set to ${phase.toLowerCase()}.`);
            }
            case 'next_day':
                this.dayCount++;
                this.advanceSeason();
                this.gameTime = 0;
                this.lastPhase = 'DAY';
                this.removeWolves();
                this.growSaplings();
                this.maybeRespawnGregAfterWait();
                this.dirty.meta = true;
                return result(`Skipped to day ${this.dayCount}.`);
            case 'teleport': {
                const x = Number(payload.x), y = Number(payload.y);
                if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.COLS || y >= this.ROWS) {
                    return result('Choose an in-bounds tile.');
                }
                let tileX = x, tileY = y;
                if (!player.creativeNoclip) {
                    let spot = null;
                    for (let radius = 0; radius <= 40 && !spot; radius++) {
                        for (let dy = -radius; dy <= radius && !spot; dy++) {
                            for (let dx = -radius; dx <= radius; dx++) {
                                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                                const tx = x + dx, ty = y + dy;
                                if (tx < 0 || ty < 0 || tx >= this.COLS || ty >= this.ROWS) continue;
                                const px = tx * CELL_SIZE + 20, py = ty * CELL_SIZE + 20;
                                if (!this.isBlockedFor(player, px, py)) { spot = { x: tx, y: ty }; break; }
                            }
                        }
                    }
                    if (!spot) return result('No walkable tile nearby.');
                    tileX = spot.x; tileY = spot.y;
                }
                player.x = tileX * CELL_SIZE + 20;
                player.y = tileY * CELL_SIZE + 20;
                player.inBoat = false;
                player.boatId = null;
                this.sendPlayer(player);
                return result(`Teleported to ${tileX}, ${tileY}.`);
            }
            case 'give': {
                const type = String(payload.type || '').toLowerCase();
                let count = Number(payload.count);
                if (!ITEM_TYPES.has(type) || !Number.isInteger(count) || count < 1 || count > 999) {
                    return result('Choose a valid item and amount (1-999).');
                }
                if (DURABILITY[type] && count > INVENTORY_SLOTS) return result(`Tool count must be ${INVENTORY_SLOTS} or less.`);
                if (!this.canGive(player, type, count)) return result('Not enough inventory space.');
                this.giveItem(player, type, count);
                this.sendPlayer(player);
                return result(`Gave ${count} ${type}.`);
            }
            case 'spawn': {
                const kind = String(payload.kind || '');
                if (!['elephant', 'wolf', 'alpha_wolf'].includes(kind)) return result('Choose elephant, wolf, or alpha wolf.');
                if (this.mobs.length >= 100) return result('Too many mobs to spawn another.');
                const x = clamp(player.x + 90, 0, this.worldWidth - CELL_SIZE);
                const y = clamp(player.y, 0, this.worldHeight - CELL_SIZE);
                const mob = kind === 'alpha_wolf'
                    ? this.createAlphaWolf(x, y)
                    : kind === 'wolf'
                    ? { id: this.nextMobId++, type: 'wolf', emoji: '🐺', x, y, hp: wolfHpForDay(this.dayCount), maxHp: wolfHpForDay(this.dayCount), speed: wolfSpeedForDay(this.dayCount), damage: wolfDamageForDay(this.dayCount), biteAt: 0 }
                    : { id: this.nextMobId++, type: 'elephant', emoji: '🐘', x, y, tx: x, ty: y, hp: 100, maxHp: 100 };
                this.mobs.push(mob);
                this.dirty.mobs = true;
                return result(`Spawned a ${kind}.`);
            }
            case 'clear_mobs': {
                const count = this.mobs.length;
                this.mobs = [];
                this.dirty.mobs = true;
                return result(`Cleared ${count} mobs.`);
            }
            case 'reveal_map':
                this.sendToPlayer(player.id, { type: 'creative:reveal' });
                return result('Minimap revealed.');
            case 'speed': {
                const speed = Number(payload.value);
                if (!Number.isFinite(speed) || speed < 0.5 || speed > 8) return result('Speed must be between 0.5x and 8x.');
                player.creativeSpeedMult = speed;
                this.sendPlayer(player);
                return result(`Creative speed set to ${speed}x.`);
            }
            case 'noclip':
                if (typeof payload.value !== 'boolean') return result('Invalid noclip setting.');
                player.creativeNoclip = payload.value;
                this.sendPlayer(player);
                return result(`Noclip ${payload.value ? 'enabled' : 'disabled'}.`);
            case 'freeze_time':
                if (typeof payload.value !== 'boolean') return result('Invalid time-freeze setting.');
                this.creativeFreezeTime = payload.value;
                this.dirty.meta = true;
                return result(`Time freeze ${payload.value ? 'enabled' : 'disabled'}.`);
            case 'invulnerability':
                if (typeof payload.value !== 'boolean') return result('Invalid invulnerability setting.');
                player.creativeInvulnerable = payload.value;
                this.sendPlayer(player);
                return result(`Invulnerability ${payload.value ? 'enabled' : 'disabled'}.`);
            default:
                return result('Unknown creative panel action.');
        }
    }

    actionEnterCave(player, payload) {
        if (player.layer === 'caves' || !this.cavesEnabled || !this.worldLayers.caves) return this.worldError(player, 'Caves are unavailable.');
        const entrance = this.buildings.find(building => building.id === payload.buildingId && building.type === 'cave_entrance');
        if (!entrance) return this.worldError(player, 'Cave entrance not found.');
        if (Math.hypot(player.x + 13 - (entrance.x + CELL_SIZE), player.y + 13 - (entrance.y + CELL_SIZE)) > HARVEST_REACH + CELL_SIZE / 2) {
            return this.worldError(player, 'You are too far from the cave entrance.');
        }
        const caveX = Number(entrance.caveX), caveY = Number(entrance.caveY);
        if (!Number.isFinite(caveX) || !Number.isFinite(caveY) ||
            !this.withLayer('caves', () => ['CAVE_FLOOR', 'CAVE_SUNLIT'].includes(this.worldGrid[Math.floor(caveY / CELL_SIZE)]?.[Math.floor(caveX / CELL_SIZE)]))) {
            return this.worldError(player, 'That cave entrance is obstructed.');
        }
        const linkedExit = this.withLayer('caves', () => this.buildings.find(building =>
            building.type === 'cave_exit' && (building.id === entrance.caveExitId || building.entranceId === entrance.id)
        ));
        if (!linkedExit) return this.worldError(player, 'This entrance has no connected cave exit.');
        player.layer = 'caves';
        player.caveEntranceId = entrance.id;
        player.x = linkedExit.x + CELL_SIZE - 13;
        player.y = linkedExit.y + CELL_SIZE - 13;
        player.inBoat = false;
        player.boatId = null;
        player.input = idleInput();
        this.sendLayerTransition(player);
    }

    actionExitCave(player, payload) {
        if (player.layer !== 'caves') return this.worldError(player, 'You are not underground.');
        if (this.gregArenaLocked && this.isPlayerInsideGregArena(player)) {
            return this.worldError(player, "Greg has sealed the arena. Defeat him or wait until no one remains inside.");
        }
        const exit = this.withLayer('caves', () => this.buildings.find(building =>
            building.id === payload.buildingId && building.type === 'cave_exit' &&
            (!building.entranceId || building.entranceId === player.caveEntranceId)
        ));
        if (!exit) return this.worldError(player, 'Cave exit not found.');
        if (Math.hypot(player.x + 13 - (exit.x + 20), player.y + 13 - (exit.y + 20)) > HARVEST_REACH) {
            return this.worldError(player, 'You are too far from the cave exit.');
        }
        const entrance = this.withLayer('surface', () => this.buildings.find(building =>
            building.id === player.caveEntranceId && building.type === 'cave_entrance'
        ));
        if (!entrance) return this.worldError(player, 'The surface entrance is no longer available.');
        player.layer = 'surface';
        player.x = entrance.x + CELL_SIZE - 13;
        player.y = entrance.y + CELL_SIZE - 13;
        player.inBoat = false;
        player.boatId = null;
        player.input = idleInput();
        this.sendLayerTransition(player);
        this.refreshGregArenaLock();
    }

    sendLayerTransition(player) {
        this.dirty.players = true;
        const layer = this.worldLayerForPlayer(player);
        this.sendToPlayer(player.id, {
            type: 'world:layer',
            layer,
            x: player.x,
            y: player.y,
            world: this.getWorldSnapshot(player)
        });
        this.broadcast({ type: 'player:update', playerId: player.id, player: this.publicPlayer(player) });
    }

    // ---------- PLACE ----------

    actionPlace(player, payload) {
        const type = String(payload.type || '');
        const x = Number(payload.x);
        const y = Number(payload.y);

        if (!type || !Number.isFinite(x) || !Number.isFinite(y)) {
            return this.worldError(player, 'Invalid placement.');
        }
        if (type === 'cave_entrance' || type === 'cave_exit') {
            return this.worldError(player, 'Cave passages are generated with the world.');
        }

        const gx = Math.floor(x / CELL_SIZE);
        const gy = Math.floor(y / CELL_SIZE);
        if (gx < 0 || gy < 0 || gx >= this.COLS || gy >= this.ROWS) {
            return this.worldError(player, 'Outside the world.');
        }

        const cx = gx * CELL_SIZE;
        const cy = gy * CELL_SIZE;
        if (Math.hypot(player.x - cx, player.y - cy) > PLACE_REACH) {
            return this.worldError(player, 'You are too far away.');
        }

        const creative = this.worldConfig.creative;
        // Acorns become saplings.
        if (type === 'acorn') {
            if (!this.canPlantAt(gx, gy)) return this.worldError(player, 'You cannot plant there.');
            if (!creative && !this.hasResources(player, { acorn: 1 })) return this.worldError(player, 'You need an acorn.');
            if (!creative) this.payResources(player, { acorn: 1 });

            this.addNode({
                x: cx, y: cy, type: 'sapling', icon: '🌱',
                hp: 1, maxHp: 1, plantedDay: this.dayCount + 1, pickup: false
            });
            this.sendPlayer(player);
            return;
        }

        const recipe = RECIPES[type];
        if (!recipe || recipe.item) return this.worldError(player, 'Unknown building.');

        if (recipe.lab && !creative && !this.nearBuilding(player, 'research', LAB_RADIUS)) {
            return this.worldError(player, 'Stand near a Science Machine.');
        }
        if (!this.canPlaceStructureAt(gx, gy, type)) {
            return this.worldError(player, type === 'boat' ? 'Boats must be placed over deep water.' : 'You cannot place there.');
        }
        if (!creative && !this.hasResources(player, recipe.cost)) {
            return this.worldError(player, 'Insufficient resources.');
        }
        if (!creative) this.payResources(player, recipe.cost);

        const building = { id: crypto.randomUUID(), x: cx, y: cy, type, hp: recipe.hp, maxHp: recipe.hp };
        if (type === 'campfire') building.expiresAt = Date.now() + recipe.lifeSeconds * 1000;
        if (type === 'chest') building.inventory = emptyChest();
        if (type === 'sign') building.text = '';

        this.buildings.push(building);
        if (type === 'wall') this.rebuildBuildingIndex();
        this.dirty.buildings = true;
        this.broadcastBuildings();
        this.sendPlayer(player);
        this.sendToPlayer(player.id, { type: 'world:activity', activity: 'work' });
        if (!this.achievementsDisabled) this.sendToPlayer(player.id, { type: 'achievement:event', id: 'first-build' });
    }

    canPlantAt(gx, gy) {
        const biome = this.worldGrid[gy]?.[gx];
        if (!biome || LIQUIDS.has(biome)) return false;
        const cx = gx * CELL_SIZE, cy = gy * CELL_SIZE;
        if (this.buildings.some(b => b.x === cx && b.y === cy)) return false;
        return !this.resourceNodes.some(n => !n.pickup && n.x === cx && n.y === cy);
    }

    canPlaceStructureAt(gx, gy, type) {
        const biome = this.worldGrid[gy]?.[gx];
        if (!biome) return false;

        const cx = gx * CELL_SIZE, cy = gy * CELL_SIZE;
        if (this.buildings.some(b => b.x === cx && b.y === cy)) return false;

        if (type === 'boat') return biome === 'OCEAN';
        if (biome === 'OCEAN') return false;

        if (this.resourceNodes.some(n => !n.pickup && n.x === cx && n.y === cy)) return false;

        // Don't wall someone in: nobody may be standing on the tile.
        for (const p of this.onlinePlayers()) {
            if (this.worldLayerForPlayer(p) !== this.activeLayer) continue;
            if (Math.abs(p.x - cx) < 30 && Math.abs(p.y - cy) < 30) return false;
        }
        return true;
    }

    nearBuilding(player, type, radius) {
        return this.buildings.some(b => b.type === type && Math.hypot(player.x - b.x, player.y - b.y) < radius);
    }

    // ---------- HARVEST ----------

    actionHarvest(player, payload) {
        const now = Date.now();
        if (now - (player.cooldownAt || 0) < HARVEST_COOLDOWN_MS) return;
        player.cooldownAt = now;

        const px = player.x + 13, py = player.y + 13;
        const slotIndex = Number.isInteger(payload.slot) ? payload.slot : (Number.isInteger(player.selected) ? player.selected : null);

        // Candidate nodes in reach, nearest first. A specific node id wins if provided.
        let candidates = [];
        if (payload.nodeId != null) {
            const n = this.nodeById.get(Number(payload.nodeId));
            if (n && Math.hypot(px - (n.x + 20), py - (n.y + 20)) <= HARVEST_REACH) candidates = [n];
        } else {
            for (const n of this.resourceNodes) {
                if (Math.abs(px - (n.x + 20)) > HARVEST_REACH || Math.abs(py - (n.y + 20)) > HARVEST_REACH) continue;
                const d = Math.hypot(px - (n.x + 20), py - (n.y + 20));
                if (d <= HARVEST_REACH) candidates.push({ n, d });
            }
            candidates.sort((a, b) => a.d - b.d);
            candidates = candidates.map(c => c.n);
        }
        if (!candidates.length) return;   // silent: the client sends this every few frames while Space is held

        // Prefer the nearest node the player can actually work with the selected tool.
        let target = null, tool = null, shakeTarget = null;
        for (const n of candidates) {
            if (n.type === 'sapling') continue;
            if (n.pickup) { target = n; break; }
            const needed = NODE_TOOL[n.type];
            if (!needed) continue;
            const slot = this.pickTool(player, slotIndex, needed);
            if (slot) { target = n; tool = slot; break; }
            // No axe equipped: a tree can still be shaken by hand.
            if (!shakeTarget && (n.type === 'wood' || n.type === 'tree')) shakeTarget = n;
        }

        if (!target && shakeTarget) return this.shakeTree(player, shakeTarget);

        if (!target) {
            const first = candidates.find(n => n.type !== 'sapling' && NODE_TOOL[n.type]);
            if (first) this.worldError(player, TOOL_HINT[NODE_TOOL[first.type]]);
            return;
        }

        const creative = this.worldConfig.creative;

        // Pickups (twigs, berries, flint, acorns, carrots)
        if (target.pickup) {
            const token = target.type === 'ivory_token' ? 'ivory' : target.type === 'wolf_token' ? 'wolf' : null;
            if (token) {
                if (!this.worldTokenDrops[token] || this.worldTokenInventory[token]) {
                    this.removeNode(target);
                    return;
                }
                this.worldTokenInventory[token] = 1;
                this.dirty.meta = true;
                this.removeNode(target);
                this.sendToPlayer(player.id, { type: 'token:pickup', token, x: target.x, y: target.y });
                return;
            }
            if (!this.canGive(player, target.type, 1)) return this.worldError(player, 'Inventory full.');
            this.giveItem(player, target.type, 1);
            this.removeNode(target);
            this.sendPlayer(player);
            return;
        }

        // Would this hit break the node? If so, check the loot fits first.
        const breaks = (target.hp ?? 1) <= 1;
        let loot = [];
        if (breaks) {
            switch (target.type) {
                case 'wood': case 'tree':
                    loot = [['wood', 5], ['twigs', 2]];
                    if (Math.random() < 0.45) loot.push(['acorn', 1]);
                    break;
                case 'big_rock': loot = [['stone', 5], ['flint', 1 + (Math.random() < 0.5 ? 1 : 0)]]; break;
                case 'flint_node': case 'rock': loot = [['flint', 1]]; break;
                case 'stone': case 'iron': loot = [[target.type, 5]]; break;
                case 'stump': loot = [['wood', 2]]; break;
            }
            if (!this.canGiveAll(player, loot)) return this.worldError(player, 'Inventory full.');
        }

        target.hp = (target.hp ?? 1) - 1;
        if (!creative) this.useTool(player, tool);

        if (!breaks) {
            this.queueNodeSet(target);
        } else {
            for (const [type, count] of loot) this.giveItem(player, type, count);
            if (target.type === 'wood' || target.type === 'tree') {
                // Trees leave stumps.
                target.type = 'stump';
                target.icon = '🪵';
                target.hp = 3;
                target.maxHp = 3;
                this.queueNodeSet(target);
            } else {
                this.removeNode(target);
            }
        }
        this.sendPlayer(player);
        this.sendToPlayer(player.id, { type: 'world:activity', activity: 'work' });
    }

    // Shaking a tree by hand: each tree can be shaken 3 times a day. A shake has a 33% chance to drop a twig
    // and (independently) a 10% chance to drop an acorn on a tile next to the tree.
    shakeTree(player, node) {
        if (node.shakeDay !== this.dayCount) { node.shakeDay = this.dayCount; node.shakes = 0; }

        if ((node.shakes || 0) >= SHAKES_PER_DAY) {
            return this.fx(player, node.x + 20, node.y - 6, 'Nothing left today', '#aaaaaa', `shake|${node.id}`);
        }

        node.shakes = (node.shakes || 0) + 1;
        const found = [];
        if (Math.random() < SHAKE_TWIG_CHANCE) { this.spawnPickupNear(node, 'twigs', '🥢'); found.push('🥢'); }
        if (Math.random() < SHAKE_ACORN_CHANCE) { this.spawnPickupNear(node, 'acorn', '🌰'); found.push('🌰'); }

        this.queueNodeSet(node);   // everyone learns how many shakes this tree has used today
        const left = SHAKES_PER_DAY - node.shakes;
        this.fx(player, node.x + 20, node.y - 6, `${found.length ? found.join(' ') : 'nothing'} (${left} left)`, found.length ? '#2ecc71' : '#aaaaaa');
    }

    spawnPickupNear(node, type, icon) {
        const gx = Math.floor(node.x / CELL_SIZE), gy = Math.floor(node.y / CELL_SIZE);
        const options = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const x = gx + dx, y = gy + dy;
                if (x < 0 || y < 0 || x >= this.COLS || y >= this.ROWS) continue;
                const biome = this.worldGrid[y]?.[x];
                if (!biome || LIQUIDS.has(biome)) continue;
                const cx = x * CELL_SIZE, cy = y * CELL_SIZE;
                if (this.buildings.some(b => b.x === cx && b.y === cy)) continue;
                if (this.resourceNodes.some(n => !n.pickup && n.x === cx && n.y === cy)) continue;
                options.push({ x: cx, y: cy });
            }
        }
        const spot = options.length ? options[Math.floor(Math.random() * options.length)] : { x: node.x, y: node.y };
        return this.addNode({ x: spot.x, y: spot.y, type, icon, pickup: true });
    }

    pickTool(player, slotIndex, needed) {
        if (slotIndex != null) {
            const slot = player.inventory[slotIndex];
            return slot && slot.type === needed ? slot : null;
        }
        return player.inventory.find(s => s.type === needed) || null;
    }

    useTool(player, slot) {
        if (!slot || !slot.maxDuration) return;
        slot.duration -= 1;
        if (slot.duration <= 0) {
            slot.type = null; slot.count = 0; slot.duration = 0; slot.maxDuration = 0;
            this.sendToPlayer(player.id, { type: 'world:error', message: 'Your tool broke.' });
        }
    }

    // ---------- ATTACK (elephants and, later, wolves) ----------

    actionAttack(player, payload) {
        const now = Date.now();
        if (now - (player.attackAt || 0) < 200) return;
        player.attackAt = now;

        const mx = Number(payload.x), my = Number(payload.y);
        if (!Number.isFinite(mx) || !Number.isFinite(my)) return;

        let best = -1, bestDist = 60;
        this.mobs.forEach((m, i) => {
            if (m.deathAt) return;
            const mobSize = m.type === 'greg' ? GREG_SIZE : m.type === 'alpha_wolf' ? ALPHA_WOLF_SIZE : MOB_SIZE;
            const d = Math.hypot(m.x + mobSize / 2 - mx, m.y + mobSize / 2 - my);
            if (d < bestDist) { bestDist = d; best = i; }
        });
        if (best < 0) return;

        // You have to be standing next to it (the client walks you there first).
        const target = this.mobs[best];
        const targetSize = target.type === 'greg' ? GREG_SIZE : target.type === 'alpha_wolf' ? ALPHA_WOLF_SIZE : MOB_SIZE;
        if (Math.hypot(player.x + 13 - (target.x + targetSize / 2), player.y + 13 - (target.y + targetSize / 2)) > ATTACK_REACH + (targetSize - MOB_SIZE) / 2) return;
        if (target.type === 'greg' && this.activeLayer === 'caves' && this.gregArena) {
            const tileX = Math.floor((player.x + 13) / CELL_SIZE), tileY = Math.floor((player.y + 13) / CELL_SIZE);
            if (tileX < this.gregArena.x - 10 || tileX >= this.gregArena.x + 10 ||
                tileY < this.gregArena.y - 10 || tileY >= this.gregArena.y + 10) {
                return this.worldError(player, "Return to Greg's arena to attack.");
            }
        }
        if (target.type === 'alpha_wolf' && target.phase !== 'stunned' && !player.ohkoEnabled) {
            return this.worldError(player, 'The Alpha Wolf is protected while its summoned wolves remain.');
        }

        const slotIndex = Number.isInteger(payload.slot) ? payload.slot : (Number.isInteger(player.selected) ? player.selected : null);
        let weapon = null;
        if (slotIndex != null) {
            const s = player.inventory[slotIndex];
            if (s && ['axe', 'pickaxe', 'sword'].includes(s.type)) weapon = s;
        } else {
            weapon = player.inventory.find(s => ['axe', 'pickaxe', 'sword'].includes(s.type)) || null;
        }
        if (!weapon) return this.worldError(player, 'Select an Axe, Pickaxe, or Sword to fight.');

        const mob = this.mobs[best];
        const damage = weapon.type === 'sword' ? 20 : 5;
        const actualDamage = player.ohkoEnabled
            ? 10000
            : mob.type === 'greg' && mob.chargeState !== 'stunned'
                ? Math.max(1, Math.floor(damage * 0.2))
                : damage;
        mob.hp -= actualDamage;
        if (!this.worldConfig.creative) this.useTool(player, weapon);

        if (mob.hp <= 0) {
            if (mob.type === 'wolf' && this.canGive(player, 'stone', 2)) this.giveItem(player, 'stone', 2);
            if (mob.type === 'wolf' && !this.achievementsDisabled) this.sendToPlayer(player.id, { type: 'achievement:event', id: 'first-wolf' });
            if (mob.type === 'greg') {
                this.gregDefeated = true;
                this.gregDefeatedDay = this.dayCount;
                this.gregArenaLocked = false;
                this.dirty.meta = true;
                this.dropWorldToken('ivory', mob.x + GREG_SIZE / 2, mob.y + GREG_SIZE / 2);
                mob.deathAt = now;
                if (!this.achievementsDisabled) this.sendToPlayer(player.id, { type: 'achievement:event', id: 'greg' });
                this.announce('Greg (from Accounting) is defeated. Every elephant is now hostile!', '#ff4444');
            } else if (mob.type === 'alpha_wolf') {
                this.alphaWolfDefeated = true;
                this.dirty.meta = true;
                this.dropWorldToken('wolf', mob.x + ALPHA_WOLF_SIZE / 2, mob.y + ALPHA_WOLF_SIZE / 2);
                this.announce('The Alpha Wolf has been defeated. Its howls will trouble you no more.', '#2ecc71');
            } else {
                this.mobs.splice(best, 1);
            }
        }
        this.dirty.mobs = true;      // everyone nearby gets the hp change / removal on the next mob sync
        this.sendPlayer(player);
    }

    spawnGregRewardChest(greg, revealAt = Date.now()) {
        const contents = [
            { type: 'wood', count: 100 + Math.floor(Math.random() * 101) },
            { type: 'stone', count: 100 },
            { type: 'flint', count: 100 },
            { type: 'twigs', count: 100 },
            { type: 'carrots', count: 50 },
            { type: 'iron', count: 25 },
            { type: 'amber', count: 3 },
            { type: 'paste', count: 20 },
            { type: 'sword', count: 1, duration: DURABILITY.sword, maxDuration: DURABILITY.sword },
            { type: 'lantern', count: 1, duration: DURABILITY.lantern, maxDuration: DURABILITY.lantern },
            { type: 'ivory_shield', count: 1, duration: DURABILITY.ivory_shield, maxDuration: DURABILITY.ivory_shield }
        ];
        const spots = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]]
            .map(([dx, dy]) => ({
                x: Math.round((greg.x + dx * CELL_SIZE) / CELL_SIZE) * CELL_SIZE,
                y: Math.round((greg.y + dy * CELL_SIZE) / CELL_SIZE) * CELL_SIZE
            }))
            .filter(point => {
                const biome = this.biomeAt(point.x + 20, point.y + 20);
                return biome !== 'CAVE_WALL' && !LIQUIDS.has(biome) &&
                    !this.buildings.some(building => building.x === point.x && building.y === point.y);
            });
        const point = spots[0] || {
            x: Math.round((greg.x + CELL_SIZE) / CELL_SIZE) * CELL_SIZE,
            y: Math.round(greg.y / CELL_SIZE) * CELL_SIZE
        };
        const inventory = emptyChest();
        contents.forEach((slot, index) => { inventory[index] = slot; });
        this.buildings.push({
            id: crypto.randomUUID(),
            x: point.x,
            y: point.y,
            type: 'chest',
            hp: 400,
            maxHp: 400,
            rewardChest: true,
            rewardChestAt: revealAt,
            inventory
        });
        this.dirty.buildings = true;
    }

    // ---------- HAMMER: break buildings ----------

    actionBreak(player, payload) {
        const target = this.buildings.find(building => building.id === payload.buildingId);
        if (target?.type === 'cave_entrance' || target?.type === 'cave_exit') {
            return this.worldError(player, 'Cave passages cannot be dismantled.');
        }
        const now = Date.now();
        if (now - (player.breakAt || 0) < BREAK_COOLDOWN_MS) return;
        player.breakAt = now;

        const slotIndex = Number.isInteger(payload.slot) ? payload.slot : (Number.isInteger(player.selected) ? player.selected : 0);
        const tool = player.inventory[slotIndex];
        if (!tool || tool.type !== 'hammer') return this.worldError(player, 'Select a Hammer (🔨) on the hotbar.');

        const b = target;
        if (!b) return;
        if (Math.hypot(player.x + 13 - (b.x + 20), player.y + 13 - (b.y + 20)) > HARVEST_REACH) return;   // walk up to it first
        if (b.type === 'chest' && Array.isArray(b.inventory) && b.inventory.some(slot => slot && slot.type && slot.count > 0)) {
            return this.worldError(player, 'Empty the chest first.');
        }

        if (!this.worldConfig.creative) this.useTool(player, tool);
        b.hp = (b.hp ?? b.maxHp ?? 100) - HAMMER_DAMAGE;
        this.dirty.buildings = true;

        if (b.hp > 0) {
            this.buildingPatchSet.set(b.id, b);
            this.sendPlayer(player);
            this.sendToPlayer(player.id, { type: 'world:activity', activity: 'work' });
            return;
        }

        // Destroyed: remove it and hand back half of the materials.
        this.buildings = this.buildings.filter(x => x !== b);
        this.buildingPatchSet.delete(b.id);
        this.buildingPatchDel.add(b.id);
        if (b.type === 'wall') this.rebuildBuildingIndex();

        const cost = (RECIPES[b.type] && RECIPES[b.type].cost) || {};
        for (const [type, amount] of Object.entries(cost)) {
            const back = Math.floor(amount / 2);
            if (back > 0 && this.canGive(player, type, 1)) this.giveItem(player, type, back);
        }
        this.fx(player, b.x + 20, b.y - 6, 'Demolished', '#ffa500');
        this.sendPlayer(player);
        this.sendToPlayer(player.id, { type: 'world:activity', activity: 'work' });
    }

    actionSignWrite(player, payload) {
        const building = this.buildings.find(b => b.id === payload.buildingId);
        if (!building || building.type !== 'sign') return this.worldError(player, 'Sign not found.');
        if (Math.hypot(player.x + 13 - (building.x + 20), player.y + 13 - (building.y + 20)) > HARVEST_REACH) {
            return this.worldError(player, 'You are too far away to write on that sign.');
        }
        if (typeof payload.text !== 'string') return this.worldError(player, 'Invalid sign text.');

        building.text = payload.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
        this.dirty.buildings = true;
        this.broadcastBuildings();
    }

    // ---------- CRAFT / EAT ----------

    actionCraft(player, payload) {
        const type = String(payload.type || '');
        const recipe = RECIPES[type];
        if (!recipe || !recipe.item) return this.worldError(player, 'Unknown recipe.');

        const creative = this.worldConfig.creative;
        if (!creative) {
            if (recipe.lab && !this.nearBuilding(player, 'research', LAB_RADIUS)) {
                return this.worldError(player, 'Stand near a Science Machine.');
            }
            if (recipe.kitchen && !this.nearBuilding(player, 'cooking', LAB_RADIUS)) {
                return this.worldError(player, 'Kitchen required.');
            }
            if (!this.hasResources(player, recipe.cost)) return this.worldError(player, 'Insufficient resources.');
        }
        if (!this.canGive(player, type, 1)) return this.worldError(player, 'Inventory full.');

        if (!creative) this.payResources(player, recipe.cost);
        this.giveItem(player, type, 1);
        this.sendPlayer(player);
    }

    actionEquipShield(player, payload) {
        const index = payload.slot === null ? null : Number(payload.slot);
        const currentShield = this.sanitizeShield(player.shield);

        if (index === null) {
            if (!currentShield) return;
            const emptyIndex = player.inventory.findIndex(slot => !slot.type);
            if (emptyIndex < 0) return this.worldError(player, 'Your inventory is full.');
            player.inventory[emptyIndex] = {
                type: currentShield.type,
                count: 1,
                duration: currentShield.durability,
                maxDuration: currentShield.maxDurability
            };
            player.shield = null;
        } else {
            if (!Number.isInteger(index) || index < 0 || index >= player.inventory.length) return;
            const slot = player.inventory[index];
            if (!slot || !SHIELD_PROTECTION[slot.type]) return this.worldError(player, 'Select a shield from your inventory.');
            player.shield = this.sanitizeShield({
                type: slot.type,
                durability: slot.duration,
                maxDurability: slot.maxDuration
            });
            player.inventory[index] = currentShield
                ? {
                    type: currentShield.type,
                    count: 1,
                    duration: currentShield.durability,
                    maxDuration: currentShield.maxDurability
                }
                : emptyPlayerSlot();
        }

        this.dirty.players = true;
        this.sendPlayer(player);
    }

    actionExtractAmber(player, payload) {
        const building = this.buildings.find(b => b.id === payload.buildingId && b.type === 'extractor');
        if (!building) return this.worldError(player, 'Extractor not found.');
        if (Math.hypot(player.x + 13 - (building.x + 20), player.y + 13 - (building.y + 20)) > HARVEST_REACH) {
            return this.worldError(player, 'You are too far away from the extractor.');
        }
        const slotIndex = Number(payload.slot);
        const slot = Number.isInteger(slotIndex) ? player.inventory[slotIndex] : null;
        if (!slot || slot.type !== 'wood' || slot.count < 5) {
            return this.worldError(player, 'Select a hotbar stack with at least 5 wood.');
        }

        const roll = Math.random();
        let amberCount = 0;
        if (roll < 1 / 5) amberCount = 1;
        else if (roll < 1 / 5 + 1 / 10) amberCount = 2;
        else if (roll < 1 / 5 + 1 / 10 + 1 / 15) amberCount = 3;

        if (amberCount && !this.canGive(player, 'amber', amberCount)) {
            return this.worldError(player, 'Inventory full. Make room for amber first.');
        }
        slot.count -= 5;
        if (slot.count <= 0) Object.assign(slot, emptyPlayerSlot());
        if (amberCount) this.giveItem(player, 'amber', amberCount);
        this.fx(player, building.x + 20, building.y - 6, amberCount ? `Amber x${amberCount}` : 'No amber found', amberCount ? '#ffcc66' : '#aaaaaa');
        this.sendPlayer(player);
    }

    actionLanternRefuel(player, payload) {
        const lanternIndex = Number(payload.lanternSlot);
        const amberIndex = Number(payload.amberSlot);
        const lantern = Number.isInteger(lanternIndex) ? player.inventory[lanternIndex] : null;
        const amber = Number.isInteger(amberIndex) ? player.inventory[amberIndex] : null;
        if (!lantern || lantern.type !== 'lantern' || !amber || amber.type !== 'amber') {
            return this.worldError(player, 'Select amber, then click a lantern in your inventory.');
        }
        if (lanternIndex === amberIndex || amber.count < 1) return this.worldError(player, 'You need amber to refuel that lantern.');
        const maxFuel = DURABILITY.lantern;
        const fuelPerAmber = 2 * 60 * TORCH_FRAMES_PER_SECOND;
        if ((lantern.duration || 0) >= maxFuel) return this.worldError(player, 'That lantern is already full.');

        amber.count -= 1;
        if (amber.count <= 0) Object.assign(amber, emptyPlayerSlot());
        lantern.maxDuration = maxFuel;
        lantern.duration = Math.min(maxFuel, Math.max(0, lantern.duration || 0) + fuelPerAmber);
        this.sendPlayer(player);
    }

    actionEat(player, payload) {
        let slot = null;
        if (Number.isInteger(payload.slot)) {
            slot = player.inventory[payload.slot];
            if (!slot || !FOOD[slot.type]) return;
        } else {
            slot = player.inventory.find(s => FOOD[s.type]);
            if (!slot) return;
        }

        player.hunger = Math.min(100, Number(player.hunger || 0) + FOOD[slot.type]);
        player.hp = Math.min(100, Number(player.hp || 0) + FOOD_HEALING[slot.type]);
        slot.count -= 1;
        if (slot.count <= 0) Object.assign(slot, emptyPlayerSlot());
        this.dirty.players = true;
        this.sendPlayer(player);
    }

    // ---------- CHEST ----------

    actionChestTransfer(player, payload) {
        const chest = this.buildings.find(b =>
            b.type === 'chest' &&
            Number(b.x) === Number(payload.chestX) &&
            Number(b.y) === Number(payload.chestY)
        );
        if (!chest) return this.worldError(player, 'Chest not found.');
        if (chest.rewardChestAt + GREG_CHEST_FADE_MS > Date.now()) return this.worldError(player, 'The reward chest is still materializing.');
        if (Math.hypot(player.x - chest.x, player.y - chest.y) > 100) {
            return this.worldError(player, 'You are too far away.');
        }

        if (!Array.isArray(chest.inventory)) chest.inventory = emptyChest();
        while (chest.inventory.length < CHEST_SLOTS) chest.inventory.push(emptyChestSlot());

        const listFor = kind => kind === 'player' ? player.inventory : kind === 'chest' ? chest.inventory : null;
        const from = listFor(payload.fromKind);
        const to = listFor(payload.toKind);
        const fromIdx = Number(payload.fromIdx);
        const toIdx = Number(payload.toIdx);

        if (!from || !to || !Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return;
        if (!from[fromIdx] || !to[toIdx]) return;
        if (from === to && fromIdx === toIdx) return;

        const source = from[fromIdx];
        const dest = to[toIdx];
        if (!source.type) return;

        const durable = !!DURABILITY[source.type];
        if (dest.type && dest.type === source.type && !durable && !NON_STACKABLE_ITEMS.has(source.type)) {
            dest.count = (Number(dest.count) || 0) + (Number(source.count) || 0);
            from[fromIdx] = from === player.inventory ? emptyPlayerSlot() : emptyChestSlot();
        } else {
            from[fromIdx] = dest;
            to[toIdx] = source;
        }

        // Empty slots must have the right shape for whichever list they landed in.
        if (!from[fromIdx].type) from[fromIdx] = from === player.inventory ? emptyPlayerSlot() : emptyChestSlot();
        if (!to[toIdx].type) to[toIdx] = to === player.inventory ? emptyPlayerSlot() : emptyChestSlot();

        // A tool needs a durability to wear down; give one to any that arrived without.
        for (const slot of [from[fromIdx], to[toIdx]]) {
            if (slot.type && DURABILITY[slot.type] && !slot.maxDuration) {
                slot.duration = DURABILITY[slot.type];
                slot.maxDuration = DURABILITY[slot.type];
            }
        }

        if (chest.rewardChest && !chest.inventory.some(slot => slot?.type && Number(slot.count) > 0)) {
            this.buildings = this.buildings.filter(building => building !== chest);
        }
        this.dirty.buildings = true;
        this.dirty.players = true;
        this.sendPlayer(player);
        this.broadcastBuildings();
    }

    // ---------- BOATS ----------

    actionBoard(player, payload) {
        const boat = this.buildings.find(b =>
            b.type === 'boat' && Number(b.x) === Number(payload.x) && Number(b.y) === Number(payload.y)
        );
        if (!boat) return this.worldError(player, 'Boat not found.');
        if (Math.hypot(player.x - boat.x, player.y - boat.y) > 60) {
            return this.worldError(player, 'You are too far away.');
        }

        player.inBoat = true;
        player.boatId = boat.id || `${boat.x},${boat.y}`;
        this.dirty.players = true;
        this.sendPlayer(player);
        this.broadcast({ type: 'player:update', playerId: player.id, player: this.publicPlayer(player) });
    }

    actionDisembark(player) {
        if (!player.inBoat) return;

        // Leaving a boat in open ocean would strand you.
        const biome = this.biomeAt(player.x + 13, player.y + 13);
        if (LIQUIDS.has(biome)) return this.worldError(player, 'Move the boat to land before leaving it.');

        player.inBoat = false;
        player.boatId = null;
        this.dirty.players = true;
        this.sendPlayer(player);
        this.broadcast({ type: 'player:update', playerId: player.id, player: this.publicPlayer(player) });
    }


    // =========================================================
    // WORLD BUILD / RESTORE
    // =========================================================

    ensureWorld() {
        if (this.worldBuilt || !this.seed) return;
        if (!Number.isInteger(this.alphaWolfStartDay)) {
            this.alphaWolfStartDay = 9 + Math.floor(Math.random() * 4);
            this.dirty.meta = true;
        }

        // After a restart the saved trees/chests/buildings are kept; only terrain is rebuilt.
        this.generateWorld({ terrainOnly: this.entitiesGenerated });
        if (this.cavesEnabled) this.ensureCaveEntrances();

        if (!this.entitiesGenerated) {
            this.entitiesGenerated = true;
            this.markAllDirty();
        }
        this.worldBuilt = true;

        // Assign ids to any nodes that predate ids.
        for (const n of this.resourceNodes) if (n.id == null) n.id = this.nextNodeId++;
        if (this.savedCaveEntities && this.worldLayers.caves) {
            const caves = this.worldLayers.caves;
            const savedCaveNodes = this.savedCaveEntities.nodes.map(unpackNode);
            if (savedCaveNodes.length || this.caveResourcesVersion >= 1) {
                caves.resourceNodes = savedCaveNodes;
            } else {
                this.caveResourcesVersion = 1;
                this.dirty.meta = true;
                this.dirty.caves = true;
            }
            caves.buildings = this.savedCaveEntities.buildings;
            caves.mobs = this.savedCaveEntities.mobs;
            caves.nextNodeId = caves.resourceNodes.reduce((next, node) => Math.max(next, (node.id || 0) + 1), 1);
            caves.nodeById = new Map(caves.resourceNodes.map(node => [node.id, node]));
            this.rebuildLayerBuildingIndex(caves);
            delete this.savedCaveEntities;
        }
        if (this.cavesEnabled) {
            this.ensureCaveExitLinks();
            this.withLayer('caves', () => this.ensureGregSpawn());
            if (this.caveResourcesVersion < 1) {
                this.caveResourcesVersion = 1;
                this.dirty.meta = true;
            }
        }
        this.rebuildIndexes();
        this.spawn = this.findNearestLandSpawn();
    }

    rebuildLayerBuildingIndex(layer) {
        layer.wallCells = new Set();
        for (const b of layer.buildings) {
            if (b.type === 'wall') layer.wallCells.add(`${Math.floor(b.x / CELL_SIZE)},${Math.floor(b.y / CELL_SIZE)}`);
        }
    }

    rebuildIndexes() {
        this.nodeById = new Map();
        for (const n of this.resourceNodes) this.nodeById.set(n.id, n);
        this.rebuildBuildingIndex();
    }

    rebuildBuildingIndex() {
        this.wallCells = new Set();
        for (const b of this.buildings) {
            if (b.type === 'wall') this.wallCells.add(`${Math.floor(b.x / CELL_SIZE)},${Math.floor(b.y / CELL_SIZE)}`);
        }
    }

    captureRuntimeLayer() {
        return {
            worldGrid: this.worldGrid,
            resourceNodes: this.resourceNodes,
            nodeById: this.nodeById,
            nextNodeId: this.nextNodeId,
            mobs: this.mobs,
            nextMobId: this.nextMobId,
            buildings: this.buildings,
            wallCells: this.wallCells,
            nodePatchSet: this.nodePatchSet,
            nodePatchDel: this.nodePatchDel,
            buildingPatchSet: this.buildingPatchSet,
            buildingPatchDel: this.buildingPatchDel,
            dirty: { nodes: this.dirty.nodes, buildings: this.dirty.buildings, mobs: this.dirty.mobs }
        };
    }

    applyRuntimeLayer(layer) {
        for (const key of [
            'worldGrid', 'resourceNodes', 'nodeById', 'nextNodeId', 'mobs', 'nextMobId',
            'buildings', 'wallCells', 'nodePatchSet', 'nodePatchDel', 'buildingPatchSet', 'buildingPatchDel'
        ]) this[key] = layer[key];
        this.dirty.nodes = !!layer.dirty?.nodes;
        this.dirty.buildings = !!layer.dirty?.buildings;
        this.dirty.mobs = !!layer.dirty?.mobs;
    }

    activateLayer(name) {
        if (name === this.activeLayer) return;
        this.worldLayers[this.activeLayer] = this.captureRuntimeLayer();
        const target = this.worldLayers[name];
        if (!target) throw new Error(`World layer "${name}" is unavailable.`);
        this.applyRuntimeLayer(target);
        this.activeLayer = name;
    }

    withLayer(name, callback) {
        const previous = this.activeLayer;
        if (name !== previous) this.activateLayer(name);
        try {
            return callback();
        } finally {
            if (name === 'caves') {
                const changed = this.dirty.nodes || this.dirty.buildings || this.dirty.mobs;
                this.flushPatches();
                if (changed) this.dirty.caves = true;
            }
            if (name !== previous) this.activateLayer(previous);
        }
    }

    worldLayerForPlayer(player) {
        return player?.layer === 'caves' && this.cavesEnabled && this.worldLayers.caves ? 'caves' : 'surface';
    }

    broadcastLayer(message) {
        const text = JSON.stringify(message);
        for (const [ws, session] of this.sessions) {
            const player = this.players.get(session.playerId);
            if (player && this.worldLayerForPlayer(player) === this.activeLayer) {
                try { ws.send(text); } catch {}
            }
        }
    }

    addNode(node) {
        node.id = this.nextNodeId++;
        this.resourceNodes.push(node);
        this.nodeById.set(node.id, node);
        this.dirty.nodes = true;
        this.dirty.meta = true;
        this.queueNodeSet(node);
        return node;
    }

    dropWorldToken(token, x, y) {
        const definition = WORLD_TOKEN_NODES[token];
        if (!definition || this.worldTokenDrops[token] || this.worldTokenInventory[token]) return false;
        this.worldTokenDrops[token] = true;
        this.dirty.meta = true;
        this.addNode({ x, y, type: definition.type, icon: definition.icon, pickup: true });
        return true;
    }

    removeNode(node) {
        const i = this.resourceNodes.indexOf(node);
        if (i >= 0) this.resourceNodes.splice(i, 1);
        this.nodeById.delete(node.id);
        this.nodePatchSet.delete(node.id);
        this.nodePatchDel.add(node.id);
        this.dirty.nodes = true;
    }

    queueNodeSet(node) {
        this.nodePatchSet.set(node.id, node);
        this.nodePatchDel.delete(node.id);
        this.dirty.nodes = true;
    }

    flushPatches() {
        const hasNodes = this.nodePatchSet.size > 0 || this.nodePatchDel.size > 0;
        const hasBuildings = this.buildingPatchSet.size > 0 || this.buildingPatchDel.size > 0;
        if (!hasNodes && !hasBuildings) return;

        const message = { type: 'world:patch' };
        if (hasNodes) message.nodes = { set: Array.from(this.nodePatchSet.values()), del: Array.from(this.nodePatchDel) };
        if (hasBuildings) {
            message.buildings = {
                set: Array.from(this.buildingPatchSet.values()).map(b => this.serializeBuilding(b)),
                del: Array.from(this.buildingPatchDel)
            };
        }
        this.broadcastLayer(message);

        this.nodePatchSet.clear();
        this.nodePatchDel.clear();
        this.buildingPatchSet.clear();
        this.buildingPatchDel.clear();
    }


    // =========================================================
    // WORLD GENERATION (same algorithm as the client)
    // =========================================================

    generateWorld({ terrainOnly = false } = {}) {
        this.normalizeSeedOrThrow();
        this.activeLayer = 'surface';
        this.worldLayers.surface = null;
        this.updateWorldDimensions();
        this.cavesEnabled = this.worldConfig.cavesEnabled !== false;
        this.worldLayers.caves = this.cavesEnabled ? this.generateCaveLayer() : null;

        const R = this.ROWS, C = this.COLS;
        const cfg = this.worldConfig;
        const preset = cfg.mapPreset || 'standard';

        const grid = Array.from({ length: R }, () => new Array(C).fill('OCEAN'));
        this.worldGrid = grid;

        if (!terrainOnly) {
            this.resourceNodes = [];
            this.mobs = [];
            this.buildings = [];
            this.nextNodeId = 1;
            this.nextMobId = 1;
        }

        this.currentRandomState = this.worldSeed;
        const rnd = () => this.seededRandom();

        const removesOcean = ['dry', 'inland', 'riverlands'].includes(preset);
        const forestScale = Math.max(0.01, Number(cfg.forestMult || 1));
        const mountainScale = Math.max(0.01, Number(cfg.mountainMult || 1));
        const isDryOrInland = ['dry', 'inland'].includes(preset);
        const occupancy = new Uint8Array(C * R);

        const isBarrenZone = (x, y) => {
            const patch = Math.sin(x * 0.021 + this.worldSeed * 0.001) + Math.cos(y * 0.019 - this.worldSeed * 0.0013);
            return patch > 1.82 && Math.sin((x + y) * 0.013) > 0.35;
        };

        const v2 = this.genVersion >= 2;
        const areaScale = v2 ? (C * R) / (520 * 520) : 1;
        const totalPlains = v2 && preset !== 'dry' ? GEN_V2.plainsBlobs * areaScale : 0;
        const totalForests = (v2 ? GEN_V2.forestBlobs * areaScale : 500) * forestScale;
        const totalMountains = (v2 ? GEN_V2.mountainBlobs * areaScale : 300) * mountainScale;

        // ---- STEP 0: terrain ----
        const oceanMult = Number(cfg.oceanMult) || 1;
        const forestMult = Number(cfg.forestMult) || 1;
        const mountainMult = Number(cfg.mountainMult) || 1;

        let oceanLevel = 0.45 + (oceanMult - 1) * 0.10;
        if (preset === 'islands') oceanLevel += 0.08;
        if (preset === 'dry') oceanLevel -= 0.10;
        if (preset === 'inland') oceanLevel -= 0.05;
        if (preset === 'riverlands') oceanLevel -= 0.02;
        oceanLevel = Math.max(0.20, Math.min(0.70, oceanLevel));

        for (let y = 0; y < R; y++) {
            for (let x = 0; x < C; x++) {
                const nx = x / Math.max(1, C - 1);
                const ny = y / Math.max(1, R - 1);

                const large = this.fbmNoise(nx * 2.5 + this.worldSeed * 0.00001, ny * 2.5 + this.worldSeed * 0.000013, 4);
                const medium = this.fbmNoise(nx * 5.0 + this.worldSeed * 0.000021, ny * 5.0 + this.worldSeed * 0.000017, 4);
                const detail = this.fbmNoise(nx * 11.0 + this.worldSeed * 0.000031, ny * 11.0 + this.worldSeed * 0.000027, 3);

                let elevation = large * 0.60 + medium * 0.28 + detail * 0.12;
                elevation = Math.max(0, Math.min(1, elevation));

                if (preset === 'islands') {
                    const islandDetail = this.fbmNoise(nx * 7.0 + this.worldSeed * 0.000041, ny * 7.0 + this.worldSeed * 0.000037, 4);
                    elevation = elevation * 0.70 + islandDetail * 0.30;
                }

                const moisture = this.fbmNoise(nx * 6.0 + 100, ny * 6.0 + 200, 4);
                const temperature = this.fbmNoise(nx * 3.5 + 500, ny * 3.5 + 600, 3);

                let biome;
                if (!removesOcean && elevation < oceanLevel) {
                    biome = 'OCEAN';
                } else if (!removesOcean && elevation < oceanLevel + 0.045) {
                    biome = 'BEACH';
                } else {
                    const mountainThreshold = 0.78 - ((mountainMult - 1) * 0.08);
                    if (elevation > mountainThreshold && elevation > oceanLevel + 0.15) {
                        biome = temperature < 0.30 ? 'SNOW' : 'MOUNTAIN';
                    } else if (v2) {
                        // v2: DESERT is the fallback; plains/forest/mountain are placed below.
                        biome = 'DESERT';
                    } else if (preset === 'dry' || (moisture < 0.28 && temperature > 0.50)) {
                        biome = 'DESERT';
                    } else {
                        const forestThreshold = 0.68 - ((forestMult - 1) * 0.10);
                        biome = (moisture > forestThreshold && elevation > oceanLevel + 0.05) ? 'FOREST' : 'PLAINS';
                    }
                }

                if (preset === 'dry' && biome === 'BEACH') biome = 'DESERT';
                if (preset === 'inland' && biome === 'BEACH') biome = 'PLAINS';

                grid[y][x] = biome;
            }
        }

        // ---- STEP 1: rivers ----
        const riverCount = preset === 'dry' ? 0 : Math.max(2, Math.min(6, Math.round((C + R) / 220)));
        for (let i = 0; i < riverCount; i++) {
            let x = Math.floor(rnd() * C);
            let y = Math.floor(rnd() * R);
            const targetX = Math.floor(C * (0.3 + rnd() * 0.4));
            const targetY = Math.floor(R * (0.3 + rnd() * 0.4));

            for (let step = 0; step < 420; step++) {
                const dx = targetX - x;
                const dy = targetY - y;
                const dist = Math.max(1, Math.hypot(dx, dy));
                x += Math.max(-2, Math.min(2, Math.round((dx / dist) * (1 + rnd() * 2.5))));
                y += Math.max(-2, Math.min(2, Math.round((dy / dist) * (1 + rnd() * 2.5))));
                x = Math.max(0, Math.min(C - 1, x));
                y = Math.max(0, Math.min(R - 1, y));

                for (let yy = Math.max(0, y - 1); yy <= Math.min(R - 1, y + 1); yy++) {
                    for (let xx = Math.max(0, x - 1); xx <= Math.min(C - 1, x + 1); xx++) {
                        if (grid[yy][xx] !== 'OCEAN' && grid[yy][xx] !== 'LAKE') grid[yy][xx] = 'RIVER';
                    }
                }
            }
        }

        // ---- STEP 2: lakes ----
        const lakeCount = preset === 'dry' ? 0 : 10;
        for (let i = 0; i < lakeCount; i++) {
            const cx = Math.floor(rnd() * C);
            const cy = Math.floor(rnd() * R);
            const radius = 6 + Math.floor(rnd() * 14);
            const rSq = radius * radius;
            for (let y = Math.max(0, cy - radius); y < Math.min(R, cy + radius); y++) {
                for (let x = Math.max(0, cx - radius); x < Math.min(C, cx + radius); x++) {
                    if (((x - cx) ** 2 + (y - cy) ** 2) < rSq && grid[y][x] !== 'OCEAN' && grid[y][x] !== 'SNOW') grid[y][x] = 'LAKE';
                }
            }
        }

        // ---- STEP 2b: plains (v2 only) ----
        for (let i = 0; i < totalPlains; i++) {
            const cx = Math.floor(rnd() * C);
            const cy = Math.floor(rnd() * R);
            const radius = GEN_V2.plainsRadius[0] + Math.floor(rnd() * GEN_V2.plainsRadius[1]);
            const rSq = radius * radius;
            for (let y = Math.max(0, cy - radius); y < Math.min(R, cy + radius); y++) {
                for (let x = Math.max(0, cx - radius); x < Math.min(C, cx + radius); x++) {
                    if (((x - cx) ** 2 + (y - cy) ** 2) < rSq && !LIQUIDS.has(grid[y][x]) &&
                        grid[y][x] !== 'BEACH' && grid[y][x] !== 'MOUNTAIN' && grid[y][x] !== 'SNOW') {
                        grid[y][x] = 'PLAINS';
                    }
                }
            }
        }

        // ---- STEP 3: forests ----
        for (let i = 0; i < totalForests; i++) {
            const cx = Math.floor(rnd() * C);
            const cy = Math.floor(rnd() * R);
            const radius = 14 + Math.floor(rnd() * 18);
            const rSq = radius * radius;
            for (let y = Math.max(0, cy - radius); y < Math.min(R, cy + radius); y++) {
                for (let x = Math.max(0, cx - radius); x < Math.min(C, cx + radius); x++) {
                    if (((x - cx) ** 2 + (y - cy) ** 2) < rSq && !LIQUIDS.has(grid[y][x]) && grid[y][x] !== 'BEACH' && grid[y][x] !== 'MOUNTAIN') {
                        grid[y][x] = 'FOREST';
                    }
                }
            }
        }

        // ---- STEP 4: mountains ----
        for (let i = 0; i < totalMountains; i++) {
            const cx = Math.floor(rnd() * C);
            const cy = Math.floor(rnd() * R);
            const radius = 10 + Math.floor(rnd() * 14);
            const rSq = radius * radius;
            for (let y = Math.max(0, cy - radius); y < Math.min(R, cy + radius); y++) {
                for (let x = Math.max(0, cx - radius); x < Math.min(C, cx + radius); x++) {
                    if (((x - cx) ** 2 + (y - cy) ** 2) < rSq && !LIQUIDS.has(grid[y][x]) && grid[y][x] !== 'BEACH') {
                        grid[y][x] = 'MOUNTAIN';
                    }
                }
            }
        }

        // ---- STEP 5: shoreline + resource/mob spawns ----
        const push = node => { node.id = this.nextNodeId++; this.resourceNodes.push(node); };

        for (let y = 0; y < R; y++) {
            for (let x = 0; x < C; x++) {
                let biome = grid[y][x];

                if (!LIQUIDS.has(biome)) {
                    const west = x > 0 ? grid[y][x - 1] : null;
                    const east = x < C - 1 ? grid[y][x + 1] : null;
                    const north = y > 0 ? grid[y - 1][x] : null;
                    const south = y < R - 1 ? grid[y + 1][x] : null;
                    if (LIQUIDS.has(west) || LIQUIDS.has(east) || LIQUIDS.has(north) || LIQUIDS.has(south)) {
                        grid[y][x] = isDryOrInland ? 'DESERT' : 'BEACH';
                        biome = grid[y][x];
                    }
                } else if (biome === 'OCEAN') {
                    const west = x > 0 ? grid[y][x - 1] : null;
                    const east = x < C - 1 ? grid[y][x + 1] : null;
                    const north = y > 0 ? grid[y - 1][x] : null;
                    const south = y < R - 1 ? grid[y + 1][x] : null;
                    if (west === 'BEACH' || east === 'BEACH' || north === 'BEACH' || south === 'BEACH') {
                        grid[y][x] = 'SHALLOW_WATER';
                    }
                    continue;
                } else {
                    continue;
                }

                // Restoring a room: the shoreline above is all we need.
                if (terrainOnly) continue;

                if (isBarrenZone(x, y)) continue;

                const roll = rnd();
                const cellOffset = y * C + x;
                const px = x * CELL_SIZE, py = y * CELL_SIZE;

                const nodeRollThreshold = biome === 'MOUNTAIN' ? 0.04 : 0.12;
                if (roll < nodeRollThreshold * cfg.resMult) {
                    if (biome === 'FOREST' || biome === 'BEACH' || biome === 'SNOW') {
                        push({
                            x: px, y: py, type: 'wood',
                            icon: biome === 'BEACH' ? '🌴' : biome === 'SNOW' ? '🌲' : '🌳',
                            hp: 5, maxHp: 5,
                            biome: biome === 'BEACH' ? 'palm' : biome === 'SNOW' ? 'snow' : 'forest'
                        });
                        occupancy[cellOffset] = 1;
                    } else if (biome === 'MOUNTAIN') {
                        push({
                            x: px, y: py, type: 'big_rock',
                            icon: '🪨',
                            hp: 10, maxHp: 10
                        });
                        occupancy[cellOffset] = 1;
                    }
                }

                if (!occupancy[cellOffset] && roll < 0.08 * cfg.resMult) {
                    if (biome === 'BEACH') {
                        if (rnd() < 0.35) push({ x: px, y: py, type: 'twigs', icon: '🥢', pickup: true });
                        if (rnd() < 0.1 * cfg.foodMult) push({ x: px, y: py, type: 'berries', icon: '🍒', pickup: true });
                    } else if (biome === 'PLAINS' || biome === 'DESERT') {
                        if (rnd() < 0.18 * cfg.resMult) push({ x: px, y: py, type: 'flint', icon: '🔷', pickup: true });
                        if (rnd() < 0.035 * cfg.foodMult) push({ x: px, y: py, type: 'carrots', icon: '🥕', pickup: true });
                        if (rnd() < 0.01 * cfg.wildlifeMult) {
                            this.mobs.push({ id: this.nextMobId++, type: 'elephant', x: px, y: py, emoji: '🐘', tx: px, ty: py, hp: 100, maxHp: 100 });
                        }
                    } else if (biome === 'FOREST' || biome === 'SNOW') {
                        if (rnd() < 0.22) push({ x: px, y: py, type: 'twigs', icon: '🥢', pickup: true });
                        if (rnd() < 0.18) push({ x: px, y: py, type: 'acorn', icon: '🌰', pickup: true });
                        if (rnd() < 0.12 * cfg.foodMult) push({ x: px, y: py, type: 'berries', icon: '🍒', pickup: true });
                    }
                }
            }
        }

        // ---- STEP 6: ruins ----
        if (!terrainOnly) {
            // v2: the Ruins setting decides how many (12 at 1.0x on a normal-size map). v1 always made 12 attempts.
            const ruinTarget = v2 ? Math.round(12 * Math.max(0, Number(cfg.ruinsMult ?? 1)) * areaScale) : 12;
            const maxAttempts = v2 ? ruinTarget * 30 + 30 : 12;
            let placed = 0;

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                if (v2 && placed >= ruinTarget) break;

                const x = Math.floor(rnd() * (C - 8)) + 4;
                const y = Math.floor(rnd() * (R - 8)) + 4;

                if (!grid[y] || !['PLAINS', 'DESERT', 'FOREST'].includes(grid[y][x]) || isBarrenZone(x, y)) continue;

                const walls = [[-1, -1], [0, -1], [1, -1], [-1, 1], [-1, 0]];
                for (const [ox, oy] of walls) {
                    this.buildings.push({
                        id: crypto.randomUUID(),
                        x: (x + ox) * CELL_SIZE, y: (y + oy) * CELL_SIZE,
                        type: 'wall', hp: 500, maxHp: 500
                    });
                }
                placed++;

                if (rnd() < (v2 ? 0.8 : 0.7)) {
                    const inventory = emptyChest();
                    if (v2) {
                        rollRuinLoot(rnd).forEach((slot, index) => { inventory[index] = slot; });
                    } else {
                        const loot = [['wood', 4], ['stone', 3], ['flint', 2], ['twigs', 3], ['berries', 2]];
                        loot.slice(0, 2 + Math.floor(rnd() * 3)).forEach(([type, count], index) => { inventory[index] = { type, count }; });
                    }
                    this.buildings.push({
                        id: crypto.randomUUID(),
                        x: x * CELL_SIZE, y: y * CELL_SIZE,
                        type: 'chest', hp: 400, maxHp: 400, inventory
                    });
                }
            }
        }
    }

    generateCaveLayer() {
        const rows = this.ROWS;
        const cols = this.COLS;
        const grid = Array.from({ length: rows }, () => new Array(cols).fill('CAVE_WALL'));
        const nodes = [];
        const buildings = [];
        const rooms = [];
        let randomState = (this.worldSeed ^ 0x6d2b79f5) >>> 0;
        const rnd = () => {
            randomState = (randomState * 1664525 + 1013904223) >>> 0;
            return randomState / 4294967296;
        };
        const carveTunnel = (from, to, width) => {
            const horizontalFirst = rnd() < 0.5;
            const carve = (cx, cy, radius) => {
                for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
                    if (dx * dx + dy * dy <= radius * radius + 1 && grid[cy + dy]?.[cx + dx] === 'CAVE_WALL') grid[cy + dy][cx + dx] = 'CAVE_FLOOR';
                }
            };
            let x = from.x, y = from.y, step = 0;
            const walkX = () => {
                while (x !== to.x) {
                    const radius = Math.max(1, Math.round(width + Math.sin(step * 0.22) * 0.8));
                    carve(x, y, radius);
                    x += Math.sign(to.x - x);
                    step++;
                }
            };
            const walkY = () => {
                while (y !== to.y) {
                    const radius = Math.max(1, Math.round(width + Math.cos(step * 0.19) * 0.8));
                    carve(x, y, radius);
                    y += Math.sign(to.y - y);
                    step++;
                }
            };
            if (horizontalFirst) { walkX(); walkY(); }
            else { walkY(); walkX(); }
            carve(x, y, width);
        };
        const roomCount = 16;
        for (let i = 0; i < roomCount; i++) {
            const cx = i === 0 ? Math.floor(cols / 2) : 10 + Math.floor(rnd() * Math.max(1, cols - 20));
            const cy = i === 0 ? Math.floor(rows / 2) : 10 + Math.floor(rnd() * Math.max(1, rows - 20));
            const radiusX = 7 + Math.floor(rnd() * 17);
            const radiusY = 7 + Math.floor(rnd() * 16);
            const chamber = { x: cx, y: cy, radiusX, radiusY };
            rooms.push(chamber);
            for (let y = Math.max(1, cy - radiusY - 2); y < Math.min(rows - 1, cy + radiusY + 2); y++) {
                for (let x = Math.max(1, cx - radiusX - 2); x < Math.min(cols - 1, cx + radiusX + 2); x++) {
                    const nx = (x - cx) / radiusX, ny = (y - cy) / radiusY;
                    const roughEdge = 1 + 0.16 * Math.sin((x + this.worldSeed % 97) * 0.71) * Math.cos((y - this.worldSeed % 53) * 0.63);
                    const sidePocket = Math.sin((x + this.worldSeed % 31) * 0.23) * Math.cos((y + this.worldSeed % 43) * 0.19) > 0.88;
                    if (nx * nx + ny * ny <= roughEdge || sidePocket && nx * nx + ny * ny < 1.35) grid[y][x] = 'CAVE_FLOOR';
                }
            }
            if (i > 0) {
                const previous = rooms[i - 1];
                carveTunnel(previous, chamber, 2 + (i % 3 === 0 ? 1 : 0));
                if (i % 3 === 0) {
                    const branchEnd = {
                        x: Math.max(2, Math.min(cols - 3, cx + (i % 2 ? -1 : 1) * (8 + Math.floor(rnd() * 12)))),
                        y: Math.max(2, Math.min(rows - 3, cy + (i % 2 ? 1 : -1) * (7 + Math.floor(rnd() * 10))))
                    };
                    carveTunnel(chamber, branchEnd, 1 + (i % 2));
                    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
                        if (dx * dx + dy * dy <= 9 && grid[branchEnd.y + dy]?.[branchEnd.x + dx] === 'CAVE_WALL') grid[branchEnd.y + dy][branchEnd.x + dx] = 'CAVE_FLOOR';
                    }
                }
            }
        }

        const caveRooms = rooms.slice(1, 7);
        const entrancePoints = caveRooms.map(room => ({ x: room.x * CELL_SIZE, y: room.y * CELL_SIZE }));
        const skylightRooms = caveRooms;
        for (const room of skylightRooms) {
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                if (dx * dx + dy * dy <= 5) grid[room.y + dy][room.x + dx] = 'CAVE_SUNLIT';
            }
        }

        const passageCells = new Set();
        for (const room of skylightRooms) {
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                if (dx * dx + dy * dy <= 5) passageCells.add(`${room.x + dx},${room.y + dy}`);
            }
        }
        for (let y = 2; y < rows - 2; y++) {
            for (let x = 2; x < cols - 2; x++) {
                const biome = grid[y][x];
                if (biome === 'CAVE_WALL' || passageCells.has(`${x},${y}`) || rnd() >= 0.12 * this.worldConfig.resMult) continue;
                const iron = rnd() < 0.24;
                nodes.push({
                    id: nodes.length + 1,
                    x: x * CELL_SIZE, y: y * CELL_SIZE,
                    type: iron ? 'iron' : 'big_rock',
                    icon: iron ? '⛓️' : '🪨',
                    hp: iron ? 8 : 10, maxHp: iron ? 8 : 10
                });
            }
        }

        buildings.push(...caveRooms.map((room, index) => ({
            id: `cave-exit-${index + 1}`,
            entranceId: `cave-entrance-${index + 1}`,
            x: room.x * CELL_SIZE,
            y: room.y * CELL_SIZE,
            type: 'cave_exit', hp: 1, maxHp: 1
        })));
        return {
            worldGrid: grid,
            resourceNodes: nodes,
            nodeById: new Map(nodes.map(node => [node.id, node])),
            nextNodeId: nodes.length + 1,
            mobs: [],
            nextMobId: 1,
            buildings,
            wallCells: new Set(),
            nodePatchSet: new Map(), nodePatchDel: new Set(),
            buildingPatchSet: new Map(), buildingPatchDel: new Set(),
            dirty: { nodes: false, buildings: false, mobs: false },
            entrancePoints
        };
    }

    ensureCaveEntrances() {
        const caves = this.worldLayers.caves;
        if (!caves) return;
        const existingEntrances = this.buildings.filter(building => building.type === 'cave_entrance');
        if (existingEntrances.length) {
            let changed = false;
            for (const entrance of existingEntrances) {
                if (entrance.width !== 2 * CELL_SIZE || entrance.height !== 2 * CELL_SIZE) {
                    entrance.width = 2 * CELL_SIZE;
                    entrance.height = 2 * CELL_SIZE;
                    changed = true;
                }
            }
            if (changed) this.dirty.buildings = true;
            return;
        }
        let randomState = (this.worldSeed ^ 0x3c6ef372) >>> 0;
        const rnd = () => {
            randomState = (randomState * 1664525 + 1013904223) >>> 0;
            return randomState / 4294967296;
        };
        const occupied = new Set([
            ...this.buildings.flatMap(building => {
                const cells = [];
                const width = building.type === 'cave_entrance' ? 2 : 1;
                const height = building.type === 'cave_entrance' ? 2 : 1;
                for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
                    cells.push(`${Math.floor(building.x / CELL_SIZE) + dx},${Math.floor(building.y / CELL_SIZE) + dy}`);
                }
                return cells;
            }),
            ...this.resourceNodes.filter(node => !node.pickup).map(node => `${Math.floor(node.x / CELL_SIZE)},${Math.floor(node.y / CELL_SIZE)}`)
        ]);
        let found = 0;
        for (let attempt = 0; attempt < 10000 && found < caves.entrancePoints.length; attempt++) {
            const x = 3 + Math.floor(rnd() * Math.max(1, this.COLS - 7));
            const y = 3 + Math.floor(rnd() * Math.max(1, this.ROWS - 7));
            let available = true;
            for (let dy = 0; dy < 2 && available; dy++) for (let dx = 0; dx < 2; dx++) {
                const key = `${x + dx},${y + dy}`;
                const biome = this.worldGrid[y + dy]?.[x + dx];
                if (!biome || LIQUIDS.has(biome) || ['MOUNTAIN', 'SNOW'].includes(biome) || occupied.has(key)) {
                    available = false;
                    break;
                }
            }
            if (!available) continue;
            const target = caves.entrancePoints[found];
            this.buildings.push({
                id: `cave-entrance-${found + 1}`,
                x: x * CELL_SIZE, y: y * CELL_SIZE,
                width: 2 * CELL_SIZE, height: 2 * CELL_SIZE,
                type: 'cave_entrance', caveX: target.x, caveY: target.y,
                caveExitId: `cave-exit-${found + 1}`,
                hp: 1, maxHp: 1
            });
            for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) occupied.add(`${x + dx},${y + dy}`);
            found++;
        }
        if (found) this.dirty.buildings = true;
    }

    ensureCaveExitLinks() {
        const caves = this.worldLayers.caves;
        if (!caves) return;
        const entrances = this.buildings
            .filter(building => building.type === 'cave_entrance')
            .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
        if (!entrances.length) return;
        entrances.forEach((entrance, index) => {
            entrance.width = 2 * CELL_SIZE;
            entrance.height = 2 * CELL_SIZE;
            entrance.caveExitId = `cave-exit-${index + 1}`;
        });
        this.withLayer('caves', () => {
            const previous = this.buildings.filter(building => building.type === 'cave_exit');
            this.buildings = this.buildings.filter(building => building.type !== 'cave_exit');
            entrances.forEach((entrance, index) => {
                let gx = Math.floor(Number(entrance.caveX) / CELL_SIZE);
                let gy = Math.floor(Number(entrance.caveY) / CELL_SIZE);
                const traversable = (x, y) => ['CAVE_FLOOR', 'CAVE_SUNLIT'].includes(this.worldGrid[y]?.[x]);
                if (!traversable(gx, gy)) {
                    const originX = Number.isFinite(gx) ? gx : Math.floor(this.COLS / 2);
                    const originY = Number.isFinite(gy) ? gy : Math.floor(this.ROWS / 2);
                    let found = null;
                    for (let radius = 1; radius < Math.max(this.COLS, this.ROWS) && !found; radius++) {
                        for (let dy = -radius; dy <= radius && !found; dy++) {
                            for (let dx = -radius; dx <= radius; dx++) {
                                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                                if (traversable(originX + dx, originY + dy)) {
                                    found = { x: originX + dx, y: originY + dy };
                                    break;
                                }
                            }
                        }
                    }
                    if (!found) throw new Error('Could not find traversable terrain for a cave exit.');
                    gx = found.x;
                    gy = found.y;
                    entrance.caveX = gx * CELL_SIZE;
                    entrance.caveY = gy * CELL_SIZE;
                }
                const oldExit = previous.find(building => building.entranceId === entrance.id);
                for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                    if (dx * dx + dy * dy <= 5 && this.worldGrid[gy + dy]?.[gx + dx] === 'CAVE_FLOOR') {
                        this.worldGrid[gy + dy][gx + dx] = 'CAVE_SUNLIT';
                    }
                }
                this.buildings.push({
                    ...(oldExit || {}),
                    id: `cave-exit-${index + 1}`,
                    entranceId: entrance.id,
                    x: gx * CELL_SIZE,
                    y: gy * CELL_SIZE,
                    type: 'cave_exit', hp: 1, maxHp: 1
                });
            });
            this.dirty.buildings = true;
            this.dirty.caves = true;
        });
        this.dirty.buildings = true;
    }

    ensureGregSpawn() {
        const existingGreg = this.mobs.find(mob => mob.type === 'greg');
        const exits = this.buildings.filter(building => building.type === 'cave_exit');
        let best = this.gregArena &&
            this.gregArena.x >= 17 && this.gregArena.y >= 17 &&
            this.gregArena.x < this.COLS - 17 && this.gregArena.y < this.ROWS - 17
            ? { x: this.gregArena.x, y: this.gregArena.y }
            : null;
        if (!best && existingGreg && Number.isFinite(existingGreg.x) && Number.isFinite(existingGreg.y)) {
            const x = Math.floor(existingGreg.x / CELL_SIZE), y = Math.floor(existingGreg.y / CELL_SIZE);
            if (x >= 17 && y >= 17 && x < this.COLS - 17 && y < this.ROWS - 17) best = { x, y };
        }
        if (!best) {
            let bestDistance = -1;
            const exitCells = exits.map(exit => ({ x: Math.floor(exit.x / CELL_SIZE), y: Math.floor(exit.y / CELL_SIZE) }));
            for (let y = 17; y < this.ROWS - 17; y++) {
                for (let x = 17; x < this.COLS - 17; x++) {
                    if (this.worldGrid[y]?.[x] !== 'CAVE_FLOOR') continue;
                    let nearestExit = Infinity;
                    for (const exit of exitCells) nearestExit = Math.min(nearestExit, Math.hypot(x - exit.x, y - exit.y));
                    if (nearestExit > bestDistance) {
                        bestDistance = nearestExit;
                        best = { x, y };
                    }
                }
            }
        }
        if (!best) return;
        this.gregArena = { x: best.x, y: best.y };
        this.dirty.meta = true;
        if (existingGreg) {
            const previousX = existingGreg.x, previousY = existingGreg.y;
            if (!existingGreg.size) {
                existingGreg.x -= CELL_SIZE;
                existingGreg.y -= CELL_SIZE;
            }
            existingGreg.size = GREG_SIZE;
            existingGreg.x = clamp(existingGreg.x, (best.x - 10) * CELL_SIZE, (best.x + 7) * CELL_SIZE);
            existingGreg.y = clamp(existingGreg.y, (best.y - 10) * CELL_SIZE, (best.y + 7) * CELL_SIZE);
            if (existingGreg.x !== previousX || existingGreg.y !== previousY) this.dirty.caves = true;
        }
        for (let dy = -15; dy < 15; dy++) {
            for (let dx = -15; dx < 15; dx++) {
                this.worldGrid[best.y + dy][best.x + dx] = 'CAVE_SUNLIT';
            }
        }
        const arenaNodes = this.resourceNodes.length;
        this.resourceNodes = this.resourceNodes.filter(node =>
            Math.abs(Math.floor(node.x / CELL_SIZE) - best.x) > 15 ||
            Math.abs(Math.floor(node.y / CELL_SIZE) - best.y) > 15
        );
        if (this.resourceNodes.length !== arenaNodes) {
            this.nodeById = new Map(this.resourceNodes.map(node => [node.id, node]));
            this.dirty.nodes = true;
            this.dirty.caves = true;
        }
        if (this.gregDefeated || existingGreg) return;
        this.mobs.push({
            id: this.nextMobId++,
            type: 'greg',
            x: (best.x - 1) * CELL_SIZE,
            y: (best.y - 1) * CELL_SIZE,
            emoji: '🐘',
            tx: (best.x - 1) * CELL_SIZE,
            ty: (best.y - 1) * CELL_SIZE,
            size: GREG_SIZE,
            hp: 2000,
            maxHp: 2000,
            chargeState: 'idle',
            chargeTimer: 0
        });
        this.dirty.caves = true;
    }


    // =========================================================
    // NOISE / RNG (identical to the client)
    // =========================================================

    seedStringToNumber(str) {
        let hash = 2166136261;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    seededRandom() {
        this.currentRandomState = (Math.imul(this.currentRandomState, 1664525) + 1013904223) >>> 0;
        return this.currentRandomState / 4294967296;
    }

    seededNoise2D(x, y, seed = this.worldSeed) {
        const s = Math.sin(x * 127.1 + y * 311.7 + seed * 0.000123) * 43758.5453123;
        return s - Math.floor(s);
    }

    smoothNoise(x, y) {
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const xf = x - x0, yf = y - y0;
        const sx = xf * xf * (3 - 2 * xf);
        const sy = yf * yf * (3 - 2 * yf);
        const n00 = this.seededNoise2D(x0, y0);
        const n10 = this.seededNoise2D(x0 + 1, y0);
        const n01 = this.seededNoise2D(x0, y0 + 1);
        const n11 = this.seededNoise2D(x0 + 1, y0 + 1);
        const ix0 = n00 + (n10 - n00) * sx;
        const ix1 = n01 + (n11 - n01) * sx;
        return ix0 + (ix1 - ix0) * sy;
    }

    fbmNoise(x, y, octaves = 4) {
        let value = 0, amplitude = 0.5, frequency = 1, total = 0;
        for (let i = 0; i < octaves; i++) {
            value += this.smoothNoise(x * frequency, y * frequency) * amplitude;
            total += amplitude;
            frequency *= 2;
            amplitude *= 0.5;
        }
        return value / total;
    }

    updateWorldDimensions() {
        const scale = Number(this.worldConfig.worldSizeMult || 1);
        const base = 520;
        this.COLS = Math.max(1, Math.round(base * scale));
        this.ROWS = Math.max(1, Math.round(base * scale));
        this.worldWidth = this.COLS * CELL_SIZE;
        this.worldHeight = this.ROWS * CELL_SIZE;
    }

    findNearestLandSpawn() {
        let best = { x: Math.floor(this.COLS / 2), y: Math.floor(this.ROWS / 2) };
        let bestDist = Infinity;
        for (let y = 0; y < this.ROWS; y++) {
            for (let x = 0; x < this.COLS; x++) {
                const biome = this.worldGrid[y]?.[x];
                if (!biome || biome === 'OCEAN' || biome === 'LAKE') continue;
                const dist = (x - this.COLS / 2) ** 2 + (y - this.ROWS / 2) ** 2;
                if (dist < bestDist) { bestDist = dist; best = { x, y }; }
            }
        }
        return { x: best.x * CELL_SIZE + 20, y: best.y * CELL_SIZE + 20 };
    }

    biomeAt(x, y) {
        const tx = Math.floor(x / CELL_SIZE), ty = Math.floor(y / CELL_SIZE);
        if (tx < 0 || ty < 0 || tx >= this.COLS || ty >= this.ROWS) return 'OCEAN';
        return this.worldGrid[ty]?.[tx] || 'OCEAN';
    }


    // =========================================================
    // INVENTORY
    // =========================================================

    hasResources(player, cost) {
        for (const [type, needed] of Object.entries(cost)) {
            let total = 0;
            for (const slot of player.inventory) if (slot?.type === type) total += Number(slot.count) || 0;
            if (total < Number(needed)) return false;
        }
        return true;
    }

    payResources(player, cost) {
        for (const [type, needed] of Object.entries(cost)) {
            let remaining = Number(needed);
            for (const slot of player.inventory) {
                if (slot?.type !== type) continue;
                const take = Math.min(remaining, Number(slot.count) || 0);
                slot.count -= take;
                remaining -= take;
                if (slot.count <= 0) Object.assign(slot, emptyPlayerSlot());
                if (remaining <= 0) break;
            }
        }
    }

    canGive(player, type, count = 1) {
        if (DURABILITY[type] || NON_STACKABLE_ITEMS.has(type)) return player.inventory.filter(s => !s.type).length >= count;
        return player.inventory.some(s => s.type === type) || player.inventory.some(s => !s.type);
    }

    // Can every (type, count) pair fit at once?
    canGiveAll(player, items) {
        let freeSlots = player.inventory.filter(s => !s.type).length;
        const stacked = new Set(player.inventory.filter(s => s.type).map(s => s.type));
        for (const [type] of items) {
            if (!DURABILITY[type] && !NON_STACKABLE_ITEMS.has(type) && stacked.has(type)) continue;
            if (freeSlots <= 0) return false;
            freeSlots--;
            if (!DURABILITY[type] && !NON_STACKABLE_ITEMS.has(type)) stacked.add(type);
        }
        return true;
    }

    giveItem(player, type, count = 1) {
        const amount = Math.max(1, Math.floor(Number(count) || 1));

        if (DURABILITY[type] || NON_STACKABLE_ITEMS.has(type)) {
            for (let i = 0; i < amount; i++) {
                const slot = player.inventory.find(s => !s.type);
                if (!slot) return false;
                slot.type = type; slot.count = 1;
                slot.duration = DURABILITY[type] || 0; slot.maxDuration = DURABILITY[type] || 0;
                if (NON_STACKABLE_ITEMS.has(type)) slot.thermalTemp = 0;
            }
            return true;
        }

        const stack = player.inventory.find(s => s.type === type);
        if (stack) { stack.count = (Number(stack.count) || 0) + amount; return true; }

        const slot = player.inventory.find(s => !s.type);
        if (!slot) return false;
        slot.type = type; slot.count = amount; slot.duration = 0; slot.maxDuration = 0;
        return true;
    }

    sanitizeInventory(raw) {
        const inventory = Array.from({ length: INVENTORY_SLOTS }, emptyPlayerSlot);
        if (!ALLOW_CLIENT_INVENTORY || this.official || !Array.isArray(raw)) return inventory;   // nobody imports items into the public server

        raw.slice(0, INVENTORY_SLOTS).forEach((slot, i) => {
            const type = typeof slot?.type === 'string' ? slot.type : null;
            if (!type || !ITEM_TYPES.has(type)) return;
            const durable = DURABILITY[type];
            inventory[i] = {
                type,
                count: durable || NON_STACKABLE_ITEMS.has(type) ? 1 : clamp(Math.floor(Number(slot.count) || 0), 1, 999),
                duration: durable ? clamp(Math.floor(Number(slot.duration) || durable), 1, durable) : 0,
                maxDuration: durable || 0,
                ...(type === 'thermal_stone' ? { thermalTemp: clamp(Number(slot.thermalTemp) || 0, -THERMAL_STONE_RANGE, THERMAL_STONE_RANGE) } : {})
            };
        });
        return inventory;
    }

    sanitizeShield(raw) {
        const type = SHIELD_PROTECTION[raw?.type] ? raw.type : null;
        if (!type) return null;
        const maxDurability = DURABILITY[type];
        const rawDurability = Number(raw.durability);
        const durability = clamp(Number.isFinite(rawDurability) ? rawDurability : maxDurability, 0, maxDurability);
        return durability > 0 ? { type, durability, maxDurability } : null;
    }


    // =========================================================
    // PLAYERS
    // =========================================================

    sanitizePlayer(incoming, id) {
        const p = incoming || {};
        return {
            id,
            name: cleanName(p.name, 'SURVIVOR', 16),
            emoji: PLAYER_EMOJIS.includes(p.emoji) ? p.emoji : '🙂',
            color: cleanColor(p.color, '#ffffff'),
            x: 0, y: 0,
            hp: 100,
            hunger: 100,
            bodyHeat: 100,
            shield: null,
            inventory: this.sanitizeInventory(p.inventory),
            inBoat: false,
            boatId: null,
            input: idleInput(),
            selected: 0,
            speedPercent: 100,
            layer: 'surface',
            caveEntranceId: null,
            exposure: 0,
            lastDamageAt: 0,
            creativePanelEnabled: false,
            ohkoEnabled: false,
            firstPerson3D: typeof p.firstPerson3D === 'boolean' ? p.firstPerson3D : null,
            yaw: Number.isFinite(p.yaw) ? p.yaw : -Math.PI / 2,
            creativeSpeedMult: 1,
            creativeNoclip: false,
            creativeInvulnerable: true,
            seenMobs: new Map(),
            online: true,
            lastSeen: Date.now()
        };
    }

    storedPlayer(p) {
        return {
            id: p.id, name: p.name, emoji: p.emoji, color: p.color,
            x: p.x, y: p.y, hp: p.hp, hunger: p.hunger, bodyHeat: p.bodyHeat,
            shield: this.sanitizeShield(p.shield),
            inventory: p.inventory, inBoat: p.inBoat, boatId: p.boatId,
            token: p.token || '', lastSeen: p.lastSeen,
            isOp: !!p.isOp, speedPercent: p.speedPercent ?? 100,
            creativePanelEnabled: !!p.creativePanelEnabled, ohkoEnabled: !!p.ohkoEnabled,
            firstPerson3D: typeof p.firstPerson3D === 'boolean' ? p.firstPerson3D : typeof p.thirdPerson3D === 'boolean' ? p.thirdPerson3D : null,
            yaw: Number.isFinite(p.yaw) ? p.yaw : -Math.PI / 2,
            creativeSpeedMult: p.creativeSpeedMult ?? 1, creativeNoclip: !!p.creativeNoclip,
            creativeInvulnerable: p.creativeInvulnerable !== false,
            layer: p.layer || 'surface', caveEntranceId: p.caveEntranceId || null
        };
    }

    publicPlayer(p) {
        const held = p.inventory?.[p.selected];
        const heldLight = held && ['torch', 'lantern'].includes(held.type) && Number(held.duration) > 0
            ? held.type
            : null;
        return {
            id: p.id, name: p.name, emoji: p.emoji, color: p.color,
            x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
            hp: p.hp, hunger: p.hunger, bodyHeat: p.bodyHeat, inBoat: p.inBoat, boatId: p.boatId,
            shield: this.sanitizeShield(p.shield),
            layer: p.layer || 'surface', heldLight,
            firstPerson3D: typeof p.firstPerson3D === 'boolean' ? p.firstPerson3D : !!this.worldConfig.firstPerson3D,
            yaw: Number.isFinite(p.yaw) ? p.yaw : -Math.PI / 2
        };
    }

    privatePlayer(p) {
        return {
            ...this.publicPlayer(p),
            inventory: p.inventory.map(s => ({ ...s })),
            isOp: !!p.isOp,
            speedPercent: p.speedPercent ?? 100,
            creativePanelEnabled: !!p.creativePanelEnabled,
            ohkoEnabled: !!p.ohkoEnabled,
            creativeSpeedMult: p.creativeSpeedMult ?? 1,
            creativeNoclip: !!p.creativeNoclip,
            creativeInvulnerable: p.creativeInvulnerable !== false,
            creativeFreezeTime: this.creativeFreezeTime
        };
    }

    sendPlayer(player) {
        this.dirty.players = true;
        this.sendToPlayer(player.id, { type: 'player:update', player: this.privatePlayer(player) });
    }

    onlineCount() {
        let n = 0;
        for (const p of this.players.values()) if (p.online) n++;
        return n;
    }

    onlinePlayers() {
        return Array.from(this.players.values()).filter(p => p.online);
    }

    pruneOfflinePlayers() {
        const now = Date.now();
        for (const [id, p] of this.players) {
            if (!p.online && now - (p.lastSeen || 0) > OFFLINE_PLAYER_TTL_MS) this.players.delete(id);
        }
    }


    // =========================================================
    // SERVER TICK
    // =========================================================

    // A plain timer drives the game loop while anyone is connected (alarms would count as billable requests).
    startTicking() {
        if (this.tickTimer) return;
        this.lastTick = Date.now();
        this.lastMobSync = 0;
        this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    }

    stopTicking() {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = null;
    }

    tick() {
        if (!this.worldBuilt || this.onlineCount() === 0) {
            this.stopTicking();
            return;
        }
        try {
            this.runTick();
        } catch (error) {
            console.error('Tick failed:', error);
        }
        this.flush(false);
    }

    runTick() {
        const now = Date.now();
        const dt = Math.min((now - this.lastTick) / 1000, 0.5);
        this.lastTick = now;

        this.updateClock(dt);
        const layers = this.cavesEnabled ? ['surface', 'caves'] : ['surface'];
        for (const layerName of layers) {
            if (layerName === 'caves' && !this.onlinePlayers().some(player => player.layer === 'caves')) continue;
            this.withLayer(layerName, () => {
                const campfires = this.buildings.filter(b => b.type === 'campfire');
                this.updateStoredThermalStones(campfires, dt);
                this.movePlayers(dt);
                this.tickElephants(dt);
                this.tickAlphaWolves(dt);
                this.tickWolves(dt, now, campfires);
                this.updateSurvival(dt, now, campfires);
                this.expireCampfires(now);
                this.flushPatches();
                if (now - this.lastMobSync >= MOB_SYNC_MS) this.syncMobs();
            });
        }
        this.broadcastSnapshot();
        if (now - this.lastMobSync >= MOB_SYNC_MS) this.lastMobSync = now;
    }

    cycleLengths() {
        const d = Number(this.worldConfig.dayMult || 1);
        const n = Number(this.worldConfig.nightMult || 1);
        return { DAY: 240 * d, DUSK: 60 * n, NIGHT: 180 * n };
    }

    phaseInfo() {
        const { DAY, DUSK, NIGHT } = this.cycleLengths();
        const t = this.gameTime;
        if (t < DAY) return { phase: 'DAY', phaseTimeLeft: DAY - t };
        if (t < DAY + DUSK) return { phase: 'DUSK', phaseTimeLeft: DAY + DUSK - t };
        return { phase: 'NIGHT', phaseTimeLeft: DAY + DUSK + NIGHT - t };
    }

    updateClock(dt) {
        if (this.creativeFreezeTime) return;
        const { DAY, DUSK, NIGHT } = this.cycleLengths();
        const total = DAY + DUSK + NIGHT;
        this.gameTime += dt;
        let dayAdvanced = false;
        while (this.gameTime >= total) {
            this.gameTime -= total;
            this.dayCount++;
            this.advanceSeason();
            dayAdvanced = true;
            this.dirty.meta = true;
            this.growSaplings();
        }
        if (dayAdvanced) this.maybeRespawnGregAfterWait();

        const phase = this.phaseInfo().phase;
        if (phase !== this.lastPhase) {
            this.lastPhase = phase;
            if (phase === 'DAY') {
                for (const layer of this.cavesEnabled ? ['surface', 'caves'] : ['surface']) {
                    this.withLayer(layer, () => this.removeWolves());
                }
            }
            if (phase === 'NIGHT' && this.dayCount >= WOLF_FIRST_DAY) this.spawnWolfWave();
        }
        if (phase === 'NIGHT' && this.dayCount >= this.alphaWolfStartDay && !this.alphaWolfDefeated) {
            this.withLayer('surface', () => {
                if (!this.mobs.some(mob => mob.type === 'alpha_wolf')) this.spawnAlphaWolf();
            });
        }
    }

    advanceSeason() {
        if (this.worldConfig.winterLengthDays === 0 && this.worldConfig.mildLengthDays === 0) {
            this.season = 'mild';
            this.seasonDaysRemaining = 0;
            return;
        }
        if (this.seasonDaysRemaining > 0) this.seasonDaysRemaining--;
        if (this.seasonDaysRemaining > 0) return;
        const nextSeason = this.season === 'winter' ? 'mild' : 'winter';
        const nextDuration = this.seasonDurationDays(nextSeason);
        if (nextDuration === 0) {
            this.seasonDaysRemaining = this.seasonDurationDays(this.season);
            return;
        }
        this.season = nextSeason;
        this.seasonDaysRemaining = nextDuration;
        for (const player of this.players.values()) player.bodyHeat = 100;
        this.announce(
            this.season === 'winter' ? 'Winter has arrived. Stay close to a heat source.' : 'The winter has passed.',
            this.season === 'winter' ? '#b9d8e8' : '#2ecc71'
        );
        this.dirty.meta = true;
    }

    seasonDurationDays(season) {
        return season === 'winter'
            ? this.worldConfig.winterLengthDays
            : this.worldConfig.mildLengthDays;
    }

    initializeSeasonSchedule() {
        const winterDays = this.seasonDurationDays('winter');
        const mildDays = this.seasonDurationDays('mild');
        this.season = winterDays > 0 && mildDays === 0 ? 'winter' : 'mild';
        this.seasonDaysRemaining = this.seasonDurationDays(this.season);
    }

    normalizeSeasonSchedule() {
        const winterDays = this.seasonDurationDays('winter');
        const mildDays = this.seasonDurationDays('mild');
        if (winterDays === 0 && mildDays === 0) {
            this.season = 'mild';
            this.seasonDaysRemaining = 0;
            return;
        }
        if (this.seasonDurationDays(this.season) === 0) {
            this.season = winterDays > 0 ? 'winter' : 'mild';
            this.seasonDaysRemaining = this.seasonDurationDays(this.season);
            return;
        }
        this.seasonDaysRemaining = clamp(this.seasonDaysRemaining, 1, this.seasonDurationDays(this.season));
    }

    maybeRespawnGregAfterWait() {
        if (!this.gregDefeated || !this.cavesEnabled || !this.worldLayers.caves) return;
        if (!Number.isInteger(this.gregDefeatedDay)) this.gregDefeatedDay = this.dayCount;
        if (this.dayCount - this.gregDefeatedDay < 10) return;

        this.withLayer('caves', () => {
            this.gregDefeated = false;
            this.ensureGregSpawn();
            if (!this.mobs.some(mob => mob.type === 'greg')) {
                this.gregDefeated = true;
                return;
            }
            this.gregDefeatedDay = null;
            this.dirty.meta = true;
            this.dirty.caves = true;
            this.syncMobs();
            this.announce('Ten days have passed. Greg has returned to the cave arena.', '#ffcc00');
        });
    }

    growSaplings() {
        const grow = () => {
            for (const n of this.resourceNodes) {
                if (n.type === 'sapling' && this.dayCount >= n.plantedDay) {
                    n.type = 'wood'; n.icon = '🌲'; n.hp = 5; n.maxHp = 5;
                    delete n.plantedDay;
                    this.queueNodeSet(n);
                }
            }
        };
        grow();
        if (this.cavesEnabled && this.worldLayers.caves) this.withLayer('caves', grow);
    }

    isBlockedFor(player, x, y) {
        if (this.gregArenaLocked && this.activeLayer === 'caves' &&
            this.isPlayerInsideGregArena(player) &&
            !this.isPointInsideGregArena(x + 13, y + 13)) return true;
        const tx = Math.floor((x + 13) / CELL_SIZE);
        const ty = Math.floor((y + 13) / CELL_SIZE);
        if (tx < 0 || ty < 0 || tx >= this.COLS || ty >= this.ROWS) return true;

        if (player.creativeNoclip) return false;
        if (['OCEAN', 'CAVE_WALL'].includes(this.worldGrid[ty]?.[tx]) && !player.inBoat) return true;

        // Walls: same 44x44 box the client uses, around each wall's centre.
        const cxp = x + 13, cyp = y + 13;
        for (let gy = ty - 1; gy <= ty + 1; gy++) {
            for (let gx = tx - 1; gx <= tx + 1; gx++) {
                if (!this.wallCells.has(`${gx},${gy}`)) continue;
                if (Math.abs(cxp - (gx * CELL_SIZE + 20)) < 22 && Math.abs(cyp - (gy * CELL_SIZE + 20)) < 22) return true;
            }
        }
        return false;
    }

    isPointInsideGregArena(x, y) {
        if (!this.gregArena || !Number.isFinite(x) || !Number.isFinite(y)) return false;
        return x >= (this.gregArena.x - 10) * CELL_SIZE &&
            x < (this.gregArena.x + 10) * CELL_SIZE &&
            y >= (this.gregArena.y - 10) * CELL_SIZE &&
            y < (this.gregArena.y + 10) * CELL_SIZE;
    }

    isPlayerInsideGregArena(player) {
        return this.worldLayerForPlayer(player) === 'caves' &&
            this.isPointInsideGregArena(player.x + 13, player.y + 13);
    }

    refreshGregArenaLock() {
        if (this.gregArenaLocked && !this.onlinePlayers().some(player => this.isPlayerInsideGregArena(player))) {
            this.gregArenaLocked = false;
            this.dirty.meta = true;
        }
    }

    movePlayers(dt) {
        for (const player of this.onlinePlayers()) {
            if (this.worldLayerForPlayer(player) !== this.activeLayer) continue;
            const input = player.input || {};
            let dx = 0, dy = 0;
            if (input.up) dy -= 1;
            if (input.down) dy += 1;
            if (input.left) dx -= 1;
            if (input.right) dx += 1;
            if (!dx && !dy) continue;
            const firstPerson = typeof player.firstPerson3D === 'boolean'
                ? player.firstPerson3D
                : !!this.worldConfig.firstPerson3D;
            if (firstPerson) {
                const forwardX = Math.cos(player.yaw ?? -Math.PI / 2);
                const forwardY = Math.sin(player.yaw ?? -Math.PI / 2);
                const strafeX = -forwardY, strafeY = forwardX;
                const localForward = -dy, localRight = dx;
                dx = forwardX * localForward + strafeX * localRight;
                dy = forwardY * localForward + strafeY * localRight;
            }

            const length = Math.hypot(dx, dy);
            dx /= length; dy /= length;

            const slow = SLOW_BIOMES.has(this.biomeAt(player.x + 13, player.y + 13));
            const distance = PLAYER_SPEED * clamp(Number(player.creativeSpeedMult ?? 1), 0.5, 8) *
                (slow ? 0.5 : 1) * clamp(Number(player.speedPercent ?? 100), 0, 100) / 100 * dt;

            // Small sub-steps so fast movement can never jump over a wall.
            const steps = Math.max(1, Math.ceil(distance / 20));
            const step = distance / steps;
            for (let i = 0; i < steps; i++) {
                const nx = wrap(player.x + dx * step, this.worldWidth);
                if (!this.isBlockedFor(player, nx, player.y)) player.x = nx;
                const ny = wrap(player.y + dy * step, this.worldHeight);
                if (!this.isBlockedFor(player, player.x, ny)) player.y = ny;
            }
        }
    }

    tickElephants(dt) {
        const players = this.onlinePlayers().filter(player => this.worldLayerForPlayer(player) === this.activeLayer);
        for (const m of this.mobs) {
            if (m.type === 'wolf' || m.type === 'alpha_wolf') continue;

            const greg = m.type === 'greg';
            if (greg && m.deathAt) {
                const revealAt = m.deathAt + GREG_DEATH_ANIMATION_MS;
                if (Date.now() >= revealAt) {
                    this.mobs.splice(this.mobs.indexOf(m), 1);
                    this.spawnGregRewardChest(m, revealAt);
                    this.broadcastBuildings();
                    this.broadcastLayer({ type: 'world:activity', activity: 'greg-victory' });
                    this.dirty.mobs = true;
                }
                continue;
            }
            const arena = this.gregArena;
            const insideArena = player => !greg || this.isPlayerInsideGregArena(player);
            const arenaPlayers = greg ? players.filter(insideArena) : players;

            if (greg && !arenaPlayers.length && arena) {
                if (this.gregArenaLocked) {
                    this.gregArenaLocked = false;
                    this.dirty.meta = true;
                }
                m.chargeState = 'disengaged';
                m.hp = Math.min(m.maxHp, m.hp + 20 * dt);
                const homeX = (arena.x - 1) * CELL_SIZE, homeY = (arena.y - 1) * CELL_SIZE;
                const dx = homeX - m.x, dy = homeY - m.y, distance = Math.hypot(dx, dy);
                const step = Math.min(distance, 150 * dt);
                if (distance > 0) {
                    m.x += dx / distance * step;
                    m.y += dy / distance * step;
                }
                this.dirty.mobs = true;
                continue;
            }
            if (greg && m.chargeState === 'disengaged') {
                m.chargeState = 'idle';
                m.chargeTimer = 0;
            }

            const center = mobCenter(m);
            if (!greg && this.gregDefeated && !m.aggro) {
                m.aggro = players.some(player => {
                    const dx = player.x + 13 - center.x, dy = player.y + 13 - center.y;
                    return dx * dx + dy * dy <= (5 * CELL_SIZE) ** 2;
                });
            }
            const targets = greg ? arenaPlayers : m.aggro ? players : [];
            let target = null, nearestDistanceSq = Infinity;
            for (const candidate of targets) {
                const dx = candidate.x + 13 - center.x, dy = candidate.y + 13 - center.y;
                const distanceSq = dx * dx + dy * dy;
                if ((greg ? distanceSq <= 900 ** 2 : distanceSq <= (5 * CELL_SIZE) ** 2 || m.aggro) && distanceSq < nearestDistanceSq) {
                    target = candidate;
                    nearestDistanceSq = distanceSq;
                }
            }
            const targetDistance = target ? Math.sqrt(nearestDistanceSq) : Infinity;

            if (greg && target && !this.gregArenaLocked) {
                this.gregArenaLocked = true;
                this.dirty.meta = true;
                for (const player of arenaPlayers) {
                    this.notify(player, 'Greg has sealed the arena. Defeat him or wait until no one remains inside.', '#ffcc00');
                }
            }

            if (greg || this.gregDefeated && m.type === 'elephant') {
                if (m.chargeState === 'stunned' || m.chargeState === 'recover') {
                    m.chargeTimer = Math.max(0, (m.chargeTimer || 0) - dt);
                    if (!m.chargeTimer) {
                        m.chargeState = 'idle';
                        m.chargeCooldown = greg ? 0.5 : 0.75;
                    }
                    this.dirty.mobs = true;
                    continue;
                }
                if (m.chargeState === 'windup') {
                    m.chargeTimer = Math.max(0, (m.chargeTimer || 0) - dt);
                    if (!m.chargeTimer) {
                        const dx = target ? target.x + 13 - center.x : 0;
                        const dy = target ? target.y + 13 - center.y : 0;
                        const distance = Math.max(1, Math.hypot(dx, dy));
                        m.chargeDx = dx / distance;
                        m.chargeDy = dy / distance;
                        m.chargeRemaining = greg ? 720 : 460;
                        m.chargeSpeed = greg ? 450 : 390;
                        m.chargeState = 'charging';
                    }
                    this.dirty.mobs = true;
                    continue;
                }
                if (m.chargeState === 'charging') {
                    const step = Math.min(m.chargeSpeed * dt, m.chargeRemaining);
                    m.x += m.chargeDx * step;
                    m.y += m.chargeDy * step;
                    m.chargeRemaining -= step;
                    if (greg && arena) {
                        m.x = clamp(m.x, (arena.x - 10) * CELL_SIZE, (arena.x + 7) * CELL_SIZE);
                        m.y = clamp(m.y, (arena.y - 10) * CELL_SIZE, (arena.y + 7) * CELL_SIZE);
                    }
                    const hit = targets.find(player => greg
                        ? Math.abs(player.x + 13 - (m.x + GREG_SIZE / 2)) <= GREG_SIZE / 2 + 13 &&
                            Math.abs(player.y + 13 - (m.y + GREG_SIZE / 2)) <= GREG_SIZE / 2 + 13
                        : Math.hypot(player.x + 13 - (m.x + MOB_SIZE / 2), player.y + 13 - (m.y + MOB_SIZE / 2)) <= 34);
                    if (hit) {
                        this.damagePlayer(hit, greg ? 20 : 10, greg ? 'greg' : 'elephant');
                        m.chargeState = 'recover';
                        m.chargeTimer = 0.6;
                    } else if (m.chargeRemaining <= 0) {
                        m.chargeState = 'stunned';
                        m.chargeTimer = greg ? 3 : 2;
                    }
                    this.dirty.mobs = true;
                    continue;
                }
                if (target && targetDistance <= (greg ? 900 : 5 * CELL_SIZE) && (m.chargeCooldown || 0) <= 0) {
                    m.chargeState = 'windup';
                    m.chargeTimer = greg ? 0.85 : 0.65;
                    this.dirty.mobs = true;
                    continue;
                }
                if (m.chargeCooldown > 0) m.chargeCooldown = Math.max(0, m.chargeCooldown - dt);
                if (target && !greg && m.aggro) {
                    const dx = target.x + 13 - center.x, dy = target.y + 13 - center.y;
                    const distance = Math.max(1, Math.hypot(dx, dy));
                    const step = Math.min(distance, 150 * dt);
                    m.x += dx / distance * step;
                    m.y += dy / distance * step;
                    this.dirty.mobs = true;
                    continue;
                }
                if (target) continue;
            }

            if (greg && arena) {
                m.x = clamp(m.x, (arena.x - 10) * CELL_SIZE, (arena.x + 7) * CELL_SIZE);
                m.y = clamp(m.y, (arena.y - 10) * CELL_SIZE, (arena.y + 7) * CELL_SIZE);
            }
            if (Math.random() < 0.01 * dt * 60) {
                const ntx = m.x + (Math.random() - 0.5) * 150;
                const nty = m.y + (Math.random() - 0.5) * 150;
                const biome = this.biomeAt(ntx + 20, nty + 20);
                if (biome !== 'OCEAN' && !SLOW_BIOMES.has(biome) && biome !== 'BAY' && biome !== 'GULF') {
                    m.tx = ntx; m.ty = nty;
                }
            }

            const dx = (m.tx ?? m.x) - m.x, dy = (m.ty ?? m.y) - m.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 1) {
                const move = Math.min(dist, 30 * dt);
                m.x += (dx / dist) * move;
                m.y += (dy / dist) * move;
                this.dirty.mobs = true;
            }
            if (greg && arena) {
                m.x = clamp(m.x, (arena.x - 10) * CELL_SIZE, (arena.x + 10) * CELL_SIZE - CELL_SIZE);
                m.y = clamp(m.y, (arena.y - 10) * CELL_SIZE, (arena.y + 10) * CELL_SIZE - CELL_SIZE);
            }
        }
    }

    // ---------- wolves ----------

    spawnWolfWave() {
        const perPlayer = wolfCountForDay(this.dayCount, this.worldConfig.wildlifeMult || 0);
        if (perPlayer <= 0) return;

        let total = this.mobs.filter(m => m.type === 'wolf').length;
        let spawned = 0;
        const hp = wolfHpForDay(this.dayCount);

        for (const p of this.onlinePlayers()) {
            for (let i = 0; i < perPlayer && total < MAX_WOLVES; i++) {
                const angle = Math.random() * Math.PI * 2;
                this.mobs.push({
                    id: this.nextMobId++, type: 'wolf', emoji: '🐺',
                    x: clamp(p.x + Math.cos(angle) * 900, 0, this.worldWidth - CELL_SIZE),
                    y: clamp(p.y + Math.sin(angle) * 900, 0, this.worldHeight - CELL_SIZE),
                    hp, maxHp: hp,
                    speed: wolfSpeedForDay(this.dayCount),        // px/s
                    damage: wolfDamageForDay(this.dayCount),
                    biteAt: 0
                });
                total++; spawned++;
            }
        }
        if (spawned) this.announce('Howling echoes through the sector...', '#ff4444');
    }

    createAlphaWolf(x, y) {
        return {
            id: this.nextMobId++,
            type: 'alpha_wolf',
            emoji: '🐺',
            x,
            y,
            hp: ALPHA_WOLF_HP,
            maxHp: ALPHA_WOLF_HP,
            phase: 'summoning',
            summonTimer: ALPHA_WOLF_SUMMON_INTERVAL,
            stunTimer: 0,
            hasSummoned: false
        };
    }

    spawnAlphaWolf() {
        const anchor = this.onlinePlayers().find(player => this.worldLayerForPlayer(player) === 'surface');
        const originX = anchor?.x ?? this.spawn.x;
        const originY = anchor?.y ?? this.spawn.y;
        const angle = Math.random() * Math.PI * 2;
        const alpha = this.createAlphaWolf(
            clamp(originX + Math.cos(angle) * 650, 0, this.worldWidth - GREG_SIZE),
            clamp(originY + Math.sin(angle) * 650, 0, this.worldHeight - GREG_SIZE)
        );
        this.mobs.push(alpha);
        this.dirty.mobs = true;
        this.announce('A deep howl rolls across the night. The Alpha Wolf is hunting.', '#ff6666');
    }

    tickAlphaWolves(dt) {
        if (this.phaseInfo().phase === 'DAY') {
            if (this.mobs.some(mob => mob.type === 'wolf' || mob.type === 'alpha_wolf')) this.removeWolves();
            return;
        }
        for (const alpha of this.mobs) {
            if (alpha.type !== 'alpha_wolf') continue;
            if (alpha.phase === 'stunned') {
                alpha.stunTimer = Math.max(0, alpha.stunTimer - dt);
                if (alpha.stunTimer > 0) {
                    this.dirty.mobs = true;
                    continue;
                }
                alpha.phase = 'summoning';
                alpha.summonTimer = 0;
                alpha.hasSummoned = false;
            }

            const summoned = this.mobs.some(mob => mob.type === 'wolf' && mob.summonedByAlpha === alpha.id);
            if (alpha.hasSummoned && !summoned) {
                alpha.phase = 'stunned';
                alpha.stunTimer = ALPHA_WOLF_STUN_DURATION;
                this.announce('The Alpha Wolf is stunned! Strike while it is vulnerable!', '#ffcc66');
                this.dirty.mobs = true;
                continue;
            }

            alpha.summonTimer = Math.max(0, alpha.summonTimer - dt);
            if (!alpha.summonTimer && this.mobs.length < 100) {
                for (let i = 0; i < ALPHA_WOLF_SUMMON_COUNT && this.mobs.length < 100; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const radius = 100 + Math.random() * 120;
                    this.mobs.push({
                        id: this.nextMobId++,
                        type: 'wolf',
                        emoji: '🐺',
                        x: clamp(alpha.x + Math.cos(angle) * radius, 0, this.worldWidth - CELL_SIZE),
                        y: clamp(alpha.y + Math.sin(angle) * radius, 0, this.worldHeight - CELL_SIZE),
                        hp: ALPHA_WOLF_SUMMON_HP,
                        maxHp: ALPHA_WOLF_SUMMON_HP,
                        speed: ALPHA_WOLF_SUMMON_SPEED,
                        damage: ALPHA_WOLF_SUMMON_DAMAGE,
                        biteAt: 0,
                        summonedByAlpha: alpha.id
                    });
                }
                alpha.hasSummoned = true;
                alpha.summonTimer = ALPHA_WOLF_SUMMON_INTERVAL;
                this.announce('The Alpha Wolf summons a pack of stronger wolves!', '#ff6666');
            }

            const players = this.onlinePlayers().filter(player => this.worldLayerForPlayer(player) === this.activeLayer);
            let target = null, nearestDistance = Infinity;
            for (const player of players) {
                const distance = Math.hypot(player.x - alpha.x, player.y - alpha.y);
                if (distance < nearestDistance) { nearestDistance = distance; target = player; }
            }
            if (target && nearestDistance > 180) {
                const step = Math.min(nearestDistance - 180, 55 * dt);
                alpha.x += (target.x - alpha.x) / nearestDistance * step;
                alpha.y += (target.y - alpha.y) / nearestDistance * step;
            }
            this.dirty.mobs = true;
        }
    }

    removeWolves() {
        const before = this.mobs.length;
        this.mobs = this.mobs.filter(m => m.type !== 'wolf' && m.type !== 'alpha_wolf');
        if (this.mobs.length !== before) this.announce('The wolves slink away with the dawn.', '#2ecc71');
    }

    tickWolves(dt, now, campfires) {
        const players = this.onlinePlayers().filter(player => this.worldLayerForPlayer(player) === this.activeLayer);
        if (!players.length) return;

        for (const m of this.mobs) {
            if (m.type !== 'wolf') continue;

            let target = null, best = Infinity;
            for (const p of players) {
                const d = Math.hypot(p.x - m.x, p.y - m.y);
                if (d < best) { best = d; target = p; }
            }
            if (!target || best > 2500) continue;

            const dx = target.x - m.x, dy = target.y - m.y;
            const dist = Math.max(best, 0.001);
            const step = m.speed * dt;
            const nearFire = !m.summonedByAlpha && campfires.some(b => Math.hypot(m.x - b.x, m.y - b.y) < 200);

            if (nearFire) {                       // campfires scare wolves off
                m.x -= (dx / dist) * step;
                m.y -= (dy / dist) * step;
            } else if (dist > 10) {
                const move = Math.min(step, dist);
                m.x += (dx / dist) * move;
                m.y += (dy / dist) * move;
            }
            m.x = clamp(m.x, 0, this.worldWidth - 1);
            m.y = clamp(m.y, 0, this.worldHeight - 1);

            // A wolf driven off by a campfire doesn't bite.
            const biteCooldown = m.summonedByAlpha ? ALPHA_WOLF_SUMMON_BITE_MS : WOLF_BITE_MS;
            if (!nearFire && dist < 40 && now - (m.biteAt || 0) >= biteCooldown) {
                m.biteAt = now;
                this.damagePlayer(target, m.damage, 'wolf', now);
            }
        }
    }

    updateThermalStoneSlots(slots, heated, dt) {
        let changed = false;
        for (const slot of slots || []) {
            if (slot?.type !== 'thermal_stone') continue;
            const current = Number(slot.thermalTemp) || 0;
            const next = this.season === 'winter'
                ? clamp(current + (heated ? THERMAL_STONE_HEAT_RATE : -THERMAL_STONE_COOL_RATE) * dt, -THERMAL_STONE_RANGE, THERMAL_STONE_RANGE)
                : 0;
            const temperature = Math.round(next * 10000) / 10000;
            if (temperature !== current || !Number.isFinite(slot.thermalTemp)) {
                slot.thermalTemp = temperature;
                changed = true;
            }
        }
        return changed;
    }

    updateStoredThermalStones(campfires, dt) {
        let changed = false;
        for (const chest of this.buildings) {
            if (chest.type !== 'chest' || !Array.isArray(chest.inventory)) continue;
            const heated = this.biomeAt(chest.x + 20, chest.y + 20) === 'DESERT' ||
                campfires.some(fire => Math.hypot(chest.x - fire.x, chest.y - fire.y) < 250);
            changed = this.updateThermalStoneSlots(chest.inventory, heated, dt) || changed;
        }
        if (!changed) return;
        this.dirty.buildings = true;
        const now = Date.now();
        if (now - (this.lastThermalChestSyncAt || 0) >= 1000) {
            this.lastThermalChestSyncAt = now;
            this.broadcastBuildings();
        }
    }

    // ---------- survival: hunger, darkness, cold, torches, death ----------

    updateSurvival(dt, now, campfires) {
        const creative = this.worldConfig.creative;
        const night = this.phaseInfo().phase === 'NIGHT' || this.activeLayer === 'caves';

        for (const p of this.onlinePlayers()) {
            if (this.worldLayerForPlayer(p) !== this.activeLayer) continue;
            const held = p.inventory[p.selected ?? 0];
            const heldLight = !!held && ['torch', 'lantern'].includes(held.type);
            const heldLightType = heldLight ? held.type : '';

            if (creative) {
                if (p.creativeInvulnerable) p.hp = 100;
                p.hunger = 100; p.exposure = 0; p.bodyHeat = 100;
                this.updateThermalStoneSlots(p.inventory, false, dt);
                continue;
            }

            // A selected light source burns down in real time, including during daylight.
            if (heldLight) {
                held.duration -= TORCH_FRAMES_PER_SECOND * dt;
                if (held.duration <= 0) {
                    Object.assign(held, emptyPlayerSlot());
                    this.notify(p, `Your ${heldLightType} burnt out!`, '#ff4444');
                    this.sendPlayer(p);
                } else if (now - (p.torchSyncAt || 0) >= 1000) {
                    p.torchSyncAt = now;
                    this.sendPlayer(p);
                }
            }

            const inDesert = this.activeLayer === 'surface' && this.biomeAt(p.x + 13, p.y + 13) === 'DESERT';
            const nearCampfire = campfires.some(b => Math.hypot(p.x - b.x - 20, p.y - b.y - 20) < 250);
            const holdingTorch = held?.type === 'torch' && Number(held.duration) > 0;
            const nearHeat = inDesert || nearCampfire || holdingTorch;
            const thermalChanged = this.updateThermalStoneSlots(p.inventory, nearHeat, dt);
            if (this.season === 'winter' && !inDesert) {
                const stoneWarmth = p.inventory.reduce((sum, slot) => {
                    if (slot?.type !== 'thermal_stone') return sum;
                    const temperature = clamp(Number(slot.thermalTemp) || 0, -THERMAL_STONE_RANGE, THERMAL_STONE_RANGE) / THERMAL_STONE_RANGE;
                    return sum + (temperature > 0 ? -temperature * (8 / 9) : -temperature * 1.5);
                }, 0);
                const coolingRate = WINTER_BODY_HEAT_LOSS * clamp(1 + stoneWarmth, 1 / 9, 4);
                p.bodyHeat = nearHeat
                    ? Math.min(100, (Number(p.bodyHeat) || 0) + WINTER_HEAT_GAIN * dt)
                    : Math.max(0, (Number(p.bodyHeat) || 0) - coolingRate * dt);
                if (p.bodyHeat <= 0) {
                    if (!this.damagePlayer(p, WINTER_COLD_DAMAGE_PER_SECOND * dt, 'cold', now)) continue;
                } else if (p.bodyHeat <= 25 && now - (p.coldMsgAt || 0) >= 5000) {
                    p.coldMsgAt = now;
                    this.notify(p, 'You are freezing. Find a campfire or hold a torch.', '#8be5ff');
                }
            } else {
                p.bodyHeat = 100;
            }
            if (thermalChanged && now - (p.thermalSyncAt || 0) >= 1000) {
                p.thermalSyncAt = now;
                this.sendPlayer(p);
            }

            // Hunger
            p.hunger = Math.max(0, p.hunger - HUNGER_PER_SECOND * (this.worldConfig.hungerMult || 1) * dt);
            if (p.hunger <= 0 && !this.damagePlayer(p, STARVE_DAMAGE_PER_SECOND * dt, 'hunger', now)) continue;

            // Darkness: unprotected time at night builds up and then hurts. It recovers when you're safe.
            const sunlit = this.biomeAt(p.x + 13, p.y + 13) === 'CAVE_SUNLIT';
            const lit = heldLight || sunlit || campfires.some(b => Math.hypot(p.x - b.x - 20, p.y - b.y - 20) < 250);
            if (night && !lit) p.exposure += dt;
            else p.exposure = Math.max(0, p.exposure - 2 * dt);

            if (p.exposure >= DARKNESS_GRACE_SECONDS) {
                if (now - (p.darkMsgAt || 0) > 3000) {
                    p.darkMsgAt = now;
                    this.notify(p, 'The darkness is hurting you.', '#ff4444');
                }
                if (!this.damagePlayer(p, DARKNESS_DAMAGE_PER_SECOND * dt, 'darkness', now)) continue;
            }

            // Slow healing when fed and left alone.
            if (p.hunger >= 50 && p.hp < 100 && now - (p.lastDamageAt || 0) > REGEN_DELAY_MS) {
                p.hp = Math.min(100, p.hp + REGEN_HP_PER_SECOND * dt);
            }
        }
    }

    // Returns false if the damage killed the player (who has then been respawned).
    damagePlayer(player, amount, source, now = Date.now()) {
        if ((this.worldConfig.creative && player.creativeInvulnerable) || amount <= 0) return true;
        const shield = this.sanitizeShield(player.shield);
        if (shield) {
            const protection = SHIELD_PROTECTION[shield.type];
            const absorbed = Math.min(amount * protection, shield.durability);
            shield.durability -= absorbed;
            amount -= absorbed;
            player.shield = shield.durability > 0 ? shield : null;
            this.dirty.players = true;
        }
        player.hp -= amount;
        player.lastDamageAt = now;
        if (player.hp > 0) return true;
        this.killPlayer(player, source);
        return false;
    }

    killPlayer(player, source) {
        const cause = source === 'wolf' ? 'was mauled by wolves'
            : source === 'hunger' ? 'starved'
            : source === 'darkness' ? 'was claimed by the darkness'
            : source === 'cold' ? 'froze to death'
            : 'died';
        this.announce(`${player.name} ${cause}.`, '#ff4444');

        player.hp = 100;
        player.hunger = 100;
        player.bodyHeat = 100;
        player.exposure = 0;
        player.lastDamageAt = 0;
        const changedLayer = this.worldLayerForPlayer(player) !== 'surface';
        player.layer = 'surface';
        player.caveEntranceId = null;
        player.x = this.spawn.x;
        player.y = this.spawn.y;
        player.inBoat = false;
        player.boatId = null;
        player.input = idleInput();
        this.refreshGregArenaLock();
        if (LOSE_INVENTORY_ON_DEATH) player.inventory = Array.from({ length: INVENTORY_SLOTS }, emptyPlayerSlot);

        this.notify(player, 'You died. You wake up back at the start.', '#ff4444');
        this.sendToPlayer(player.id, { type: 'player:died' });
        if (changedLayer) {
            this.sendLayerTransition(player);
            this.sendPlayer(player);
        }
        else this.sendPlayer(player);
    }

    // The client shows chat lines from 'SYSTEM' without a name, so these need no client changes.
    notify(player, text, color = '#ffa500') {
        this.sendToPlayer(player.id, { type: 'chat:message', name: 'SYSTEM', text, color });
    }

    announce(text, color = '#ffa500') {
        this.broadcast({ type: 'chat:message', name: 'SYSTEM', text, color });
    }


    expireCampfires(now) {
        const before = this.buildings.length;
        this.buildings = this.buildings.filter(b => b.type !== 'campfire' || !b.expiresAt || b.expiresAt > now);
        if (this.buildings.length !== before) {
            this.dirty.buildings = true;
            this.broadcastBuildings();
        }
    }


    // =========================================================
    // BROADCASTS
    // =========================================================

    // Lightweight, sent every tick. Heavy world data goes out only when it changes.
    broadcastSnapshot() {
        const { phase, phaseTimeLeft } = this.phaseInfo();
        const online = this.onlinePlayers();
        for (const player of online) {
            const layer = this.worldLayerForPlayer(player);
            this.sendToPlayer(player.id, {
                type: 'world:state',
                dayCount: this.dayCount,
                season: this.season,
                seasonDaysRemaining: this.seasonDaysRemaining,
                playerCount: online.length,
                gameTime: this.gameTime,
                creativeFreezeTime: this.creativeFreezeTime,
                achievementsDisabled: this.achievementsDisabled,
                gregDefeated: this.gregDefeated,
                phase,
                phaseTimeLeft,
                gregArenaLocked: this.gregArenaLocked,
                players: online.filter(other => this.worldLayerForPlayer(other) === layer).map(p => this.publicPlayer(p))
            });
        }
    }

    serializeBuilding(b) {
        if (b.type === 'campfire' && b.expiresAt) {
            return { ...b, life: Math.max(1, Math.round(((b.expiresAt - Date.now()) / 1000) * 60)) };
        }
        return b;
    }

    serializeBuildings() {
        return this.buildings.map(b => this.serializeBuilding(b));
    }

    broadcastBuildings() {
        this.broadcastLayer({ type: 'world:update', world: { buildings: this.serializeBuildings() } });
    }

    mobVisibleTo(player, m) {
        return Math.abs(m.x - player.x) <= MOB_VIEW_X && Math.abs(m.y - player.y) <= MOB_VIEW_Y;
    }

    // Each player only receives mobs near them, and only what changed since their last update.
    syncMobs() {
        const r1 = v => Math.round(v * 10) / 10;

        for (const p of this.onlinePlayers()) {
            if (this.worldLayerForPlayer(p) !== this.activeLayer) continue;
            const seen = p.seenMobs || (p.seenMobs = new Map());
            const visible = new Set();
            const set = [], del = [];

            for (const m of this.mobs) {
                if (!this.mobVisibleTo(p, m)) continue;
                visible.add(m.id);
                const prev = seen.get(m.id);
                if (!prev) {
                    set.push(m);
                    seen.set(m.id, {
                        x: m.x, y: m.y, hp: m.hp, chargeState: m.chargeState, deathAt: m.deathAt,
                        phase: m.phase, summonTimer: Math.ceil(m.summonTimer || 0), stunTimer: Math.ceil(m.stunTimer || 0)
                    });
                } else if (Math.abs(prev.x - m.x) > 0.5 || Math.abs(prev.y - m.y) > 0.5 ||
                    prev.hp !== m.hp || prev.chargeState !== m.chargeState || prev.deathAt !== m.deathAt ||
                    prev.phase !== m.phase || prev.summonTimer !== Math.ceil(m.summonTimer || 0) ||
                    prev.stunTimer !== Math.ceil(m.stunTimer || 0)) {
                    set.push({
                        id: m.id, x: r1(m.x), y: r1(m.y), hp: m.hp, chargeState: m.chargeState, deathAt: m.deathAt,
                        phase: m.phase, summonTimer: Math.ceil(m.summonTimer || 0), stunTimer: Math.ceil(m.stunTimer || 0)
                    });
                    prev.x = m.x; prev.y = m.y; prev.hp = m.hp; prev.chargeState = m.chargeState; prev.deathAt = m.deathAt;
                    prev.phase = m.phase; prev.summonTimer = Math.ceil(m.summonTimer || 0); prev.stunTimer = Math.ceil(m.stunTimer || 0);
                }
            }
            for (const id of Array.from(seen.keys())) {
                if (!visible.has(id)) { del.push(id); seen.delete(id); }
            }

            if (set.length || del.length) this.sendToPlayer(p.id, { type: 'world:mobs', set, del });
        }
    }

    nearbyMobsFor(player) {
        const seen = new Map();
        const out = [];
        if (player) {
            for (const m of this.mobs) {
                if (!this.mobVisibleTo(player, m)) continue;
                out.push(m);
                seen.set(m.id, {
                    x: m.x, y: m.y, hp: m.hp, chargeState: m.chargeState, deathAt: m.deathAt,
                    phase: m.phase, summonTimer: Math.ceil(m.summonTimer || 0), stunTimer: Math.ceil(m.stunTimer || 0)
                });
            }
            player.seenMobs = seen;
        }
        return out;
    }

    getWorldSnapshot(player) {
        return this.withLayer(this.worldLayerForPlayer(player), () => ({
            layer: this.activeLayer,
            season: this.season,
            seasonDaysRemaining: this.seasonDaysRemaining,
            rows: this.ROWS,
            cols: this.COLS,
            width: this.worldWidth,
            height: this.worldHeight,
            gregDefeated: this.gregDefeated,
            gregArenaLocked: this.gregArenaLocked,
            terrain: this.worldGrid.map(row => row.join(',')),
            resourceNodes: this.resourceNodes,
            mobs: this.nearbyMobsFor(player),
            buildings: this.serializeBuildings(),
            discoveredGrid: this.encodeDiscoveryMap(this.getDiscoveryMap(this.activeLayer)),
            gregArena: this.activeLayer === 'caves' ? this.gregArena : null
        }));
    }


    // =========================================================
    // SEED
    // =========================================================

    normalizeSeed(seed) {
        if (typeof seed !== 'string') return '';
        const raw = seed.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (raw.length !== SEED_TOTAL_LENGTH) return '';
        for (const char of raw) if (!SEED_CHARS.includes(char)) return '';
        return raw;
    }

    normalizeSeedOrThrow() {
        const normalized = this.normalizeSeed(this.seed);
        if (!normalized) throw new Error('Invalid multiplayer world seed.');
        this.seed = normalized;
        this.worldSeed = this.seedStringToNumber(this.seed.substring(SEED_SETTINGS_LENGTH));
        this.currentRandomState = this.worldSeed;
    }

    decodeWorldSettings(seed) {
        seed = String(seed || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (seed.length !== SEED_TOTAL_LENGTH) {
            throw new Error(`Invalid seed length. Expected ${SEED_TOTAL_LENGTH} characters.`);
        }

        const settingsPart = seed.substring(0, SEED_SETTINGS_LENGTH);
        const indexes = settingsPart.split('').map(char => {
            const index = SEED_CHARS.indexOf(char);
            if (index < 0) throw new Error(`Invalid seed character: ${char}`);
            return index;
        });

        return {
            resMult: 0.2 + indexes[0] * 0.2,
            foodMult: 0.2 + indexes[1] * 0.2,
            dayMult: 0.5 + indexes[2] * 0.5,
            nightMult: 0.5 + indexes[3] * 0.5,
            hungerMult: 0.2 + indexes[4] * 0.2,
            worldSizeMult: 0.75 + indexes[5] * 0.25,
            mapPreset: MAP_PRESETS[indexes[6]] || 'standard',
            oceanMult: 0.5 + indexes[7] * 0.1,
            forestMult: 0.2 + indexes[8] * 0.1,
            mountainMult: 0.2 + (indexes[9] % 24) * 0.1,
            cavesEnabled: indexes[9] < 24,
            wildlifeMult: indexes[10] * 0.25,
            // The 12th character packs two things: bit 0 = creative mode, the rest = ruin density.
            // Old seeds only ever used 'A' and 'B', which decode to normal (1.0x) ruins.
            creative: (indexes[11] & 1) === 1,
            ruinsMult: (((indexes[11] >> 1) + 4) % 16) * 0.25
        };
    }

    // Only used if a client joins without a valid seed.
    createFallbackSeed(config) {
        const idx = (value, min, step) => Math.round((Number(value) - min) / step);
        const indexes = [
            idx(config.resMult, 0.2, 0.2), idx(config.foodMult, 0.2, 0.2),
            idx(config.dayMult, 0.5, 0.5), idx(config.nightMult, 0.5, 0.5),
            idx(config.hungerMult, 0.2, 0.2), idx(config.worldSizeMult, 0.75, 0.25),
            Math.max(0, MAP_PRESETS.indexOf(config.mapPreset)),
            idx(config.oceanMult, 0.5, 0.1), idx(config.forestMult, 0.2, 0.1),
            idx(config.mountainMult, 0.2, 0.1) + (config.cavesEnabled === false ? 24 : 0), idx(config.wildlifeMult, 0, 0.25),
            (config.creative ? 1 : 0) + 2 * ((Math.round(Number(config.ruinsMult ?? 1) / 0.25) - 4 + 16) % 16)
        ];
        const settings = indexes.map(i => SEED_CHARS[clamp(Math.round(i) || 0, 0, SEED_CHARS.length - 1)]).join('');
        return settings + this.randomCode(SEED_RANDOM_LENGTH);
    }

    normalizeWorldConfig(config) {
        const c = { ...DEFAULT_WORLD_CONFIG, ...(config || {}) };
        return {
            resMult: Number(c.resMult) || 1,
            foodMult: Number(c.foodMult) || 1,
            dayMult: Number(c.dayMult) || 1,
            nightMult: Number(c.nightMult) || 1,
            hungerMult: Number(c.hungerMult) || 1,
            worldSizeMult: Number(c.worldSizeMult) || 1,
            mapPreset: MAP_PRESETS.includes(c.mapPreset) ? c.mapPreset : 'standard',
            oceanMult: Number(c.oceanMult) || 1,
            forestMult: Number(c.forestMult) || 1,
            mountainMult: Number(c.mountainMult) || 1,
            wildlifeMult: Number(c.wildlifeMult) || 0,
            ruinsMult: Number.isFinite(Number(c.ruinsMult)) ? clamp(Number(c.ruinsMult), 0, 3.75) : 1,
            winterLengthDays: Number.isFinite(Number(c.winterLengthDays)) ? clamp(Math.round(Number(c.winterLengthDays)), 0, 30) : 8,
            mildLengthDays: Number.isFinite(Number(c.mildLengthDays)) ? clamp(Math.round(Number(c.mildLengthDays)), 0, 30) : 8,
            cavesEnabled: c.cavesEnabled !== false,
            creative: !!c.creative,
            firstPerson3D: !!(c.firstPerson3D ?? c.thirdPerson3D)
        };
    }


    // =========================================================
    // MESSAGING HELPERS
    // =========================================================

    sendToPlayer(playerId, message) {
        for (const [ws, session] of this.sessions) {
            if (session.playerId === playerId) this.send(ws, message);
        }
    }

    broadcast(message, except = null) {
        const text = JSON.stringify(message);
        for (const ws of this.sessions.keys()) {
            if (ws === except) continue;
            try { ws.send(text); } catch {}
        }
    }

    send(ws, message) {
        try { ws.send(JSON.stringify(message)); } catch {}
    }

    // Identical errors are limited to one per 1.5 s per player (the client repeats actions while keys are held).
    worldError(player, message) {
        const key = `${player.id}|${message}`;
        const now = Date.now();
        if (now - (this.errorThrottle.get(key) || 0) < 1500) return;
        this.errorThrottle.set(key, now);
        if (this.errorThrottle.size > 500) {
            for (const [k, t] of this.errorThrottle) if (now - t > 1500) this.errorThrottle.delete(k);
        }
        this.sendToPlayer(player.id, { type: 'world:error', message });
    }

    // Small floating-text effect shown only to the acting player (e.g. what fell out of a shaken tree).
    fx(player, x, y, text, color = '#ffffff', throttleKey = null) {
        if (throttleKey) {
            const key = `${player.id}|${throttleKey}`;
            const now = Date.now();
            if (now - (this.errorThrottle.get(key) || 0) < 1500) return;
            this.errorThrottle.set(key, now);
        }
        this.sendToPlayer(player.id, { type: 'world:fx', x, y, text, color });
    }

    corsHeaders() {
        return {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        };
    }

    json(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: { 'Content-Type': 'application/json', ...this.corsHeaders() }
        });
    }
}