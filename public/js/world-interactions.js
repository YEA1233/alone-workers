        function seedBiome(cx, cy, type, size) {
            const sX = Math.max(0, Math.floor(cx - size)), eX = Math.min(COLS, Math.ceil(cx + size));
            const sY = Math.max(0, Math.floor(cy - size)), eY = Math.min(ROWS, Math.ceil(cy + size));
            for (let y = sY; y < eY; y++) for (let x = sX; x < eX; x++) if (worldGrid[y][x] !== 'OCEAN' && Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) < size * seededRandom() * 2) worldGrid[y][x] = type;
        }

        function scheduleDiscoverySave() {
            if (pendingMode === 'online' || pendingMode === 'online-create') return;
            clearTimeout(mapDiscoverySaveTimer);
            mapDiscoverySaveTimer = setTimeout(async () => {
                mapDiscoverySaveTimer = null;
                if (currentState !== 'GAME' && currentState !== 'PLAYING') return;
                const saved = await saveGame(false, true);
                if (saved === false) setSaveStatus('Map progress could not be saved locally.', true);
            }, 2000);
        }

        let _discoveryThrottleCounter = 0;
        function updateDiscovery() {
            if ((frameCount % 3) !== 0) return;
            // Throttle discovery updates in creative mode to reduce CPU when many tiles
            if (worldConfig.creative) { if ((_discoveryThrottleCounter++ % 6) !== 0) return; }
            const px = Math.floor(player.x / 40), py = Math.floor(player.y / 40);
            const newly = [];
            for (let y = py - 8; y <= py + 8; y++) for (let x = px - 8; x <= px + 8; x++) if (x >= 0 && x < COLS && y >= 0 && y < ROWS && Math.sqrt((x - px) ** 2 + (y - py) ** 2) <= 8 && !discoveredGrid[y * COLS + x]) { discoveredGrid[y * COLS + x] = 1; newly.push(y * COLS + x); }
            if (newly.length) mapTerrainDirty = true;
            if (newly.length && currentState !== 'MENU') scheduleDiscoverySave();
            // Send discovered updates to server in batches
            if (gameSocket && gameSocket.readyState === WebSocket.OPEN && newly.length) {
                gameSocket.send(JSON.stringify({ type: 'discovered:update', roomId: onlineRoom, playerId: onlinePlayerId, tiles: newly }));
            }
        }

        function handleHarvest(node, idx) {
            const activeItem = getActiveItem();
            const hasAxe = activeItem.type === 'axe';
            const hasPick = activeItem.type === 'pickaxe';
            const hasShovel = activeItem.type === 'shovel';

            if (node.pickup) {
                const token = TOKEN_DEFINITIONS[node.type];
                if (token) {
                    if (!soloTokenDrops[token.key] || soloTokenInventory[token.key]) {
                        resourceNodes.splice(idx, 1);
                        return;
                    }
                    soloTokenInventory[token.key] = 1;
                    resourceNodes.splice(idx, 1);
                    playTokenPickup(token.key);
                    return;
                }
                addToInv(node.type, 1);
                resourceNodes.splice(idx, 1);
                return;
            }

            if ((node.type === 'wood' || node.type === 'tree') && hasAxe ||
                ['big_rock', 'flint_node', 'rock', 'stone', 'iron'].includes(node.type) && hasPick) {
                noteMusicActivity('work');
            }

            if (node.type === 'wood' || node.type === 'tree') {
                if (hasAxe) {
                    node.hp--; useToolDurability();
                    if (node.hp <= 0) {
                        addToInv('wood', 5);
                        addToInv('twigs', 2);
                        if (Math.random() < 0.45) addToInv('acorn', 1);
                        node.type = 'stump'; node.icon = '🪵'; node.hp = 3; node.maxHp = 3;
                    }
                } else {
                    shakeTreeLocal(node);
                }
                return;
            }

            if (node.type === 'big_rock') {
                if (hasPick) {
                    node.hp--; useToolDurability();
                    if (node.hp <= 0) {
                        addToInv('stone', 5);
                        addToInv('flint', 1 + (Math.random() < 0.5 ? 1 : 0));
                        resourceNodes.splice(idx, 1);
                    }
                } else if (frameCount % 60 === 0) {
                    displayChat({ name: 'SYSTEM', text: 'Select a Pickaxe (⛏️) on the hotbar.', color: '#ffa500' });
                }
                return;
            }

            if (node.type === 'flint_node' || node.type === 'rock') {
                if (hasPick) {
                    node.hp--; useToolDurability();
                    if (node.hp <= 0) {
                        addToInv('flint', 1);
                        resourceNodes.splice(idx, 1);
                    }
                } else if (frameCount % 60 === 0) {
                    displayChat({ name: 'SYSTEM', text: 'Select a Pickaxe (⛏️) on the hotbar.', color: '#ffa500' });
                }
                return;
            }

            if (node.type === 'stone' || node.type === 'iron') {
                if (hasPick) {
                    node.hp--; useToolDurability();
                    if (node.hp <= 0) {
                        addToInv(node.type, 5);
                        resourceNodes.splice(idx, 1);
                    }
                } else if (frameCount % 60 === 0) {
                    displayChat({ name: 'SYSTEM', text: 'Select a Pickaxe (⛏️) on the hotbar.', color: '#ffa500' });
                }
                return;
            }

            if (node.type === 'stump') {
                if (hasShovel) {
                    node.hp--; useToolDurability();
                    if (node.hp <= 0) {
                        addToInv('wood', 2);
                        resourceNodes.splice(idx, 1);
                    }
                } else if (frameCount % 60 === 0) {
                    displayChat({ name: 'SYSTEM', text: 'Select a Shovel (🧹) on the hotbar.', color: '#ffa500' });
                }
            }
        }

        function extractAmberLocal(extractor, woodSlot) {
            if (Math.hypot(player.x + 13 - (extractor.x + 20), player.y + 13 - (extractor.y + 20)) > 80) {
                displayChat({ name: 'SYSTEM', text: 'You are too far away from the extractor.', color: '#ffa500' });
                return;
            }
            const roll = Math.random();
            const amount = roll < 1 / 5 ? 1
                : roll < 1 / 5 + 1 / 10 ? 2
                    : roll < 1 / 5 + 1 / 10 + 1 / 15 ? 3
                        : 0;
            if (amount && !player.inventory.some(slot => slot.type === 'amber') &&
                !player.inventory.some(slot => slot.type === null) && woodSlot.count === 5) {
                displayChat({ name: 'SYSTEM', text: 'Inventory full. Make room for amber first.', color: '#ff4444' });
                return;
            }
            woodSlot.count -= 5;
            if (woodSlot.count <= 0) Object.assign(woodSlot, { type: null, count: 0, duration: 0, maxDuration: 0 });
            if (amount) addToInv('amber', amount);
            renderInventory();
            displayChat({ name: 'SYSTEM', text: amount ? `The extractor produced ${amount} amber.` : 'The extractor found no amber this time.', color: amount ? '#ffcc66' : '#aaaaaa' });
        }

        function getBiomeAtWorldPos(x, y) {
            const tileX = Math.floor((x + 20) / cellSize);
            const tileY = Math.floor((y + 20) / cellSize);
            if (tileX < 0 || tileY < 0 || tileX >= COLS || tileY >= ROWS) return 'OCEAN';
            return worldGrid[tileY]?.[tileX] || 'OCEAN';
        }

        function wrapWorldCoordinate(value, limit) {
            return value < 0 ? limit + value : value >= limit ? value - limit : value;
        }

        function isLocationBlocked(x, y) {
            if (gregArenaLocked && currentLayer === 'caves' &&
                insideGregArena(player.x + 13, player.y + 13) &&
                !insideGregArena(x + 13, y + 13)) return true;
            if (creativeNoclip) return false;
            const tileX = Math.floor((x + 13) / cellSize);
            const tileY = Math.floor((y + 13) / cellSize);
            if (tileX < 0 || tileY < 0 || tileX >= COLS || tileY >= ROWS) return true;
            const biome = worldGrid[tileY]?.[tileX];
            const waterBlocked = biome && BIOMES[biome] && BIOMES[biome].passable === false && !player.inBoat;
            const blockedByWall = buildings.some(b => b.type === 'wall' && Math.abs((x + 13) - (b.x + 20)) < 22 && Math.abs((y + 13) - (b.y + 20)) < 22);
            return waterBlocked || blockedByWall;
        }

        function canPlaceStructureAt(x, y, type) {
            const blockedByWall = buildings.some(b => b.type === 'wall' && Math.abs(b.x - x) < 40 && Math.abs(b.y - y) < 40);
            const blockedByBuilding = buildings.some(b => b.type !== 'wall' && Math.abs(b.x - x) < 40 && Math.abs(b.y - y) < 40 && b.type !== 'acorn');
            const blockedByNode = resourceNodes.some(n => Math.abs(n.x - x) < 40 && Math.abs(n.y - y) < 40 && n.type !== 'sapling');
            const tooCloseToPlayer = Math.abs(player.x - x) < 30 && Math.abs(player.y - y) < 30;
            const biome = getBiomeAtWorldPos(x, y);
            const waterTile = BIOMES[biome] && BIOMES[biome].passable === false;
            const overWaterOnly = type === 'boat';
            if (type === 'wall') return !(blockedByWall || blockedByBuilding || blockedByNode || tooCloseToPlayer || waterTile);
            if (overWaterOnly) return !(blockedByBuilding || blockedByNode || tooCloseToPlayer || !waterTile || buildings.some(b => b.type === 'boat' && Math.abs(b.x - x) < 40 && Math.abs(b.y - y) < 40));
            return !(blockedByBuilding || blockedByNode || tooCloseToPlayer || waterTile);
        }

        function tryPlaceStructure() {
            const target = placementMouse;
            const type = buildMode;

            if (!type || type === 'none') return;
            if (type === 'cave_entrance' || type === 'cave_exit') {
                displayChat({ name: 'SYSTEM', text: 'Cave passages are generated with the world.', color: '#ffa500' });
                cancelPlacement();
                return;
            }

            // -----------------------------------------
            // CHECK LOCATION
            // -----------------------------------------
            if (!canPlaceStructureAt(target.x, target.y, type)) {
                displayChat({
                    name: 'SYSTEM',
                    text: type === 'boat'
                        ? 'Boats must be placed over deep water.'
                        : 'You cannot place there.',
                    color: '#ffa500'
                });

                // No resources have been spent yet,
                // so cancelling is automatically a full refund.
                cancelPlacement();
                return;
            }

            // -----------------------------------------
            // ACORN
            // -----------------------------------------
            if (type === 'acorn') {
                if (isOnlineActive()) { sendWorldAction('place', { type: 'acorn', x: target.x, y: target.y }); cancelPlacement(); return; }
                const slot =
                    player.inventory.find(
                        s => s && s.type === 'acorn'
                    );

                if (!slot || slot.count <= 0) {
                    displayChat({
                        name: 'SYSTEM',
                        text: 'No acorns left to plant.',
                        color: '#ffa500'
                    });

                    cancelPlacement();
                    return;
                }

                if (!worldConfig.creative) {
                    slot.count -= 1;

                    if (slot.count <= 0) {
                        slot.type = null;
                        slot.count = 0;
                    }
                }

                resourceNodes.push({
                    x: target.x,
                    y: target.y,
                    type: 'sapling',
                    icon: '🌱',
                    hp: 1,
                    maxHp: 1,
                    plantedDay: dayCount + 1,
                    pickup: false
                });

                displayChat({
                    name: 'SYSTEM',
                    text: 'Acorn planted. It will sprout in 1 day.',
                    color: '#2ecc71'
                });

                renderInventory();

                // Acorns are single-use, so leave placement mode.
                cancelPlacement();

                return;
            }

            // -----------------------------------------
            // STRUCTURE
            // -----------------------------------------
            const recipe = BUILDINGS[type];

            if (!recipe) {
                console.warn(
                    'Unknown building type:',
                    type
                );

                cancelPlacement();
                return;
            }

            // Check resources BEFORE placing.
            if (!worldConfig.creative && !hasRes(recipe)) {
                displayChat({
                    name: 'SYSTEM',
                    text: `${recipe.name}: need materials.`,
                    color: '#f00'
                });

                // Stay in placement mode so the player can
                // potentially gather materials and try again.
                return;
            }

            // -----------------------------------------
            // ONLINE
            // -----------------------------------------
            if (
                gameSocket &&
                gameSocket.readyState === WebSocket.OPEN
            ) {
                gameSocket.send(JSON.stringify({
                    type: 'world:action',
                    playerId: onlinePlayerId,
                    action: {
                        type: 'place',
                        payload: {
                            type,
                            x: target.x,
                            y: target.y
                        }
                    }
                }));

                setBlueprintFeedback(
                    `${recipe.name} requested.`
                );

                displayChat({
                    name: 'SYSTEM',
                    text:
                        `Requesting placement of ${recipe.name}...`,
                    color: '#888'
                });

                /*
                 * IMPORTANT:
                 *
                 * Do NOT pay resources here.
                 *
                 * The server should deduct them only after
                 * successfully accepting the placement.
                 *
                 * The server response should ultimately tell
                 * the client whether placement succeeded.
                 */

            } else {

                // -----------------------------------------
                // OFFLINE / SOLO
                // -----------------------------------------
                if (!worldConfig.creative) {
                    payRes(recipe);
                }

                const building = {
                    x: target.x,
                    y: target.y,
                    type,
                    hp: recipe.hp || 100,
                    maxHp: recipe.hp || 100,
                    life: recipe.life || Infinity,

                    inventory:
                        type === 'chest'
                            ? Array.from(
                                { length: 10 },
                                () => ({
                                    type: null,
                                    count: 0
                                })
                            )
                            : undefined
                };
                if (type === 'sign') building.text = '';

                buildings.push(building);
                noteMusicActivity('work');
                unlockAchievement('first-build');

                setBlueprintFeedback(
                    `${recipe.name} placed (offline).`
                );

                displayChat({
                    name: 'SYSTEM',
                    text:
                        `${recipe.name} placed.`,
                    color: '#2ecc71'
                });
            }

            // -----------------------------------------
            // KEEP PLACEMENT MODE ACTIVE
            // -----------------------------------------
            //
            // DO NOT call cancelPlacement() here.
            //
            // This is what allows:
            //
            // WALL → click → WALL → click → WALL → click
            //
            // without reopening the build menu.
            //
            // The player exits with X / ESC / right-click.
        }

        function handleInput(e) {
            if (!['GAME', 'PLAYING'].includes(currentState) || player.isDowned) return;
            if (thirdPerson3D && document.pointerLockElement !== canvas) {
                if (canvas.requestPointerLock) {
                    const request = canvas.requestPointerLock();
                    if (request?.catch) request.catch(error => {
                        console.error('First-person pointer lock failed:', error);
                        const hint = document.getElementById('first-person-hint');
                        if (hint) hint.textContent = 'MOUSE LOCK FAILED — CLICK TO RETRY';
                    });
                }
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const screenX = (e.clientX - rect.left) / globalScale, screenY = (e.clientY - rect.top) / globalScale;
            const worldPoint = thirdPerson3D ? screenToWorld3D(screenX, screenY) : { x: screenX + camera.x, y: screenY + camera.y };
            const mx = worldPoint.x, my = worldPoint.y;
            placementMouse = { x: Math.floor(mx / 40) * 40, y: Math.floor(my / 40) * 40 };
            if (e.shiftKey && creativeAvailable()) { creativeTeleportToTile(mx / cellSize, my / cellSize); return; }

            const activeItem = getActiveItem();
            if (!isPlacing && activeItem && activeItem.type === 'acorn') {
                buildMode = 'acorn';
                isPlacing = true;
                document.getElementById('placement-label').innerText = 'PLACING ACORN';
                document.getElementById('placement-controls').style.display = 'flex';
                return;
            }

            if (isPlacing && buildMode !== 'none') {
                tryPlaceStructure();
                return;
            }

            const gx = Math.floor(mx / 40), gy = Math.floor(my / 40);
            const bIdx = buildings.findIndex(b => {
                const width = b.type === 'cave_entrance' ? 2 : 1;
                const height = b.type === 'cave_entrance' ? 2 : 1;
                const bx = Math.floor(b.x / cellSize), by = Math.floor(b.y / cellSize);
                return gx >= bx && gx < bx + width && gy >= by && gy < by + height;
            });
            const nodeIdx = resourceNodes.findIndex(n => Math.abs(n.x + 20 - mx) < 20 && Math.abs(n.y + 20 - my) < 20);

            if (bIdx !== -1) {
                const bld = buildings[bIdx];
                if (getActiveItem() && getActiveItem().type === 'hammer') {
                    startBuildingTask(bld);
                    return;
                }
                if (bld.type === 'cave_entrance' || bld.type === 'cave_exit') {
                    if (currentLayer === 'caves' && bld.type === 'cave_exit') {
                        startCaveTask(bld, 'cave_exit');
                    } else if (currentLayer !== 'caves' && bld.type === 'cave_entrance') {
                        startCaveTask(bld, 'cave_enter');
                    }
                    return;
                }
                if (bld.type === 'extractor') {
                    const held = getActiveItem();
                    if (held?.type !== 'wood' || held.count < 5) {
                        displayChat({ name: 'SYSTEM', text: 'Select a hotbar stack with at least 5 wood, then click the extractor.', color: '#ffa500' });
                        return;
                    }
                    if (isOnlineActive()) {
                        sendWorldAction('extract_amber', { buildingId: bld.id, slot: selectedHotbarIndex });
                    } else {
                        extractAmberLocal(bld, held);
                    }
                    return;
                }
                if (bld.type === 'boat') {
                    if (!player.inBoat) startBoatTask(bld);
                    else displayChat({ name: 'SYSTEM', text: 'Press SPACE to leave the boat when you reach land.', color: '#ffa500' });
                    return;
                }
                if (bld.type === 'sign') {
                    if (Math.hypot(player.x - bld.x, player.y - bld.y) < 80) editSign(bld);
                    else displayChat({ name: 'SYSTEM', text: 'You are too far away to write on the sign.', color: '#ffa500' });
                    return;
                }
                const dist = Math.hypot(player.x - bld.x, player.y - bld.y);
                if (bld.type === 'chest') {
                    if (dist < 80) { openChest(bld); }
                    else displayChat({ name: 'SYSTEM', text: 'You are too far away to access the chest.', color: '#ffa500' });
                    return;
                }
            }

            // Click something: walk up to it (pathfinding), then act on it.
            const mobIdx = mobs.findIndex(m => {
                const center = mobCenter(m);
                return Math.hypot(center.x - mx, center.y - my) < Math.max(40, mobSize(m) / 2);
            });
            if (mobIdx !== -1) { startMobTask(mobs[mobIdx]); return; }
            if (nodeIdx !== -1) { startNodeTask(resourceNodes[nodeIdx]); return; }
            if (bIdx !== -1 && buildMode === 'none' && ['research', 'cooking'].includes(buildings[bIdx].type)) toggleBuildMenu();
        }

        function toggleBuildMenu() {
            if (player.isDowned) return;
            const overlay = document.getElementById('build-menu-overlay');
            if (overlay.style.display === 'flex') { closeBuildMenu(); return; }

            stopMovement();
            const nearLab = buildings.some(b => b.type === 'research' && Math.sqrt((player.x - b.x) ** 2 + (player.y - b.y) ** 2) < 180);
            document.getElementById('science-warning').style.display = nearLab ? 'none' : 'block';
            renderBlueprints(nearLab);
            overlay.style.display = 'flex';
        }

        function blueprintType(key) {
            if (['axe', 'pickaxe', 'sword', 'torch', 'lantern', 'shovel', 'hammer', 'acorn'].includes(key)) return 'TOOLS';
            if (['campfire', 'wall', 'boat', 'door', 'chest', 'sign'].includes(key)) return 'STRUCTURES';
            if (['research', 'extractor', 'cooking'].includes(key)) return 'STATIONS';
            return 'TOOLS';
        }

        function recipeCosts(data) {
            const costs = [];
            if (data.twigs) costs.push(`${data.twigs} TWIGS`);
            if (data.flint) costs.push(`${data.flint} FLINT`);
            if (data.wood) costs.push(`${data.wood} WOOD`);
            if (data.stone) costs.push(`${data.stone} STONE`);
            if (data.iron) costs.push(`${data.iron} IRON`);
            return costs.join('  •  ') || 'NO COST';
        }

        function createRecipeCard(name, icon, type, cost, available, action, note) {
            const card = document.createElement('div');
            card.className = `build-card ${available ? '' : 'locked'}`;
            card.innerHTML = `<span class="recipe-icon">${icon}</span><div><div class="recipe-name">${name}</div><div class="recipe-type">${type}</div></div><div class="recipe-cost">${cost}</div><div class="recipe-action">${note}</div>`;
            card.onclick = () => { if (available) action(); else setBlueprintFeedback(`${name}: ${note}.`); };
            document.getElementById('build-grid-content').appendChild(card);
        }

        function setBlueprintFeedback(message) {
            const feedback = document.getElementById('blueprint-feedback');
            if (feedback) feedback.innerText = message;
        }

        function renderBlueprints(nearLab) {
            const categories = ['ALL', 'TOOLS', 'STRUCTURES', 'STATIONS', 'FOOD'];
            const tabs = document.getElementById('blueprint-tabs'); tabs.innerHTML = '';
            categories.forEach(category => {
                const tab = document.createElement('button'); tab.className = `blueprint-tab ${blueprintCategory === category ? 'active' : ''}`; tab.innerText = category;
                tab.onclick = () => { blueprintCategory = category; renderBlueprints(nearLab); }; tabs.appendChild(tab);
            });
            const grid = document.getElementById('build-grid-content'); grid.innerHTML = '';
            const recipes = Object.keys(BUILDINGS)
                .filter(key => !['door', 'acorn', 'ivory_shield', 'cave_entrance', 'cave_exit'].includes(key))
                .map(key => ({ key, data: BUILDINGS[key], type: blueprintType(key) }));
            recipes.push({ key: 'paste', name: 'PASTE', icon: '🧪', cost: '15 WOOD', type: 'FOOD', available: true, note: 'HUNGER +30 / HP +10' });
            if (blueprintCategory !== 'ALL') recipes.splice(0, recipes.length, ...recipes.filter(recipe => recipe.type === blueprintCategory));
            document.getElementById('blueprint-summary').innerText = `${recipes.length} RECIPES  •  ${blueprintCategory === 'ALL' ? 'ALL CATEGORIES' : blueprintCategory}`;
            recipes.forEach(recipe => {
                if (recipe.key === 'paste') {
                    const canCraftPaste = worldConfig.creative || hasRes({ wood: 15 });
                    const canUseKitchen = worldConfig.creative || buildings.some(b => b.type === 'cooking' && Math.sqrt((player.x - b.x) ** 2 + (player.y - b.y) ** 2) < 180);
                    createRecipeCard(recipe.name, recipe.icon, recipe.type, recipe.cost, canCraftPaste && canUseKitchen, () => { if (isOnlineActive()) { sendWorldAction('craft', { type: 'paste' }); return; } if (canUseKitchen && (worldConfig.creative || hasRes({ wood: 15 }))) { if (!worldConfig.creative) payRes({ wood: 15 }); addToInv('paste', 1); setBlueprintFeedback('PASTE crafted.'); } else setBlueprintFeedback('PASTE: NEED KITCHEN OR MATERIALS.'); }, canUseKitchen ? 'HUNGER +30 / HP +10' : 'KITCHEN REQUIRED');
                    return;
                }
                const locked = recipe.data.reqLab && !nearLab && !worldConfig.creative;
                const affordable = worldConfig.creative || hasRes(recipe.data);
                createRecipeCard(recipe.data.name, recipe.data.icon, recipe.type, recipeCosts(recipe.data), !locked, () => craftOrBuild(recipe.key), locked ? 'LAB REQUIRED' : affordable ? recipe.data.type === 'item' ? 'CRAFT' : 'PLACE' : 'NEED MATERIALS');
            });
        }

        function craftOrBuild(key) {
            if (key === 'cave_entrance' || key === 'cave_exit') {
                setBlueprintFeedback('Cave passages are generated with the world.');
                return;
            }
            if (isOnlineActive() && (key === 'paste' || BUILDINGS[key]?.type === 'item')) { sendWorldAction('craft', { type: key }); closeBuildMenu(); return; }
            if (key === 'paste') {
                const nearKitchen = buildings.some(
                    b =>
                        b.type === 'cooking' &&
                        Math.sqrt(
                            (player.x - b.x) ** 2 +
                            (player.y - b.y) ** 2
                        ) < 180
                );

                if (!worldConfig.creative && !nearKitchen) {
                    setBlueprintFeedback('PASTE: NEED KITCHEN.');
                    displayChat({
                        name: 'SYSTEM',
                        text: 'Kitchen required to craft paste.',
                        color: '#f00'
                    });
                    return;
                }

                if (worldConfig.creative || hasRes({ wood: 15 })) {
                    if (!worldConfig.creative) {
                        payRes({ wood: 15 });
                    }

                    addToInv('paste', 1);
                    setBlueprintFeedback('PASTE crafted.');
                    closeBuildMenu();
                    return;
                }

                setBlueprintFeedback('PASTE: NEED MATERIALS.');
                displayChat({
                    name: 'SYSTEM',
                    text: 'Insufficient resources.',
                    color: '#f00'
                });
                return;
            }

            if (worldConfig.creative || hasRes(BUILDINGS[key])) {

                if (BUILDINGS[key].type === 'item') {
                    if ((BUILDINGS[key].durability || BUILDINGS[key].duration) && !player.inventory.some(slot => !slot.type)) {
                        setBlueprintFeedback(`${BUILDINGS[key].name.toUpperCase()}: INVENTORY FULL.`);
                        displayChat({ name: 'SYSTEM', text: 'Make room in your inventory before crafting that item.', color: '#ffa500' });
                        return;
                    }

                    if (!worldConfig.creative) {
                        payRes(BUILDINGS[key]);
                    }

                    addToInv(key, 1);

                } else {

                    buildMode = key;
                    isPlacing = true;

                    document.getElementById('placement-label').innerText =
                        `PLACING ${BUILDINGS[key].name.toUpperCase()}`;

                    document.getElementById('placement-controls').style.display =
                        'flex';

                    displayChat({
                        name: 'SYSTEM',
                        text: `Click to place. Press X to stop.`,
                        color: '#888'
                    });
                }

                setBlueprintFeedback(`${BUILDINGS[key].name} ready.`);
                closeBuildMenu();

            } else {

                setBlueprintFeedback(
                    `${BUILDINGS[key].name}: NEED MATERIALS.`
                );

                displayChat({
                    name: 'SYSTEM',
                    text: `Insufficient resources.`,
                    color: '#f00'
                });
            }

        } // <-- THIS was missing

        function closeBuildMenu() { document.getElementById('build-menu-overlay').style.display = 'none'; }

        function editSign(building) {
            const text = window.prompt('Write a message on this sign (up to 120 characters):', building.text || '');
            if (text === null) return;
            const value = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
            if (isOnlineActive()) {
                sendWorldAction('sign_write', { buildingId: building.id, text: value });
            } else {
                building.text = value;
            }
        }

        // CHEST UI: open a chest building and render drag & drop storage
        let _activeChestBuilding = null;
        function openChest(building) {
            if (!building || building.type !== 'chest') return;
            if (building.rewardChestAt + GREG_CHEST_FADE_MS > Date.now()) {
                displayChat({ name: 'SYSTEM', text: 'The reward chest is still materializing.', color: '#ffcc00' });
                return;
            }
            _activeChestBuilding = building;
            const overlay = document.getElementById('chest-menu-overlay');
            overlay.style.display = 'flex';
            renderChestUI();
        }

        function closeChest() {
            const overlay = document.getElementById('chest-menu-overlay');
            overlay.style.display = 'none';
            _activeChestBuilding = null;
        }

        function syncActiveChest() {
            if (!_activeChestBuilding) return;
            const updated = buildings.find(building =>
                building.type === 'chest' &&
                (building.id === _activeChestBuilding.id ||
                    (building.x === _activeChestBuilding.x && building.y === _activeChestBuilding.y))
            );
            if (!updated) {
                closeChest();
                return;
            }
            _activeChestBuilding = updated;
            renderChestUI();
        }

        function renderChestUI() {
            if (!_activeChestBuilding) return;
            const chestGrid = document.getElementById('chest-storage-grid');
            const playerGrid = document.getElementById('player-storage-grid');
            if (!chestGrid || !playerGrid) return;

            // Clear
            chestGrid.innerHTML = '';
            playerGrid.innerHTML = '';

            // Ensure chest inventory exists and has 10 slots
            if (!_activeChestBuilding.inventory) _activeChestBuilding.inventory = Array.from({ length: 10 }, () => ({ type: null, count: 0 }));
            const chestSlotCount = _activeChestBuilding.rewardChest ? Math.max(10, Math.min(11, _activeChestBuilding.inventory.length)) : 10;
            _activeChestBuilding.inventory = _activeChestBuilding.inventory.slice(0, chestSlotCount);
            while (_activeChestBuilding.inventory.length < chestSlotCount) _activeChestBuilding.inventory.push({ type: null, count: 0 });

            // Render chest slots
            _activeChestBuilding.inventory.forEach((slot, idx) => {
                const el = document.createElement('div');
                el.className = `storage-slot ${!slot.type ? 'empty' : ''}`;
                el.draggable = true;
                el.dataset.kind = 'chest';
                el.dataset.index = idx;
                el.innerText = slot.type ? (ITEM_ICONS[slot.type] || slot.type.toUpperCase().slice(0, 1)) : '';
                if (slot.type) el.title = itemTooltipText(slot.type, slot);
                if (slot.type === 'thermal_stone') {
                    el.insertAdjacentHTML('beforeend', `<span class="thermal-status">${thermalStoneStatus(slot.thermalTemp).icon}</span>`);
                }
                if (slot.count > 0) {
                    const c = document.createElement('div'); c.className = 'count'; c.innerText = slot.count; el.appendChild(c);
                }
                el.addEventListener('dragstart', handleSlotDragStart);
                el.addEventListener('dragover', handleSlotDragOver);
                el.addEventListener('drop', handleSlotDrop);
                chestGrid.appendChild(el);
            });

            // Render player slots (show hotbar + rest)
            player.inventory.forEach((slot, idx) => {
                const el = document.createElement('div');
                el.className = `storage-slot ${!slot.type ? 'empty' : ''}`;
                el.draggable = true;
                el.dataset.kind = 'player';
                el.dataset.index = idx;
                el.innerText = slot.type ? (ITEM_ICONS[slot.type] || slot.type.toUpperCase().slice(0, 1)) : '';
                if (slot.type) el.title = itemTooltipText(slot.type, slot);
                if (slot.type === 'thermal_stone') {
                    el.insertAdjacentHTML('beforeend', `<span class="thermal-status">${thermalStoneStatus(slot.thermalTemp).icon}</span>`);
                }
                if (slot.count > 0) { const c = document.createElement('div'); c.className = 'count'; c.innerText = slot.count; el.appendChild(c); }
                el.addEventListener('dragstart', handleSlotDragStart);
                el.addEventListener('dragover', handleSlotDragOver);
                el.addEventListener('drop', handleSlotDrop);
                playerGrid.appendChild(el);
            });
        }

        let _dragPayload = null;
        function handleSlotDragStart(e) {
            const el = e.currentTarget;
            const kind = el.dataset.kind;
            const idx = Number(el.dataset.index);
            _dragPayload = { kind, idx };
            e.dataTransfer.effectAllowed = 'move';
        }
        function handleSlotDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }
        function handleSlotDrop(e) {
            e.preventDefault();
            const target = e.currentTarget;
            target.classList.remove('drag-over');
            if (!_dragPayload) return;
            const from = _dragPayload;
            const toKind = target.dataset.kind;
            const toIdx = Number(target.dataset.index);

            transferBetweenSlots(from.kind, from.idx, toKind, toIdx);
            _dragPayload = null;
            renderChestUI();
        }

        function transferBetweenSlots(fromKind, fromIdx, toKind, toIdx) {
            // Server-authoritative transfer: send a chest_transfer action and wait for server sync
            if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) {
                if (!_activeChestBuilding) return;
                if (_activeChestBuilding.rewardChestAt + GREG_CHEST_FADE_MS > Date.now()) return;
                const from = fromKind === 'player' ? player.inventory : _activeChestBuilding.inventory;
                const to = toKind === 'player' ? player.inventory : _activeChestBuilding.inventory;
                if (!from[fromIdx]?.type || !to[toIdx]) return;
                const source = from[fromIdx], destination = to[toIdx];
                if (destination.type && destination.type === source.type && source.type !== 'thermal_stone' && !BUILDINGS[source.type]?.durability && !BUILDINGS[source.type]?.duration) {
                    destination.count = (destination.count || 0) + (source.count || 0);
                    from[fromIdx] = { type: null, count: 0 };
                } else {
                    from[fromIdx] = destination;
                    to[toIdx] = source;
                }
                if (_activeChestBuilding.rewardChest &&
                    !_activeChestBuilding.inventory.some(slot => slot?.type && (slot.count ?? 1) > 0)) {
                    buildings = buildings.filter(building => building !== _activeChestBuilding);
                    closeChest();
                    renderInventory();
                    return;
                }
                renderInventory();
                return;
            }
            if (_activeChestBuilding?.rewardChestAt + GREG_CHEST_FADE_MS > Date.now()) return;
            const chestX = _activeChestBuilding?.x, chestY = _activeChestBuilding?.y;
            gameSocket.send(JSON.stringify({ type: 'world:action', playerId: onlinePlayerId, action: { type: 'chest_transfer', payload: { chestX, chestY, fromKind, fromIdx, toKind, toIdx } } }));
            // Optimistically close UI until server responds with authoritative update
            // closeChest(); // optional: keep open while waiting
        }

        // Close chest if clicking outside canvas (optional)
        document.addEventListener('keydown', e => { if (e.code === 'Escape' && document.getElementById('chest-menu-overlay')?.style.display === 'flex') closeChest(); });


        function cancelPlacement() {
            buildMode = 'none'; isPlacing = false;
            const controls = document.getElementById('placement-controls');
            if (controls) controls.style.display = 'none';
        }

        function showItemTooltip(text, clientX, clientY) {
            const tooltip = document.getElementById('item-tooltip');
            if (!tooltip) return;
            if (!text) {
                hideItemTooltip();
                return;
            }
            tooltip.textContent = text;
            tooltip.style.display = 'block';
            tooltip.style.left = `${Math.max(4, Math.min(clientX + 14, window.innerWidth - 240))}px`;
            tooltip.style.top = `${Math.min(clientY + 16, window.innerHeight - 70)}px`;
        }

        function hideItemTooltip() {
            const tooltip = document.getElementById('item-tooltip');
            if (tooltip) tooltip.style.display = 'none';
        }

        function updatePlacementMouse(e) {
            const rect = canvas.getBoundingClientRect();
            if (thirdPerson3D) {
                const point = screenToWorld3D((e.clientX - rect.left) / globalScale, (e.clientY - rect.top) / globalScale);
                placementMouse = { x: Math.floor(point.x / cellSize) * cellSize, y: Math.floor(point.y / cellSize) * cellSize };
                return;
            }
            const worldX = (e.clientX - rect.left) / globalScale + camera.x;
            const worldY = (e.clientY - rect.top) / globalScale + camera.y;
            placementMouse = { x: Math.floor(worldX / 40) * 40, y: Math.floor(worldY / 40) * 40 };
            const hoveredNode = [...resourceNodes].reverse().find(node =>
                Math.abs(node.x + 20 - worldX) <= (node.pickup ? (TOKEN_DEFINITIONS[node.type] ? 26 : 16) : 26) &&
                Math.abs(node.y + 20 - worldY) <= (node.pickup ? (TOKEN_DEFINITIONS[node.type] ? 26 : 16) : 26)
            );
            showItemTooltip(
                hoveredNode
                    ? hoveredNode.pickup
                        ? ITEM_DESCRIPTIONS[hoveredNode.type]
                        : NODE_DESCRIPTIONS[hoveredNode.type] || ITEM_DESCRIPTIONS[hoveredNode.type]
                    : null,
                e.clientX,
                e.clientY
            );
        }

        function setFirstPersonMode(enabled) {
            const changed = thirdPerson3D !== !!enabled;
            thirdPerson3D = !!enabled;
            if (changed) stopMovement();
            if (!thirdPerson3D) releaseFirstPersonPointerLock();
            updateFirstPersonHint();
        }

        function releaseFirstPersonPointerLock() {
            if (document.pointerLockElement === canvas) document.exitPointerLock();
        }

        function updateFirstPersonHint() {
            const hint = document.getElementById('first-person-hint');
            if (!hint) return;
            const active = thirdPerson3D && ['GAME', 'PLAYING'].includes(currentState) && !isAnyOverlayActive();
            hint.style.display = active && document.pointerLockElement !== canvas ? 'block' : 'none';
            if (active && !canvas.requestPointerLock) hint.textContent = 'FIRST-PERSON MODE NEEDS POINTER LOCK, WHICH THIS BROWSER DOES NOT SUPPORT';
        }

        function handleFirstPersonMouseLook(event) {
            if (!thirdPerson3D || document.pointerLockElement !== canvas) return;
            firstPersonYaw += event.movementX * 0.0025;
            firstPersonPitch = Math.max(-0.65, Math.min(1.15, firstPersonPitch + event.movementY * 0.0025));
        }

        let lastThermalRenderAt = 0, lastColdMessageAt = 0;
