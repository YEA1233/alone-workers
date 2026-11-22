        function wolfCountForDay(day, wildlife) {
            if (!(wildlife > 0) || day < WOLF_FIRST_DAY) return 0;
            const base = 1 + Math.floor((day - WOLF_FIRST_DAY) / 5);
            return Math.min(WOLF_CAP_PER_PLAYER, Math.max(1, Math.round(base * wildlife)));
        }
        function wolfHpForDay(day) { return Math.min(30, Math.round(10 + day * 1.5)); }
        function wolfDamageForDay(day) { return Math.min(5, 3 + Math.floor(day / 8)); }
        function wolfSpeedForDay(day) { return Math.min(150, (1.7 + 0.04 * day) * 60); }
        function createSoloAlphaWolf(x, y) {
            return {
                id: `solo-alpha-wolf-${Date.now()}-${++soloAlphaWolfSequence}`,
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
        function updateSoloAlphaWolf(alpha) {
            if (alpha.phase === 'stunned') {
                alpha.stunTimer = Math.max(0, alpha.stunTimer - gameFrameDt);
                if (alpha.stunTimer > 0) return;
                alpha.phase = 'summoning';
                alpha.summonTimer = 0;
                alpha.hasSummoned = false;
            }
            const summoned = mobs.some(mob => mob.type === 'wolf' && mob.summonedByAlpha === alpha.id);
            if (alpha.hasSummoned && !summoned) {
                alpha.phase = 'stunned';
                alpha.stunTimer = ALPHA_WOLF_STUN_DURATION;
                displayChat({ name: 'SYSTEM', text: 'The Alpha Wolf is stunned! Strike while it is vulnerable!', color: '#ffcc66' });
                return;
            }
            alpha.summonTimer = Math.max(0, alpha.summonTimer - gameFrameDt);
            if (!alpha.summonTimer && mobs.length < 100) {
                for (let i = 0; i < ALPHA_WOLF_SUMMON_COUNT && mobs.length < 100; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const radius = 100 + Math.random() * 120;
                    mobs.push({
                        id: `${alpha.id}-summon-${Date.now()}-${i}`,
                        type: 'wolf',
                        emoji: '🐺',
                        x: Math.max(0, Math.min(worldWidth - 40, alpha.x + Math.cos(angle) * radius)),
                        y: Math.max(0, Math.min(worldHeight - 40, alpha.y + Math.sin(angle) * radius)),
                        hp: ALPHA_WOLF_SUMMON_HP,
                        maxHp: ALPHA_WOLF_SUMMON_HP,
                        speed: ALPHA_WOLF_SUMMON_SPEED,
                        damage: ALPHA_WOLF_SUMMON_DAMAGE,
                        summonedByAlpha: alpha.id
                    });
                }
                alpha.hasSummoned = true;
                alpha.summonTimer = ALPHA_WOLF_SUMMON_INTERVAL;
                displayChat({ name: 'SYSTEM', text: 'The Alpha Wolf summons a pack of stronger wolves!', color: '#ff6666' });
            }
            const dx = player.x - alpha.x, dy = player.y - alpha.y, distance = Math.hypot(dx, dy);
            if (distance > 180) {
                const step = Math.min(distance - 180, 0.9 * gameFrameDt * 60);
                alpha.x += dx / distance * step;
                alpha.y += dy / distance * step;
            }
        }
        const LIQUID_BIOMES = new Set(['OCEAN', 'LAKE', 'RIVER', 'BAY', 'GULF', 'SHALLOW_WATER']);
        const NODE_TOOL_NEEDED = { wood: 'axe', tree: 'axe', big_rock: 'pickaxe', flint_node: 'pickaxe', rock: 'pickaxe', stone: 'pickaxe', iron: 'pickaxe', stump: 'shovel' };
        const TOOL_HINTS = {
            axe: 'Select an Axe (🪓) on the hotbar.',
            pickaxe: 'Select a Pickaxe (⛏️) on the hotbar.',
            shovel: 'Select a Shovel on the hotbar.'
        };

        let autoKeys = { up: false, down: false, left: false, right: false };   // virtual key presses from the auto-walk
        let autoTask = null;        // click task: { kind: 'node' | 'mob', id, ref, startType }
        let autoPath = null;        // { points, index, goalX, goalY, at }
        let autoStuck = { x: 0, y: 0, at: 0, count: 0 };
        let autoMarker = null;      // ring drawn around the current target
        let lastWorkAt = -1e9, lastAttackAt = -1e9, lastAutoHintAt = -1e9;
        let steerAcc = 0, steerHold = 0, steerPressMinor = false;
        let floatingTexts = [];
        const unreachableTargets = new Map();


        // ---------------------------------------------------------
        // small helpers
        // ---------------------------------------------------------
