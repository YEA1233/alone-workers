        function sendWorldAction(type, payload = {}) {
            if (!isOnlineActive()) return false;
            gameSocket.send(JSON.stringify({ type: 'world:action', playerId: onlinePlayerId, action: { type, payload } }));
            return true;
        }
        function setConnectionStatus(message, color = '#888') {
            const status = document.getElementById('connection-status');
            if (status) { status.innerText = message; status.style.color = color; }
        }
        // Metadata config mapping default configuration boundaries
        const SETTING_METADATA = {
            'res': { min: 0.2, max: 3.0, step: 0.2, def: 1.0 },
            'food': { min: 0.2, max: 3.0, step: 0.2, def: 1.0 },
            'day': { min: 0.5, max: 4.0, step: 0.5, def: 1.0 },
            'night': { min: 0.5, max: 4.0, step: 0.5, def: 1.0 },
            'hunger': { min: 0.2, max: 2.0, step: 0.2, def: 1.0 },
            'world-size': { min: 0.75, max: 2.0, step: 0.25, def: 1.0 },
            'ocean': { min: 0.5, max: 1.4, step: 0.1, def: 1.0 },
            'forest': { min: 0.2, max: 2.5, step: 0.1, def: 1.0 },
            'mountain': { min: 0.2, max: 2.5, step: 0.1, def: 1.0 },
            'wildlife': { min: 0, max: 3, step: 0.25, def: 1.0 },
            'ruins': { min: 0, max: 3, step: 0.25, def: 1.0 },
            'winter-days': { min: 0, max: 30, step: 1, def: 8 },
            'mild-days': { min: 0, max: 30, step: 1, def: 8 }
        };

        function toggleLimitOverride() {
            const checkbox = document.getElementById('set-override-limits');
            if (document.getElementById('world-type').value !== 'solo') checkbox.checked = false;
            const isOverridden = checkbox.checked;
            document.getElementById('override-warning').style.display = isOverridden ? 'block' : 'none';

            document.querySelectorAll('.setting-item[data-setting]').forEach(item => {
                const key = item.getAttribute('data-setting');
                const container = item.querySelector('.input-control');
                const oldInput = container.querySelector('input');
                const currentValue = oldInput ? oldInput.value : SETTING_METADATA[key].def;

                container.innerHTML = ''; // Wipe out existing control

                const newInput = document.createElement('input');
                newInput.id = `set-${key}`;
                newInput.value = currentValue;

                if (isOverridden) {
                    // Transform into an unrestricted custom numeric text box
                    newInput.type = 'number';
                    newInput.step = 'any';
                    newInput.style.cssText = "background:#000; color:#ff4444; border:1px solid #ff4444; padding:4px; width:80px; text-align:center; font-family:monospace;";
                } else {
                    // Restore standard restricted ranges safely
                    newInput.type = 'range';
                    newInput.min = SETTING_METADATA[key].min;
                    newInput.max = SETTING_METADATA[key].max;
                    newInput.step = SETTING_METADATA[key].step;

                    // Re-bind default sanitization boundaries if text input values exceed range bounds
                    if (Number(currentValue) > SETTING_METADATA[key].max) newInput.value = SETTING_METADATA[key].max;
                    if (Number(currentValue) < SETTING_METADATA[key].min) newInput.value = SETTING_METADATA[key].min;
                }

                container.appendChild(newInput);
            });
        }

        function updateOverrideAvailability() {
            const checkbox = document.getElementById('set-override-limits');
            if (!checkbox) return;
            const multiplayer = document.getElementById('world-type').value !== 'solo';
            checkbox.disabled = multiplayer;
            if (multiplayer && checkbox.checked) {
                checkbox.checked = false;
                toggleLimitOverride();
            } else {
                const warning = document.getElementById('override-warning');
                if (warning) warning.textContent = multiplayer
                    ? 'Slider limit overrides are only available for solo worlds.'
                    : '⚠️ WARNING: Removing safety constraints allows ultra-high/low inputs. This can crash your browser, cause intense lag, or break map generation logic. Proceed with caution.';
            }
        }

function saveAchievementData() {
    try {
        localStorage.setItem(achievementStorageKey, JSON.stringify(achievementData));
    } catch (error) {
        console.error('Could not save achievements:', error);
    }
}

function areAchievementsDisabled() {
    return worldAchievementsDisabled || achievementData.adminConsoleUsed ||
        (activeAchievementWorldKey && achievementData.disabledWorlds.includes(activeAchievementWorldKey));
}

function setAchievementWorld(kind, id, disabled = false) {
    activeAchievementWorldKey = id ? `${kind}:${id}` : '';
    worldAchievementsDisabled = !!disabled ||
        !!worldConfig.creative ||
        (activeAchievementWorldKey && achievementData.disabledWorlds.includes(activeAchievementWorldKey));
    if (worldAchievementsDisabled && activeAchievementWorldKey &&
        !achievementData.disabledWorlds.includes(activeAchievementWorldKey)) {
        achievementData.disabledWorlds.push(activeAchievementWorldKey);
        saveAchievementData();
    }
    renderAchievements();
}

