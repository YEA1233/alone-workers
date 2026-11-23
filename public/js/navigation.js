        function playerCenter() { return { x: player.x + 13, y: player.y + 13 }; }
        function nodeCenter(n) { return { x: n.x + 20, y: n.y + 20 }; }
        function mobSize(m) { return m.type === 'greg' ? 120 : m.type === 'alpha_wolf' ? 100 : 40; }
        function mobCenter(m) { const size = mobSize(m); return { x: m.x + size / 2, y: m.y + size / 2 }; }
        function insideGregArena(x, y) {
            const arena = isOnlineActive() ? gregArenaOnline : caveLayerLocal?.gregArena;
            if (!arena) return false;
            const tileX = Math.floor(x / cellSize), tileY = Math.floor(y / cellSize);
            return tileX >= arena.x - 10 && tileX < arena.x + 10 &&
                tileY >= arena.y - 10 && tileY < arena.y + 10;
        }
        function isWeapon(item) { return !!item && ['axe', 'pickaxe', 'sword'].includes(item.type); }
        function isTree(n) { return n.type === 'wood' || n.type === 'tree'; }

        function treeShakesLeft(n) {
            const used = n.shakeDay === dayCount ? (n.shakes || 0) : 0;
            return Math.max(0, SHAKES_PER_DAY - used);
        }

        function manualMoveKeys() {
            return !!(keys['KeyW'] || keys['ArrowUp'] || keys['KeyS'] || keys['ArrowDown'] ||
                keys['KeyA'] || keys['ArrowLeft'] || keys['KeyD'] || keys['ArrowRight']);
        }

        // Your real keys plus the auto-walk's virtual ones (this is what gets sent to the server).
        function effectiveKeys() {
            const out = { ...keys };
            if (autoKeys.up) out.KeyW = true;
            if (autoKeys.down) out.KeyS = true;
            if (autoKeys.left) out.KeyA = true;
            if (autoKeys.right) out.KeyD = true;
            return out;
        }

        // Keys only give 8 directions. To walk at any angle we press the "major" axis all the time and the "minor" axis
        // for a fraction of the time (error diffusion), so the average heading is exact and we don't drift into corners.
        // The pattern is re-decided every 3rd frame so it still works at the online input rate (20 messages a second).
        function setAutoSteer(vx, vy) {
            if (thirdPerson3D) {
                const forwardX = Math.cos(firstPersonYaw), forwardY = Math.sin(firstPersonYaw);
                const rightX = -forwardY, rightY = forwardX;
                const forward = vx * forwardX + vy * forwardY;
                vx = vx * rightX + vy * rightY;
                vy = -forward;
            }
            const ax = Math.abs(vx), ay = Math.abs(vy);
            if (ax < 4 && ay < 4) { autoKeys.up = autoKeys.down = autoKeys.left = autoKeys.right = false; return; }

            const major = Math.max(ax, ay), minor = Math.min(ax, ay);
            const r = minor / major;
            const duty = r / (0.7071 + 0.2929 * r);        // share of time the minor key must be down to get ratio r
            if (steerHold <= 0) {
                steerAcc += duty;
                steerPressMinor = steerAcc >= 1;
                if (steerPressMinor) steerAcc -= 1;
                steerHold = 3;
            }
            steerHold--;

            const xIsMajor = ax >= ay;
            const pressX = xIsMajor || steerPressMinor;
            const pressY = !xIsMajor || steerPressMinor;
            autoKeys.right = pressX && vx > 0;
            autoKeys.left = pressX && vx < 0;
            autoKeys.down = pressY && vy > 0;
            autoKeys.up = pressY && vy < 0;
        }

        function stopAutoSteer() {
            autoKeys.up = autoKeys.down = autoKeys.left = autoKeys.right = false;
            steerAcc = 0; steerHold = 0; steerPressMinor = false;
            autoStuck.at = 0;
            autoStuck.count = 0;
        }

        function cancelAutoTask() {
            autoTask = null;
            autoPath = null;
            autoMarker = null;
            stopAutoSteer();
        }

        function requestBoatDisembark() {
            if (!player.inBoat) return;
            if (isOnlineActive()) {
                sendWorldAction('disembark');
                return;
            }
            if (LIQUID_BIOMES.has(getBiomeAtWorldPos(player.x, player.y))) {
                displayChat({ name: 'SYSTEM', text: 'Move the boat to land before leaving it.', color: '#ffa500' });
                return;
            }
            player.inBoat = false;
            player.boatId = null;
            displayChat({ name: 'SYSTEM', text: 'You step off the boat.', color: '#2ecc71' });
        }

        function floatText(x, y, text, color = '#ffffff') {
            floatingTexts.push({ x, y, text: String(text), color, born: performance.now() });
            if (floatingTexts.length > 40) floatingTexts.shift();
        }

        function playTokenPickup(tokenKey) {
            const definition = Object.values(TOKEN_DEFINITIONS).find(token => token.key === tokenKey);
            if (!definition) return;
            const audio = TOKEN_PICKUP_AUDIO.get(tokenKey);
            if (audio && soundSettings.effects > 0) {
                audio.currentTime = 0;
                audio.volume = soundSettings.effects;
                audio.play().catch(error => console.warn(`Could not play token pickup sound "${definition.audio}":`, error));
            }
            showRewardBurst(`${definition.icon}`, `${definition.label} · WORLD TOKEN`, definition.color, definition.glow);
        }

        function showRewardBurst(iconText, labelText, color, glow) {
            const burst = document.createElement('div');
            burst.className = 'token-pickup-burst';
            burst.style.setProperty('--token-color', color);
            burst.style.setProperty('--token-glow', glow);
            burst.setAttribute('role', 'status');
            const icon = document.createElement('span');
            icon.className = 'token-icon';
            icon.textContent = iconText;
            const label = document.createElement('span');
            label.className = 'token-label';
            label.textContent = labelText;
            burst.append(icon, label);
            document.getElementById('token-pickup-layer')?.appendChild(burst);
            window.setTimeout(() => burst.remove(), 3700);
        }

        function autoHint(text) {
            const now = performance.now();
            if (now - lastAutoHintAt < 2000) return;
            lastAutoHintAt = now;
            const pc = playerCenter();
            floatText(pc.x, pc.y - 30, text, '#ffa500');
        }

        function targetKey(target, kind) { return target.id != null ? `${kind}${target.id}` : target; }
        function markUnreachable(target, kind, ms = 6000) { unreachableTargets.set(targetKey(target, kind), performance.now() + ms); }
        function isUnreachable(target, kind) {
            const key = targetKey(target, kind);
            const until = unreachableTargets.get(key);
            if (until === undefined) return false;
            if (performance.now() > until) { unreachableTargets.delete(key); return false; }
            return true;
        }


        // ---------------------------------------------------------
        // pathfinding (A* on the 40px tile grid; avoids ocean and walls, the same things movement collides with)
        // ---------------------------------------------------------
        function buildWallSet() {
            const set = new Set();
            for (const b of buildings) if (b.type === 'wall') set.add(Math.floor(b.y / TILE) * 4096 + Math.floor(b.x / TILE));
            return set;
        }

        function makeBlockedTest(walls) {
            const inBoat = player.inBoat;
            const tileBlocked = (tx, ty) =>
                tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS ||
                (!inBoat && worldGrid[ty] && worldGrid[ty][tx] === 'OCEAN') ||
                walls.has(ty * 4096 + tx);

            // A point test with a little slack, so smoothed paths don't graze walls or the shoreline.
            const pointBlocked = (x, y, margin = 10) => {
                const probes = [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]];
                for (const [ox, oy] of probes) {
                    if (tileBlocked(Math.floor((x + ox) / TILE), Math.floor((y + oy) / TILE))) return true;
                }
                return false;
            };
            return { tileBlocked, pointBlocked };
        }

        function lineClear(ax, ay, bx, by, test) {
            const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 8));
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                if (test.pointBlocked(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
            }
            return true;
        }

        function heapPush(heap, item) {
            heap.push(item);
            let i = heap.length - 1;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (heap[parent][0] <= heap[i][0]) break;
                [heap[parent], heap[i]] = [heap[i], heap[parent]];
                i = parent;
            }
        }

        function heapPop(heap) {
            const top = heap[0];
            const last = heap.pop();
            if (heap.length) {
                heap[0] = last;
                let i = 0;
                for (; ;) {
                    const l = 2 * i + 1, r = l + 1;
                    let m = i;
                    if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                    if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                    if (m === i) break;
                    [heap[m], heap[i]] = [heap[i], heap[m]];
                    i = m;
                }
            }
            return top;
        }

        // Returns a list of waypoints (world pixels) or null if there is no way there.
        function findPath(sx, sy, gx, gy, test) {
            const { tileBlocked } = test;
            const start = { x: Math.floor(sx / TILE), y: Math.floor(sy / TILE) };
            let goal = { x: Math.floor(gx / TILE), y: Math.floor(gy / TILE) };
            if (start.x < 0 || start.y < 0 || start.x >= COLS || start.y >= ROWS) return null;

            // Target on a blocked tile (e.g. a mob on the shoreline): aim for the nearest open tile instead.
            if (tileBlocked(goal.x, goal.y)) {
                let found = null;
                for (let r = 1; r <= 3 && !found; r++) {
                    let best = Infinity;
                    for (let dy = -r; dy <= r; dy++) {
                        for (let dx = -r; dx <= r; dx++) {
                            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                            const x = goal.x + dx, y = goal.y + dy;
                            if (tileBlocked(x, y)) continue;
                            const d = (x - start.x) ** 2 + (y - start.y) ** 2;
                            if (d < best) { best = d; found = { x, y }; }
                        }
                    }
                }
                if (!found) return null;
                goal = found;
            }

            // Look in a window around start and goal first; if there is no way through, widen the window once.
            // (The wide search is greedier: a slightly longer route is fine, a long pause is not.)
            for (const [PAD, BUDGET, GREED] of [[25, 9000, 1], [70, 26000, 1.8]]) {
                const tiles = searchTiles(start, goal, PAD, BUDGET, GREED, tileBlocked);
                if (tiles) return smoothPath(tiles, start, test);
            }
            return null;
        }

        function searchTiles(start, goal, PAD, BUDGET, GREED, tileBlocked) {
            const minX = Math.max(0, Math.min(start.x, goal.x) - PAD), maxX = Math.min(COLS - 1, Math.max(start.x, goal.x) + PAD);
            const minY = Math.max(0, Math.min(start.y, goal.y) - PAD), maxY = Math.min(ROWS - 1, Math.max(start.y, goal.y) + PAD);
            const W = maxX - minX + 1, H = maxY - minY + 1;
            const idx = (x, y) => (y - minY) * W + (x - minX);

            const cost = new Float32Array(W * H).fill(Infinity);
            const from = new Int32Array(W * H).fill(-1);
            const closed = new Uint8Array(W * H);
            const heap = [];
            const h = (x, y) => {
                const dx = Math.abs(x - goal.x), dy = Math.abs(y - goal.y);
                return GREED * (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy));
            };

            cost[idx(start.x, start.y)] = 0;
            heapPush(heap, [h(start.x, start.y), start.x, start.y]);
            const goalIdx = idx(goal.x, goal.y);
            let expansions = 0;

            while (heap.length && expansions < BUDGET) {
                const [, cx, cy] = heapPop(heap);
                const ci = idx(cx, cy);
                if (closed[ci]) continue;
                closed[ci] = 1;
                if (ci === goalIdx) break;
                expansions++;

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (!dx && !dy) continue;
                        const nx = cx + dx, ny = cy + dy;
                        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
                        if (tileBlocked(nx, ny)) continue;
                        if (dx && dy && (tileBlocked(cx + dx, cy) || tileBlocked(cx, cy + dy))) continue;   // no squeezing past corners
                        const ni = idx(nx, ny);
                        if (closed[ni]) continue;
                        const c = cost[ci] + (dx && dy ? 1.4142 : 1);
                        if (c < cost[ni]) {
                            cost[ni] = c;
                            from[ni] = ci;
                            heapPush(heap, [c + h(nx, ny), nx, ny]);
                        }
                    }
                }
            }
            if (cost[goalIdx] === Infinity) return null;

            const tiles = [];
            for (let i = goalIdx; i !== -1; i = from[i]) tiles.push({ x: minX + (i % W), y: minY + Math.floor(i / W) });
            tiles.reverse();
            tiles.shift();   // we are already standing on the first tile
            return tiles;
        }

        // Straighten the path: skip waypoints that have a clear line of sight.
        function smoothPath(tiles, start, test) {
            const pts = tiles.map(t => ({ x: t.x * TILE + 20, y: t.y * TILE + 20 }));
            const out = [];
            let anchor = { x: start.x * TILE + 20, y: start.y * TILE + 20 };
            let i = 0;
            while (i < pts.length) {
                let far = i;
                for (let j = Math.min(pts.length - 1, i + 16); j > i; j--) {     // look at most 16 tiles ahead
                    if (lineClear(anchor.x, anchor.y, pts[j].x, pts[j].y, test)) { far = j; break; }
                }
                out.push(pts[far]);
                anchor = pts[far];
                i = far + 1;
            }
            return out;
        }

        function planPath(sx, sy, tx, ty) {
            const test = makeBlockedTest(buildWallSet());
            if (lineClear(sx, sy, tx, ty, test)) return [{ x: tx, y: ty }];   // nothing in the way
            const path = findPath(sx, sy, tx, ty, test);
            if (!path) return null;
            return path.length ? path : [{ x: tx, y: ty }];
        }

        // Returns 'arrived', 'moving', 'blocked' (no route) or 'stuck' (not getting anywhere).
        function steerToward(tx, ty, reach) {
            const pc = playerCenter();
            if (Math.hypot(tx - pc.x, ty - pc.y) <= reach) { stopAutoSteer(); autoPath = null; return 'arrived'; }

            const now = performance.now();

            // Not making progress for ~3 seconds in a row: give up on this target.
            if (!autoStuck.at || now - autoStuck.at > 1000) {
                if (autoStuck.at && Math.hypot(pc.x - autoStuck.x, pc.y - autoStuck.y) < 10) {
                    autoStuck.count++;
                    autoPath = null;
                } else {
                    autoStuck.count = 0;
                }
                autoStuck.x = pc.x; autoStuck.y = pc.y; autoStuck.at = now;
                if (autoStuck.count >= 3) { autoStuck.count = 0; autoStuck.at = 0; return 'stuck'; }
            }

            // (Re)plan when we have no path, it is old, or the target (a mob) has moved.
            const needPlan = !autoPath || now - autoPath.at > 3000 ||
                (now - autoPath.at > 450 && Math.hypot(autoPath.goalX - tx, autoPath.goalY - ty) > 30);
            if (needPlan) {
                const points = planPath(pc.x, pc.y, tx, ty);
                if (!points) { autoPath = null; return 'blocked'; }
                autoPath = { points, index: 0, goalX: tx, goalY: ty, at: now };
            }

            while (autoPath.index < autoPath.points.length - 1) {
                const p = autoPath.points[autoPath.index];
                if (Math.hypot(p.x - pc.x, p.y - pc.y) < 18) autoPath.index++; else break;
            }
            const wp = autoPath.points[autoPath.index];
            setAutoSteer(wp.x - pc.x, wp.y - pc.y);
            return 'moving';
        }


        // ---------------------------------------------------------
        // choosing targets
        // ---------------------------------------------------------
        function findWorkTarget() {
            const pc = playerCenter();
            const held = getActiveItem() ? getActiveItem().type : null;
            let best = null, bestScore = Infinity;
            let mismatchTool = null, mismatchDist = Infinity;

            for (const n of resourceNodes) {
                const dx = n.x + 20 - pc.x;
                if (dx > WORK_SEARCH || dx < -WORK_SEARCH) continue;
                const dy = n.y + 20 - pc.y;
                if (dy > WORK_SEARCH || dy < -WORK_SEARCH) continue;
                const d = Math.hypot(dx, dy);
                if (d > WORK_SEARCH) continue;

                let score;
                if (n.pickup) {
                    score = d;
                } else if (n.type === 'sapling') {
                    continue;
                } else {
                    const needed = NODE_TOOL_NEEDED[n.type];
                    if (!needed) continue;
                    if (isTree(n) && held !== 'axe') {
                        if (treeShakesLeft(n) <= 0) continue;     // already shaken 3 times today
                        score = d + 80;                           // pick up what already fell before shaking again
                    } else if (held === needed) {
                        score = d;
                    } else {
                        if (d < mismatchDist) { mismatchDist = d; mismatchTool = needed; }
                        continue;
                    }
                }
                if (isUnreachable(n, 'node')) continue;
                if (score < bestScore) { bestScore = score; best = n; }
            }

            if (!best && mismatchTool && mismatchDist <= REACH_WORK + 14) autoHint(TOOL_HINTS[mismatchTool]);
            return best;
        }

        function findAttackTarget() {
            if (!isWeapon(getActiveItem())) { autoHint('Select an Axe, Pickaxe, or Sword to fight.'); return null; }
            const pc = playerCenter();
            let wolf = null, wolfD = Infinity, other = null, otherD = Infinity;
            for (const m of mobs) {
                const center = mobCenter(m);
                const d = Math.hypot(center.x - pc.x, center.y - pc.y);
                if (d > ATTACK_SEARCH) continue;
                if (isUnreachable(m, 'mob')) continue;
                if (m.type === 'wolf') { if (d < wolfD) { wolfD = d; wolf = m; } }
                else if (d < otherD) { otherD = d; other = m; }
            }
            return wolf || other;     // wolves first
        }

        function resolveTaskTarget() {
            if (!autoTask) return null;
            const list = autoTask.kind === 'mob' ? mobs :
                ['building', 'boat', 'cave_enter', 'cave_exit'].includes(autoTask.kind) ? buildings : resourceNodes;
            if (autoTask.id != null) return list.find(o => o.id === autoTask.id) || null;
            if (['building', 'boat', 'cave_enter', 'cave_exit'].includes(autoTask.kind)) {
                return list.find(o => o.x === autoTask.x && o.y === autoTask.y && o.type === autoTask.type) || null;
            }
            return list.includes(autoTask.ref) ? autoTask.ref : null;
        }

        function taskNodeFinished(n) {
            if (n.type !== autoTask.startType) return true;     // tree -> stump, and so on
            const held = getActiveItem() ? getActiveItem().type : null;
            if (!n.pickup && isTree(n) && held !== 'axe' && treeShakesLeft(n) <= 0) return true;   // shaken out for today
            return false;
        }

        // Called when you click something.
        function startNodeTask(n) {
            const held = getActiveItem() ? getActiveItem().type : null;
            if (!n.pickup) {
                if (n.type === 'sapling') { floatText(n.x + 20, n.y - 6, 'Still growing', '#aaaaaa'); return; }
                const needed = NODE_TOOL_NEEDED[n.type];
                if (!needed) return;
                if (isTree(n) && held !== 'axe') {
                    if (treeShakesLeft(n) <= 0) { floatText(n.x + 20, n.y - 6, 'Nothing left today', '#aaaaaa'); return; }
                } else if (held !== needed) {
                    autoHint(TOOL_HINTS[needed]);
                    return;
                }
            }
            autoTask = { kind: 'node', id: n.id != null ? n.id : null, ref: n, startType: n.type };
            autoPath = null;
            stopAutoSteer();
        }

        function boatApproachPoint(boat) {
            const boatX = Math.floor(boat.x / TILE);
            const boatY = Math.floor(boat.y / TILE);
            const candidates = [
                [boatX - 1, boatY], [boatX + 1, boatY],
                [boatX, boatY - 1], [boatX, boatY + 1]
            ];
            const pc = playerCenter();
            return candidates
                .filter(([x, y]) => x >= 0 && y >= 0 && x < COLS && y < ROWS &&
                    BIOMES[worldGrid[y]?.[x]]?.passable &&
                    !LIQUID_BIOMES.has(worldGrid[y]?.[x]) &&
                    Math.hypot((x * TILE + 20) - 13 - boat.x, (y * TILE + 20) - 13 - boat.y) <= 48)
                .map(([x, y]) => ({ x: x * TILE + 20, y: y * TILE + 20 }))
                .sort((a, b) => Math.hypot(a.x - pc.x, a.y - pc.y) - Math.hypot(b.x - pc.x, b.y - pc.y))[0] || null;
        }

        function startBoatTask(boat) {
            autoTask = {
                kind: 'boat',
                id: boat.id ?? null,
                ref: boat,
                x: boat.x,
                y: boat.y,
                type: boat.type
            };
            autoPath = null;
            stopAutoSteer();
        }

        function startMobTask(m) {
            if (!isWeapon(getActiveItem())) { autoHint('Select an Axe, Pickaxe, or Sword to fight.'); return; }
            autoTask = { kind: 'mob', id: m.id != null ? m.id : null, ref: m, startType: m.type };
            triggerPlayerThought('fight');
            autoPath = null;
            stopAutoSteer();
        }

        function startBuildingTask(building) {
            if (building.type === 'cave_entrance' || building.type === 'cave_exit') {
                floatText(building.x + 20, building.y - 6, 'Cave passages cannot be dismantled', '#aaaaaa');
                return;
            }
            if (getActiveItem()?.type !== 'hammer') {
                autoHint('Select a Hammer (🔨) on the hotbar.');
                return;
            }
            if (building.type === 'chest' && building.inventory?.some(slot => slot?.type && (slot.count ?? 1) > 0)) {
                floatText(building.x + 20, building.y - 6, 'Empty chest first', '#ffa500');
                return;
            }
            autoTask = {
                kind: 'building',
                id: building.id ?? null,
                ref: building,
                x: building.x,
                y: building.y,
                type: building.type
            };
            autoPath = null;
            stopAutoSteer();
        }

        function startCaveTask(building, kind) {
            autoTask = { kind, id: building.id ?? null, ref: building, x: building.x, y: building.y, type: building.type };
            autoPath = null;
            stopAutoSteer();
        }

        function dismantleBuildingLocal(building) {
            const index = buildings.indexOf(building);
            if (index < 0) {
                cancelAutoTask();
                return;
            }
            if (building.type === 'chest' && building.inventory?.some(slot => slot?.type && (slot.count ?? 1) > 0)) {
                floatText(building.x + 20, building.y - 6, 'Empty chest first', '#ffa500');
                cancelAutoTask();
                return;
            }

            buildings.splice(index, 1);
            noteMusicActivity('work');
            const recipe = BUILDINGS[building.type];
            const unreturned = [];
            if (!worldConfig.creative && recipe) {
                const metadata = ['hp', 'icon', 'name', 'reqLab', 'radius', 'life', 'desc', 'type', 'duration', 'durability'];
                for (const [key, amount] of Object.entries(recipe)) {
                    if (metadata.includes(key) || typeof amount !== 'number') continue;
                    const refund = Math.floor(amount / 2);
                    if (refund <= 0) continue;
                    const hasStack = player.inventory.some(slot => slot.type === key);
                    const hasSpace = player.inventory.some(slot => !slot.type);
                    if (!hasStack && !hasSpace) {
                        unreturned.push(key);
                        continue;
                    }
                    addToInv(key, refund);
                }
            }
            useToolDurability();
            displayChat({
                name: 'SYSTEM',
                text: unreturned.length
                    ? `${BUILDINGS[building.type]?.name || building.type} dismantled. Inventory full; could not recover ${unreturned.join(', ')}.`
                    : `${BUILDINGS[building.type]?.name || building.type} dismantled.`,
                color: unreturned.length ? '#ffa500' : '#2ecc71'
            });
            cancelAutoTask();
        }


        // ---------------------------------------------------------
        // acting on the target once we are next to it
        // ---------------------------------------------------------
        function attackMobLocal(m) {
            if (m.deathAt) return;
            noteMusicActivity('combat');
            const pc = playerCenter();
            if (m.type === 'greg' && !insideGregArena(pc.x, pc.y)) {
                floatText(mobCenter(m).x, m.y - 4, 'Return to the arena', '#ffcc00');
                return;
            }
            if (m.type === 'alpha_wolf' && m.phase !== 'stunned' && !ohkoEnabled) {
                floatText(mobCenter(m).x, m.y - 4, 'Its pack protects it!', '#ffcc66');
                return;
            }
            const held = getActiveItem()?.type;
            const damage = held === 'sword' ? 20 : 5;
            const actualDamage = ohkoEnabled
                ? 10000
                : m.type === 'greg' && m.chargeState !== 'stunned'
                    ? Math.max(1, Math.floor(damage * 0.2))
                    : damage;
            m.hp -= actualDamage;
            useToolDurability();
            floatText(mobCenter(m).x, m.y - 4, `-${actualDamage}`, '#ff6666');
            if (m.hp <= 0) {
                if (m.type === 'greg') {
                    gregDefeated = true;
                    gregDefeatedDay = dayCount;
                    gregArenaLocked = false;
                    dropSoloBossToken('ivory', m.x + 60, m.y + 60);
                    m.deathAt = Date.now();
                    unlockAchievement('greg');
                    displayChat({ name: 'SYSTEM', text: 'Greg (from Accounting) is defeated. Every elephant is now hostile!', color: '#ff4444' });
                    return;
                }
                if (m.type === 'alpha_wolf') {
                    alphaWolfDefeated = true;
                    dropSoloBossToken('wolf', m.x + 50, m.y + 50);
                    displayChat({ name: 'SYSTEM', text: 'The Alpha Wolf has been defeated. Its howls will trouble you no more.', color: '#2ecc71' });
                }
                if (m.type === 'wolf') { addToInv('stone', 2); unlockAchievement('first-wolf'); }
                const i = mobs.indexOf(m);
                if (i >= 0) mobs.splice(i, 1);
            }
        }
