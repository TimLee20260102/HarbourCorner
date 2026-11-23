const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const publicDir = fs.existsSync(path.join(__dirname, 'index.html'))
    ? __dirname
    : path.resolve(__dirname, '..');

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});
app.use(express.static(publicDir));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const wardLights = {
    '床位 101': { id: '101', name: '微光 101', x: 25, y: 30, isOn: false },
    '床位 102': { id: '102', name: '微光 102', x: 50, y: 25, isOn: false },
    '床位 103': { id: '103', name: '微光 103', x: 75, y: 30, isOn: false },
    '床位 104': { id: '104', name: '微光 104', x: 25, y: 65, isOn: false },
    '床位 105': { id: '105', name: '微光 105', x: 50, y: 70, isOn: false },
    '床位 106': { id: '106', name: '微光 106', x: 75, y: 65, isOn: false }
};

const activeLights = {};
const residualTimers = new Map();
const visitorSockets = new Map();
const RESIDUAL_GLOW_MS = 4 * 60 * 60 * 1000;
const SOLO_WAIT_MS = 10 * 1000;
const MIN_LIGHT_DISTANCE = 18;
const lightJar = [];
let soloTimer = null;
let soloSince = 0;
let soloUserId = null;
let soloGiftDelivered = false;

function emitLights() {
    io.emit('update_lights', Object.values(activeLights));
}

function clearResidualTimer(visitorId) {
    const timer = residualTimers.get(visitorId);
    if (timer) clearTimeout(timer);
    residualTimers.delete(visitorId);
}

function activeUserIds() {
    return Object.values(activeLights)
        .filter((light) => light.status === 'active')
        .map((light) => light.id);
}

function emitLightJarState() {
    io.emit('light-jar-state', { count: lightJar.length });
}

function getLightPosition() {
    const existingLights = Object.values(activeLights);
    const distanceToNearestLight = (position) => {
        if (existingLights.length === 0) return Infinity;

        return existingLights.reduce((minimum, light) => Math.min(
            minimum,
            Math.hypot(position.x - light.x, position.y - light.y)
        ), Infinity);
    };

    for (let attempt = 0; attempt < 100; attempt += 1) {
        const position = {
            x: Math.random() * 84 + 8,
            y: Math.random() * 72 + 8
        };
        if (distanceToNearestLight(position) >= MIN_LIGHT_DISTANCE) return position;
    }

    let bestPosition = null;
    let bestDistance = -1;
    for (let y = 8; y <= 80; y += 2) {
        for (let x = 8; x <= 92; x += 2) {
            const position = { x, y };
            const distance = distanceToNearestLight(position);
            if (distance > bestDistance) {
                bestPosition = position;
                bestDistance = distance;
            }
        }
    }

    return bestPosition;
}

io.use((socket, next) => {
    const visitorId = socket.handshake.auth && socket.handshake.auth.visitor_id;
    if (typeof visitorId !== 'string' || !/^hc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitorId)) {
        next(new Error('A valid visitor ID is required.'));
        return;
    }

    socket.data.visitorId = visitorId.toLowerCase();
    next();
});

function deliverStoredGlow() {
    if (soloGiftDelivered || !soloUserId || Date.now() - soloSince < SOLO_WAIT_MS) return;
    if (activeUserIds().length !== 1 || activeUserIds()[0] !== soloUserId) return;

    const glowIndex = lightJar.findIndex((glow) => glow.donorId !== soloUserId);
    if (glowIndex === -1) return;

    const light = activeLights[soloUserId];
    if (!light) return;

    lightJar.splice(glowIndex, 1);
    light.brightness = Math.min(2.5, (light.brightness || 1) + 0.8);
    soloGiftDelivered = true;
    emitLightJarState();
    emitLights();
    io.emit('solo-light-boost', { targetId: soloUserId });
}

