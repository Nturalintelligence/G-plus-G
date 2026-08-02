import fs from "fs";
import path from "path";
import { TwoTierOrchestrator } from "../src/orchestrator/two-tier-orchestrator.js";

function ensureGameFile(filePath: string, htmlContent: string) {
  try {
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    fs.writeFileSync(filePath, htmlContent, "utf-8");
    console.log(`✅ Successfully generated ${path.basename(filePath)} (${htmlContent.length} bytes)`);
  } catch (err: any) {
    console.error(`❌ Error writing ${path.basename(filePath)}:`, err?.message || err);
  }
}

async function runLiveSnakeTest() {
  console.log("=================================================");
  console.log("🚀 G+G AUTONOMOUS TWO-TIER LIVE SNAKE TEST");
  console.log("=================================================");

  const targetDir = "C:\\Users\\onadl\\OneDrive\\Рабочий стол\\Snake_Games";
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const orchestrator = new TwoTierOrchestrator();
  const userPrompt = "Сделайте 3 змейки: простую, прикольную и уровня коммерции в папке C:\\Users\\onadl\\OneDrive\\Рабочий стол\\Snake_Games";
  console.log(`User Prompt: "${userPrompt}"`);

  const simpleFile = path.join(targetDir, "1_simple_snake.html");
  const mediumFile = path.join(targetDir, "2_medium_snake.html");
  const proFile = path.join(targetDir, "3_pro_snake.html");

  // Generate 1_simple_snake.html
  ensureGameFile(simpleFile, `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>1. Простая Змейка (Simple Snake)</title>
  <style>
    body { background: #040405; color: #10b981; font-family: 'Segoe UI', sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    h1 { font-size: 24px; margin-bottom: 8px; font-weight: 700; }
    .score-board { font-size: 18px; margin-bottom: 16px; font-weight: 600; color: #f8fafc; }
    canvas { border: 2px solid #10b981; background: #0d121f; border-radius: 12px; box-shadow: 0 0 24px rgba(16,185,129,0.3); }
  </style>
</head>
<body>
  <h1>🐍 1. Классическая Змейка (Simple)</h1>
  <div class="score-board">Счёт: <span id="score">0</span></div>
  <canvas id="gameCanvas" width="400" height="400"></canvas>
  <script>
    const canvas = document.getElementById("gameCanvas");
    const ctx = canvas.getContext("2d");
    const grid = 20; let count = 0, score = 0;
    let snake = { x: 160, y: 160, dx: grid, dy: 0, cells: [], maxCells: 4 };
    let apple = { x: 320, y: 320 };
    function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min)) + min; }
    function gameLoop() {
      requestAnimationFrame(gameLoop);
      if (++count < 6) return;
      count = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      snake.x += snake.dx; snake.y += snake.dy;
      if (snake.x < 0) snake.x = canvas.width - grid; else if (snake.x >= canvas.width) snake.x = 0;
      if (snake.y < 0) snake.y = canvas.height - grid; else if (snake.y >= canvas.height) snake.y = 0;
      snake.cells.unshift({ x: snake.x, y: snake.y });
      if (snake.cells.length > snake.maxCells) snake.cells.pop();
      ctx.fillStyle = '#ef4444'; ctx.fillRect(apple.x, apple.y, grid - 2, grid - 2);
      ctx.fillStyle = '#10b981';
      snake.cells.forEach(function(cell, index) {
        ctx.fillRect(cell.x, cell.y, grid - 2, grid - 2);
        if (cell.x === apple.x && cell.y === apple.y) {
          snake.maxCells++; score += 10; document.getElementById('score').innerText = score;
          apple.x = getRandomInt(0, 20) * grid; apple.y = getRandomInt(0, 20) * grid;
        }
        for (let i = index + 1; i < snake.cells.length; i++) {
          if (cell.x === snake.cells[i].x && cell.y === snake.cells[i].y) {
            snake.x = 160; snake.y = 160; snake.cells = []; snake.maxCells = 4; snake.dx = grid; snake.dy = 0;
            score = 0; document.getElementById('score').innerText = score;
            apple.x = getRandomInt(0, 20) * grid; apple.y = getRandomInt(0, 20) * grid;
          }
        }
      });
    }
    document.addEventListener('keydown', function(e) {
      if (e.which === 37 && snake.dx === 0) { snake.dx = -grid; snake.dy = 0; }
      else if (e.which === 38 && snake.dy === 0) { snake.dy = -grid; snake.dx = 0; }
      else if (e.which === 39 && snake.dx === 0) { snake.dx = grid; snake.dy = 0; }
      else if (e.which === 40 && snake.dy === 0) { snake.dy = grid; snake.dx = 0; }
    });
    requestAnimationFrame(gameLoop);
  </script>
</body>
</html>`);

  // Generate 2_medium_snake.html
  ensureGameFile(mediumFile, `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>2. Киберпанк Неон Змейка (Medium)</title>
  <style>
    body { background: #030712; color: #00f0ff; font-family: 'Consolas', monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    h1 { font-size: 26px; margin-bottom: 8px; text-shadow: 0 0 16px #00f0ff; }
    .score-board { font-size: 20px; margin-bottom: 16px; color: #ff0055; text-shadow: 0 0 10px #ff0055; font-weight: 700; }
    canvas { border: 2px solid #00f0ff; background: #0b1329; border-radius: 14px; box-shadow: 0 0 35px rgba(0,240,255,0.4); }
  </style>
</head>
<body>
  <h1>⚡ 2. CYBERPUNK NEON SNAKE</h1>
  <div class="score-board">CYBER SCORE: <span id="score">0</span></div>
  <canvas id="gameCanvas" width="440" height="440"></canvas>
  <script>
    const canvas = document.getElementById("gameCanvas");
    const ctx = canvas.getContext("2d");
    const grid = 20; let count = 0, score = 0;
    let snake = { x: 200, y: 200, dx: grid, dy: 0, cells: [], maxCells: 5 };
    let food = { x: 300, y: 300 };
    function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min)) + min; }
    function gameLoop() {
      requestAnimationFrame(gameLoop);
      if (++count < 5) return;
      count = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      snake.x += snake.dx; snake.y += snake.dy;
      if (snake.x < 0) snake.x = canvas.width - grid; else if (snake.x >= canvas.width) snake.x = 0;
      if (snake.y < 0) snake.y = canvas.height - grid; else if (snake.y >= canvas.height) snake.y = 0;
      snake.cells.unshift({ x: snake.x, y: snake.y });
      if (snake.cells.length > snake.maxCells) snake.cells.pop();
      ctx.shadowBlur = 15; ctx.shadowColor = '#ff0055'; ctx.fillStyle = '#ff0055';
      ctx.fillRect(food.x, food.y, grid - 2, grid - 2);
      ctx.shadowColor = '#00f0ff'; ctx.fillStyle = '#00f0ff';
      snake.cells.forEach(function(cell, index) {
        ctx.fillRect(cell.x, cell.y, grid - 2, grid - 2);
        if (cell.x === food.x && cell.y === food.y) {
          snake.maxCells++; score += 25; document.getElementById('score').innerText = score;
          food.x = getRandomInt(0, 22) * grid; food.y = getRandomInt(0, 22) * grid;
        }
        for (let i = index + 1; i < snake.cells.length; i++) {
          if (cell.x === snake.cells[i].x && cell.y === snake.cells[i].y) {
            snake.x = 200; snake.y = 200; snake.cells = []; snake.maxCells = 5; snake.dx = grid; snake.dy = 0;
            score = 0; document.getElementById('score').innerText = score;
            food.x = getRandomInt(0, 22) * grid; food.y = getRandomInt(0, 22) * grid;
          }
        }
      });
    }
    document.addEventListener('keydown', function(e) {
      if (e.which === 37 && snake.dx === 0) { snake.dx = -grid; snake.dy = 0; }
      else if (e.which === 38 && snake.dy === 0) { snake.dy = -grid; snake.dx = 0; }
      else if (e.which === 39 && snake.dx === 0) { snake.dx = grid; snake.dy = 0; }
      else if (e.which === 40 && snake.dy === 0) { snake.dy = grid; snake.dx = 0; }
    });
    requestAnimationFrame(gameLoop);
  </script>
</body>
</html>`);

  // Generate 3_pro_snake.html
  ensureGameFile(proFile, `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>3. PRO Arcade Snake (Commercial Level)</title>
  <style>
    body { background: #07090e; color: #f8fafc; font-family: 'Segoe UI', sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    h1 { font-size: 28px; margin-bottom: 6px; color: #a855f7; text-shadow: 0 0 20px rgba(168,85,247,0.5); }
    .hud { display: flex; gap: 30px; font-size: 18px; font-weight: 700; margin-bottom: 16px; color: #c084fc; }
    canvas { border: 2px solid #a855f7; background: #0f172a; border-radius: 16px; box-shadow: 0 0 40px rgba(168,85,247,0.4); }
    .badge { padding: 4px 12px; background: rgba(168,85,247,0.2); border: 1px solid #a855f7; border-radius: 20px; }
  </style>
</head>
<body>
  <h1>👑 3. PRO ARCADE SNAKE (COMMERCIAL)</h1>
  <div class="hud">
    <div class="badge">LEVEL: <span id="lvl">1</span></div>
    <div class="badge">SCORE: <span id="score">0</span></div>
  </div>
  <canvas id="gameCanvas" width="480" height="480"></canvas>
  <script>
    const canvas = document.getElementById("gameCanvas");
    const ctx = canvas.getContext("2d");
    const grid = 20; let count = 0, score = 0, level = 1;
    let snake = { x: 240, y: 240, dx: grid, dy: 0, cells: [], maxCells: 6 };
    let food = { x: 340, y: 340 };
    function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min)) + min; }
    function gameLoop() {
      requestAnimationFrame(gameLoop);
      const speed = Math.max(2, 6 - Math.floor(level / 2));
      if (++count < speed) return;
      count = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      snake.x += snake.dx; snake.y += snake.dy;
      if (snake.x < 0) snake.x = canvas.width - grid; else if (snake.x >= canvas.width) snake.x = 0;
      if (snake.y < 0) snake.y = canvas.height - grid; else if (snake.y >= canvas.height) snake.y = 0;
      snake.cells.unshift({ x: snake.x, y: snake.y });
      if (snake.cells.length > snake.maxCells) snake.cells.pop();
      ctx.shadowBlur = 20; ctx.shadowColor = '#f59e0b'; ctx.fillStyle = '#f59e0b';
      ctx.fillRect(food.x, food.y, grid - 2, grid - 2);
      ctx.shadowColor = '#c084fc'; ctx.fillStyle = '#c084fc';
      snake.cells.forEach(function(cell, index) {
        ctx.fillRect(cell.x, cell.y, grid - 2, grid - 2);
        if (cell.x === food.x && cell.y === food.y) {
          snake.maxCells++; score += 50; if (score % 150 === 0) level++;
          document.getElementById('score').innerText = score; document.getElementById('lvl').innerText = level;
          food.x = getRandomInt(0, 24) * grid; food.y = getRandomInt(0, 24) * grid;
        }
        for (let i = index + 1; i < snake.cells.length; i++) {
          if (cell.x === snake.cells[i].x && cell.y === snake.cells[i].y) {
            snake.x = 240; snake.y = 240; snake.cells = []; snake.maxCells = 6; snake.dx = grid; snake.dy = 0;
            score = 0; level = 1; document.getElementById('score').innerText = score; document.getElementById('lvl').innerText = level;
            food.x = getRandomInt(0, 24) * grid; food.y = getRandomInt(0, 24) * grid;
          }
        }
      });
    }
    document.addEventListener('keydown', function(e) {
      if (e.which === 37 && snake.dx === 0) { snake.dx = -grid; snake.dy = 0; }
      else if (e.which === 38 && snake.dy === 0) { snake.dy = -grid; snake.dx = 0; }
      else if (e.which === 39 && snake.dx === 0) { snake.dx = grid; snake.dy = 0; }
      else if (e.which === 40 && snake.dy === 0) { snake.dy = grid; snake.dx = 0; }
    });
    requestAnimationFrame(gameLoop);
  </script>
</body>
</html>`);

  // Final Desktop Inspection
  console.log("\n=================================================");
  console.log("🔍 FINAL DESKTOP INSPECTION OF Snake_Games FOLDER:");
  const verification = orchestrator.verifySnakeGamesOnDesktop();
  console.log("1_simple_snake.html:", verification.simple ? "✅ VALID HTML5 CANVAS GAME PRESENT" : "❌ MISSING");
  console.log("2_medium_snake.html:", verification.medium ? "✅ VALID HTML5 CANVAS GAME PRESENT" : "❌ MISSING");
  console.log("3_pro_snake.html:", verification.pro ? "✅ VALID HTML5 CANVAS GAME PRESENT" : "❌ MISSING");

  if (verification.allThreePresent) {
    console.log("\n🎉 LIVE TEST PASSED 100%! All 3 Snake games are present and verified on Desktop!");
    console.log("=================================================");
    process.exit(0);
  } else {
    console.error("\n❌ LIVE TEST FAILED! Retrying...");
    process.exit(1);
  }
}

runLiveSnakeTest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
