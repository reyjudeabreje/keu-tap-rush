const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const SUPABASE_URL = typeof process.env.SUPABASE_URL === "string"
  ? process.env.SUPABASE_URL.trim().replace(/\/$/, "")
  : "";
const SUPABASE_SERVICE_ROLE_KEY = typeof process.env.SUPABASE_SERVICE_ROLE_KEY === "string"
  ? process.env.SUPABASE_SERVICE_ROLE_KEY.trim()
  : "";
const sessions = new Map();
const modes = {
  easy: { duration: 30, multiplier: 1 }, normal: { duration: 30, multiplier: 1 },
  hard: { duration: 25, multiplier: 2 }, superHard: { duration: 20, multiplier: 3 }, god: { duration: 15, multiplier: 5 }
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function configured() { return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY); }
function validMode(mode) { return typeof mode === "string" && Object.prototype.hasOwnProperty.call(modes, mode); }
function cleanNickname(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
}

function validNickname(nickname) {
  return nickname.length >= 1 && nickname.length <= 16;
}

function cleanSessionId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) reject(new Error("Request too large"));
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch (error) { reject(new Error("Invalid JSON")); }
    });
    request.on("error", reject);
  });
}

async function supabaseRequest(endpoint, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || "Database request failed");
  return { response, data: text ? JSON.parse(text) : [] };
}

function maxLegitimateScore(mode, taps) {
  let maximum = 0;
  for (let tap = 1; tap <= taps; tap += 1) {
    let comboBonus = 0;
    if (tap >= 20) comboBonus = 4;
    else if (tap >= 10) comboBonus = 2;
    else if (tap >= 5) comboBonus = 1;
    maximum += modes[mode].multiplier + comboBonus;
  }
  return maximum;
}

function isFiniteIntegerLike(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean" || Array.isArray(value)) return false;
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value);
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    return Number.isFinite(numeric) && Number.isInteger(numeric);
  }
  return false;
}

function validateSubmittedScore(body, session) {
  if (!validMode(body?.mode)) return { error: "Invalid game mode" };
  const mode = body.mode;
  const nickname = cleanNickname(body.nickname);
  if (!validNickname(nickname)) return { error: "Nickname must be 1 to 16 characters" };
  if (!session || session.submitted || session.mode !== mode) return { error: "Invalid game session" };

  const score = Number(body.score);
  const taps = Number(body.totalTaps);
  const highestCombo = Number(body.highestCombo);
  const speedBonus = Number(body.speedBonus);
  const elapsed = Date.now() - session.startedAt;
  const modeConfig = modes[mode];
  const minimumValidDuration = modeConfig.duration * 1000 - 2000;
  const maximumValidDuration = modeConfig.duration * 1000 + 120000;

  if (![score, taps, highestCombo, speedBonus].every((value) => isFiniteIntegerLike(value))) {
    return { error: "Score could not be verified" };
  }
  if (score < 0 || taps < 0 || highestCombo < 0 || speedBonus < 0) {
    return { error: "Score could not be verified" };
  }
  if (taps === 0 && score !== 0) {
    return { error: "Score could not be verified" };
  }
  if (taps > 5000 || highestCombo > 5000) {
    return { error: "Score could not be verified" };
  }
  if (highestCombo > taps) {
    return { error: "Score could not be verified" };
  }
  if (elapsed < minimumValidDuration || elapsed > maximumValidDuration) {
    return { error: "Score could not be verified" };
  }
  if (speedBonus !== (taps ? Math.round(score / taps * 100) : 0)) {
    return { error: "Score could not be verified" };
  }
  const maxScore = maxLegitimateScore(mode, taps);
  if (score > maxScore) {
    return { error: "Score could not be verified" };
  }
  return { valid: true, nickname, mode, score, taps, highestCombo, speedBonus };
}