function refreshSoloPresence() {
    const ids = activeUserIds();
    if (ids.length !== 1) {
        if (soloTimer) clearTimeout(soloTimer);
        soloTimer = null;
        soloSince = 0;
        soloUserId = null;
        soloGiftDelivered = false;
        return;
    }

    if (soloUserId === ids[0]) return;

    if (soloTimer) clearTimeout(soloTimer);
    soloUserId = ids[0];
    soloSince = Date.now();
    soloGiftDelivered = false;
    soloTimer = setTimeout(deliverStoredGlow, SOLO_WAIT_MS);
}

io.on('connection', (socket) => {
    console.log('一位新的同行者連線，ID:', socket.id);
    const visitorId = socket.data.visitorId;

    clearResidualTimer(visitorId);
    let sockets = visitorSockets.get(visitorId);
    if (!sockets) {
        sockets = new Set();
        visitorSockets.set(visitorId, sockets);
    }
    sockets.add(socket.id);

    socket.emit('init-ward-status', wardLights);
    let visitorLight = activeLights[visitorId];
    if (visitorLight) {
        visitorLight.status = 'active';
        delete visitorLight.expiresAt;
    } else {
        visitorLight = {
            id: visitorId,
            ...getLightPosition(),
            status: 'active',
            brightness: 1
        };
        activeLights[visitorId] = visitorLight;
    }
    emitLights();
    socket.emit('light-jar-state', { count: lightJar.length });
    refreshSoloPresence();

    socket.on('toggle-light', (lightId) => {
        if (lightId === 'REFRESH_MAP') {
            io.emit('init-ward-status', wardLights);
            return;
        }

        const key = `床位 ${lightId}`;
        const light = wardLights[key];
        if (!light) return;

        if (!light.isOn) {
            light.isOn = true;
            light.ownerId = visitorId;
            io.emit('sync-ward-light', light);
        } else if (light.ownerId === visitorId) {
            light.isOn = false;
            light.ownerId = null;
            io.emit('sync-ward-light', light);
        } else {
            io.emit('receive-companion-ripple', { lightId });
        }
    });

    socket.on('click_light', ({ targetId } = {}) => {
        if (!targetId || targetId === visitorId) return;

        const target = activeLights[targetId];
        if (!target) return;

        if (target.status === 'residual') {
            target.brightness = Math.min(2.5, (target.brightness || 0.45) + 0.25);
            target.encouragementCount = (target.encouragementCount || 0) + 1;
            emitLights();
            return;
        }

        io.emit('light_triggered', { fromId: visitorId, targetId });
    });

    socket.on('deposit-light', () => {
        lightJar.push({ donorId: visitorId, createdAt: Date.now() });
        emitLightJarState();
        deliverStoredGlow();
    });

    socket.on('disconnect', () => {
        console.log('同行者斷開連線:', socket.id);

        const visitorConnections = visitorSockets.get(visitorId);
        if (visitorConnections) {
            visitorConnections.delete(socket.id);
            if (visitorConnections.size > 0) return;
            visitorSockets.delete(visitorId);
        }

        Object.values(wardLights).forEach((light) => {
            if (light.ownerId === visitorId) {
                light.isOn = false;
                light.ownerId = null;
                io.emit('sync-ward-light', light);
            }
        });

        const light = activeLights[visitorId];
        if (light) {
            light.status = 'residual';
            light.brightness = 0.45;
            light.encouragementCount = light.encouragementCount || 0;
            light.expiresAt = Date.now() + RESIDUAL_GLOW_MS;
            const timer = setTimeout(() => {
                if (activeLights[visitorId] === light && light.status === 'residual' && !visitorSockets.has(visitorId)) {
                    delete activeLights[visitorId];
                    residualTimers.delete(visitorId);
                    emitLights();
                }
            }, RESIDUAL_GLOW_MS);
            residualTimers.set(visitorId, timer);
        }

        emitLights();
        refreshSoloPresence();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`微光港灣病房地圖服務已在 Port ${PORT} 溫暖啟動...`);
});
