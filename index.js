const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(_dirname)); // 讓伺服器能讀取外層的 index.html
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 💡 新增：初始化 6 盞固定病房夜燈的狀態（預設全部熄滅 false）
// 使用百分比定位 (x, y)，確保在所有人的螢幕上位置都一樣
let wardLights = {
    "床位 101": { id: "101", name: "微光 101", x: 25, y: 30, isOn: false },
    "床位 102": { id: "102", name: "微光 102", x: 50, y: 25, isOn: false },
    "床位 103": { id: "103", name: "微光 103", x: 75, y: 30, isOn: false },
    "床位 104": { id: "104", name: "微光 104", x: 25, y: 65, isOn: false },
    "床位 105": { id: "105", name: "微光 105", x: 50, y: 70, isOn: false },
    "床位 106": { id: "106", name: "微光 106", x: 75, y: 65, isOn: false }
};

io.on('connection', (socket) => {
    console.log('一位新的病友連線，ID:', socket.id);

    // 💡 新增功能：當有新病友剛進來網頁時，立刻把目前「所有人點亮的燈光狀態」同步發送給他
    socket.emit('init-ward-status', wardLights);

    // 監聽某人切換了某一盞燈的開關
    socket.on('toggle-light', (lightId) => {
        if (lightId === 'REFRESH_MAP') {
            io.emit('init-ward-status', wardLights);
            return;
        }
        // 尋找對應的床位
        const key = `床位 ${lightId}`;
        if (wardLights[key]) {
            if (!wardLights[key].isOn) {
                // 切換狀態：如果是開就變熄，如果是熄就變開
                wardLights[key].isOn = true;
                wardLights[key].ownerId = socket.id;
                console.log(`${key} 狀態更新為:💡 點亮(擁有者: ${socket.id})`);

                // 【核心廣播】：把這盞燈最新的狀態，廣播給所有人同步更新
                io.emit('sync-ward-light', wardLights[key]);
            } 
            else {
                if (wardLights[key].ownerId === socket.id){
                    wardLights[key].isOn = false;
                    wardLights[key].ownerId = null;
                
                console.log(`${key} 狀態為更新:主人主動熄滅`);
                io.emit('sync-ward-light',wardLights[key]);
            }
            else {
                console.log(`${key} 收到病友陪伴點擊, 發送漣漪`);
                io.emit('receive-companion-ripple',{lightId: lightId});
            }
        }
    }
});

    socket.on('disconnect', () => {
        console.log('病友斷開連線:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`微光港灣病房地圖服務已在 Port ${PORT} 溫暖啟動...`);
});


// 儲存目前在線的孤燈數據
// 結構: { socketId: { id: string, x: number, y: number } }
let activeLights = {};

io.on('connection', (socket) => {
    console.log(`病友加入: ${socket.id}`);

    // 1. 當新連線進來，為其生成一盞孤燈的隨機位置（百分比坐標，方便前端自適應）
    activeLights[socket.id] = {
        id: socket.id,
        x: Math.floor(Math.random() * 60) + 20, // 限制在 20% ~ 80% 區域，避免貼邊
        y: Math.floor(Math.random() * 40) + 30  // 限制在 30% ~ 70% 區域，避開底欄與頂欄
    };

    // 廣播給所有人更新後的孤燈名單
    io.emit('update_lights', Object.values(activeLights));

    // 2. 監聽點擊某盞孤燈的事件
    socket.on('click_light', (data) => {
        const targetId = data.targetId;
        
        // 確認被點擊的燈是否還在線
        if (activeLights[targetId]) {
            // 觸發雙邊陪伴大漣漪：通知全體（或只通知這兩個人，這裡建議廣播讓大家都能看到溫暖的互動）
            io.emit('light_triggered', {
                fromId: socket.id,
                targetId: targetId
            });
        }
    });

    // 3. 監聽斷開連線
    socket.on('disconnect', () => {
        console.log(`病友離開: ${socket.id}`);
        // 移除該盞孤燈
        delete activeLights[socket.id];
        // 再次廣播更新名單
        io.emit('update_lights', Object.values(activeLights));
    });
});

const socket = io('https://onrender.com'); // 如果是同網域可直接 io()
const container = document.getElementById('lonely-lights-container');

// 儲存目前前端渲染的燈 DOM 對照表，方便精準控制動畫
let lightElements = {}; 

// 1. 監聽後端廣播的在線燈火數據
socket.on('update_lights', (lightsArray) => {
    container.innerHTML = ''; // 清空重新渲染
    lightElements = {};

    lightsArray.forEach(light => {
        const dot = document.createElement('div');
        dot.className = 'light-dot';
        // 使用百分比布局，確保在不同螢幕大小下分布相對一致
        dot.style.left = `${light.x}%`;
        dot.style.top = `${light.y}%`;
        
        // 如果這盞燈是自己，可以加上特別的標記或顏色（選實作）
        if (light.id === socket.id) {
            dot.style.backgroundColor = '#a8ffb2'; 
            dot.style.boxShadow = '0 0 8px #a8ffb2';
        }

        // 點擊事件：點擊對方的燈
        dot.addEventListener('click', () => {
            if (light.id !== socket.id) {
                socket.emit('click_light', { targetId: light.id });
            }
        });

        container.appendChild(dot);
        // 快取 DOM 節點
        lightElements[light.id] = dot;
    });
});

// 2. 監聽雙邊觸發點亮事件
socket.on('light_triggered', (data) => {
    const { fromId, targetId } = data;

    // 讓發起方與接收方的燈同時變亮並產生漣漪
    [fromId, targetId].forEach(id => {
        const el = lightElements[id];
        if (el) {
            // 觸發高亮變亮
            el.classList.add('ignited');
            
            // 產生隨身漣漪
            createLocalRipple(el.style.left, el.style.top);

            // 1.5 秒後恢復微光呼吸狀態
            setTimeout(() => {
                el.classList.remove('ignited');
            }, 1500);
        }
    });

    // 💡 這裡可以同時調用你原本寫好的「雙邊觸發陪伴大漣漪」全螢幕特效函數！
    // 例如：triggerBigRipple(fromId, targetId);
});

// 生成孤燈專屬小漣漪的輔助函數
function createLocalRipple(left, top) {
    const ripple = document.createElement('div');
    ripple.className = 'light-ripple';
    ripple.style.left = left;
    ripple.style.top = top;
    container.appendChild(ripple);
    
    // 動態結束後移除自己，避免記憶體洩漏
    ripple.addEventListener('animationend', () => {
        ripple.remove();
    });
}

