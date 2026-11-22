        function updateRemotePlayer(playerId, playerState) {
            if (playerId === onlinePlayerId || !playerState) return;
            if ((playerState.layer || 'surface') !== currentLayer) {
                delete remotePlayers[playerId];
                return;
            }
            const previous = remotePlayers[playerId];
            remotePlayers[playerId] = { ...playerState, renderX: previous?.renderX ?? playerState.x, renderY: previous?.renderY ?? playerState.y, targetX: playerState.x, targetY: playerState.y };
            if (isMapOpen) drawWorldMap();
        }

        function restoreWorldDiscovery(world) {
            discoveredGrid = world?.discoveredGrid
                ? decodeBytes(world.discoveredGrid, COLS * ROWS)
                : new Uint8Array(COLS * ROWS);
            mapTerrainDirty = true;
        }

        function persistMapView() {
            try {
                localStorage.setItem('alone_world_map_view', JSON.stringify({ zoom: mapZoom, x: mapPan.x, y: mapPan.y }));
            } catch (error) {
                console.warn('Could not save map view settings:', error);
            }
        }

        function disconnectFromGameServer() {
            if (gameSocket?.readyState === WebSocket.OPEN) gameSocket.send(JSON.stringify({ type: 'leave', roomId: onlineRoom, playerId: onlinePlayerId }));
            gameSocket?.close(); gameSocket = null; remotePlayers = {};
        }

        function stopMovement() {
            keys['KeyW'] = keys['ArrowUp'] = keys['KeyS'] = keys['ArrowDown'] =
                keys['KeyA'] = keys['ArrowLeft'] = keys['KeyD'] = keys['ArrowRight'] = false;
            keys['Space'] = keys['KeyF'] = false;
            cancelAutoTask();
        }

        function isAnyOverlayActive() {
            const overlayIds = ['main-menu', 'init-choice', 'world-slots-screen', 'world-settings-screen', 'room-browser-screen', 'tutorial-screen', 'news-screen', 'desktop-options-screen', 'sound-settings-screen', 'build-menu-overlay', 'world-map-overlay', 'pause-screen', 'admin-console'];
            const chestOpen = document.getElementById('chest-menu-overlay')?.style.display === 'flex';
            return chestOpen || overlayIds.some(id => {
                const el = document.getElementById(id);
                return el && (el.style.display === 'flex' || el.style.display === 'block');
            });
        }

        function openSaveDatabase() {
            return new Promise((resolve, reject) => {
                if (!window.indexedDB) return reject(new Error('IndexedDB is unavailable.'));
                const request = indexedDB.open('alone-survival', 2);
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves');
                };
                request.onerror = () => reject(request.error || new Error('Could not open local save storage.'));
                request.onsuccess = () => resolve(request.result);
            });
        }

        async function listLegacyBrowserSaveSlots() {
            const db = await openSaveDatabase();
            return new Promise((resolve, reject) => {
                const store = db.transaction('saves', 'readonly').objectStore('saves');
                const values = store.getAll(), keys = store.getAllKeys();
                let valuesDone = false, keysDone = false;
                const finish = () => {
                    if (!valuesDone || !keysDone) return;
                    const slots = (values.result || []).map((save, index) => save && save.version
                        ? { ...save, slotId: save.slotId || String(keys.result[index]), slotName: save.slotName || 'Legacy world' }
                        : null).filter(Boolean);
                    resolve(slots.sort((a, b) => String(a.slotName).localeCompare(String(b.slotName))));
                };
                values.onsuccess = () => { valuesDone = true; finish(); };
                keys.onsuccess = () => { keysDone = true; finish(); };
                values.onerror = keys.onerror = event => reject(event.target.error || new Error('Could not list saved worlds.'));
            });
        }

        async function listSaveSlots() {
            if (!window.aloneDesktop) return listLegacyBrowserSaveSlots();
            const desktopSlots = await window.aloneDesktop.saves.list();
            if (localStorage.getItem('alone_desktop_idb_migrated') === '1') return desktopSlots;

            const legacySlots = await listLegacyBrowserSaveSlots();
            const desktopIds = new Set(desktopSlots.map(slot => slot.slotId));
            for (const slot of legacySlots) {
                if (desktopIds.has(slot.slotId)) continue;
                const save = await readLegacyBrowserSave(slot.slotId);
                if (save) await window.aloneDesktop.saves.write(slot.slotId, save);
            }
            localStorage.setItem('alone_desktop_idb_migrated', '1');
            return legacySlots.length ? window.aloneDesktop.saves.list() : desktopSlots;
        }

        async function readLegacyBrowserSave(slotId = 'current') {
            const db = await openSaveDatabase();
            return new Promise((resolve, reject) => {
                const request = db.transaction('saves', 'readonly').objectStore('saves').get(slotId);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error || new Error('Could not read saved world.'));
            });
        }

        async function writeSaveData(save, slotId = 'legacy-current') {
            if (window.aloneDesktop) return window.aloneDesktop.saves.write(slotId, save);
            const db = await openSaveDatabase();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction('saves', 'readwrite');
                transaction.objectStore('saves').put(save, slotId);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error || new Error('Could not write saved world.'));
            });
        }

        async function readSaveData(slotId = 'current') {
            if (window.aloneDesktop) return window.aloneDesktop.saves.read(slotId);
            return readLegacyBrowserSave(slotId);
        }

        async function deleteSaveSlot(slotId) {
            if (window.aloneDesktop) return window.aloneDesktop.saves.delete(slotId);
            const db = await openSaveDatabase();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction('saves', 'readwrite');
                transaction.objectStore('saves').delete(slotId);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error || new Error('Could not delete saved world.'));
            });
        }

        async function checkSavedGame() {
            try {
                const slots = await listSaveSlots();
                const loadBtn = document.getElementById('load-save-btn');
                if (loadBtn) loadBtn.style.display = (slots.length || localStorage.getItem('alone_survival_save')) ? 'block' : 'none';
            } catch (error) {
                console.error('Saved world listing failed:', error);
            }
        }

        function init() {
            document.getElementById('game-version-label').textContent = `VERSION ${GAME_VERSION}`;
            resize();
            displayRandomQuote();
            checkSavedGame();
            initializeDesktopOptions().catch(showDesktopOptionsError);
            window.addEventListener('keydown', e => {
                const chatInput = document.getElementById('chat-input');
                const adminConsoleOpen = document.getElementById('admin-console')?.style.display === 'flex';
                if (e.code === 'Backquote') { e.preventDefault(); toggleAdminConsole(); return; }
                if (e.code === 'Escape' && adminConsoleOpen) {
                    toggleAdminConsole();
                    return;
                }
                if (adminConsoleOpen) return;
                if (e.code === 'Escape' && thirdPerson3D && document.pointerLockElement === canvas) {
                    document.exitPointerLock();
                    stopMovement();
                    return;
                }
                if (document.activeElement === chatInput) {
                    // While typing, keys must not move you, open the map, pause, etc.
                    if (e.code === 'Enter') { e.preventDefault(); sendChatMessage(); }
                    else if (e.code === 'Escape') chatInput.blur();
                    return;
                }
                if (e.code === 'Enter' && isOnlineActive() && !isAnyOverlayActive()) { e.preventDefault(); releaseFirstPersonPointerLock(); chatInput.focus(); return; }
                if (e.code === 'Escape' && isPlacing) { cancelPlacement(); return; }
                if (e.code === 'KeyM' && currentState !== 'MENU') { toggleWorldMap(); return; }
                if (e.code.startsWith('Digit') && Number(e.code.slice(5)) >= 1 && Number(e.code.slice(5)) <= 9) { selectHotbar(Number(e.code.slice(5)) - 1); return; }
                if (isAnyOverlayActive()) {
                    if (e.code === 'Escape' && document.getElementById('sound-settings-screen').style.display === 'flex') {
                        closeSoundSettings();
                    } else if (e.code === 'KeyB' && document.getElementById('build-menu-overlay').style.display === 'flex') {
                        closeBuildMenu();
                    } else if ((e.code === 'KeyP' || e.code === 'Escape') && document.getElementById('pause-screen').style.display === 'flex') {
                        resumeGame();
                    }
                    return;
                }

                if (e.code === 'Space' && player.inBoat) {
                    e.preventDefault();
                    if (!e.repeat) requestBoatDisembark();
                    return;
                }

                keys[e.code] = true;
                if (e.code === 'KeyP' || e.code === 'Escape') pauseGame();
                if (e.code === 'KeyB') toggleBuildMenu();
            });
            window.addEventListener('keyup', e => {
                if (document.getElementById('admin-console')?.style.display !== 'flex') keys[e.code] = false;
            });
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    releaseFirstPersonPointerLock();
                    stopMovement();
                    if (gameSocket && gameSocket.readyState === WebSocket.OPEN) {
                        gameSocket.send(JSON.stringify({ type: 'input:update', roomId: onlineRoom, playerId: onlinePlayerId, sequence: ++inputSequence, input: { keys: {} } }));
                    }
                }
            });
            window.addEventListener('wheel', e => { if (!isAnyOverlayActive()) selectHotbar(selectedHotbarIndex + (e.deltaY > 0 ? 1 : -1)); }, { passive: true });
            window.addEventListener('resize', resize);
            window.addEventListener('blur', () => { releaseFirstPersonPointerLock(); stopMovement(); });
            document.addEventListener('pointerlockchange', updateFirstPersonHint);
            document.addEventListener('mousemove', handleFirstPersonMouseLook);
            canvas.addEventListener('mousedown', handleInput);
            canvas.addEventListener('mousemove', updatePlacementMouse);
            canvas.addEventListener('mouseleave', hideItemTooltip);
            worldMapCanvas.addEventListener('pointerdown', startMapDrag);
            worldMapCanvas.addEventListener('pointermove', dragMap);
            worldMapCanvas.addEventListener('pointerup', stopMapDrag);
            worldMapCanvas.addEventListener('pointercancel', stopMapDrag);
            worldMapCanvas.addEventListener('wheel', zoomMapAtCursor, { passive: false });
            canvas.addEventListener('contextmenu', e => { e.preventDefault(); closeBuildMenu(); cancelPlacement(); });
            setupMobile();
            setupCreativePanel();
            document.getElementById('save-file-input').addEventListener('change', handleSaveFile);
            document.getElementById('set-world-seed').addEventListener('input', handleSeedInput);
            const settingsFields = document.getElementById('settings-fields-container');
            settingsFields.addEventListener('input', () => { seedSettingsLocked = false; });
            settingsFields.addEventListener('change', () => { seedSettingsLocked = false; });
            updateOverrideAvailability();
            autosaveTimer = setInterval(() => { if (currentState === 'GAME' || currentState === 'PLAYING') saveGame(false, true); }, 60000);
            renderInventory();
            gameLoop();
        }

        function resetGame() {
            updateDesktopPresence('In the main menu');
            stopMovement();
            disconnectFromGameServer();
            isRoomOwner = false;
            currentState = 'MENU'; isPlacing = false;
            activeAchievementWorldKey = '';
            worldAchievementsDisabled = false;
            isRoomOwner = false;
            setFirstPersonMode(false);
            firstPersonYaw = -Math.PI / 2;
            firstPersonPitch = 0.24;
            player.hp = 100; player.hunger = 100; player.bodyHeat = 100; player.isDowned = false; player.reviveProgress = 0;
            player.shield = null;
            player.inventory = Array(15).fill(null).map(() => ({ type: null, count: 0, duration: 0, maxDuration: 0 }));
            selectedHotbarIndex = 0;
            buildings = []; resourceNodes = []; unlocked = { door: false }; mobs = [];
            frameCount = 0; currentPhase = 'DAY'; phaseTimeLeft = CYCLE.DAY.length; darknessExposure = 0; hungerAlertLevel = 0;
            dayCount = 1; wolfWaveSpawned = false; gregDefeated = false; gregDefeatedDay = null; gregArenaLocked = false;
            alphaWolfStartDay = null; alphaWolfDefeated = false; player.creativeInvulnerable = true;
            soloTokenInventory = { ivory: 0, wolf: 0 };
            soloTokenDrops = { ivory: false, wolf: false };
            initializeSoloSeason();
            discoveredGrid.fill(0); mapTerrainDirty = true; isMapOpen = false;
            document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
            document.getElementById('main-menu').style.display = 'flex';
            document.getElementById('hud').style.display = 'none';
            document.getElementById('inventory-container').style.display = 'none';
            document.getElementById('utility-bar').style.display = 'none';
            document.getElementById('top-controls').style.display = 'none';
            document.getElementById('clock-container').style.display = 'none';
            document.getElementById('chat-box').style.display = 'none';
            document.getElementById('online-room-code').style.display = 'none';
            document.getElementById('darkness-warning').style.display = 'none';
            const chatInput = document.getElementById('chat-input');
            if (chatInput) chatInput.value = '';
            cancelPlacement();
            resetCreativeState();
            displayRandomQuote(); renderInventory();
            checkSavedGame();
        }

        function encodeBytes(bytes) {
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
            return btoa(binary);
        }

        function decodeBytes(value, expectedLength) {
            const binary = atob(value);
            if (binary.length !== expectedLength) throw new Error('Invalid save data length.');
            const bytes = new Uint8Array(expectedLength);
            for (let i = 0; i < expectedLength; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }

        function createSaveData() {
            const packSaveNode = node => [node.x, node.y, node.type, node.hp, node.maxHp, node.pickup ? 1 : 0, node.icon || null, node.plantedDay ?? null, node.shakes ?? null, node.shakeDay ?? null];
            const compactNodes = resourceNodes.map(packSaveNode);
            const savedPlayer = { ...player, inventory: player.inventory.map(slot => ({ ...slot })) };
            return {
                version: 10, genVersion: currentGenVersion, seed: worldSeed,
                seedString: currentWorldSeed,
                slotId: activeSaveSlotId,
                slotName: activeSaveSlotName,
                gameType: 'solo',
                config: { ...worldConfig, firstPerson3D: thirdPerson3D },
                firstPerson3D: thirdPerson3D,
                dayCount, currentPhase, phaseTimeLeft, darknessExposure, currentSeason, seasonDaysRemaining, gregDefeated, gregDefeatedDay, gregArenaLocked,
                alphaWolfStartDay, alphaWolfDefeated,
                soloTokenInventory: { ...soloTokenInventory },
                soloTokenDrops: { ...soloTokenDrops },
                selectedHotbarIndex,
                unlocked, player: savedPlayer, buildings, resourceNodes: compactNodes, mobs,
                discoveredGrid: encodeBytes(discoveredGrid),
                currentLayer,
                achievementsDisabled: areAchievementsDisabled(),
                caves: caveLayerLocal ? {
                    resourceNodes: caveLayerLocal.resourceNodes,
                    resourceVersion: 1,
                    buildings: caveLayerLocal.buildings,
                    mobs: caveLayerLocal.mobs,
                    gregArena: caveLayerLocal.gregArena || null,
                    discoveredGrid: encodeBytes(caveLayerLocal.discoveredGrid)
                } : null,
                surfaceLayer: currentLayer === 'caves' && surfaceLayerLocal ? {
                    resourceNodes: surfaceLayerLocal.resourceNodes.map(packSaveNode),
                    buildings: surfaceLayerLocal.buildings,
                    mobs: surfaceLayerLocal.mobs,
                    discoveredGrid: encodeBytes(surfaceLayerLocal.discoveredGrid)
                } : null
            };
        }

        function requestMultiplayerWorldSave() {
            if (!isOnlineActive()) return Promise.reject(new Error('Not connected to a multiplayer world.'));
            if (pendingWorldExport) return Promise.reject(new Error('A world save is already in progress.'));
            return new Promise((resolve, reject) => {
                pendingWorldExport = { resolve, reject, chunks: [], timeout: setTimeout(() => {
                    if (pendingWorldExport) {
                        pendingWorldExport = null;
                        pendingWorldExportId = null;
                        reject(new Error('World save export timed out.'));
                    }
                }, 30000) };
                if (!sendWorldAction('world_save_export')) {
                    clearTimeout(pendingWorldExport.timeout);
                    pendingWorldExport = null;
                    reject(new Error('Could not request the server world save.'));
                }
            });
        }

        function sendWorldSaveImport(save) {
            if (!isOnlineActive() || !save) return;
            const normalized = { ...save };
            if (!normalized.surfaceLayer) {
                if (normalized.currentLayer === 'caves') throw new Error('This save does not include its surface layer.');
                normalized.surfaceLayer = {
                    resourceNodes: normalized.resourceNodes || [],
                    buildings: normalized.buildings || [],
                    mobs: normalized.mobs || []
                };
            }
            const transferId = crypto.randomUUID();
            const text = JSON.stringify(normalized);
            if (text.length > 12_000_000) throw new Error('This world is too large to transfer.');
            const chunkSize = 32_000;
            const total = Math.ceil(text.length / chunkSize);
            sendWorldAction('world_save_import', { stage: 'start', transferId, total });
            for (let index = 0; index < total; index++) {
                sendWorldAction('world_save_import', {
                    stage: 'chunk', transferId, index,
                    chunk: text.slice(index * chunkSize, (index + 1) * chunkSize)
                });
            }
            sendWorldAction('world_save_import', { stage: 'finish', transferId });
        }

        async function exportSaveFile(save, filename) {
            if (window.aloneDesktop) return window.aloneDesktop.exportSave(save, filename);
            const blob = new Blob([JSON.stringify(save)], { type: 'application/octet-stream' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${String(filename || 'alone-world').replace(/[^a-z0-9-_]+/gi, '-')}.save`;
            document.body.appendChild(link);
            link.click();
            setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
            return true;
        }

        async function persistSaveSlot(save, download = false) {
            if (!activeSaveSlotId) activeSaveSlotId = crypto.randomUUID();
            if (!activeSaveSlotName) activeSaveSlotName = prompt('Name this saved world:', onlineRoom ? `${onlineRoom} world` : 'My World')?.trim() || 'My World';
            save.slotId = activeSaveSlotId;
            save.slotName = activeSaveSlotName;
            await writeSaveData(save, activeSaveSlotId);
            const exported = download ? await exportSaveFile(save, activeSaveSlotName) : true;
            checkSavedGame();
            return exported;
        }

        async function saveMultiplayerWorld() {
            try {
                const save = await requestMultiplayerWorldSave();
                const exported = await persistSaveSlot(save, true);
                setSaveStatus(window.aloneDesktop
                    ? (exported ? 'Multiplayer world saved on this computer and exported.' : 'Multiplayer world saved on this computer.')
                    : 'Multiplayer world saved to this browser and downloaded.', false);
            } catch (error) {
                setSaveStatus(`World save failed: ${error.message}`, true);
            }
        }

        async function saveGame(download = false, silent = false) {
            if (isOnlineActive()) {
                try {
                    const saveData = await requestMultiplayerWorldSave();
                    const exported = await persistSaveSlot(saveData, download);
                    if (!silent) setSaveStatus(download
                        ? (window.aloneDesktop
                            ? (exported ? 'World saved on this computer and exported.' : 'World saved on this computer.')
                            : 'World downloaded and saved locally.')
                        : (window.aloneDesktop ? 'World saved to local files.' : 'World saved locally.'), false);
                    return true;
                } catch (error) {
                    if (!silent) setSaveStatus(`World save failed: ${error.message}`, true);
                    return false;
                }
            }
            let saveData;
            try {
                saveData = JSON.parse(JSON.stringify(createSaveData()));
            } catch (error) {
                setSaveStatus(`Save failed: ${error.message}`, true);
                return false;
            }
            if (!activeSaveSlotId) activeSaveSlotId = crypto.randomUUID();
            if (!activeSaveSlotName) activeSaveSlotName = document.getElementById('world-name')?.value.trim() || 'My World';
            saveData.slotId = activeSaveSlotId;
            saveData.slotName = activeSaveSlotName;
            try {
                await writeSaveData(saveData, activeSaveSlotId);
                localStorage.removeItem('alone_survival_save');
                checkSavedGame();
            } catch (error) {
                if (!silent) setSaveStatus(`Local save failed: ${error.message}`, true);
                return false;
            }
            if (download) {
                try {
                    const exported = await exportSaveFile(saveData, `alone-sector-${new Date().toISOString().slice(0, 10)}`);
                    if (!exported) {
                        if (!silent) setSaveStatus(window.aloneDesktop
                            ? 'Sector saved on this computer. Export canceled.'
                            : 'Sector saved locally; download canceled.', false);
                        return true;
                    }
                } catch (error) {
                    if (!silent) setSaveStatus(`World saved locally, but export failed: ${error.message}`, true);
                    return false;
                }
            }
            if (!silent) setSaveStatus(download
                ? (window.aloneDesktop ? 'Sector saved on this computer and exported.' : 'Sector downloaded and saved locally.')
                : (window.aloneDesktop ? 'Sector saved to local files.' : 'Sector saved locally.'), false);
            return true;
        }

        function applySave(save, warningAccepted = false) {
            if (!save || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(save.version) || !save.discoveredGrid) throw new Error('Unsupported or damaged save file.');
            const achievementsDisabled = !!save.achievementsDisabled || !!save.config?.creative;
            if (achievementsDisabled && !warningAccepted &&
                !confirm('This world has cheats enabled or has used the admin console. Achievements will be disabled in this world. Continue?')) return;
            activeSaveSlotId = save.slotId || 'current';
            activeSaveSlotName = save.slotName || 'Legacy world';
            pendingMode = 'solo';
            worldConfig = {
                ...worldConfig,
                ...save.config,
                winterLengthDays: save.config?.winterLengthDays ?? 8,
                mildLengthDays: save.config?.mildLengthDays ?? 8
            };
            setAchievementWorld('solo', activeSaveSlotId, achievementsDisabled || !!worldConfig.creative);
            setFirstPersonMode(!!(save.firstPerson3D ?? save.thirdPerson3D ?? save.config?.firstPerson3D ?? save.config?.thirdPerson3D));
            worldConfig.firstPerson3D = thirdPerson3D;
            pendingLoad = save;
            currentLayer = 'surface';
            surfaceLayerLocal = null;
            caveLayerLocal = null;

            if (save.version === 1) {
                const biomeMap = ['OCEAN', 'PLAINS', 'FOREST', 'MOUNTAIN'];
                const flatGrid = decodeBytes(save.worldGrid, COLS * ROWS);
                worldGrid = Array.from({ length: ROWS }, (_, y) => Array.from(flatGrid.slice(y * COLS, (y + 1) * COLS), v => biomeMap[v] || 'OCEAN'));
                finishLoadFromSave();
                return;
            }

            updateWorldDimensions();                 // size COLS/ROWS from the SAVED config first
            currentWorldSeed = save.seedString || '';
            generateOrganicMap({ fromSave: true });  // terrain only; finishLoadFromSave() runs at step 7
        }

        function finishLoadFromSave() {
            const save = pendingLoad;
            pendingLoad = null;
            if (!save) return;

            discoveredGrid = decodeBytes(save.discoveredGrid, COLS * ROWS);
            dayCount = Number(save.dayCount) || 1;
            alphaWolfStartDay = Number.isInteger(save.alphaWolfStartDay) && save.alphaWolfStartDay >= 9 && save.alphaWolfStartDay <= 12
                ? save.alphaWolfStartDay
                : 9 + Math.floor(Math.random() * 4);
            alphaWolfDefeated = !!save.alphaWolfDefeated;
            const savedTokenInventory = save.soloTokenInventory || save.worldTokenInventory || {};
            soloTokenInventory = {
                ivory: savedTokenInventory.ivory === 1 ? 1 : 0,
                wolf: savedTokenInventory.wolf === 1 ? 1 : 0
            };
            const savedTokenDrops = save.soloTokenDrops || save.worldTokenDrops || {};
            soloTokenDrops = {
                ivory: !!savedTokenDrops.ivory || soloTokenInventory.ivory === 1,
                wolf: !!savedTokenDrops.wolf || soloTokenInventory.wolf === 1
            };
            syncClientSeason(save.season, save.seasonDaysRemaining);
            if (!Number.isInteger(save.seasonDaysRemaining)) seasonDaysRemaining = seasonDurationDays(currentSeason);
            normalizeSoloSeasonSchedule();
            currentPhase = CYCLE[save.currentPhase] ? save.currentPhase : 'DAY';
            phaseTimeLeft = Number(save.phaseTimeLeft) || CYCLE[currentPhase].length;
            darknessExposure = save.darknessExposure || 0;
            gregDefeated = !!save.gregDefeated;
            gregArenaLocked = !!save.gregArenaLocked && !gregDefeated;
            gregDefeatedDay = gregDefeated
                ? (Number.isInteger(save.gregDefeatedDay) && save.gregDefeatedDay > 0 ? save.gregDefeatedDay : dayCount)
                : null;
            unlocked = save.unlocked || { door: false };
            player = { ...save.player, inventory: save.player.inventory.map(slot => ({ ...slot })), shield: normalizeShieldData(save.player.shield) };
            player.creativeInvulnerable = save.player.creativeInvulnerable !== false;
            player.bodyHeat = Math.max(0, Math.min(100, Number(save.player.bodyHeat ?? 100)));
            buildings = (save.buildings || []).map(building => building.type === 'cave_entrance'
                ? { ...building, width: 2 * cellSize, height: 2 * cellSize }
                : building);
            mobs = save.mobs || [];
            wolfWaveSpawned = false;

            const iconFor = t => t === 'wood' ? '🌲' : ['stone', 'rocks', 'big_rock'].includes(t) ? '🪨' : t === 'iron' ? '⛓️' : t === 'berries' ? '🍒' : t === 'carrots' ? '🥕' : t === 'twigs' ? '🥢' : t === 'flint' ? '🔷' : t === 'acorn' ? '🌰' : t === 'sapling' ? '🌱' : TOKEN_DEFINITIONS[t]?.icon || '🪵';
            resourceNodes = (save.version >= 2 ? (save.resourceNodes || []) : []).map(n => {
                const node = { x: n[0], y: n[1], type: n[2], hp: n[3], maxHp: n[4], pickup: !!n[5], icon: n[6] || iconFor(n[2]) };
                if (n[7] != null) node.plantedDay = n[7];
                if (n[8] != null) node.shakes = n[8];
                if (n[9] != null) node.shakeDay = n[9];
                return node;
            });
            if (save.version === 1) resourceNodes = save.resourceNodes || [];

            currentLayer = 'surface';
            surfaceLayerLocal = null;
            if (save.version >= 7 && save.caves && caveLayerLocal) {
                const savedCaveNodes = save.caves.resourceNodes;
                if (Array.isArray(savedCaveNodes) && (savedCaveNodes.length > 0 || save.caves.resourceVersion >= 1)) {
                    caveLayerLocal.resourceNodes = savedCaveNodes;
                }
                caveLayerLocal.buildings = save.caves.buildings || caveLayerLocal.buildings;
                caveLayerLocal.mobs = save.caves.mobs || [];
                caveLayerLocal.gregArena = save.caves.gregArena || caveLayerLocal.gregArena || null;
                if (save.caves.discoveredGrid) caveLayerLocal.discoveredGrid = decodeBytes(save.caves.discoveredGrid, COLS * ROWS);
            }
            if (save.version >= 7 && save.currentLayer === 'caves' && save.surfaceLayer && caveLayerLocal) {
                const surfaceNodes = (save.surfaceLayer.resourceNodes || []).map(n => ({
                    x: n[0], y: n[1], type: n[2], hp: n[3], maxHp: n[4],
                    pickup: !!n[5], icon: n[6] || iconFor(n[2]),
                    ...(n[7] != null ? { plantedDay: n[7] } : {}),
                    ...(n[8] != null ? { shakes: n[8] } : {}),
                    ...(n[9] != null ? { shakeDay: n[9] } : {})
                }));
                surfaceLayerLocal = {
                    worldGrid,
                    resourceNodes: surfaceNodes,
                    buildings: (save.surfaceLayer.buildings || []).map(building => building.type === 'cave_entrance'
                        ? { ...building, width: 2 * cellSize, height: 2 * cellSize }
                        : building),
                    mobs: save.surfaceLayer.mobs || [],
                    discoveredGrid: decodeBytes(save.surfaceLayer.discoveredGrid, COLS * ROWS)
                };
                if (player.caveReturn) {
                    const previousEntrances = (save.surfaceLayer.buildings || []).filter(building => building.type === 'cave_entrance' && !building.width);
                    if (previousEntrances.length) {
                        player.caveReturn.x += cellSize / 2;
                        player.caveReturn.y += cellSize / 2;
                    }
                }
                restoreLocalLayer(caveLayerLocal, 'caves');
            } else if (worldConfig.cavesEnabled && !buildings.some(building => building.type === 'cave_entrance')) {
                generateSoloCaves();
            }
            if (worldConfig.cavesEnabled && caveLayerLocal) {
                ensureSoloCaveExitLinks(
                    currentLayer === 'caves' && surfaceLayerLocal ? surfaceLayerLocal.buildings : buildings,
                    caveLayerLocal
                );
                ensureSoloGregSpawn(caveLayerLocal);
            }
            const tokenNodes = [
                ...resourceNodes,
                ...(surfaceLayerLocal?.resourceNodes || []),
                ...(caveLayerLocal?.resourceNodes || [])
            ];
            if (tokenNodes.some(node => node.type === 'ivory_token')) soloTokenDrops.ivory = true;
            if (tokenNodes.some(node => node.type === 'wolf_token')) soloTokenDrops.wolf = true;

            selectedHotbarIndex = Math.max(0, Math.min(player.inventory.length - 1, save.selectedHotbarIndex || 0));
            if (worldConfig.creative) discoveredGrid.fill(1);
            normalizeInventory();
            placementMouse = { x: player.x, y: player.y };
            mapTerrainDirty = true;
            startGameUI();
            currentState = 'PLAYING';
            renderInventory();
        }

        function setSaveStatus(message, isError) {
            const status = document.getElementById('save-status');
            if (status) { status.textContent = message; status.style.color = isError ? '#ff4444' : '#2ecc71'; }
        }

        async function loadGame(slotId = 'current') {
            try {
                const save = await readSaveData(slotId);
                const legacySave = window.aloneDesktop ? null : localStorage.getItem('alone_survival_save');
                if (!save && !legacySave) throw new Error('No local save found.');
                applySave(save || JSON.parse(legacySave));
            }
            catch (error) { displayChat({ name: 'SYSTEM', text: `Load failed: ${error.message}`, color: '#f00' }); }
        }

        async function openSaveFile() {
            if (!window.aloneDesktop) {
                document.getElementById('save-file-input')?.click();
                return;
            }
            try {
                const contents = await window.aloneDesktop.openSave();
                if (contents === null) return;
                applySave(JSON.parse(contents));
            } catch (error) {
                alert(`Could not open save file: ${error.message}`);
            }
        }

        async function saveAndQuit() {
            await saveGame(false);
            resetGame();
        }

        function handleSaveFile(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => { try { applySave(JSON.parse(reader.result)); } catch (error) { displayChat({ name: 'SYSTEM', text: `File load failed: ${error.message}`, color: '#f00' }); } };
            reader.readAsText(file);
            event.target.value = '';
        }
        function handleSeedInput() {
            const input = document.getElementById('set-world-seed');
            if (!input) return;

            // Remove everything except valid alphanumeric seed characters.
            const raw = input.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '');
            seedSettingsLocked = true;

            // Automatically insert the display hyphen.
            if (raw.length <= SEED_SETTINGS_LENGTH) {
                input.value = raw;
            } else {
                input.value =
                    raw.substring(0, SEED_SETTINGS_LENGTH) +
                    '-' +
                    raw.substring(SEED_SETTINGS_LENGTH);
            }

            const status = document.getElementById('seed-status');

            if (raw.length !== SEED_TOTAL_LENGTH) {
                if (status) {
                    status.textContent =
                        `${raw.length}/${SEED_TOTAL_LENGTH} characters`;
                    status.style.color = '#888';
                }
                return;
            }

            try {
                const decoded = decodeWorldSettings(raw);

                document.getElementById('set-res').value = decoded.resMult;
                document.getElementById('set-food').value = decoded.foodMult;
                document.getElementById('set-day').value = decoded.dayMult;
                document.getElementById('set-night').value = decoded.nightMult;
                document.getElementById('set-hunger').value = decoded.hungerMult;
                document.getElementById('set-world-size').value = decoded.worldSizeMult;
                document.getElementById('set-map-preset').value = decoded.mapPreset;
                document.getElementById('set-ocean').value = decoded.oceanMult;
                document.getElementById('set-forest').value = decoded.forestMult;
                document.getElementById('set-mountain').value = decoded.mountainMult;
                document.getElementById('set-wildlife').value = decoded.wildlifeMult;
        document.getElementById('set-ruins').value = decoded.ruinsMult;
                document.getElementById('set-creative').checked = decoded.creative;
                document.getElementById('set-caves').checked = decoded.cavesEnabled;

                currentWorldSeed = raw;

                if (status) {
                    status.textContent = '✓ VALID SEED — SETTINGS LOADED';
                    status.style.color = '#55ff55';
                }

            } catch (error) {

                if (status) {
                    status.textContent = '✕ INVALID SEED';
                    status.style.color = '#ff4444';
                }
            }
        }
        function testSeedSystem() {

            console.clear();

            console.log(
                '===================================='
            );

            console.log(
                '        WORLD SEED SYSTEM TEST'
            );

            console.log(
                '===================================='
            );


            // -----------------------------------------------------
            // TEST 1
            // Encode current settings.
            // -----------------------------------------------------

            const settingsPart =
                encodeWorldSettings();

            console.log(
                'Settings portion:',
                settingsPart
            );

            console.log(
                'Settings length:',
                settingsPart.length
            );


            // -----------------------------------------------------
            // TEST 2
            // Generate complete seed.
            // -----------------------------------------------------

            const seed =
                settingsPart +
                randomSeedPart(
                    SEED_RANDOM_LENGTH
                );

            console.log(
                'Complete seed:',
                formatWorldSeed(seed)
            );

            console.log(
                'Seed length:',
                seed.length
            );


            // -----------------------------------------------------
            // TEST 3
            // Decode settings.
            // -----------------------------------------------------

            const decoded =
                decodeWorldSettings(seed);

            console.log(
                'Decoded settings:',
                decoded
            );


            // -----------------------------------------------------
            // TEST 4
            // Generate numeric seed.
            // -----------------------------------------------------

            const randomPart =
                seed.substring(
                    SEED_SETTINGS_LENGTH
                );

            const numericSeed =
                seedStringToNumber(
                    randomPart
                );

            console.log(
                'Random portion:',
                randomPart
            );

            console.log(
                'Numeric seed:',
                numericSeed
            );


            // -----------------------------------------------------
            // TEST 5
            // Check deterministic RNG.
            // -----------------------------------------------------

            currentRandomState =
                numericSeed;

            const sequenceA = [
                seededRandom(),
                seededRandom(),
                seededRandom(),
                seededRandom(),
                seededRandom()
            ];


            currentRandomState =
                numericSeed;

            const sequenceB = [
                seededRandom(),
                seededRandom(),
                seededRandom(),
                seededRandom(),
                seededRandom()
            ];


            const identical =
                JSON.stringify(sequenceA) ===
                JSON.stringify(sequenceB);


            console.log(
                'Sequence A:',
                sequenceA
            );

            console.log(
                'Sequence B:',
                sequenceB
            );

            console.log(
                'Sequences identical:',
                identical
            );


            // -----------------------------------------------------
            // RESULT
            // -----------------------------------------------------

            console.log(
                '===================================='
            );

            console.log(
                identical
                    ? '✓ SEED SYSTEM TEST PASSED'
                    : '✕ SEED SYSTEM TEST FAILED'
            );

            console.log(
                '===================================='
            );


            return {
                seed: formatWorldSeed(seed),
                settingsPart,
                randomPart,
                decoded,
                sequenceA,
                sequenceB,
                identical
            };
        }