function disableAchievementsForWorld(reason, notifyServer = true) {
    worldAchievementsDisabled = true;
    if (activeAchievementWorldKey) {
        if (!achievementData.disabledWorlds.includes(activeAchievementWorldKey)) {
            achievementData.disabledWorlds.push(activeAchievementWorldKey);
            saveAchievementData();
        }
    } else if (!achievementData.adminConsoleUsed) {
        achievementData.adminConsoleUsed = true;
        saveAchievementData();
    }
    renderAchievements();
    if (notifyServer && isOnlineActive()) {
        gameSocket.send(JSON.stringify({ type: 'achievement:disable', reason }));
    }
}

function unlockAchievement(id) {
    if (areAchievementsDisabled()) return;
    if (achievementData.unlocked.includes(id)) return;
    const achievement = ACHIEVEMENTS.find(item => item.id === id);
    if (!achievement) return;
    achievementData.unlocked.push(id);
    saveAchievementData();
    renderAchievements();
    renderEmojiPicker();
    if (achievementReturnScreen?.id === 'achievements-screen') renderAchievements();
    showRewardBurst(
        '🏆',
        `ACHIEVEMENT UNLOCKED · ${achievement.name}${achievement.emoji ? ` · ${achievement.emoji} unlocked` : ''}`,
        '#ffd700',
        'rgba(255, 215, 0, 0.7)'
    );
}

function recordPlayerDeath() {
    if (areAchievementsDisabled()) return;
    achievementData.deaths += 1;
    saveAchievementData();
    unlockAchievement('first-death');
    if (achievementData.deaths >= 100) unlockAchievement('deaths-100');
    renderAchievements();
}

function checkSurvivalAchievements(days) {
    if (areAchievementsDisabled() || !Number.isFinite(days)) return;
    if (days >= 2) unlockAchievement('first-night');
    if (days >= 5) unlockAchievement('day-five');
    if (days >= 20) unlockAchievement('day-twenty');
}

function updatePlayerEmojiButton() {
    const button = document.getElementById('play-emoji');
    if (!button) return;
    if (!isEmojiUnlocked(player.emoji)) player.emoji = FREE_PLAYER_EMOJIS[0];
    button.textContent = player.emoji;
    button.dataset.emoji = player.emoji;
}

function renderAchievements() {
    const list = document.getElementById('achievement-list');
    const summary = document.getElementById('achievement-summary');
    if (!list || !summary) return;
    list.replaceChildren();
    const unlockedCount = achievementData.unlocked.length;
    summary.textContent = areAchievementsDisabled()
        ? `Achievements disabled in this world because cheats are on or the admin console was used. · ${unlockedCount} / ${ACHIEVEMENTS.length} already unlocked`
        : `${unlockedCount} / ${ACHIEVEMENTS.length} unlocked · Deaths: ${achievementData.deaths}`;
    for (const achievement of ACHIEVEMENTS) {
        const unlocked = achievementData.unlocked.includes(achievement.id);
        const card = document.createElement('article');
        card.className = `achievement-card${unlocked ? '' : ' locked'}`;
        const icon = document.createElement('span');
        icon.className = 'achievement-icon';
        icon.textContent = achievement.emoji || '🏅';
        const copy = document.createElement('span');
        copy.className = 'achievement-copy';
        const title = document.createElement('strong');
        title.textContent = achievement.name;
        const detail = document.createElement('small');
        detail.textContent = `${achievement.description} ${unlocked ? 'UNLOCKED' : 'LOCKED'}${achievement.id === 'deaths-100' ? ` · ${Math.min(achievementData.deaths, 100)}/100 deaths` : ''}`;
        copy.append(title, detail);
        card.append(icon, copy);
        list.appendChild(card);
    }
}

function renderEmojiPicker() {
    const grid = document.getElementById('emoji-grid');
    if (!grid) return;
    grid.replaceChildren();
    for (const emoji of PLAYER_EMOJIS) {
        const unlocked = isEmojiUnlocked(emoji);
        const option = document.createElement('button');
        option.type = 'button';
        option.className = `emoji-option${unlocked ? '' : ' locked'}${player.emoji === emoji ? ' selected' : ''}`;
        option.disabled = !unlocked;
        option.setAttribute('aria-label', unlocked ? `Choose ${emoji}` : `Locked character ${emoji}`);
        const icon = document.createElement('span');
        icon.className = 'emoji-icon';
        icon.textContent = emoji;
        option.appendChild(icon);
        if (!unlocked) {
            const lock = document.createElement('span');
            lock.className = 'emoji-lock';
            lock.textContent = 'LOCKED';
            option.appendChild(lock);
        } else {
            option.addEventListener('click', () => {
                player.emoji = emoji;
                updatePlayerEmojiButton();
                try {
                    localStorage.setItem(`alone_player_emoji_${onlinePlayerId}`, emoji);
                } catch (error) {
                    console.error('Could not save selected character:', error);
                }
                hideEmojiPicker();
            });
        }
        grid.appendChild(option);
    }
}

function showEmojiPicker() {
    renderEmojiPicker();
    document.getElementById('emoji-picker').style.display = 'flex';
}

function hideEmojiPicker() {
    document.getElementById('emoji-picker').style.display = 'none';
}

function showAchievements() {
    achievementReturnScreen = [...document.querySelectorAll('.screen')]
        .find(screen => getComputedStyle(screen).display !== 'none') || document.getElementById('main-menu');
    document.querySelectorAll('.screen').forEach(screen => { screen.style.display = 'none'; });
    hideEmojiPicker();
    renderAchievements();
    document.getElementById('achievements-screen').style.display = 'flex';
}

