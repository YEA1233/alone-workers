        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        const miniCanvas = document.getElementById('minimap-canvas');
        const miniCtx = miniCanvas.getContext('2d');

        // Lighting Buffer
        const lightCanvas = document.createElement('canvas');
        const lctx = lightCanvas.getContext('2d');

        const TARGET_WIDTH = 1600;
        const GAME_VERSION = document.querySelector('meta[name="game-version"]')?.content || '1.0.6.0';
        let globalScale = 1.0, logicalWidth = 1600, logicalHeight = 900;
        let COLS = 520, ROWS = 520, cellSize = 40;
        let worldWidth = COLS * cellSize, worldHeight = ROWS * cellSize;
        let pendingLoad = null;
        let activeSaveSlotId = null, activeSaveSlotName = '';
        let slotEntryMode = 'solo', pendingWorldImport = null;
        let pendingWorldExport = null, pendingWorldExportId = null;
        const PLAYER_SPEED = 4.5;

        const SEED_SETTINGS_LENGTH = 12;
        const SEED_RANDOM_LENGTH = 16;

        const SEED_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const GEN_VERSION = 2;   // 1 = old terrain (kept for old saves), 2 = desert fallback + placed plains
        const GEN_V2 = { plainsBlobs: 210, forestBlobs: 90, mountainBlobs: 50, plainsRadius: [14, 20] };

        function loadStoredId(name) {
            const slot = new URLSearchParams(location.search).get('slot') || '';
            const key = name + slot;
            try {
                let value = localStorage.getItem(key);
                if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
                return value;
            } catch (error) {
                return crypto.randomUUID();
            }
        }

        function loadAchievementData() {
            try {
                const saved = JSON.parse(localStorage.getItem(achievementStorageKey) || 'null');
                const knownIds = new Set(ACHIEVEMENTS.map(item => item.id));
                return {
                    unlocked: Array.isArray(saved?.unlocked) ? [...new Set(saved.unlocked.filter(id => knownIds.has(id)))] : [],
                    deaths: Number.isSafeInteger(saved?.deaths) && saved.deaths >= 0 ? saved.deaths : 0,
                    disabledWorlds: Array.isArray(saved?.disabledWorlds) ? [...new Set(saved.disabledWorlds.filter(key => typeof key === 'string'))] : [],
                    adminConsoleUsed: saved?.adminConsoleUsed === true
                };
            } catch (error) {
                console.warn('Could not load achievements:', error);
                return { unlocked: [], deaths: 0 };
            }
        }

        function isEmojiUnlocked(emoji) {
            if (FREE_PLAYER_EMOJIS.includes(emoji)) return true;
            const achievement = ACHIEVEMENTS.find(item => item.emoji === emoji);
            return !!achievement && achievementData.unlocked.includes(achievement.id);
        }

        const SEED_TOTAL_LENGTH =
            SEED_SETTINGS_LENGTH +
            SEED_RANDOM_LENGTH;
        let currentWorldSeed = '';
        let currentGenVersion = GEN_VERSION;
        let worldSeed = 0;
        let currentRandomState = 0;

        function getSliderIndex(id, min, max, step) {

            const value = Number(
                document.getElementById(id)?.value
            );

            return Math.round((value - min) / step);
        }
        function encodeWorldSettings() {

            const values = [

                // RESOURCE
                getSliderIndex('set-res', 0.2, 3.0, 0.2),

                // FOOD
                getSliderIndex('set-food', 0.2, 3.0, 0.2),

                // DAY
                getSliderIndex('set-day', 0.5, 4.0, 0.5),

                // NIGHT
                getSliderIndex('set-night', 0.5, 4.0, 0.5),

                // HUNGER
                getSliderIndex('set-hunger', 0.2, 2.0, 0.2),

                // WORLD SIZE
                getSliderIndex('set-world-size', 0.75, 2.0, 0.25),

                // MAP PRESET
                {
                    standard: 0,
                    inland: 1,
                    dry: 2,
                    riverlands: 3,
                    islands: 4
                }[
                document.getElementById('set-map-preset')?.value || 'standard'
                ],

                // OCEAN
                getSliderIndex('set-ocean', 0.5, 1.4, 0.1),

                // FOREST
                getSliderIndex('set-forest', 0.2, 2.5, 0.1),

                // MOUNTAIN
                getSliderIndex('set-mountain', 0.2, 2.5, 0.1) + (document.getElementById('set-caves')?.checked === false ? 24 : 0),

                // WILDLIFE
                getSliderIndex('set-wildlife', 0, 3, 0.25),

                // CREATIVE (bit 0) + RUINS (the rest). Old seeds only ever had 0 or 1 here, which means normal ruins.
        (document.getElementById('set-creative')?.checked ? 1 : 0) +
            2 * ((Math.max(0, Math.min(15, getSliderIndex('set-ruins', 0, 3, 0.25))) - 4 + 16) % 16)
    ];

            /*
             * Convert the settings indexes into a compact
             * alphanumeric representation.
             *
             * Each setting gets one character.
             */
            return values.map(v => {

                const index = Math.max(
                    0,
                    Math.min(
                        SEED_CHARS.length - 1,
                        Number(v) || 0
                    )
                );

                return SEED_CHARS[index];

            }).join('');
        }
        function generateWorldSeed() {

            const settingsPart = encodeWorldSettings();
            const randomPart = randomSeedPart(SEED_RANDOM_LENGTH);

            return settingsPart + randomPart;
        }
        function formatWorldSeed(seed) {

            if (!seed) return '';

            return (
                seed.substring(0, SEED_SETTINGS_LENGTH) +
                '-' +
                seed.substring(SEED_SETTINGS_LENGTH)
            );
        }
        function randomizeWorldSeed() {

            const input =
                document.getElementById('set-world-seed');

            if (!input) return;

            input.value =
                formatWorldSeed(generateWorldSeed());
            seedSettingsLocked = false;

        }
        // ---------------------------------------------------------
        // RANDOM ALPHANUMERIC STRING
        // ---------------------------------------------------------

        function randomSeedPart(length) {

            let result = '';

            for (let i = 0; i < length; i++) {
                result += SEED_CHARS[
                    Math.floor(Math.random() * SEED_CHARS.length)
                ];
            }

            return result;
        }


        // ---------------------------------------------------------
        // CONVERT STRING → NUMERIC SEED
        // ---------------------------------------------------------

        function seedStringToNumber(str) {

            let hash = 2166136261;

            for (let i = 0; i < str.length; i++) {

                hash ^= str.charCodeAt(i);

                hash +=
                    (hash << 1) +
                    (hash << 4) +
                    (hash << 7) +
                    (hash << 8) +
                    (hash << 24);
            }

            return hash >>> 0;
        }


        // ---------------------------------------------------------
        // SEEDED RANDOMNESS
        // ---------------------------------------------------------

        function seededRandom() {

            currentRandomState =
                (currentRandomState * 1664525 + 1013904223) >>> 0;

            return currentRandomState / 4294967296;
        }

        function rollRuinLoot(random = seededRandom) {
            const resources = [
                { type: 'wood', min: 8, max: 20 },
                { type: 'stone', min: 6, max: 16 },
                { type: 'iron', min: 2, max: 6 },
                { type: 'twigs', min: 5, max: 14 },
                { type: 'flint', min: 3, max: 8 },
                { type: 'berries', min: 2, max: 6 },
                { type: 'carrots', min: 2, max: 6 },
                { type: 'acorn', min: 1, max: 4 }
            ];
            const loot = [];
            const resourceSlots = 3 + Math.floor(random() * 4);

            for (let i = 0; i < resourceSlots; i++) {
                const resource = resources.splice(
                    Math.floor(random() * resources.length),
                    1
                )[0];
                loot.push({
                    type: resource.type,
                    count: resource.min + Math.floor(random() * (resource.max - resource.min + 1))
                });
            }

            if (random() < 0.25) {
                const tools = ['axe', 'pickaxe', 'sword', 'shovel', 'hammer', 'torch'];
                const type = tools[Math.floor(random() * tools.length)];
                const durability = BUILDINGS[type].durability || BUILDINGS[type].duration;
                loot.splice(Math.floor(random() * (loot.length + 1)), 0, {
                    type,
                    count: 1,
                    duration: durability,
                    maxDuration: durability
                });
            }

            return loot;
        }

        const BIOMES = {
            OCEAN: { color: '#001a33', passable: false },
            CAVE_WALL: { color: '#090a0d', passable: false },
            CAVE_FLOOR: { color: '#282522', passable: true },
            CAVE_SUNLIT: { color: '#71634a', passable: true },
            LAKE: { color: '#0d3c5d', passable: true },
            RIVER: { color: '#2b6e8f', passable: true },
            SHALLOW_WATER: { color: '#4d8eaa', passable: true },
            BAY: { color: '#235d7d', passable: true },
            GULF: { color: '#1c4b67', passable: true },
            BEACH: { color: '#d9c27c', passable: true },
            PLAINS: { color: '#1a2e1a', passable: true },
            FOREST: { color: '#0d1a0d', passable: true },
            DESERT: { color: '#d1a95a', passable: true },
            SNOW: { color: '#dfeaf7', passable: true },
            MOUNTAIN: { color: '#222222', passable: true }
        };

        const BUILDINGS = {
            axe: { twigs: 2, flint: 1, hp: 1, icon: '🪓', name: "Axe", type: 'item', reqLab: false, durability: 40 },
            pickaxe: { twigs: 1, flint: 2, hp: 1, icon: '⛏️', name: "Pickaxe", type: 'item', reqLab: false, durability: 40 },
            sword: { iron: 5, twigs: 2, hp: 1, icon: '🗡️', name: "Sword", type: 'item', reqLab: false, durability: 160 },
            wooden_shield: { wood: 20, hp: 1, icon: '🛡️', name: "Wooden Shield", type: 'item', reqLab: false, durability: 225 },
            iron_shield: { wood: 10, iron: 10, hp: 1, icon: '🛡️', name: "Iron Shield", type: 'item', reqLab: false, durability: 600 },
            ivory_shield: { hp: 1, icon: '🛡️', name: "Ivory Shield", type: 'item', reqLab: false, durability: 1500 },
            torch: { twigs: 2, wood: 5, hp: 1, icon: '🔦', name: "Torch", type: 'item', reqLab: false, duration: 60 * 60 },
            lantern: { iron: 2, twigs: 4, torch: 1, hp: 1, icon: '🏮', name: "Lantern", type: 'item', reqLab: false, duration: 8 * 60 * 60 },
            shovel: { twigs: 2, wood: 4, stone: 4, hp: 1, icon: '🧹', name: "Shovel", type: 'item', reqLab: false, durability: 30 },
    hammer: { wood: 4, stone: 4, twigs: 2, hp: 1, icon: '🔨', name: "Hammer", type: 'item', reqLab: false, durability: 80 },
            thermal_stone: { stone: 10, iron: 2, hp: 1, icon: '🪨', name: "Thermal Stone", type: 'item', reqLab: true },
            campfire: { wood: 30, hp: 100, icon: '🔥', name: "Campfire", radius: 250, life: 360 * 60, reqLab: false },
            wall: { wood: 5, hp: 500, icon: '🧱', name: "Wall", reqLab: false },
            boat: { wood: 12, flint: 2, hp: 100, icon: '🛶', name: "Boat", reqLab: false },
            cave_entrance: { hp: 1, icon: '🕳️', name: 'Cave Entrance' },
            cave_exit: { hp: 1, icon: '🪜', name: 'Surface Exit' },
            sign: { wood: 4, hp: 200, icon: '🪧', name: "Sign", reqLab: false },
            chest: { wood: 12, stone: 8, hp: 400, icon: '📦', name: "Chest", reqLab: true },
            research: { wood: 40, stone: 40, hp: 400, icon: '🔬', name: "Science Machine", reqLab: false },
            extractor: { iron: 15, stone: 15, hp: 200, icon: '🦾', name: "Extractor", reqLab: true },
            cooking: { wood: 15, hp: 300, icon: '🍳', name: "Kitchen", reqLab: true },
            door: { iron: 10, wood: 10, hp: 450, icon: '🚪', name: "Airlock", reqLab: true },
            acorn: { icon: '🌰', name: 'Acorn', type: 'item', reqLab: false }
        };

        const ITEM_ICONS = { wood: '🌲', stone: '🪨', iron: '⛓️', amber: '🟠', twigs: '🥢', flint: '🔷', axe: '🪓', pickaxe: '⛏️', sword: '🗡️', wooden_shield: '🛡️', iron_shield: '🛡️', ivory_shield: '🛡️', torch: '🔦', lantern: '🏮', shovel: '🪏', hammer: '🔨', berries: '🍒', carrots: '🥕', paste: '🧪', acorn: '🌰', thermal_stone: '🪨', chest: '📦' };
        const SHIELD_STATS = {
            wooden_shield: { name: 'Wooden Shield', durability: 225, protection: 0.6 },
            iron_shield: { name: 'Iron Shield', durability: 600, protection: 0.8 },
            ivory_shield: { name: 'Ivory Shield', durability: 1500, protection: 0.9 }
        };
        const ITEM_DESCRIPTIONS = {
            wood: 'Wood: a basic building and crafting material.',
            stone: 'Stone: a sturdy building and crafting material.',
            iron: 'Iron: a valuable metal used for advanced structures.',
            amber: 'Amber: refuels a lantern for 2 minutes.',
            twigs: 'Twigs: a light material used to craft tools.',
            flint: 'Flint: a sharp stone used to craft tools.',
            axe: 'Axe: chops trees and can be used to fight.',
            pickaxe: 'Pickaxe: mines rocks, flint, and iron.',
            torch: 'Torch: provides light at night while held.',
            lantern: 'Lantern: a bright light that lasts 8 minutes; click its inventory slot while holding amber to refuel it.',
            shovel: 'Shovel: clears tree stumps.',
            hammer: 'Hammer: dismantles structures; empty chests first.',
            thermal_stone: 'Thermal Stone: warms near campfires or while you hold a torch. A warm stone slows winter cooling; a cold stone speeds it up. Stones cool slowly when left away from heat.',
            berries: 'Berries: eat to restore 15 hunger and 5 health.',
            carrots: 'Carrots: eat to restore 15 hunger and 5 health.',
            paste: 'Paste: eat to restore 30 hunger and 10 health.',
            sword: 'Sword: an iron weapon that deals more damage than an axe or pickaxe and lasts longer.',
            wooden_shield: 'Wooden Shield: absorbs 60% of incoming damage until its 225 HP durability is depleted.',
            iron_shield: 'Iron Shield: absorbs 80% of incoming damage until its 600 HP durability is depleted.',
            ivory_shield: 'Ivory Shield: Greg’s trophy. Absorbs 90% of incoming damage until its 1,500 HP durability is depleted.',
            acorn: 'Acorn: plant it to grow a tree.',
            big_rock: 'Large rock: mine it with a pickaxe for stone and flint.',
            rock: 'Flint deposit: mine it with a pickaxe.',
            flint_node: 'Flint deposit: mine it with a pickaxe.',
            stump: 'Tree stump: clear it with a shovel.',
            sapling: 'Sapling: it will grow into a tree after a day.',
            tree: 'Tree: chop it with an axe, or shake it for small items.',
            wolf: 'Wolf: a hostile creature. Fight with an axe, pickaxe, or sword.',
            alpha_wolf: 'Alpha Wolf: a 1,250-health summoner that calls stronger wolves. Defeat its pack to stun it for 10 seconds.',
            elephant: 'Elephant: peaceful until Greg is defeated. Then it charges if you come within 5 tiles.',
            greg: 'Greg (from Accounting): a 2,000-health cave boss. Bait his charge and attack while he is stunned.'
        };
        const NODE_DESCRIPTIONS = {
            wood: 'Tree: chop it with an axe, or shake it for small items.',
            tree: 'Tree: chop it with an axe, or shake it for small items.',
            big_rock: 'Large rock: mine it with a pickaxe for stone and flint.',
            rock: 'Flint deposit: mine it with a pickaxe.',
            flint_node: 'Flint deposit: mine it with a pickaxe.',
            stone: 'Stone deposit: mine it with a pickaxe.',
            iron: 'Iron deposit: mine it with a pickaxe.',
            stump: 'Tree stump: clear it with a shovel.',
            sapling: 'Sapling: it will grow into a tree after a day.'
        };
        const PLAYER_COLORS = ['#00f2ff', '#ffcc00', '#2ecc71', '#ff00ff', '#ffffff', '#ff9900'];
        const FREE_PLAYER_EMOJIS = ['🤠', '😃', '🙃', '🙂', '😑', '😐', '🫤'];
        const ACHIEVEMENTS = [
            { id: 'first-night', name: 'Night owl', description: 'Make it to Day 2.', emoji: '🌱' },
            { id: 'first-build', name: 'Home sweet home', description: 'Build your first structure.', emoji: '🧱' },
            { id: 'first-wolf', name: 'First blood', description: 'Defeat a wolf.', emoji: '🐺' },
            { id: 'first-death', name: 'Ouch', description: 'Die for the first time.' },
            { id: 'day-five', name: 'Getting the hang of it', description: 'Survive 5 days.', emoji: '🌙' },
            { id: 'caves', name: 'We need to go deeper', description: 'Enter the caves for the first time.', emoji: '🦇' },
            { id: 'greg', name: "You're fired", description: 'Defeat Greg for the first time.', emoji: '💼' },
            { id: 'day-twenty', name: 'Hey this is pretty easy actually', description: 'Survive 20 days.', emoji: '🏆' },
            { id: 'host-three', name: 'If you build it they will come', description: 'Host a world with at least two other players.', emoji: '👑' },
            { id: 'deaths-100', name: 'You suck', description: 'Die 100 times.', emoji: '☠️' }
        ];
        const PLAYER_EMOJIS = [...FREE_PLAYER_EMOJIS, ...ACHIEVEMENTS.filter(item => item.emoji).map(item => item.emoji)];

        const QUOTES = [
            "TIP: Select tools and light sources on your hotbar before using them.",
            "TIP: Trees leave stumps! Clear them with a 🧹 Shovel.",
            "TIP: Hold a 🔦 Torch at night to see where you're going.",
            "TIP: Items like twigs no longer spawn on top of trees.",
            "TEASE: The darkness is absolute. Don't let your torch die.",
            "TIP: Click food in your pack to eat it instantly!",
            "TEASE: Dusk warning gives you time to build a campfire.",
            "TIP: Torches only last 1 minute of active use. Plan ahead.",
            "TEASE: Did you see the elephant? It's real.",
            "JOKE: Why carry a torch? Because the campfire is heavy.",
            "TIP: Berries and carrots restore 15 hunger and 5 health.",
            "JOKE: If you see a carrot, it's not a trap. Probably."
        ];

        let worldGrid = [], discoveredGrid = new Uint8Array(COLS * ROWS);
        let resourceNodes = [], buildings = [], currentState = 'MENU', mobs = [];
        let currentLayer = 'surface', surfaceLayerLocal = null, caveLayerLocal = null, gregArenaOnline = null;
        let gregArenaLocked = false;
        let frameCount = 0, darknessExposure = 0, hungerAlertLevel = 0;
        let gameFrameDt = 1 / 60, lastGameFrameAt = performance.now();
        let keys = {}, camera = { x: 0, y: 0 }, unlocked = { door: false }, buildMode = 'none', isPlacing = false;
        let player = {
            x: worldWidth / 2, y: worldHeight / 2, color: '#00f2ff', emoji: '🤠',
            hp: 100, hunger: 100, bodyHeat: 100, isDowned: false, reviveProgress: 0, creativeInvulnerable: true,
            shield: null,
            inBoat: false, boatId: null,
            inventory: Array(15).fill(null).map(() => ({ type: null, count: 0, duration: 0, maxDuration: 0 }))
        };
        let thirdPerson3D = false;
        let firstPersonYaw = -Math.PI / 2;
        let firstPersonPitch = 0.24;
        let selectedHotbarIndex = 0;
        let consoleIsOp = false;
        let consoleSpeedPercent = 100;
        let creativePanelEnabled = false, ohkoEnabled = false;
        let localRegenConfirmations = null;
        let worldConfig = { resMult: 1, foodMult: 1, dayMult: 1, nightMult: 1, hungerMult: 1, oceanMult: 1, forestMult: 1, mountainMult: 1, wildlifeMult: 1, ruinsMult: 1, worldSize: 1, mapPreset: 'standard', creative: false, cavesEnabled: true, firstPerson3D: false, winterLengthDays: 8, mildLengthDays: 8 };
        let dayCount = 1, wolfWaveSpawned = false, gregDefeated = false, gregDefeatedDay = null;
        let alphaWolfStartDay = null, alphaWolfDefeated = false, soloAlphaWolfSequence = 0;
        let soloTokenInventory = { ivory: 0, wolf: 0 };
        let soloTokenDrops = { ivory: false, wolf: false };
        let currentSeason = 'mild', seasonDaysRemaining = 8;
        let seedSettingsLocked = false;
        let lastWinterVisualActive = false;
        let blueprintCategory = 'ALL';
        let autosaveTimer = null;
        let mapDiscoverySaveTimer = null;
        let isMapOpen = false;
        let pendingMode = 'solo', pendingVisibility = 'public', gameSocket = null, onlineRoom = '', onlinePlayerId = loadStoredId('alone_player_id'), onlinePlayerToken = loadStoredId('alone_player_token'), remotePlayers = {}, onlineName = 'SURVIVOR';
        const achievementStorageKey = `alone_achievements_${onlinePlayerId}`;
        let achievementData = loadAchievementData();
        let achievementReturnScreen = null;
        let isRoomOwner = false;
        let activeAchievementWorldKey = '';
        let worldAchievementsDisabled = false;
        try {
            const savedEmoji = localStorage.getItem(`alone_player_emoji_${onlinePlayerId}`);
            if (savedEmoji && PLAYER_EMOJIS.includes(savedEmoji) && isEmojiUnlocked(savedEmoji)) player.emoji = savedEmoji;
        } catch (error) {
            console.warn('Could not load selected character:', error);
        }
        let inputSequence = 0, lastServerSequence = 0;
        const GAME_SERVER_URL = 'wss://game-server.crazyfunnyboy265.workers.dev/ws';
        const SOUNDTRACK_FILES = {
            boss: 'BOSS!!.mp3',
            winterCombat: 'Cold fighting.mp3',
            mildCombat: 'Fight em till you cant no more.mp3',
            winterWork: 'Really cold out here.mp3',
            mildWork: 'Tedious.mp3',
            caveWork: 'Working in the dark.mp3',
            gregVictory: 'Too easy.mp3',
            alphaWolf: "You're Cooked.mp3",
            menu: 'Menus.mp3'
        };
        const TOKEN_DEFINITIONS = {
            ivory_token: { key: 'ivory', label: 'IVORY TOKEN', icon: '🦷', color: '#fff1cf', glow: 'rgba(255, 224, 153, 0.65)', audio: 'Greg token.mp3' },
            wolf_token: { key: 'wolf', label: 'WOLF TOKEN', icon: '🐺', color: '#d8d0ff', glow: 'rgba(157, 125, 255, 0.7)', audio: 'Wolf token.mp3' }
        };
        const TOKEN_PICKUP_AUDIO = new Map(Object.entries(TOKEN_DEFINITIONS).map(([type, definition]) => {
            const audio = new Audio(new URL(encodeURI(definition.audio), document.baseURI).href);
            audio.preload = 'auto';
            return [definition.key, audio];
        }));
        const MENU_SCREEN_IDS = [
            'main-menu', 'generation-screen', 'news-screen', 'achievements-screen',
            'init-choice', 'world-slots-screen', 'world-settings-screen',
            'room-browser-screen', 'tutorial-screen', 'pause-screen',
            'desktop-options-screen', 'sound-settings-screen'
        ];
        const MUSIC_COOLDOWN_EXEMPT = new Set(['boss', 'alphaWolf', 'winterCombat', 'mildCombat', 'caveWork', 'menu']);
        const GREG_SHAKE_MS = 1000;
        const GREG_FADE_MS = 5000;
        const GREG_CHEST_FADE_MS = 2000;
        const soundtrack = new Map(Object.entries(SOUNDTRACK_FILES).map(([key, file]) => {
            const audio = new Audio(new URL(encodeURI(file), document.baseURI).href);
            audio.loop = key === 'menu';
            audio.preload = 'none';
            audio.volume = 0;
            audio.addEventListener('ended', () => {
                soundtrackStarted.delete(key);
                if (!MUSIC_COOLDOWN_EXEMPT.has(key)) {
                    soundtrackCooldownUntil.set(key, performance.now() + MUSIC_TRACK_COOLDOWN_MS);
                }
                if (key === 'gregVictory') gregVictoryMusicRequested = false;
                audio.currentTime = 0;
            });
            return [key, audio];
        }));
        const soundtrackPlayPending = new Set();
        const soundtrackPlayFailed = new Set();
        const soundtrackStarted = new Set();
        const soundtrackCooldownUntil = new Map();
        let gregVictoryMusicRequested = false;
        let lastMusicCombatAt = -Infinity, lastMusicWorkAt = -Infinity;
        const MUSIC_COMBAT_HOLD_MS = 3500;
        const MUSIC_WORK_HOLD_MS = 20000;
        const MUSIC_TRACK_COOLDOWN_MS = 20000;
        let mapZoom = 1;
        let mapPan = { x: 0, y: 0 }, mapDrag = null;
        try {
            const savedMapView = JSON.parse(localStorage.getItem('alone_world_map_view') || 'null');
            if (Number.isFinite(savedMapView?.zoom)) mapZoom = Math.max(0.5, Math.min(3, savedMapView.zoom));
            if (Number.isFinite(savedMapView?.x) && Number.isFinite(savedMapView?.y)) mapPan = { x: savedMapView.x, y: savedMapView.y };
        } catch (error) {
            console.warn('Could not restore map view settings:', error);
        }
        let mapTerrainCanvas = document.createElement('canvas'), mapTerrainDirty = true;
        mapTerrainCanvas.width = COLS; mapTerrainCanvas.height = ROWS;
        let placementMouse = { x: worldWidth / 2, y: worldHeight / 2 };
        const worldMapCanvas = document.getElementById('world-map-canvas');
        const worldMapCtx = worldMapCanvas.getContext('2d');

        const CYCLE = {
            DAY: { length: 240 * 60, label: 'DAYLIGHT', color: 0 },
            DUSK: { length: 60 * 60, label: 'DUSK', color: 0.65 },
            NIGHT: { length: 180 * 60, label: 'NIGHT', color: 1.0 }
        };
        let currentPhase = 'DAY', phaseTimeLeft = CYCLE.DAY.length;

        function seasonDurationDays(season) {
            const key = season === 'winter' ? 'winterLengthDays' : 'mildLengthDays';
            const value = Number(worldConfig[key]);
            return Number.isFinite(value) ? Math.max(0, value) : 8;
        }

        function initializeSoloSeason() {
            const winterDays = seasonDurationDays('winter');
            const mildDays = seasonDurationDays('mild');
            currentSeason = winterDays > 0 && mildDays === 0 ? 'winter' : 'mild';
            seasonDaysRemaining = seasonDurationDays(currentSeason);
            player.bodyHeat = 100;
        }

        function normalizeSoloSeasonSchedule() {
            const winterDays = seasonDurationDays('winter');
            const mildDays = seasonDurationDays('mild');
            if (winterDays === 0 && mildDays === 0) {
                currentSeason = 'mild';
                seasonDaysRemaining = 0;
                return;
            }
            if (seasonDurationDays(currentSeason) === 0) {
                currentSeason = winterDays > 0 ? 'winter' : 'mild';
                seasonDaysRemaining = seasonDurationDays(currentSeason);
                return;
            }
            seasonDaysRemaining = Math.max(1, Math.min(seasonDurationDays(currentSeason), seasonDaysRemaining));
        }

        function syncClientSeason(season, daysRemaining) {
            const nextSeason = season === 'winter' ? 'winter' : 'mild';
            if (nextSeason !== currentSeason) mapTerrainDirty = true;
            currentSeason = nextSeason;
            if (Number.isInteger(daysRemaining)) seasonDaysRemaining = Math.max(0, Math.min(30, daysRemaining));
        }

        function thermalStoneStatus(temperature) {
            if (currentSeason !== 'winter') return { icon: '⚪️', label: 'No status' };
            const temp = Number(temperature) || 0;
            if (temp <= -20) return { icon: '🔵', label: 'Cyan/cold' };
            if (temp < 5) return { icon: '⚪️', label: 'Neutral' };
            if (temp < 30) return { icon: '🟢', label: 'Warm' };
            if (temp < 65) return { icon: '🟡', label: 'Hot' };
            if (temp < 85) return { icon: '🟠', label: 'Very hot' };
            return { icon: '🔴', label: 'Extremely hot' };
        }

        function itemTooltipText(type, slot) {
            const description = ITEM_DESCRIPTIONS[type] || type;
            const shield = SHIELD_STATS[type];
            if (shield) {
                const durability = Math.max(0, Math.min(shield.durability, Number(slot?.duration ?? slot?.durability) || shield.durability));
                return `${description} Durability: ${Math.ceil(durability)}/${shield.durability}.`;
            }
            if (type !== 'thermal_stone') return description;
            const status = thermalStoneStatus(slot?.thermalTemp);
            return `${description} Status: ${status.label}.`;
        }

        function normalizeShieldData(raw) {
            const stats = SHIELD_STATS[raw?.type];
            if (!stats) return null;
            const rawDurability = Number(raw.durability);
            const durability = Math.max(0, Math.min(stats.durability, Number.isFinite(rawDurability) ? rawDurability : stats.durability));
            return durability > 0 ? { type: raw.type, durability, maxDurability: stats.durability } : null;
        }

        function winterVisualActive() {
            return currentSeason === 'winter' && getBiomeAtWorldPos(player.x + 13, player.y + 13) !== 'DESERT';
        }

        function winterBiomeColor(biome) {
            const color = BIOMES[biome]?.color || '#51614a';
            if (!winterVisualActive()) return color;
            const grey = [145, 157, 170];
            const rgb = [1, 3, 5].map((start, index) => {
                const channel = parseInt(color.slice(start, start + 2), 16);
                return Math.round(channel * 0.88 + grey[index] * 0.12).toString(16).padStart(2, '0');
            });
            return `#${rgb.join('')}`;
        }

        function drawWinterScreenTint() {
            if (!winterVisualActive()) return;
            const cold = 1 - Math.max(0, Math.min(100, Number(player.bodyHeat) || 0)) / 100;
            const opacity = 0.07 + cold * 0.3;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = `rgba(137, 157, 178, ${opacity})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
        }

        function advanceSoloSeason() {
            const winterDays = seasonDurationDays('winter');
            const mildDays = seasonDurationDays('mild');
            if (winterDays === 0 && mildDays === 0) {
                currentSeason = 'mild';
                seasonDaysRemaining = 0;
                player.bodyHeat = 100;
                return;
            }
            if (seasonDaysRemaining > 0) seasonDaysRemaining--;
            if (seasonDaysRemaining > 0) return;
            const nextSeason = currentSeason === 'winter' ? 'mild' : 'winter';
            const nextDuration = seasonDurationDays(nextSeason);
            if (nextDuration > 0) {
                currentSeason = nextSeason;
                seasonDaysRemaining = nextDuration;
            } else {
                seasonDaysRemaining = seasonDurationDays(currentSeason);
                return;
            }
            player.bodyHeat = 100;
            mapTerrainDirty = true;
            displayChat({
                name: 'SYSTEM',
                text: currentSeason === 'winter' ? 'Winter has arrived. Stay close to a heat source.' : 'The winter has passed.',
                color: currentSeason === 'winter' ? '#b9d8e8' : '#2ecc71'
            });
        }

        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            globalScale = canvas.width / TARGET_WIDTH;
            logicalWidth = TARGET_WIDTH;
            logicalHeight = canvas.height / globalScale;
            miniCanvas.width = 210;
            miniCanvas.height = 140;
            lightCanvas.width = canvas.width;
            lightCanvas.height = canvas.height;
        }

        function displayRandomQuote() {
            const el = document.getElementById('menu-quote');
            if (el) el.innerText = QUOTES[Math.floor(Math.random() * QUOTES.length)];
        }

        function randomizePlayerIdentity() {
            player.color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
            player.emoji = PLAYER_EMOJIS[Math.floor(Math.random() * PLAYER_EMOJIS.length)];
        }

        function damagePlayer(amount) {
            if (isOnlineActive() || (worldConfig.creative && player.creativeInvulnerable)) return;
            if (amount >= 1.5) registerPlayerHurtThought();
            const shield = SHIELD_STATS[player.shield?.type];
            if (shield && player.shield.durability > 0) {
                const absorbed = Math.min(amount * shield.protection, player.shield.durability);
                player.shield.durability -= absorbed;
                amount -= absorbed;
                if (player.shield.durability <= 0) {
                    player.shield = null;
                    displayChat({ name: 'SYSTEM', text: `${shield.name} broke.`, color: '#ffa500' });
                }
                renderInventory();
            }
            player.hp -= amount;
        }
