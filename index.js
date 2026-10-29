const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.get('/',(req, res)=>{
    res.sendFile(path.join(_dirname, 'index.html'));
});
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