function hideAchievements() {
    document.getElementById('achievements-screen').style.display = 'none';
    const returnScreen = achievementReturnScreen || document.getElementById('main-menu');
    returnScreen.style.display = 'flex';
    achievementReturnScreen = null;
}

function connectToGameServer() {
            if (gameSocket) {
                try {
                    gameSocket.close();
                } catch { }
            }

            const room =
                encodeURIComponent(
                    onlineRoom || 'public'
                );

            setConnectionStatus(
                'CONNECTING...',
                '#ffcc00'
            );

            try {
                gameSocket =
                    new WebSocket(
                        `${GAME_SERVER_URL}?room=${room}`
                    );
            } catch (error) {
                console.error(
                    'WebSocket creation failed:',
                    error
                );

                setConnectionStatus(
                    'OFFLINE MODE',
                    '#ff4444'
                );

                return;
            }

            gameSocket.onopen = () => {

                setConnectionStatus(
                    'CONNECTED',
                    '#2ecc71'
                );

                /*
                 * IMPORTANT:
                 *
                 * Send the COMPLETE 28-character seed.
                 * Never send numeric worldSeed here.
                 */
                gameSocket.send(
                    JSON.stringify({
                        type: 'join',

                token: onlinePlayerToken,

                        roomId:
                            onlineRoom ||
                            'public',

                        roomName:
                            onlineRoom || '',

                        visibility:
                            pendingVisibility ||
                            'public',

                        playerId:
                            onlinePlayerId,

                        seed:
                            currentWorldSeed,

                        worldConfig: {
                            resMult:
                                worldConfig.resMult,

                            foodMult:
                                worldConfig.foodMult,

                            dayMult:
                                worldConfig.dayMult,

                            nightMult:
                                worldConfig.nightMult,

                            hungerMult:
                                worldConfig.hungerMult,

                            worldSizeMult:
                                worldConfig.worldSizeMult,

                            mapPreset:
                                worldConfig.mapPreset,

                            oceanMult:
                                worldConfig.oceanMult,

                            forestMult:
                                worldConfig.forestMult,

                            mountainMult:
                                worldConfig.mountainMult,

                            wildlifeMult:
                                worldConfig.wildlifeMult,

                            winterLengthDays:
                                worldConfig.winterLengthDays,

                            mildLengthDays:
                                worldConfig.mildLengthDays,

                            creative:
                                !!worldConfig.creative,

                            firstPerson3D:
                                !!(worldConfig.firstPerson3D ?? worldConfig.thirdPerson3D)
                        },

                        player: {
                            x:
                                player.x,

                            y:
                                player.y,

                            hp:
                                player.hp,

                            hunger:
                                player.hunger,

                            emoji:
                                player.emoji,

                            color:
                                player.color,

                            name:
                                onlineName,

                            inventory:
                                Array.isArray(
                                    player.inventory
                                )
                                    ? player.inventory.map(
                                        slot => ({
                                            type:
                                                slot?.type ||
                                                null,

                                            count:
                                                Number(
                                                    slot?.count
                                                ) || 0,
                                            thermalTemp:
                                                Number(slot?.thermalTemp) || 0
                                        })
                                    )
                                    : [],

                            firstPerson3D:
                                !!(worldConfig.firstPerson3D ?? worldConfig.thirdPerson3D),

                            yaw:
                                firstPersonYaw,

                            inBoat:
                                !!player.inBoat,

                            boatId:
                                player.boatId ||
                                null
                        }
                    })
                );
            };


            gameSocket.onmessage = event => {

                let message;

                try {
                    message =
                        JSON.parse(
                            event.data
                        );
                } catch (error) {
                    console.error(
                        'Invalid server message:',
                        event.data
                    );
                    return;
                }

                if (message.type === 'world:activity') {
                    if (message.activity === 'work') noteMusicActivity('work');
                    else if (message.activity === 'greg-victory') playGregVictoryMusic();
                    return;
                }

                if (message.type === 'achievement:event') {
                    if (typeof message.id === 'string') unlockAchievement(message.id);
                    return;
                }

                if (message.type === 'player:died') {
                    recordPlayerDeath();
                    return;
                }

                if (message.type === 'achievements:disabled') {
                    setAchievementWorld('online', onlineRoom, true);
                    return;
                }

                // =====================================================
                // ROOM INITIALIZATION
                // =====================================================

                if (
                    message.type ===
                    'room:init'
                ) {
                    consoleIsOp = !!message.isOp;
                    isRoomOwner = !!message.isOwner;

                    console.log(
                        'MULTIPLAYER ROOM INIT:',
                        message
                    );

                    /*
                     * The server is authoritative.
                     *
                     * Use its seed as a STRING.
                     */
                    if (
                        typeof message.seed ===
                        'string'
                    ) {

                        currentWorldSeed =
                            message.seed
                                .toUpperCase()
                                .replace(
                                    /[^A-Z0-9]/g,
                                    ''
                                );

                        console.log(
                            'SERVER WORLD SEED:',
                            formatWorldSeed(
                                currentWorldSeed
                            )
                        );
                    }

                    // -------------------------------------------------
                    // World configuration
                    // -------------------------------------------------

                    if (
                        message.worldConfig
                    ) {

                        worldConfig = {
                            ...worldConfig,
                            ...message.worldConfig
                        };
                    }
                    setAchievementWorld(
                        'online',
                        message.roomId || onlineRoom,
                        !!message.achievementsDisabled || !!message.worldConfig?.creative
                    );
                    if (isRoomOwner && Number(message.playerCount) >= 3) unlockAchievement('host-three');

                    // -------------------------------------------------
                    // Dimensions
                    // -------------------------------------------------

                    if (
                        message.world
                    ) {

                        const world =
                            message.world;
                        syncClientSeason(world.season, world.seasonDaysRemaining);
                        if (typeof world.gregDefeated === 'boolean') gregDefeated = world.gregDefeated;
                        currentLayer = world.layer === 'caves' ? 'caves' : 'surface';
                        gregArenaOnline = world.gregArena || null;
                        if (typeof world.gregArenaLocked === 'boolean') gregArenaLocked = world.gregArenaLocked;

                        if (
                            Number.isFinite(
                                world.rows
                            )
                        ) {
                            ROWS =
                                world.rows;
                        }

                        if (
                            Number.isFinite(
                                world.cols
                            )
                        ) {
                            COLS =
                                world.cols;
                        }

                        if (
                            Number.isFinite(
                                world.width
                            )
                        ) {
                            worldWidth =
                                world.width;
                        }

                        if (
                            Number.isFinite(
                                world.height
                            )
                        ) {
                            worldHeight =
                                world.height;
                        }

                        // -------------------------------------------------
                        // Decode authoritative terrain
                        // -------------------------------------------------

                        if (
                            Array.isArray(
                                world.terrain
                            )
                        ) {

                            worldGrid =
                                world.terrain.map(
                                    row =>
                                        String(row)
                                            .split(',')
                                );

                            mapTerrainDirty =
                                true;
                        }

                        // -------------------------------------------------
                        // Resources
                        // -------------------------------------------------

                        restoreWorldDiscovery(world);
                        mapTerrainCanvas.width = COLS;
                        mapTerrainCanvas.height = ROWS;
                        mapTerrainDirty = true;

                        if (
                            Array.isArray(
                                world.resourceNodes
                            )
                        ) {

                            resourceNodes =
                                world.resourceNodes.map(
                                    node => ({
                                        ...node
                                    })
                                );
                        }

                        // -------------------------------------------------
                        // Wildlife
                        // -------------------------------------------------

                        if (
                            Array.isArray(
                                world.mobs
                            )
                        ) {

                            mobs =
                                world.mobs.map(
                                    mob => ({
                                        ...mob
                                    })
                                );
                        }

                        // -------------------------------------------------
                        // Buildings
                        // -------------------------------------------------

                        if (
                            Array.isArray(
                                world.buildings
                            )
                        ) {

                            buildings =
                                world.buildings.map(
                                    building => ({
                                        ...building,

                                        inventory:
                                            Array.isArray(
                                                building.inventory
                                            )
                                                ? building.inventory.map(
                                                    slot => ({
                                                        ...slot
                                                    })
                                                )
                                                : building.inventory
                                    })
                                );
                        }
                    }

                    // -------------------------------------------------
                    // Player ID
                    // -------------------------------------------------

                    if (
                        message.playerId
                    ) {

                        onlinePlayerId =
                            message.playerId;
                    }

                    // -------------------------------------------------
                    // Other players
                    // -------------------------------------------------

                    remotePlayers = {};
                    const me = Array.isArray(message.players) ? message.players.find(p => p && p.id === onlinePlayerId) : null;
                    if (me) {
                        player.x = me.x; player.y = me.y; player.serverX = me.x; player.serverY = me.y;
                        setFirstPersonMode(!!me.firstPerson3D);
                        if (Number.isFinite(me.yaw)) firstPersonYaw = me.yaw;
                    } else {
                        setFirstPersonMode(!!(worldConfig.firstPerson3D ?? worldConfig.thirdPerson3D));
                    }

                    if (
                        Array.isArray(
                            message.players
                        )
                    ) {

                        for (
                            const remote
                            of message.players
                        ) {

                            if (
                                !remote ||
                                !remote.id ||
                                remote.id ===
                                onlinePlayerId
                            ) {
                                continue;
                            }

                            updateRemotePlayer(
                                remote.id,
                                remote
                            );
                        }
                    }

                    // -------------------------------------------------
                    // Refresh terrain canvas
                    // -------------------------------------------------

                    mapTerrainDirty =
                        true;

                    /*
                     * DO NOT call generateOrganicMap()
                     * here.
                     *
                     * The server already generated
                     * the authoritative world.
                     */

                    currentState =
                        'GAME';

                    startGameUI();
                    if (pendingWorldImport) {
                        try {
                            sendWorldSaveImport(pendingWorldImport);
                        } catch (error) {
                            pendingWorldImport = null;
                            displayChat({ name: 'SYSTEM', text: `Saved world import failed: ${error.message}`, color: '#ff4444' });
                        }
                    }

                    return;
                }

                if (message.type === 'world:reset') {
                    currentWorldSeed = String(message.seed || '').toUpperCase();
                    if (message.worldConfig) worldConfig = { ...worldConfig, ...message.worldConfig };
                    setAchievementWorld('online', onlineRoom, !!message.achievementsDisabled || !!message.worldConfig?.creative);
                    const world = message.world || {};
                    syncClientSeason(message.season ?? world.season, message.seasonDaysRemaining ?? world.seasonDaysRemaining);
                    if (typeof world.gregDefeated === 'boolean') gregDefeated = world.gregDefeated;
                    currentLayer = world.layer === 'caves' ? 'caves' : 'surface';
                    gregArenaOnline = world.gregArena || null;
                    gregArenaLocked = !!world.gregArenaLocked;
                    if (Number.isFinite(world.rows)) ROWS = world.rows;
                    if (Number.isFinite(world.cols)) COLS = world.cols;
                    if (Number.isFinite(world.width)) worldWidth = world.width;
                    if (Number.isFinite(world.height)) worldHeight = world.height;
                    worldGrid = Array.isArray(world.terrain)
                        ? world.terrain.map(row => String(row).split(','))
                        : [];
                    resourceNodes = Array.isArray(world.resourceNodes) ? world.resourceNodes.map(node => ({ ...node })) : [];
                    mobs = Array.isArray(world.mobs) ? world.mobs.map(mob => ({ ...mob })) : [];
                    buildings = Array.isArray(world.buildings) ? world.buildings.map(building => ({ ...building })) : [];
                    restoreWorldDiscovery(world);
                    mapTerrainCanvas.width = COLS;
                    mapTerrainCanvas.height = ROWS;
                    mapTerrainDirty = true;
                    dayCount = Number(message.dayCount) || 1;
                    gameTime = Number(message.gameTime) || 0;
                    currentPhase = 'DAY';
                    phaseTimeLeft = CYCLE.DAY.length;
                    wolfWaveSpawned = false;
                    player.x = worldWidth / 2;
                    player.y = worldHeight / 2;
                    if (Number.isFinite(player.serverX) && Number.isFinite(player.serverY)) {
                        player.x = player.serverX;
                        player.y = player.serverY;
                    }
                    player.serverX = player.x;
                    player.serverY = player.y;
                    autoTask = null;
                    autoPath = null;
                    renderInventory();
                    writeAdminConsole(message.reason === 'import'
                        ? 'The owner imported a saved world.'
                        : 'The server regenerated the world and reset player states.');
                    return;
                }

                if (message.type === 'world:layer') {
                    const world = message.world;
                    if (!world || !Array.isArray(world.terrain)) return;
                    if (typeof world.gregDefeated === 'boolean') gregDefeated = world.gregDefeated;
                    if (message.layer === 'caves' && currentLayer !== 'caves') {
                        unlockAchievement('caves');
                        triggerPlayerThought('cave');
                    }
                    currentLayer = message.layer === 'caves' ? 'caves' : 'surface';
                    gregArenaOnline = world.gregArena || null;
                    gregArenaLocked = !!world.gregArenaLocked;
                    worldGrid = world.terrain.map(row => String(row).split(','));
                    ROWS = Number(world.rows) || worldGrid.length;
                    COLS = Number(world.cols) || worldGrid[0]?.length || COLS;
                    worldWidth = Number(world.width) || COLS * cellSize;
                    worldHeight = Number(world.height) || ROWS * cellSize;
                    resourceNodes = Array.isArray(world.resourceNodes) ? world.resourceNodes.map(node => ({ ...node })) : [];
                    mobs = Array.isArray(world.mobs) ? world.mobs.map(mob => ({ ...mob })) : [];
                    buildings = Array.isArray(world.buildings) ? world.buildings.map(building => ({ ...building })) : [];
                    restoreWorldDiscovery(world);
                    player.x = Number(message.x) || 0;
                    player.y = Number(message.y) || 0;
                    player.serverX = player.x;
                    player.serverY = player.y;
                    player.inBoat = false;
                    player.boatId = null;
                    remotePlayers = {};
                    autoTask = null;
                    autoPath = null;
                    stopMovement();
                    mapTerrainCanvas.width = COLS;
                    mapTerrainCanvas.height = ROWS;
                    mapTerrainDirty = true;
                    return;
                }

                if (message.type === 'map:tiles') {
                    if (message.layer !== currentLayer || !Array.isArray(message.tiles)) return;
                    for (const index of message.tiles) {
                        if (Number.isInteger(index) && index >= 0 && index < discoveredGrid.length) discoveredGrid[index] = 1;
                    }
                    mapTerrainDirty = true;
                    if (isMapOpen) drawWorldMap();
                    return;
                }

                if (message.type === 'admin:result') {
                    writeAdminConsole(message.text || '');
                    return;
                }

                if (message.type === 'creative:result') {
                    cpStatus(message.text || '');
                    return;
                }

                if (message.type === 'creative:reveal') {
                    discoveredGrid.fill(1);
                    mapTerrainDirty = true;
                    cpStatus('Minimap revealed.');
                    return;
                }

                if (message.type === 'world:save:error') {
                    if (pendingWorldExport) {
                        clearTimeout(pendingWorldExport.timeout);
                        pendingWorldExport.reject(new Error(message.message || 'World save transfer failed.'));
                        pendingWorldExport = null;
                        pendingWorldExportId = null;
                    }
                    pendingWorldImport = null;
                    displayChat({ name: 'SYSTEM', text: message.message || 'World save transfer failed.', color: '#ff4444' });
                    return;
                }

                if (message.type === 'world:save:export_start') {
                    if (!pendingWorldExport || typeof message.transferId !== 'string' ||
                        !Number.isInteger(message.total) || message.total < 1 || message.total > 400) return;
                    pendingWorldExportId = message.transferId;
                    pendingWorldExport.chunks = Array(message.total);
                    return;
                }

                if (message.type === 'world:save:export_chunk') {
                    if (!pendingWorldExport || message.transferId !== pendingWorldExportId ||
                        !Number.isInteger(message.index) || message.index < 0 ||
                        message.index >= pendingWorldExport.chunks.length || typeof message.chunk !== 'string') return;
                    pendingWorldExport.chunks[message.index] = message.chunk;
                    return;
                }

                if (message.type === 'world:save:export_end') {
                    if (!pendingWorldExport || message.transferId !== pendingWorldExportId) return;
                    try {
                        if (pendingWorldExport.chunks.some(chunk => typeof chunk !== 'string')) throw new Error('World save transfer was incomplete.');
                        const save = JSON.parse(pendingWorldExport.chunks.join(''));
                        const blankDiscovery = encodeBytes(new Uint8Array(COLS * ROWS));
                        save.slotId = activeSaveSlotId;
                        save.slotName = activeSaveSlotName;
                        save.gameType = 'multiplayer';
                        save.discoveredGrid = blankDiscovery;
                        if (save.surfaceLayer) save.surfaceLayer.discoveredGrid = blankDiscovery;
                        if (save.caves) save.caves.discoveredGrid = blankDiscovery;
                        const activeWorld = save.currentLayer === 'caves' ? save.caves : save.surfaceLayer;
                        if (!activeWorld) throw new Error('The server did not include the active world layer.');
                        save.resourceNodes = activeWorld.resourceNodes;
                        save.buildings = activeWorld.buildings;
                        save.mobs = activeWorld.mobs;
                        pendingWorldExport.resolve(save);
                    } catch (error) {
                        pendingWorldExport.reject(error);
                    } finally {
                        clearTimeout(pendingWorldExport.timeout);
                        pendingWorldExport = null;
                        pendingWorldExportId = null;
                    }
                    return;
                }

                if (message.type === 'world:save:imported') {
                    pendingWorldImport = null;
                    displayChat({ name: 'SYSTEM', text: message.message || 'Saved world imported.', color: '#2ecc71' });
                    return;
                }

                if (message.type === 'admin:status') {
                    consoleIsOp = !!message.isOp;
                    if (consoleIsOp) writeAdminConsole('Admin permissions updated.');
                    return;
                }

                // =====================================================
                // WORLD STATE
                // =====================================================

                if (
                    message.type ===
                    'world:state'
                ) {
                    if (message.season === 'mild' || message.season === 'winter') {
                        syncClientSeason(message.season, message.seasonDaysRemaining);
                    }
                    if (typeof message.gregDefeated === 'boolean') gregDefeated = message.gregDefeated;
                    if (typeof message.gregArenaLocked === 'boolean') gregArenaLocked = message.gregArenaLocked;
                    if (message.achievementsDisabled) setAchievementWorld('online', onlineRoom, true);

                    if (
                        typeof message.seed ===
                        'string'
                    ) {

                        currentWorldSeed =
                            message.seed
                                .toUpperCase()
                                .replace(
                                    /[^A-Z0-9]/g,
                                    ''
                                );
                    }

                    if (
                        message.worldConfig
                    ) {

                        worldConfig = {
                            ...worldConfig,
                            ...message.worldConfig
                        };
                    }

                    if (
                        Number.isFinite(
                            message.dayCount
                        )
                    ) {
                        dayCount =
                            message.dayCount;
                        checkSurvivalAchievements(dayCount);
                    }
                    if (isRoomOwner && Number(message.playerCount) >= 3) unlockAchievement('host-three');

                    if (
                        Number.isFinite(
                            message.gameTime
                        )
                    ) {
                        gameTime =
                            message.gameTime;
                    }
                    if (typeof message.phase === 'string' && CYCLE[message.phase]) {
                        currentPhase = message.phase;
                        phaseTimeLeft = Math.round((Number(message.phaseTimeLeft) || 0) * 60);
                    }
                    if (typeof message.creativeFreezeTime === 'boolean') {
                        creativeFreezeTime = message.creativeFreezeTime;
                        const freezeControl = document.getElementById('cp-freeze');
                        if (freezeControl) freezeControl.checked = creativeFreezeTime;
                    }

                    // -------------------------------------------------
                    // Players
                    // -------------------------------------------------

                    if (
                        Array.isArray(
                            message.players
                        )
                    ) {

                        const seen =
                            new Set();

                        for (
                            const remote
                            of message.players
                        ) {

                            if (
                                !remote ||
                                !remote.id
                            ) {
                                continue;
                            }

                            if (
                                remote.id ===
                                onlinePlayerId
                            ) {
                                if (typeof remote.firstPerson3D === 'boolean') setFirstPersonMode(remote.firstPerson3D);

                                /*
                                 * Do not overwrite local
                                 * rendering state with the
                                 * server snapshot.
                                 *
                                 * Keep authoritative values
                                 * that matter.
                                 */
                                if (
                                    Number.isFinite(
                                        remote.hp
                                    )
                                ) {
                                    player.hp =
                                        remote.hp;
                                }

                                if (
                                    Number.isFinite(
                                        remote.hunger
                                    )
                                ) {
                                    player.hunger =
                                        remote.hunger;
                                }
                                if (Number.isFinite(remote.bodyHeat)) player.bodyHeat = remote.bodyHeat;
                                if (Object.hasOwn(remote, 'shield')) {
                                    player.shield = normalizeShieldData(remote.shield);
                                    renderShieldSlot();
                                }
                                if (Number.isFinite(remote.x) && Number.isFinite(remote.y)) { player.serverX = remote.x; player.serverY = remote.y; }
                                if (typeof remote.inBoat === 'boolean') player.inBoat = remote.inBoat;
                                player.boatId = remote.boatId || null;
                                continue;
                            }

                            seen.add(
                                remote.id
                            );

                            updateRemotePlayer(
                                remote.id,
                                remote
                            );
                        }

                        for (
                            const id
                            of Object.keys(
                                remotePlayers
                            )
                        ) {

                            if (
                                !seen.has(id)
                            ) {
                                delete remotePlayers[id];
                            }
                        }
                    }

                    // -------------------------------------------------
                    // World
                    // -------------------------------------------------

                    if (
                        message.world
                    ) {

                        if (
                            Array.isArray(
                                message.world.resourceNodes
                            )
                        ) {
                            resourceNodes =
                                message.world.resourceNodes;
                        }

                        if (
                            Array.isArray(
                                message.world.mobs
                            )
                        ) {
                            mobs =
                                message.world.mobs;
                        }

                        if (
                            Array.isArray(
                                message.world.buildings
                            )
                        ) {
                            buildings =
                                message.world.buildings;
                        }

                    }

                    return;
                }

                if (message.type === 'world:patch') {
                    if (message.buildings) {
                if (message.buildings.del && message.buildings.del.length) {
                    const gone = new Set(message.buildings.del);
                    buildings = buildings.filter(b => !gone.has(b.id));
                }
                for (const b of message.buildings.set || []) {
                    const i = buildings.findIndex(x => x.id === b.id);
                    if (i >= 0) buildings[i] = b; else buildings.push(b);
                }
            }
            const nodes = message.nodes || {};
                    if (nodes.del && nodes.del.length) {
                        const gone = new Set(nodes.del);
                        resourceNodes = resourceNodes.filter(n => !gone.has(n.id));
                    }
                    for (const node of nodes.set || []) {
                        const i = resourceNodes.findIndex(n => n.id === node.id);
                        if (i >= 0) resourceNodes[i] = node; else resourceNodes.push(node);
                    }
                    return;
                }

                if (message.type === 'world:fx') {
                    floatText(Number(message.x) || player.x, Number(message.y) || player.y, String(message.text || ''), message.color || '#ffffff');
                    return;
                }

                if (message.type === 'token:pickup') {
                    if (message.token === 'ivory' || message.token === 'wolf') playTokenPickup(message.token);
                    return;
                }

                if (message.type === 'world:mobs') {
                    if (message.del && message.del.length) {
                        const gone = new Set(message.del);
                        mobs = mobs.filter(m => !gone.has(m.id));
                    }
                    for (const entry of message.set || []) {
                        const existing = mobs.find(m => m.id === entry.id);
                        if (existing) Object.assign(existing, entry);
                        else if (entry.type) mobs.push({ ...entry });
                    }
                    return;
                }
                // =====================================================
                // WORLD UPDATE
                // =====================================================

                if (
                    message.type ===
                    'world:update'
                ) {

                    const world =
                        message.world;

                    if (!world) return;
                    if (typeof world.gregDefeated === 'boolean') gregDefeated = world.gregDefeated;
                    gregArenaOnline = world.gregArena || null;
                    if (typeof world.gregArenaLocked === 'boolean') gregArenaLocked = world.gregArenaLocked;

                    if (
                        Array.isArray(
                            world.resourceNodes
                        )
                    ) {
                        resourceNodes =
                            world.resourceNodes;
                    }

                    if (
                        Array.isArray(
                            world.mobs
                        )
                    ) {
                        mobs =
                            world.mobs;
                    }

                    if (
                        Array.isArray(
                            world.buildings
                        )
                    ) {
                        buildings =
                            world.buildings;
                        syncActiveChest();
                    }

                    mapTerrainDirty =
                        true;

                    return;
                }


                // =====================================================
                // PLAYER UPDATE
                // =====================================================

                if (
                    message.type ===
                    'player:update'
                ) {

                    const id =
                        message.playerId ||
                        message.player?.id;

                    if (!id) return;

                    if (
                        id ===
                        onlinePlayerId
                    ) {

                        if (
                            message.player
                        ) {
                            if (typeof message.player.firstPerson3D === 'boolean') setFirstPersonMode(message.player.firstPerson3D);
                            if (Number.isFinite(message.player.x) && Number.isFinite(message.player.y)) {
                                player.serverX = message.player.x;
                                player.serverY = message.player.y;
                            }

                            if (
                                Number.isFinite(
                                    message.player.hp
                                )
                            ) {
                                player.hp =
                                    message.player.hp;
                            }

                            if (
                                Number.isFinite(
                                    message.player.hunger
                                )
                            ) {
                                player.hunger =
                                    message.player.hunger;
                            }
                            if (Number.isFinite(message.player.bodyHeat)) player.bodyHeat = message.player.bodyHeat;
                            if (Object.hasOwn(message.player, 'shield')) player.shield = normalizeShieldData(message.player.shield);

                            if (
                                Array.isArray(
                                    message.player.inventory
                                )
                            ) {

                                player.inventory =
                                    message.player.inventory.map(
                                        slot => ({
                                            ...slot
                                        })
                                    );

                                renderInventory();
                                renderChestUI();
                            }
                            else if (Object.hasOwn(message.player, 'shield')) renderShieldSlot();

                            if (
                                typeof
                                message.player.inBoat ===
                                'boolean'
                            ) {
                                player.inBoat =
                                    message.player.inBoat;
                            }

                            player.boatId =
                                message.player.boatId ||
                                null;
                            if (typeof message.player.isOp === 'boolean') consoleIsOp = message.player.isOp;
                            if (Number.isFinite(message.player.speedPercent)) consoleSpeedPercent = message.player.speedPercent;
                            if (typeof message.player.creativePanelEnabled === 'boolean') creativePanelEnabled = message.player.creativePanelEnabled;
                            if (typeof message.player.ohkoEnabled === 'boolean') ohkoEnabled = message.player.ohkoEnabled;
                            if (Number.isFinite(message.player.creativeSpeedMult)) creativeSpeedMult = message.player.creativeSpeedMult;
                            if (typeof message.player.creativeNoclip === 'boolean') creativeNoclip = message.player.creativeNoclip;
                            if (typeof message.player.creativeInvulnerable === 'boolean') player.creativeInvulnerable = message.player.creativeInvulnerable;
                            if (typeof message.player.creativeFreezeTime === 'boolean') creativeFreezeTime = message.player.creativeFreezeTime;
                            const noclipControl = document.getElementById('cp-noclip');
                            if (noclipControl) noclipControl.checked = creativeNoclip;
                            const freezeControl = document.getElementById('cp-freeze');
                            if (freezeControl) freezeControl.checked = creativeFreezeTime;
                            const invulnerabilityControl = document.getElementById('cp-invulnerable');
                            if (invulnerabilityControl) invulnerabilityControl.checked = player.creativeInvulnerable;
                            const speedControl = document.getElementById('cp-speed');
                            if (speedControl) speedControl.value = creativeSpeedMult;
                            const speedLabel = document.getElementById('cp-speed-val');
                            if (speedLabel) speedLabel.textContent = `${creativeSpeedMult}x`;
                            updateCreativeButton();
                        }

                        return;
                    }

                    updateRemotePlayer(
                        id,
                        message.player
                    );

                    return;
                }


                // =====================================================
                // PLAYER JOINED
                // =====================================================

                if (
                    message.type ===
                    'player:joined'
                ) {

                    const remote =
                        message.player;

                    if (
                        remote &&
                        remote.id &&
                        remote.id !==
                        onlinePlayerId
                    ) {

                        updateRemotePlayer(
                            remote.id,
                            remote
                        );
                    }

                    return;
                }


                // =====================================================
                // PLAYER LEFT
                // =====================================================

                if (
                    message.type ===
                    'player:left'
                ) {

                    if (
                        message.playerId
                    ) {

                        delete remotePlayers[
                            message.playerId
                        ];
                    }

                    return;
                }


                // =====================================================
                // WORLD ERROR
                // =====================================================

                if (
                    message.type ===
                    'world:error'
                ) {
                    if (autoTask?.kind === 'building') cancelAutoTask();

                    displayChat({
                        name: 'SYSTEM',
                        text:
                            message.message ||
                            'World action rejected.',
                        color: '#ff4444'
                    });

                    return;
                }


                // =====================================================
                // CHAT
                // =====================================================

                if (
                    message.type ===
                    'chat:message'
                ) {

                    displayChat({
                        name:
                            message.name ||
                            'PLAYER',

                        text:
                            message.text ||
                            '',

                        color:
                            message.color ||
                            '#fff'
                    });

                    return;
                }


                // =====================================================
                // ERROR
                // =====================================================

                if (
                    message.type ===
                    'error'
                ) {

                    console.error(
                        'SERVER ERROR:',
                        message.message
                    );

                    displayChat({
                        name: 'SYSTEM',

                        text:
                            message.message ||
                            'Server error.',

                        color: '#ff4444'
                    });
                }
            };


            gameSocket.onerror = error => {

                console.error(
                    'GAME SERVER ERROR:',
                    error
                );

                setConnectionStatus(
                    'SERVER ERROR',
                    '#ff4444'
                );
            };


            gameSocket.onclose = event => {

                console.log(
                    'GAME SERVER CLOSED:',
                    event.code,
                    event.reason
                );

                if (
                    gameSocket &&
                    gameSocket.readyState ===
                    WebSocket.CLOSED
                ) {

                    setConnectionStatus(
                        'DISCONNECTED',
                        '#ff4444'
                    );
                }
            };
        }