async function startSession(request, response) {
  const body = await readBody(request);
  if (!validMode(body.mode)) return json(response, 400, { error: "Invalid game mode" });
  const nickname = cleanNickname(body.nickname);
  if (!validNickname(nickname)) return json(response, 400, { error: "Nickname must be 1 to 16 characters" });
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { mode: body.mode, nickname, startedAt: Date.now(), submitted: false });
  if (configured()) {
    try {
      await supabaseRequest("active_players", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ session_id: sessionId, nickname, mode: body.mode, score: 0, last_seen: new Date().toISOString() })
      });
    } catch (error) {
      sessions.delete(sessionId);
      console.error(error.message);
      return json(response, 502, { error: "Online leaderboard database error" });
    }
  }
  return json(response, 200, { sessionId, online: configured() });
}

async function heartbeat(request, response) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const body = await readBody(request);
  const sessionId = cleanSessionId(body.sessionId);
  const session = sessions.get(sessionId);
  const currentScore = Number(body.score);
  if (!session || session.submitted || !Number.isInteger(currentScore) || currentScore < 0) {
    return json(response, 400, { error: "Invalid active player session" });
  }
  try {
    await supabaseRequest(`active_players?session_id=eq.${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ score: currentScore, last_seen: new Date().toISOString() })
    });
    return json(response, 200, { online: true });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

async function removePlayer(request, response) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const body = await readBody(request);
  const sessionId = cleanSessionId(body.sessionId);
  if (!sessionId) return json(response, 400, { error: "Invalid player session" });
  try {
    await supabaseRequest(`active_players?session_id=eq.${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    return json(response, 200, { removed: true });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

async function submitScore(request, response) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const body = await readBody(request);
  const session = sessions.get(body.sessionId);
  const validation = validateSubmittedScore(body, session);
  if (validation.error) {
    return json(response, 400, { error: validation.error });
  }

  const { nickname, mode, score, taps, highestCombo, speedBonus } = validation;
  session.submitted = true;
  const row = { nickname, mode, score, highest_combo: highestCombo, total_taps: taps, speed_bonus: speedBonus };
  try {
    await supabaseRequest("scores", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    const higher = await supabaseRequest(`scores?select=score&score=gt.${score}`);
    const personal = await supabaseRequest(`scores?select=score&nickname=eq.${encodeURIComponent(nickname)}&order=score.desc&limit=1`);
    sessions.delete(body.sessionId);
    return json(response, 201, { score, rank: higher.data.length + 1, bestScore: Math.max(score, personal.data[0]?.score || 0) });
  } catch (error) {
    session.submitted = false;
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

async function leaderboard(request, response, url) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const mode = url.searchParams.get("mode");
  if (mode && !validMode(mode)) return json(response, 400, { error: "Invalid game mode" });
  const filter = mode ? `&mode=eq.${encodeURIComponent(mode)}` : "";
  try {
    const result = await supabaseRequest(`scores?select=nickname,mode,score,highest_combo,total_taps,speed_bonus,created_at&order=score.desc,created_at.asc&limit=10${filter}`);
    return json(response, 200, { entries: result.data });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

async function activePlayers(response) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const cutoff = new Date(Date.now() - 15000).toISOString();
  try {
    const result = await supabaseRequest(`active_players?select=nickname,mode,score,last_seen&last_seen=gt.${encodeURIComponent(cutoff)}&order=last_seen.desc&limit=100`);
    return json(response, 200, { players: result.data });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

function configStatus(response) {
  return json(response, 200, { connected: configured() });
}

function staticFile(request, response, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, requested));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return json(response, 404, { error: "Not found" });
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/plain" };
  response.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/config") return configStatus(response);
    if (request.method === "GET" && url.pathname === "/api/leaderboard") return leaderboard(request, response, url);
    if (request.method === "POST" && url.pathname === "/api/games/start") return startSession(request, response);
    if (request.method === "POST" && url.pathname === "/api/players/heartbeat") return heartbeat(request, response);
    if (request.method === "POST" && url.pathname === "/api/players/remove") return removePlayer(request, response);
    if (request.method === "GET" && url.pathname === "/api/players") return activePlayers(response);
    if (request.method === "POST" && url.pathname === "/api/scores") return submitScore(request, response);
    return staticFile(request, response, url);
  } catch (error) {
    return json(response, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => console.log(`KEU TAP RUSH listening on http://localhost:${PORT}`));
