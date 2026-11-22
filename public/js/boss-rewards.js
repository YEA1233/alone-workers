        function updateSoloGregDeath() {
            const deathAt = mobs.find(mob => mob.type === 'greg' && mob.deathAt && !mob.rewardSpawned);
            if (!deathAt || Date.now() < deathAt.deathAt + GREG_SHAKE_MS + GREG_FADE_MS) return;
            deathAt.rewardSpawned = true;
            const i = mobs.indexOf(deathAt);
            if (i >= 0) mobs.splice(i, 1);
            spawnGregRewardChest(deathAt, deathAt.deathAt + GREG_SHAKE_MS + GREG_FADE_MS);
            playGregVictoryMusic();
        }

        function dropSoloBossToken(tokenKey, x, y) {
            const definition = Object.values(TOKEN_DEFINITIONS).find(token => token.key === tokenKey);
            if (!definition || soloTokenDrops[tokenKey] || soloTokenInventory[tokenKey]) return false;
            soloTokenDrops[tokenKey] = true;
            resourceNodes.push({ x, y, type: `${tokenKey}_token`, icon: definition.icon, pickup: true });
            return true;
        }

        function spawnGregRewardChest(greg, revealAt = Date.now()) {
            const inventory = [
                { type: 'wood', count: 100 + Math.floor(Math.random() * 101) },
                { type: 'stone', count: 100 },
                { type: 'flint', count: 100 },
                { type: 'twigs', count: 100 },
                { type: 'carrots', count: 50 },
                { type: 'iron', count: 25 },
                { type: 'amber', count: 3 },
                { type: 'paste', count: 20 },
                { type: 'sword', count: 1, duration: BUILDINGS.sword.durability, maxDuration: BUILDINGS.sword.durability },
                { type: 'lantern', count: 1, duration: BUILDINGS.lantern.duration, maxDuration: BUILDINGS.lantern.duration },
                { type: 'ivory_shield', count: 1, duration: BUILDINGS.ivory_shield.durability, maxDuration: BUILDINGS.ivory_shield.durability }
            ];
            const directions = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]];
            const spot = directions
                .map(([dx, dy]) => ({
                    x: Math.round((greg.x + dx * cellSize) / cellSize) * cellSize,
                    y: Math.round((greg.y + dy * cellSize) / cellSize) * cellSize
                }))
                .find(point => {
                    const gx = Math.floor(point.x / cellSize), gy = Math.floor(point.y / cellSize);
                    return BIOMES[worldGrid[gy]?.[gx]]?.passable &&
                        !buildings.some(building => building.x === point.x && building.y === point.y);
                }) || {
                    x: Math.round((greg.x + cellSize) / cellSize) * cellSize,
                    y: Math.round(greg.y / cellSize) * cellSize
                };
            buildings.push({
                id: `greg-reward-${Date.now()}`,
                x: spot.x,
                y: spot.y,
                type: 'chest',
                hp: 400,
                maxHp: 400,
                rewardChest: true,
                rewardChestAt: revealAt,
                inventory: [...inventory, ...Array.from({ length: 5 }, () => ({ type: null, count: 0 }))]
            });
        }

        function updateChargeMob(mob) {
            if (mob.deathAt) return;
            const isGreg = mob.type === 'greg';
            const center = playerCenter();
            const mobPosition = mobCenter(mob);
            const dxToPlayer = center.x - mobPosition.x, dyToPlayer = center.y - mobPosition.y;
            const distance = Math.hypot(dxToPlayer, dyToPlayer);
            const arena = caveLayerLocal?.gregArena;
            if (isGreg && gregArenaLocked && !insideGregArena(center.x, center.y)) gregArenaLocked = false;

            if (isGreg && !insideGregArena(center.x, center.y)) {
                mob.chargeState = 'disengaged';
                mob.hp = Math.min(mob.maxHp, mob.hp + 20 * gameFrameDt);
                if (arena) {
                    const homeX = (arena.x - 1) * cellSize, homeY = (arena.y - 1) * cellSize;
                    const dx = homeX - mob.x, dy = homeY - mob.y, homeDistance = Math.hypot(dx, dy);
                    const step = Math.min(homeDistance, 2.5);
                    if (homeDistance > 0) {
                        mob.x += dx / homeDistance * step;
                        mob.y += dy / homeDistance * step;
                    }
                }
                return;
            }
            if (isGreg && mob.chargeState === 'disengaged') {
                mob.chargeState = 'idle';
                mob.chargeTimer = 0;
            }

            if (!isGreg && mob.type === 'elephant' && gregDefeated && !mob.aggro && distance <= 5 * cellSize) {
                mob.aggro = true;
            }
            const targetInRange = isGreg
                ? insideGregArena(center.x, center.y) && distance <= 900
                : mob.type === 'elephant' && gregDefeated && mob.aggro && distance <= 5 * cellSize;
            if (isGreg && targetInRange && !gregArenaLocked) {
                gregArenaLocked = true;
                displayChat({ name: 'SYSTEM', text: 'Greg has sealed the arena. Defeat him or wait until no one remains inside.', color: '#ffcc00' });
            }

            if (mob.chargeState === 'stunned' || mob.chargeState === 'recover') {
                mob.chargeTimer = Math.max(0, (mob.chargeTimer || 0) - 1);
                if (!mob.chargeTimer) {
                    mob.chargeState = 'idle';
                    mob.chargeCooldown = isGreg ? 30 : 45;
                }
                return;
            }
            if (mob.chargeState === 'windup') {
                mob.chargeTimer = Math.max(0, (mob.chargeTimer || 0) - 1);
                if (!mob.chargeTimer) {
                    const length = Math.max(1, distance);
                    mob.chargeDx = dxToPlayer / length;
                    mob.chargeDy = dyToPlayer / length;
                    mob.chargeRemaining = isGreg ? 720 : 460;
                    mob.chargeSpeed = isGreg ? 7.5 : 6.5;
                    mob.chargeState = 'charging';
                }
                return;
            }
            if (mob.chargeState === 'charging') {
                const step = Math.min(mob.chargeSpeed || 7, mob.chargeRemaining || 0);
                mob.x += (mob.chargeDx || 0) * step;
                mob.y += (mob.chargeDy || 0) * step;
                mob.chargeRemaining -= step;
                if (isGreg && arena) {
                    mob.x = Math.max((arena.x - 10) * cellSize, Math.min((arena.x + 7) * cellSize, mob.x));
                    mob.y = Math.max((arena.y - 10) * cellSize, Math.min((arena.y + 7) * cellSize, mob.y));
                }
                const chargeCenter = mobCenter(mob);
                if (isGreg
                    ? Math.abs(center.x - chargeCenter.x) <= 60 + 13 && Math.abs(center.y - chargeCenter.y) <= 60 + 13
                    : Math.hypot(center.x - chargeCenter.x, center.y - chargeCenter.y) <= 34) {
                    if (!isGreg || insideGregArena(center.x, center.y)) damagePlayer(isGreg ? 20 : 10);
                    mob.chargeState = 'recover';
                    mob.chargeTimer = 24;
                } else if (mob.chargeRemaining <= 0) {
                    mob.chargeState = 'stunned';
                    mob.chargeTimer = isGreg ? 180 : 120;
                    if (isGreg) floatText(chargeCenter.x, mob.y - 12, 'GREG IS STUNNED!', '#fff2a1');
                }
                return;
            }
            if (targetInRange && (mob.chargeCooldown || 0) <= 0) {
                mob.chargeState = 'windup';
                mob.chargeTimer = isGreg ? 50 : 38;
                floatText(mobPosition.x, mob.y - 12, '!!', '#ffcc00');
                return;
            }
            if (mob.chargeCooldown > 0) mob.chargeCooldown--;
            if (!isGreg && gregDefeated && mob.aggro) {
                if (distance > 70) {
                    const step = Math.min(distance - 70, 2.5);
                    mob.x += dxToPlayer / Math.max(distance, 1) * step;
                    mob.y += dyToPlayer / Math.max(distance, 1) * step;
                }
                return;
            }
            if (isGreg && arena) {
                mob.x = Math.max((arena.x - 10) * cellSize, Math.min((arena.x + 10) * cellSize - cellSize, mob.x));
                mob.y = Math.max((arena.y - 10) * cellSize, Math.min((arena.y + 10) * cellSize - cellSize, mob.y));
            }

            if (Math.random() < 0.01) {
                const ntx = mob.x + (Math.random() - 0.5) * 150;
                const nty = mob.y + (Math.random() - 0.5) * 150;
                if (BIOMES[getBiomeAtWorldPos(ntx, nty)]?.passable) {
                    mob.tx = ntx;
                    mob.ty = nty;
                }
            }
            const dx = (mob.tx ?? mob.x) - mob.x, dy = (mob.ty ?? mob.y) - mob.y, roamDistance = Math.hypot(dx, dy);
            if (roamDistance > 1) {
                mob.x += dx / roamDistance * 0.5;
                mob.y += dy / roamDistance * 0.5;
            }
        }

        function performTaskAction(target, kind) {
            const now = performance.now();

            if (kind === 'cave_enter' || kind === 'cave_exit') {
                if (now - lastWorkAt < 260) return;
                lastWorkAt = now;
                if (isOnlineActive()) {
                    sendWorldAction(kind, { buildingId: target.id });
                } else if (kind === 'cave_enter') {
                    enterCaveLocal(target);
                } else {
                    exitCaveLocal(target);
                }
                cancelAutoTask();
                return;
            }

            if (kind === 'boat') {
                if (now - lastWorkAt < 260) return;
                lastWorkAt = now;
                if (isOnlineActive()) {
                    sendWorldAction('board', { x: target.x, y: target.y });
                } else {
                    player.inBoat = true;
                    player.boatId = target.id ?? `${target.x},${target.y}`;
                    displayChat({ name: 'SYSTEM', text: 'You board the boat. Move across the water, then press SPACE on land to leave it.', color: '#2ecc71' });
                }
                cancelAutoTask();
                return;
            }

            if (kind === 'building') {
                if (now - lastWorkAt < 260) return;
                if (getActiveItem()?.type !== 'hammer') {
                    autoHint('Select a Hammer (🔨) on the hotbar.');
                    cancelAutoTask();
                    return;
                }
                if (target.type === 'chest' && target.inventory?.some(slot => slot?.type && (slot.count ?? 1) > 0)) {
                    floatText(target.x + 20, target.y - 6, 'Empty chest first', '#ffa500');
                    cancelAutoTask();
                    return;
                }
                lastWorkAt = now;
                if (isOnlineActive()) {
                    sendWorldAction('break', {
                        buildingId: target.id,
                        slot: selectedHotbarIndex
                    });
                } else {
                    dismantleBuildingLocal(target);
                }
                return;
            }

            if (kind === 'mob') {
                if (now - lastAttackAt < 260) return;
                if (!isWeapon(getActiveItem())) {
                    autoHint('Select an Axe, Pickaxe, or Sword to fight.');
                    if (autoTask) cancelAutoTask();
                    return;
                }
                lastAttackAt = now;
                noteMusicActivity('combat');
                if (isOnlineActive()) {
                    const c = mobCenter(target);
                    sendWorldAction('attack', { x: c.x, y: c.y });
                } else {
                    attackMobLocal(target);
                }
                return;
            }

            if (now - lastWorkAt < 130) return;
            const held = getActiveItem() ? getActiveItem().type : null;

            if (!target.pickup) {
                const needed = NODE_TOOL_NEEDED[target.type];
                const shaking = isTree(target) && held !== 'axe';
                if (shaking) {
                    if (treeShakesLeft(target) <= 0) {
                        if (autoTask) cancelAutoTask(); else markUnreachable(target, 'node', 8000);
                        return;
                    }
                } else if (needed && held !== needed) {
                    autoHint(TOOL_HINTS[needed]);
                    if (autoTask) cancelAutoTask(); else markUnreachable(target, 'node', 4000);
                    return;
                }
            }

            lastWorkAt = now;
            if (isOnlineActive()) {
                sendWorldAction('harvest', { nodeId: target.id });
            } else {
                const i = resourceNodes.indexOf(target);
                if (i >= 0) handleHarvest(target, i);
            }
        }


        // ---------------------------------------------------------
        // shaking trees by hand (solo; online the server does this)
        // ---------------------------------------------------------
        function spawnPickupNearLocal(node, type, icon) {
            const gx = Math.floor(node.x / TILE), gy = Math.floor(node.y / TILE);
            const options = [];
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const x = gx + dx, y = gy + dy;
                    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
                    const biome = worldGrid[y] && worldGrid[y][x];
                    if (!biome || LIQUID_BIOMES.has(biome)) continue;
                    const cx = x * TILE, cy = y * TILE;
                    if (buildings.some(b => b.x === cx && b.y === cy)) continue;
                    if (resourceNodes.some(n => !n.pickup && n.x === cx && n.y === cy)) continue;
                    options.push({ x: cx, y: cy });
                }
            }
            const spot = options.length ? options[Math.floor(Math.random() * options.length)] : { x: node.x, y: node.y };
            resourceNodes.push({ x: spot.x, y: spot.y, type, icon, pickup: true });
        }

        function shakeTreeLocal(node) {
            if (node.shakeDay !== dayCount) { node.shakeDay = dayCount; node.shakes = 0; }
            if (node.shakes >= SHAKES_PER_DAY) {
                floatText(node.x + 20, node.y - 6, 'Nothing left today', '#aaaaaa');
                return;
            }
            node.shakes++;
            const found = [];
            if (Math.random() < SHAKE_TWIG_CHANCE) { spawnPickupNearLocal(node, 'twigs', '🥢'); found.push('🥢'); }
            if (Math.random() < SHAKE_ACORN_CHANCE) { spawnPickupNearLocal(node, 'acorn', '🌰'); found.push('🌰'); }
            floatText(node.x + 20, node.y - 6, `${found.length ? found.join(' ') : 'nothing'} (${SHAKES_PER_DAY - node.shakes} left)`, found.length ? '#2ecc71' : '#aaaaaa');
        }


        // ---------------------------------------------------------
        // the per-frame update (call once per frame, before movement)
        // ---------------------------------------------------------
        function updateAutoTask() {
            if (player.isDowned) { cancelAutoTask(); return; }

            const manual = manualMoveKeys();
            const attackHeld = !!keys['KeyF'];
            const workHeld = !!keys['Space'] && !player.inBoat;

            let target = null, kind = 'node';

            if (attackHeld) {                      // holding F beats any click task
                autoTask = null;
                kind = 'mob';
                target = findAttackTarget();
            } else if (autoTask) {
                if (manual) { cancelAutoTask(); return; }
                kind = autoTask.kind;
                target = resolveTaskTarget();
                if (!target || (kind === 'node' && taskNodeFinished(target))) { cancelAutoTask(); return; }
            } else if (workHeld) {
                target = findWorkTarget();
            }

            if (!target) {
                autoMarker = null;
                autoPath = null;
                stopAutoSteer();
                return;
            }

            const boatPoint = kind === 'boat' ? boatApproachPoint(target) : null;
            if (kind === 'boat' && !boatPoint) {
                autoHint('Move the boat beside a shore to board it.');
                cancelAutoTask();
                return;
            }
            const c = kind === 'mob' ? mobCenter(target) : kind === 'boat' ? boatPoint : nodeCenter(target);
            autoMarker = { x: c.x, y: c.y, kind };
            const reach = kind === 'mob' ? REACH_ATTACK : kind === 'boat' ? 10 : REACH_WORK;
            const pc = playerCenter();

            if (Math.hypot(c.x - pc.x, c.y - pc.y) <= reach) {
                stopAutoSteer();
                autoPath = null;
                performTaskAction(target, kind);
                return;
            }

            if (manual) { stopAutoSteer(); return; }     // you are steering yourself; we only act when you are in reach

            const status = steerToward(c.x, c.y, reach);
            if (status === 'blocked' || status === 'stuck') {
                floatText(pc.x, pc.y - 26, "Can't reach that", '#ff8888');
                markUnreachable(target, kind);
                const wasClickTask = !!autoTask;
                stopAutoSteer();
                autoPath = null;
                if (wasClickTask) cancelAutoTask();
            }
        }


        // ---------------------------------------------------------
        // drawing: target ring + floating text (call from draw() while the world transform is active)
        // ---------------------------------------------------------
        function drawAutoEffects() {
            if (autoMarker) {
                ctx.save();
                ctx.strokeStyle = autoMarker.kind === 'mob' ? 'rgba(255,90,90,0.9)' : 'rgba(255,204,0,0.9)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(autoMarker.x, autoMarker.y, 26 + Math.sin(performance.now() / 120) * 2, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }

            const nowMs = performance.now();
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = 'bold 14px Segoe UI';
            for (let i = floatingTexts.length - 1; i >= 0; i--) {
                const f = floatingTexts[i];
                const age = nowMs - f.born;
                if (age > 1500) { floatingTexts.splice(i, 1); continue; }
                const y = f.y - age * 0.03;
                ctx.globalAlpha = Math.max(0, 1 - age / 1500);
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                ctx.strokeText(f.text, f.x, y);
                ctx.fillStyle = f.color;
                ctx.fillText(f.text, f.x, y);
            }
            ctx.restore();
        }
        function gameLoop() {
            try { update(); draw(); } catch (error) { console.error('Frame error:', error); }
            requestAnimationFrame(gameLoop);
        }
        window.onload = init;
