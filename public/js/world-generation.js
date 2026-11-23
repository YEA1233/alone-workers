        function updateWorldDimensions() {

            const scale =
                Number(
                    worldConfig.worldSizeMult ?? 1
                );

            const base = 520;

            COLS =
                Math.max(
                    1,
                    Math.round(base * scale)
                );

            ROWS =
                Math.max(
                    1,
                    Math.round(base * scale)
                );

            worldWidth =
                COLS * cellSize;

            worldHeight =
                ROWS * cellSize;

            worldGrid = [];

            discoveredGrid =
                new Uint8Array(
                    COLS * ROWS
                );

            mapTerrainCanvas.width =
                COLS;

            mapTerrainCanvas.height =
                ROWS;

            player.x =
                worldWidth / 2;

            player.y =
                worldHeight / 2;

            placementMouse = {
                x: player.x,
                y: player.y
            };
        }

        function findNearestLandSpawn() {
            let best = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
            let bestDist = Infinity;
            for (let y = 0; y < ROWS; y++) {
                for (let x = 0; x < COLS; x++) {
                    const biome = worldGrid[y]?.[x];
                    if (!biome || biome === 'OCEAN' || biome === 'LAKE') continue;
                    const dist = (x - COLS / 2) ** 2 + (y - ROWS / 2) ** 2;
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = { x, y };
                    }
                }
            }

            return { x: best.x * cellSize + 20, y: best.y * cellSize + 20 };
        }

        // State configuration schema for incremental generator steps
        let generationState = {
            active: false,
            stepIndex: 0,
            ctx: null,
            totalForests: 0,
            totalMountains: 0,
            forestIndex: 0,
            mountainIndex: 0,
            yTracker: 0
        };

        function updateGenerationProgress() {
            const labels = [
                'Shaping the land and biomes...',
                'Carving rivers...',
                'Forming lakes...',
                'Growing plains and forests...',
                'Raising mountain ranges...',
                'Placing resources and wildlife...',
                'Scattering ancient ruins...',
                'Opening cave passages...',
                'World ready.'
            ];
            const state = generationState;
            const stage = Math.min(state.stepIndex, labels.length - 1);
            let withinStage = 0;
            if (stage === 0 || stage === 5) withinStage = state.yTracker / Math.max(1, ROWS);
            else if (stage === 3) withinStage = state.totalForests ? state.forestIndex / state.totalForests : 1;
            else if (stage === 4) {
                withinStage = state.totalMountains ? state.mountainIndex / state.totalMountains : 1;
            } else if (stage === 6 || stage === 7) withinStage = 0.5;
            else withinStage = 1;
            const percent = Math.max(0, Math.min(100, Math.round((stage + withinStage) / 8 * 100)));
            const text = document.getElementById('generation-stage');
            const bar = document.getElementById('generation-progress-bar');
            const label = document.getElementById('generation-progress-label');
            if (text) text.textContent = labels[stage];
            if (bar) bar.style.width = `${percent}%`;
            if (label) label.textContent = `${percent}%`;
        }

        function generateSoloCaves() {
            if (!worldConfig.cavesEnabled) {
                caveLayerLocal = null;
                return;
            }
            const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill('CAVE_WALL'));
            const rooms = [];
            let state = (worldSeed ^ 0x6d2b79f5) >>> 0;
            const random = () => {
                state = (state * 1664525 + 1013904223) >>> 0;
                return state / 4294967296;
            };
            const carveTunnel = (from, to, width) => {
                const horizontalFirst = random() < 0.5;
                const carve = (cx, cy, radius) => {
                    for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
                        if (ox * ox + oy * oy <= radius * radius + 1 && grid[cy + oy]?.[cx + ox] === 'CAVE_WALL') grid[cy + oy][cx + ox] = 'CAVE_FLOOR';
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
                const cx = i === 0 ? Math.floor(COLS / 2) : 10 + Math.floor(random() * Math.max(1, COLS - 20));
                const cy = i === 0 ? Math.floor(ROWS / 2) : 10 + Math.floor(random() * Math.max(1, ROWS - 20));
                const rx = 7 + Math.floor(random() * 17), ry = 7 + Math.floor(random() * 16);
                const chamber = { x: cx, y: cy, rx, ry };
                rooms.push(chamber);
                for (let y = Math.max(1, cy - ry - 2); y < Math.min(ROWS - 1, cy + ry + 2); y++) {
                    for (let x = Math.max(1, cx - rx - 2); x < Math.min(COLS - 1, cx + rx + 2); x++) {
                        const nx = (x - cx) / rx, ny = (y - cy) / ry;
                        const roughEdge = 1 + 0.16 * Math.sin((x + worldSeed % 97) * 0.71) * Math.cos((y - worldSeed % 53) * 0.63);
                        const sidePocket = Math.sin((x + worldSeed % 31) * 0.23) * Math.cos((y + worldSeed % 43) * 0.19) > 0.88;
                        if (nx * nx + ny * ny <= roughEdge || sidePocket && nx * nx + ny * ny < 1.35) grid[y][x] = 'CAVE_FLOOR';
                    }
                }
                if (i) {
                    const previous = rooms[i - 1];
                    carveTunnel(previous, chamber, 2 + (i % 3 === 0 ? 1 : 0));
                    if (i % 3 === 0) {
                        const branchEnd = {
                            x: Math.max(2, Math.min(COLS - 3, cx + (i % 2 ? -1 : 1) * (8 + Math.floor(random() * 12)))),
                            y: Math.max(2, Math.min(ROWS - 3, cy + (i % 2 ? 1 : -1) * (7 + Math.floor(random() * 10))))
                        };
                        carveTunnel(chamber, branchEnd, 1 + (i % 2));
                        for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
                            if (ox * ox + oy * oy <= 9 && grid[branchEnd.y + oy]?.[branchEnd.x + ox] === 'CAVE_WALL') grid[branchEnd.y + oy][branchEnd.x + ox] = 'CAVE_FLOOR';
                        }
                    }
                }
            }
            const caveEntrances = rooms.slice(1, 7);
            const skylightRooms = caveEntrances;
            for (const room of skylightRooms) {
                for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
                    if (ox * ox + oy * oy <= 5) grid[room.y + oy][room.x + ox] = 'CAVE_SUNLIT';
                }
            }
            const nodes = [];
            const caveBuildings = caveEntrances.map((room, index) => ({
                id: `solo-cave-exit-${index + 1}`,
                entranceId: `solo-cave-entrance-${index + 1}`,
                x: room.x * cellSize, y: room.y * cellSize,
                type: 'cave_exit', hp: 1, maxHp: 1
            }));
            const passageCells = new Set();
            for (const room of skylightRooms) {
                for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
                    if (ox * ox + oy * oy <= 5) passageCells.add(`${room.x + ox},${room.y + oy}`);
                }
            }
            for (let y = 2; y < ROWS - 2; y++) {
                for (let x = 2; x < COLS - 2; x++) {
                    if (grid[y][x] === 'CAVE_WALL' || passageCells.has(`${x},${y}`) || random() >= 0.12 * worldConfig.resMult) continue;
                    const iron = random() < 0.24;
                    nodes.push({ id: `cave-node-${nodes.length + 1}`, x: x * cellSize, y: y * cellSize, type: iron ? 'iron' : 'big_rock', icon: iron ? '⛓️' : '🪨', hp: iron ? 8 : 10, maxHp: iron ? 8 : 10 });
                }
            }

            let entryIndex = 0;
            state = (worldSeed ^ 0x3c6ef372) >>> 0;
            const entranceRandom = () => {
                state = (state * 1664525 + 1013904223) >>> 0;
                return state / 4294967296;
            };
            const occupied = new Set([
                ...buildings.map(building => `${Math.floor(building.x / cellSize)},${Math.floor(building.y / cellSize)}`),
                ...resourceNodes.filter(node => !node.pickup).map(node => `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`)
            ]);
            for (let attempt = 0; attempt < 10000 && entryIndex < caveEntrances.length; attempt++) {
                const x = 3 + Math.floor(entranceRandom() * Math.max(1, COLS - 7));
                const y = 3 + Math.floor(entranceRandom() * Math.max(1, ROWS - 7));
                let available = true;
                for (let oy = 0; oy < 2 && available; oy++) for (let ox = 0; ox < 2; ox++) {
                    const key = `${x + ox},${y + oy}`;
                    const biome = worldGrid[y + oy]?.[x + ox];
                    if (!biome || LIQUID_BIOMES.has(biome) || ['MOUNTAIN', 'SNOW'].includes(biome) || occupied.has(key)) {
                        available = false;
                        break;
                    }
                }
                if (!available) continue;
                const caveRoom = caveEntrances[entryIndex];
                buildings.push({
                    id: `solo-cave-entrance-${entryIndex + 1}`,
                    x: x * cellSize, y: y * cellSize, type: 'cave_entrance',
                    width: 2 * cellSize, height: 2 * cellSize,
                    caveX: caveRoom.x * cellSize, caveY: caveRoom.y * cellSize,
                    caveExitId: `solo-cave-exit-${entryIndex + 1}`,
                    hp: 1, maxHp: 1
                });
                for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) occupied.add(`${x + ox},${y + oy}`);
                entryIndex++;
            }
            caveLayerLocal = { worldGrid: grid, resourceNodes: nodes, buildings: caveBuildings, mobs: [], gregArena: null, discoveredGrid: new Uint8Array(COLS * ROWS) };
            if (!generationState.fromSave) ensureSoloGregSpawn(caveLayerLocal);
        }

        function ensureSoloGregSpawn(caveLayer) {
            if (!worldConfig.cavesEnabled || !caveLayer) return;
            const existingGreg = caveLayer.mobs.find(mob => mob.type === 'greg');
            const exits = caveLayer.buildings.filter(building => building.type === 'cave_exit');
            const exitCells = exits.map(exit => ({ x: Math.floor(exit.x / cellSize), y: Math.floor(exit.y / cellSize) }));
            const savedArena = caveLayer.gregArena;
            let best = savedArena && Number.isInteger(savedArena.x) && Number.isInteger(savedArena.y) &&
                savedArena.x >= 17 && savedArena.y >= 17 && savedArena.x < COLS - 17 && savedArena.y < ROWS - 17
                ? { x: caveLayer.gregArena.x, y: caveLayer.gregArena.y }
                : existingGreg && ['CAVE_FLOOR', 'CAVE_SUNLIT'].includes(caveLayer.worldGrid[Math.floor(existingGreg.y / cellSize)]?.[Math.floor(existingGreg.x / cellSize)])
                    ? { x: Math.floor(existingGreg.x / cellSize), y: Math.floor(existingGreg.y / cellSize) }
                    : null;
            if (!best) {
                let bestDistance = -1;
                for (let y = 17; y < ROWS - 17; y++) {
                    for (let x = 17; x < COLS - 17; x++) {
                        if (caveLayer.worldGrid[y]?.[x] !== 'CAVE_FLOOR') continue;
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
            caveLayer.gregArena = { x: best.x, y: best.y };
            if (existingGreg) {
                if (!existingGreg.size) {
                    existingGreg.x -= cellSize;
                    existingGreg.y -= cellSize;
                }
                existingGreg.size = cellSize * 3;
                existingGreg.x = Math.max((best.x - 10) * cellSize, Math.min((best.x + 7) * cellSize, existingGreg.x));
                existingGreg.y = Math.max((best.y - 10) * cellSize, Math.min((best.y + 7) * cellSize, existingGreg.y));
            }
            for (let dy = -15; dy < 15; dy++) {
                for (let dx = -15; dx < 15; dx++) {
                    caveLayer.worldGrid[best.y + dy][best.x + dx] = 'CAVE_SUNLIT';
                }
            }
            caveLayer.resourceNodes = caveLayer.resourceNodes.filter(node =>
                Math.abs(Math.floor(node.x / cellSize) - best.x) > 15 ||
                Math.abs(Math.floor(node.y / cellSize) - best.y) > 15
            );
            if (gregDefeated || existingGreg) return;
            caveLayer.mobs.push({
                id: 'solo-greg-accounting',
                type: 'greg',
                x: (best.x - 1) * cellSize,
                y: (best.y - 1) * cellSize,
                emoji: '🐘',
                tx: (best.x - 1) * cellSize,
                ty: (best.y - 1) * cellSize,
                size: cellSize * 3,
                hp: 2000,
                maxHp: 2000,
                chargeState: 'idle',
                chargeTimer: 0
            });
        }

        function maybeRespawnSoloGreg() {
            if (!gregDefeated || worldConfig.cavesEnabled === false || !caveLayerLocal) return;
            if (dayCount - gregDefeatedDay < 10) return;

            gregDefeated = false;
            ensureSoloGregSpawn(caveLayerLocal);
            if (!caveLayerLocal.mobs.some(mob => mob.type === 'greg')) {
                gregDefeated = true;
                return;
            }
            gregDefeatedDay = null;
            displayChat({ name: 'SYSTEM', text: 'Ten days have passed. Greg has returned to the cave arena.', color: '#ffcc00' });
        }

        function ensureSoloCaveExitLinks(surfaceBuildings, caveLayer) {
            if (!worldConfig.cavesEnabled || !caveLayer) return;
            const entrances = surfaceBuildings
                .filter(building => building.type === 'cave_entrance')
                .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
            const exits = [];
            for (let i = 0; i < entrances.length; i++) {
                const entrance = entrances[i];
                let gx = Math.floor(Number(entrance.caveX) / cellSize);
                let gy = Math.floor(Number(entrance.caveY) / cellSize);
                const walkable = (x, y) => ['CAVE_FLOOR', 'CAVE_SUNLIT'].includes(caveLayer.worldGrid[y]?.[x]);
                if (!walkable(gx, gy)) {
                    const originX = Number.isFinite(gx) ? gx : Math.floor(COLS / 2);
                    const originY = Number.isFinite(gy) ? gy : Math.floor(ROWS / 2);
                    let found = null;
                    for (let radius = 1; radius < Math.max(COLS, ROWS) && !found; radius++) {
                        for (let dy = -radius; dy <= radius && !found; dy++) {
                            for (let dx = -radius; dx <= radius; dx++) {
                                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                                if (walkable(originX + dx, originY + dy)) {
                                    found = { x: originX + dx, y: originY + dy };
                                    break;
                                }
                            }
                        }
                    }
                    if (!found) throw new Error('Could not find walkable terrain for a cave exit.');
                    gx = found.x;
                    gy = found.y;
                }
                entrance.caveX = gx * cellSize;
                entrance.caveY = gy * cellSize;
                entrance.caveExitId = `solo-cave-exit-${i + 1}`;
                for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
                    if (ox * ox + oy * oy <= 5 && caveLayer.worldGrid[gy + oy]?.[gx + ox] === 'CAVE_FLOOR') {
                        caveLayer.worldGrid[gy + oy][gx + ox] = 'CAVE_SUNLIT';
                    }
                }
                exits.push({
                    id: entrance.caveExitId,
                    entranceId: entrance.id,
                    x: entrance.caveX,
                    y: entrance.caveY,
                    type: 'cave_exit',
                    hp: 1,
                    maxHp: 1
                });
            }
            caveLayer.buildings = exits;
        }

        function captureLocalLayer() {
            return { worldGrid, resourceNodes, buildings, mobs, discoveredGrid };
        }

        function restoreLocalLayer(layer, name) {
            worldGrid = layer.worldGrid;
            resourceNodes = layer.resourceNodes;
            buildings = layer.buildings;
            mobs = layer.mobs;
            discoveredGrid = layer.discoveredGrid;
            currentLayer = name;
            mapTerrainCanvas.width = COLS;
            mapTerrainCanvas.height = ROWS;
            mapTerrainDirty = true;
            remotePlayers = {};
        }

        function enterCaveLocal(entrance) {
            if (!worldConfig.cavesEnabled || !caveLayerLocal) return;
            unlockAchievement('caves');
            surfaceLayerLocal = captureLocalLayer();
            const surfaceX = entrance.x + cellSize - 13, surfaceY = entrance.y + cellSize - 13;
            player.caveReturn = { x: surfaceX, y: surfaceY };
            player.caveEntranceId = entrance.id;
            restoreLocalLayer(caveLayerLocal, 'caves');
            const exit = buildings.find(building => building.id === entrance.caveExitId && building.type === 'cave_exit');
            if (!exit) {
                restoreLocalLayer(surfaceLayerLocal, 'surface');
                surfaceLayerLocal = null;
                floatText(entrance.x + 20, entrance.y - 6, 'No connected cave exit', '#ff8888');
                return;
            }
            player.x = exit.x + cellSize - 13;
            player.y = exit.y + cellSize - 13;
            triggerPlayerThought('cave');
            player.inBoat = false;
            autoTask = null;
            autoPath = null;
            stopMovement();
        }

        function exitCaveLocal(exit) {
            if (currentLayer !== 'caves' || !surfaceLayerLocal) return;
            if (gregArenaLocked && insideGregArena(playerCenter().x, playerCenter().y)) {
                displayChat({ name: 'SYSTEM', text: "Greg has sealed the arena. Defeat him or wait until no one remains inside.", color: '#ffcc00' });
                return;
            }
            const pairedEntrance = surfaceLayerLocal.buildings.find(building =>
                building.type === 'cave_entrance' && building.id === exit?.entranceId
            );
            if (exit?.entranceId && !pairedEntrance) {
                floatText(exit.x + 20, exit.y - 6, 'This exit leads elsewhere', '#ff8888');
                return;
            }
            const returnPoint = pairedEntrance
                ? { x: pairedEntrance.x + cellSize - 13, y: pairedEntrance.y + cellSize - 13 }
                : player.caveReturn || { x: worldWidth / 2, y: worldHeight / 2 };
            restoreLocalLayer(surfaceLayerLocal, 'surface');
            player.x = returnPoint.x;
            player.y = returnPoint.y;
            player.caveEntranceId = null;
            player.inBoat = false;
            autoTask = null;
            autoPath = null;
            stopMovement();
        }

        function generateOrganicMap(options = {}) {

            const fromSave = !!options.fromSave;
            currentLayer = 'surface';
            surfaceLayerLocal = null;
            caveLayerLocal = null;
            // New worlds use the newest terrain. Saves made before v2 have no genVersion and keep the old terrain.
            currentGenVersion = fromSave ? (pendingLoad.genVersion || 1) : GEN_VERSION;

            console.log("WORLD CONFIG:", worldConfig);

            try {

                if (fromSave) {

                    // Loading a save: reuse the saved numeric seed,
                    // ignore the seed textbox completely.
                    worldSeed = pendingLoad.seed;
                    currentRandomState = worldSeed;

                } else {

                    const seedInput =
                        document.getElementById('set-world-seed');

                    let enteredSeed =
                        seedInput?.value
                            ?.toUpperCase()
                            .replace(/[^A-Z0-9]/g, '');

                    // If no seed was entered, create one.
                    if (!enteredSeed) {
                        enteredSeed = generateWorldSeed();
                    }

                    // Validate length.
                    if (
                        enteredSeed.length !==
                        SEED_SETTINGS_LENGTH + SEED_RANDOM_LENGTH
                    ) {
                        throw new Error(
                            `Invalid world seed. Expected ${SEED_SETTINGS_LENGTH + SEED_RANDOM_LENGTH} characters.`
                        );
                    }

                    // Store the complete seed.
                    currentWorldSeed = enteredSeed;

                    // The RANDOM half determines the actual
                    // world-generation randomness.
                    const randomPart =
                        enteredSeed.substring(SEED_SETTINGS_LENGTH);

                    worldSeed =
                        seedStringToNumber(randomPart);

                    // Reset deterministic random sequence.
                    currentRandomState = worldSeed;
                }

                console.log("NUMERIC WORLD SEED:", worldSeed);



                // -------------------------------------------------
                // EXISTING GENERATION SETUP
                // -------------------------------------------------

                if (typeof updateWorldDimensions === 'function') {
                    updateWorldDimensions();
                }

                if (
                    typeof ROWS === 'undefined' ||
                    typeof COLS === 'undefined' ||
                    isNaN(ROWS) ||
                    isNaN(COLS)
                ) {
                    throw new Error(
                        "ROWS or COLS is not a valid number."
                    );
                }

                worldGrid = new Array(ROWS);

                for (let y = 0; y < ROWS; y++) {
                    worldGrid[y] =
                        new Array(COLS).fill('OCEAN');
                }

                mapTerrainDirty = true;

                // IMPORTANT:
                // This must remain AFTER worldSeed was initialized.
                currentRandomState = worldSeed;

                resourceNodes = [];
                mobs = [];
                buildings = [];

                generationState = {
                    active: true,
                    fromSave,
                    stepIndex: 0,
                    yTracker: 0,
                    forestIndex: 0,
                    mountainIndex: 0,
                    totalForests: 0,
                    totalMountains: 0,
                    ctx: null
                };

                generationState.ctx = {
                    occupancy: new Uint8Array(COLS * ROWS),

                    cX: COLS / 2,
                    cY: ROWS / 2,

                    mapPreset:
                        worldConfig.mapPreset || 'standard',

                    oceanScale:
                        Math.max(
                            0.1,
                            Number(worldConfig.oceanMult || 1)
                        ),

                    removesOcean:
                        ['dry', 'inland', 'riverlands']
                            .includes(
                                worldConfig.mapPreset || 'standard'
                            ),

                    forestScale:
                        Math.max(
                            0.01,
                            Number(worldConfig.forestMult || 1)
                        ),

                    mountainScale:
                        Math.max(
                            0.01,
                            Number(worldConfig.mountainMult || 1)
                        ),

                    LIQUIDS: new Set([
                        'OCEAN',
                        'LAKE',
                        'RIVER',
                        'BAY',
                        'GULF',
                        'SHALLOW_WATER'
                    ]),

                    isDryOrInland:
                        ['dry', 'inland']
                            .includes(
                                worldConfig.mapPreset || 'standard'
                            ),

                    isBarrenZone: (x, y) => {

                        const patch =
                            Math.sin(
                                x * 0.021 +
                                worldSeed * 0.001
                            ) +
                            Math.cos(
                                y * 0.019 -
                                worldSeed * 0.0013
                            );

                        return (
                            patch > 1.82 &&
                            Math.sin(
                                (x + y) * 0.013
                            ) > 0.35
                        );
                    }
                };

                generationState.ctx.continentBias =
                    0.9 +
                    (
                        1.5 -
                        generationState.ctx.oceanScale
                    ) * 0.35;

                generationState.ctx.oceanThreshold =
                    0.15 +
                    (
                        1.4 -
                        generationState.ctx.oceanScale
                    ) * 0.08;

                const v2 = currentGenVersion >= 2;
                const areaScale = v2 ? (COLS * ROWS) / (520 * 520) : 1;
                generationState.genVersion = currentGenVersion;
                generationState.plainsDone = false;
                generationState.totalPlains = (v2 && generationState.ctx.mapPreset !== 'dry') ? GEN_V2.plainsBlobs * areaScale : 0;
                generationState.totalForests = (v2 ? GEN_V2.forestBlobs * areaScale : 500) * generationState.ctx.forestScale;
                generationState.totalMountains = (v2 ? GEN_V2.mountainBlobs * areaScale : 300) * generationState.ctx.mountainScale;

                const generationScreen = document.getElementById('generation-screen');
                if (generationScreen) generationScreen.style.display = 'flex';
                updateGenerationProgress();
                requestAnimationFrame(
                    executeGenerationStep
                );

            } catch (outerErr) {

                alert(
                    `❌ CRASH INSIDE SETUP:\n\n${outerErr.message}`
                );
            }
        }
        // ============================================================
        // ORGANIC WORLD NOISE
        // ============================================================

        function seededNoise2D(x, y, seed = worldSeed) {
            const s =
                Math.sin(
                    x * 127.1 +
                    y * 311.7 +
                    seed * 0.000123
                ) * 43758.5453123;

            return s - Math.floor(s);
        }

        function smoothNoise(x, y) {
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);

            const xf = x - x0;
            const yf = y - y0;

            // Smooth interpolation
            const sx = xf * xf * (3 - 2 * xf);
            const sy = yf * yf * (3 - 2 * yf);

            const n00 = seededNoise2D(x0, y0);
            const n10 = seededNoise2D(x0 + 1, y0);
            const n01 = seededNoise2D(x0, y0 + 1);
            const n11 = seededNoise2D(x0 + 1, y0 + 1);

            const ix0 = n00 + (n10 - n00) * sx;
            const ix1 = n01 + (n11 - n01) * sx;

            return ix0 + (ix1 - ix0) * sy;
        }

        function fbmNoise(x, y, octaves = 4) {
            let value = 0;
            let amplitude = 0.5;
            let frequency = 1;
            let totalAmplitude = 0;

            for (let i = 0; i < octaves; i++) {
                value += smoothNoise(
                    x * frequency,
                    y * frequency
                ) * amplitude;

                totalAmplitude += amplitude;

                frequency *= 2;
                amplitude *= 0.5;
            }

            return value / totalAmplitude;
        }

        function executeGenerationStep() {
            if (!generationState || !generationState.active) return;

            try {
                updateGenerationProgress();
                const c = generationState.ctx;
                if (!c) throw new Error("Generation context (ctx) was not initialized properly.");
                mapTerrainDirty = true;

                switch (generationState.stepIndex) {

                    case 0: { // Organic Terrain

                        const linesPerFrame = Math.max(4, Math.floor(ROWS / 15));

                        const oceanMult = Number(worldConfig.oceanMult) || 1;
                        const forestMult = Number(worldConfig.forestMult) || 1;
                        const mountainMult = Number(worldConfig.mountainMult) || 1;

                        const preset = worldConfig.mapPreset || 'standard';

                        // ---------------------------------------------------------
                        // OCEAN LEVEL
                        // ---------------------------------------------------------

                        let oceanLevel = 0.45;

                        // Higher ocean setting = more ocean.
                        oceanLevel += (oceanMult - 1) * 0.10;

                        if (preset === 'islands') {
                            oceanLevel += 0.08;
                        }

                        if (preset === 'dry') {
                            oceanLevel -= 0.10;
                        }

                        if (preset === 'inland') {
                            oceanLevel -= 0.05;
                        }

                        if (preset === 'riverlands') {
                            oceanLevel -= 0.02;
                        }

                        oceanLevel = Math.max(
                            0.20,
                            Math.min(0.70, oceanLevel)
                        );

                        // ---------------------------------------------------------
                        // GENERATE TERRAIN
                        // ---------------------------------------------------------

                        for (
                            let i = 0;
                            i < linesPerFrame &&
                            generationState.yTracker < ROWS;
                            i++
                        ) {

                            const y = generationState.yTracker;

                            for (let x = 0; x < COLS; x++) {

                                // Normalized coordinates.
                                const nx = x / Math.max(1, COLS - 1);
                                const ny = y / Math.max(1, ROWS - 1);

                                // -------------------------------------------------
                                // LARGE LAND MASS SHAPE
                                // -------------------------------------------------

                                const large = fbmNoise(
                                    nx * 2.5 + worldSeed * 0.00001,
                                    ny * 2.5 + worldSeed * 0.000013,
                                    4
                                );

                                // -------------------------------------------------
                                // MEDIUM TERRAIN
                                // -------------------------------------------------

                                const medium = fbmNoise(
                                    nx * 5.0 + worldSeed * 0.000021,
                                    ny * 5.0 + worldSeed * 0.000017,
                                    4
                                );

                                // -------------------------------------------------
                                // SMALL DETAIL
                                // -------------------------------------------------

                                const detail = fbmNoise(
                                    nx * 11.0 + worldSeed * 0.000031,
                                    ny * 11.0 + worldSeed * 0.000027,
                                    3
                                );

                                // -------------------------------------------------
                                // COMBINE
                                // -------------------------------------------------

                                let elevation =
                                    large * 0.60 +
                                    medium * 0.28 +
                                    detail * 0.12;

                                // Keep it firmly inside 0-1.
                                elevation = Math.max(
                                    0,
                                    Math.min(1, elevation)
                                );

                                // -------------------------------------------------
                                // ISLAND PRESET
                                // -------------------------------------------------

                                if (preset === 'islands') {

                                    const islandDetail = fbmNoise(
                                        nx * 7.0 + worldSeed * 0.000041,
                                        ny * 7.0 + worldSeed * 0.000037,
                                        4
                                    );

                                    elevation =
                                        elevation * 0.70 +
                                        islandDetail * 0.30;
                                }

                                // -------------------------------------------------
                                // MOISTURE
                                // -------------------------------------------------

                                const moisture = fbmNoise(
                                    nx * 6.0 + 100,
                                    ny * 6.0 + 200,
                                    4
                                );

                                // -------------------------------------------------
                                // TEMPERATURE
                                // -------------------------------------------------

                                const temperature = fbmNoise(
                                    nx * 3.5 + 500,
                                    ny * 3.5 + 600,
                                    3
                                );

                                let biome;

                                // -------------------------------------------------
                                // OCEAN
                                // -------------------------------------------------

                                if (
                                    !c.removesOcean &&
                                    elevation < oceanLevel
                                ) {

                                    biome = 'OCEAN';

                                } else {

                                    // -------------------------------------------------
                                    // COAST
                                    // -------------------------------------------------

                                    if (
                                        !c.removesOcean &&
                                        elevation < oceanLevel + 0.045
                                    ) {

                                        biome = 'BEACH';

                                    } else {

                                        // -------------------------------------------------
                                        // MOUNTAIN
                                        // -------------------------------------------------

                                        const mountainThreshold =
                                            0.78 -
                                            ((mountainMult - 1) * 0.08);

                                        if (
                                            elevation > mountainThreshold &&
                                            elevation > oceanLevel + 0.15
                                        ) {

                                            if (temperature < 0.30) {
                                                biome = 'SNOW';
                                            } else {
                                                biome = 'MOUNTAIN';
                                            }

                                        } else {

                                            // -------------------------------------------------
                                            // DESERT
                                            // -------------------------------------------------

                                            if (
                                                preset === 'dry' ||
                                                (
                                                    moisture < 0.28 &&
                                                    temperature > 0.50
                                                )
                                            ) {

                                                biome = 'DESERT';

                                            } else {

                                                // -------------------------------------------------
                                                // FOREST
                                                // -------------------------------------------------

                                                const forestThreshold =
                                                    0.68 -
                                                    ((forestMult - 1) * 0.10);

                                                if (
                                                    moisture > forestThreshold &&
                                                    elevation > oceanLevel + 0.05
                                                ) {

                                                    biome = 'FOREST';

                                                } else {

                                                    biome = 'PLAINS';
                                                }
                                            }
                                        }
                                    }
                                }

                                // v2: land that isn't mountain/snow/beach starts as DESERT. Plains and forest are painted on afterwards.
                                if (generationState.genVersion >= 2 && (biome === 'PLAINS' || biome === 'FOREST')) biome = 'DESERT';

                                // Preset cleanup.
                                if (
                                    preset === 'dry' &&
                                    biome === 'BEACH'
                                ) {
                                    biome = 'DESERT';
                                }

                                if (
                                    preset === 'inland' &&
                                    biome === 'BEACH'
                                ) {
                                    biome = 'PLAINS';
                                }

                                if (x === Math.floor(COLS / 2) && y === Math.floor(ROWS / 2)) {
                                    console.log(
                                        "TERRAIN TEST",
                                        {
                                            elevation,
                                            oceanLevel,
                                            moisture,
                                            temperature,
                                            biome
                                        }
                                    );
                                }

                                worldGrid[y][x] = biome;
                            }

                            generationState.yTracker++;
                        }

                        if (generationState.yTracker >= ROWS) {
                            generationState.stepIndex = 1;
                        }

                        break;
                    }

                    case 1: // Rivers
                        const riverCount = c.mapPreset === 'dry' ? 0 : Math.max(2, Math.min(6, Math.round((COLS + ROWS) / 220)));
                        for (let i = 0; i < riverCount; i++) {
                            let x = Math.floor(seededRandom() * COLS);
                            let y = Math.floor(seededRandom() * ROWS);
                            const targetX = Math.floor(COLS * (0.3 + seededRandom() * 0.4));
                            const targetY = Math.floor(ROWS * (0.3 + seededRandom() * 0.4));

                            for (let step = 0; step < 420; step++) {
                                const dx = targetX - x;
                                const dy = targetY - y;
                                const dist = Math.max(1, Math.hypot(dx, dy));
                                x += Math.max(-2, Math.min(2, Math.round((dx / dist) * (1 + seededRandom() * 2.5))));
                                y += Math.max(-2, Math.min(2, Math.round((dy / dist) * (1 + seededRandom() * 2.5))));
                                x = Math.max(0, Math.min(COLS - 1, x));
                                y = Math.max(0, Math.min(ROWS - 1, y));

                                for (let yy = Math.max(0, y - 1); yy <= Math.min(ROWS - 1, y + 1); yy++) {
                                    for (let xx = Math.max(0, x - 1); xx <= Math.min(COLS - 1, x + 1); xx++) {
                                        if (worldGrid[yy] && worldGrid[yy][xx] !== 'OCEAN' && worldGrid[yy][xx] !== 'LAKE') worldGrid[yy][xx] = 'RIVER';
                                    }
                                }
                            }
                        }
                        generationState.stepIndex = 2;
                        break;

                    case 2: // Lakes
                        const clusterLakes = c.mapPreset === 'dry' ? 0 : 10;
                        for (let i = 0; i < clusterLakes; i++) {
                            const cx = Math.floor(seededRandom() * COLS);
                            const cy = Math.floor(seededRandom() * ROWS);
                            const radius = 6 + Math.floor(seededRandom() * 14);
                            const rSq = radius * radius;
                            for (let y = Math.max(0, cy - radius); y < Math.min(ROWS, cy + radius); y++) {
                                for (let x = Math.max(0, cx - radius); x < Math.min(COLS, cx + radius); x++) {
                                    if (((x - cx) ** 2 + (y - cy) ** 2) < rSq && worldGrid[y] && worldGrid[y][x] !== 'OCEAN' && worldGrid[y][x] !== 'SNOW') worldGrid[y][x] = 'LAKE';
                                }
                            }
                        }
                        generationState.stepIndex = 3;
                        break;

                    case 3: // Plains (v2 only), then forests
                        // v2: paint plains once, before the forests, so forests and mountains overwrite them.
                        if (generationState.genVersion >= 2 && !generationState.plainsDone) {
                            generationState.plainsDone = true;
                            for (let i = 0; i < generationState.totalPlains; i++) {
                                const cx = Math.floor(seededRandom() * COLS);
                                const cy = Math.floor(seededRandom() * ROWS);
                                const radius = GEN_V2.plainsRadius[0] + Math.floor(seededRandom() * GEN_V2.plainsRadius[1]);
                                const rSq = radius * radius;
                                for (let y = Math.max(0, cy - radius); y < Math.min(ROWS, cy + radius); y++) {
                                    for (let x = Math.max(0, cx - radius); x < Math.min(COLS, cx + radius); x++) {
                                        if (worldGrid[y] && ((x - cx) ** 2 + (y - cy) ** 2) < rSq && !c.LIQUIDS.has(worldGrid[y][x]) &&
                                            worldGrid[y][x] !== 'BEACH' && worldGrid[y][x] !== 'MOUNTAIN' && worldGrid[y][x] !== 'SNOW') {
                                            worldGrid[y][x] = 'PLAINS';
                                        }
                                    }
                                }
                            }
                        }

                        let forestBatches = Math.max(10, Math.floor(generationState.totalForests / 10));
                        for (let i = 0; i < forestBatches && generationState.forestIndex < generationState.totalForests; i++) {
                            const cx = Math.floor(seededRandom() * COLS);
                            const cy = Math.floor(seededRandom() * ROWS);
                            const radius = 14 + Math.floor(seededRandom() * 18);
                            const rSq = radius * radius;
                            for (let y = Math.max(0, cy - radius); y < Math.min(ROWS, cy + radius); y++) {
                                for (let x = Math.max(0, cx - radius); x < Math.min(COLS, cx + radius); x++) {
                                    if (worldGrid[y] && ((x - cx) ** 2 + (y - cy) ** 2) < rSq && !c.LIQUIDS.has(worldGrid[y][x]) && worldGrid[y][x] !== 'BEACH' && worldGrid[y][x] !== 'MOUNTAIN') {
                                        worldGrid[y][x] = 'FOREST';
                                    }
                                }
                            }
                            generationState.forestIndex++;
                        }
                        if (generationState.forestIndex >= generationState.totalForests) generationState.stepIndex = 4;
                        break;
                    case 4: // Mountains
                        let mountainBatches = Math.max(10, Math.floor(generationState.totalMountains / 10));
                        for (let i = 0; i < mountainBatches && generationState.mountainIndex < generationState.totalMountains; i++) {
                            const cx = Math.floor(seededRandom() * COLS);
                            const cy = Math.floor(seededRandom() * ROWS);
                            const radius = 10 + Math.floor(seededRandom() * 14);
                            const rSq = radius * radius;
                            for (let y = Math.max(0, cy - radius); y < Math.min(ROWS, cy + radius); y++) {
                                for (let x = Math.max(0, cx - radius); x < Math.min(COLS, cx + radius); x++) {
                                    if (worldGrid[y] && ((x - cx) ** 2 + (y - cy) ** 2) < rSq && !c.LIQUIDS.has(worldGrid[y][x]) && worldGrid[y][x] !== 'BEACH') {
                                        worldGrid[y][x] = 'MOUNTAIN';
                                    }
                                }
                            }
                            generationState.mountainIndex++;
                        }
                        if (generationState.mountainIndex >= generationState.totalMountains) {
                            generationState.stepIndex = 5;
                            generationState.yTracker = 0;
                        }
                        break;

                    case 5: // Shallows / Shoreline / Entity Spawns
                        let cleanLinesPerFrame = Math.max(4, Math.floor(ROWS / 10));
                        for (let i = 0; i < cleanLinesPerFrame && generationState.yTracker < ROWS; i++) {
                            let y = generationState.yTracker;
                            for (let x = 0; x < COLS; x++) {
                                let biome = worldGrid[y][x];

                                if (!c.LIQUIDS.has(biome)) {
                                    const west = x > 0 ? worldGrid[y][x - 1] : null;
                                    const east = x < COLS - 1 ? worldGrid[y][x + 1] : null;
                                    const north = y > 0 ? worldGrid[y - 1][x] : null;
                                    const south = y < ROWS - 1 ? worldGrid[y + 1][x] : null;
                                    if (c.LIQUIDS.has(west) || c.LIQUIDS.has(east) || c.LIQUIDS.has(north) || c.LIQUIDS.has(south)) {
                                        worldGrid[y][x] = c.isDryOrInland ? 'DESERT' : 'BEACH';
                                        biome = worldGrid[y][x];
                                    }
                                } else if (biome === 'OCEAN') {
                                    const west = x > 0 ? worldGrid[y][x - 1] : null;
                                    const east = x < COLS - 1 ? worldGrid[y][x + 1] : null;
                                    const north = y > 0 ? worldGrid[y - 1][x] : null;
                                    const south = y < ROWS - 1 ? worldGrid[y + 1][x] : null;
                                    if (west === 'BEACH' || east === 'BEACH' || north === 'BEACH' || south === 'BEACH') {
                                        worldGrid[y][x] = 'SHALLOW_WATER';
                                        continue;
                                    }
                                    continue;
                                } else {
                                    continue;
                                }
                                if (generationState.fromSave) continue;   // shoreline is done; don't spawn entities
                                if (c.isBarrenZone(x, y)) continue;
                                const roll = seededRandom();
                                const cellOffset = y * COLS + x;
                                const nodeRollThreshold = biome === 'MOUNTAIN' ? 0.04 : 0.12;
                                if (roll < nodeRollThreshold * worldConfig.resMult) {
                                    if (biome === 'FOREST' || biome === 'BEACH' || biome === 'SNOW') {
                                        const treeType = biome === 'BEACH' ? 'palm' : biome === 'SNOW' ? 'snow' : 'forest';
                                        resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'wood', icon: biome === 'BEACH' ? '🌴' : biome === 'SNOW' ? '🌲' : '🌳', hp: 5, maxHp: 5, biome: treeType });
                                        c.occupancy[cellOffset] = 1;
                                    } else if (biome === 'MOUNTAIN') {
                                        resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'big_rock', icon: '🪨', hp: 10, maxHp: 10 });
                                        c.occupancy[cellOffset] = 1;
                                    }
                                }
                                if (!c.occupancy[cellOffset] && roll < 0.08 * worldConfig.resMult) {
                                    if (biome === 'BEACH') {
                                        if (seededRandom() < 0.35) resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'twigs', icon: '🥢', pickup: true });
                                        if (seededRandom() < 0.1 * worldConfig.foodMult) resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'berries', icon: '🍒', pickup: true });
                                    } else if (biome === 'PLAINS' || biome === 'DESERT') {
                                        if (seededRandom() < 0.18 * worldConfig.resMult) resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'flint', icon: '🔷', pickup: true });
                                        if (seededRandom() < 0.035 * worldConfig.foodMult) resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'carrots', icon: '🥕', pickup: true });
                                        if (seededRandom() < 0.01 * worldConfig.wildlifeMult) mobs.push({ x: x * cellSize, y: y * cellSize, emoji: '🐘', tx: x * cellSize, ty: y * cellSize, hp: 100, maxHp: 100 });
                                    } else if (biome === 'FOREST' || biome === 'SNOW') {
                                        if (seededRandom() < 0.22) resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'twigs', icon: '🥢', pickup: true });
                                        if (seededRandom() < 0.18) resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'acorn', icon: '🌰', pickup: true });
                                        if (seededRandom() < 0.12 * worldConfig.foodMult) resourceNodes.push({ x: x * cellSize, y: y * cellSize, type: 'berries', icon: '🍒', pickup: true });
                                    }
                                }
                            }
                            generationState.yTracker++;
                        }
                        if (generationState.yTracker >= ROWS) generationState.stepIndex = 6;
                        break;
                    case 6: { // Ruins
                const ruinsV2 = generationState.genVersion >= 2;
                const ruinAreaScale = (COLS * ROWS) / (520 * 520);
                const ruinTarget = ruinsV2 ? Math.round(12 * Math.max(0, Number(worldConfig.ruinsMult ?? 1)) * ruinAreaScale) : 12;
                const ruinAttempts = ruinsV2 ? ruinTarget * 30 + 30 : 12;
                let ruinsPlaced = 0;
                for (let attempt = 0; attempt < ruinAttempts; attempt++) {
                    if (ruinsV2 && ruinsPlaced >= ruinTarget) break;
                    const x = Math.floor(seededRandom() * (COLS - 8)) + 4;
                    const y = Math.floor(seededRandom() * (ROWS - 8)) + 4;
                    if (!worldGrid[y] || !['PLAINS', 'DESERT', 'FOREST'].includes(worldGrid[y][x]) || c.isBarrenZone(x, y)) continue;
                    const walls = [[-1, -1], [0, -1], [1, -1], [-1, 1], [-1, 0]];
                    walls.forEach(([ox, oy]) => buildings.push({ x: (x + ox) * cellSize, y: (y + oy) * cellSize, type: 'wall', hp: 500, maxHp: 500 }));
                    ruinsPlaced++;
                    if (seededRandom() < (ruinsV2 ? 0.8 : 0.7)) {
                        const inventory = Array.from({ length: 10 }, () => ({ type: null, count: 0 }));
                        if (ruinsV2) {
                            rollRuinLoot(seededRandom).forEach((slot, index) => { inventory[index] = slot; });
                        } else {
                            const loot = [['wood', 4], ['stone', 3], ['flint', 2], ['twigs', 3], ['berries', 2]];
                            loot.slice(0, 2 + Math.floor(seededRandom() * 3)).forEach(([type, count], index) => { inventory[index] = { type, count }; });
                        }
                        buildings.push({ x: x * cellSize, y: y * cellSize, type: 'chest', hp: 400, maxHp: 400, inventory });
                    }
                }
                generationState.stepIndex = 7;
                break;
            }
            case 7: // Cave layer
                        if (!generationState.fromSave) generateSoloCaves();
                        else if (worldConfig.cavesEnabled && !caveLayerLocal) generateSoloCaves();
                        generationState.stepIndex = 8;
                        break;
            case 8: // Done
                        if (generationState.fromSave) { generationState.active = false; finishLoadFromSave(); break; }
                        const spawn = findNearestLandSpawn();
                        player.x = spawn.x;
                        player.y = spawn.y;
                        player.inBoat = false;
                        player.boatId = null;
                        placementMouse = { x: player.x, y: player.y };
                        currentLayer = 'surface';
                        surfaceLayerLocal = null;
                        generationState.active = false;
                        currentState = 'GAME';
                        startGameUI();
                        saveGame(false, true);
                        break;
                } // This closes the switch statement

                if (generationState.active) {
                    requestAnimationFrame(executeGenerationStep);
                }
            } catch (err) {
                generationState.active = false;
                const generationScreen = document.getElementById('generation-screen');
                if (generationScreen) generationScreen.style.display = 'none';
                alert(`🚨 MAP GENERATOR CRASHED!\n\nStep Index: ${generationState?.stepIndex}\nRow Tracker: ${generationState?.yTracker}\nError Details: ${err.message}`);
            }
        }
