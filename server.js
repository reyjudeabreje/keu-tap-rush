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
const PLAYER_ID_COOKIE = "keu_player";
const PLAYER_NICKNAME_COOKIE = "keu_nickname";
const PLAYER_ID_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2;
const ACTIVE_PLAYER_TIMEOUT_MS = 45 * 1000;
const PLAYER_ID_COOKIE_SECRET = typeof process.env.PLAYER_ID_COOKIE_SECRET === "string" && process.env.PLAYER_ID_COOKIE_SECRET.trim()
  ? process.env.PLAYER_ID_COOKIE_SECRET.trim()
  : SUPABASE_SERVICE_ROLE_KEY;
const sessions = new Map();
const modes = {
  easy: { duration: 30, multiplier: 1 }, normal: { duration: 30, multiplier: 1 },
  hard: { duration: 25, multiplier: 2 }, superHard: { duration: 20, multiplier: 3 }, god: { duration: 15, multiplier: 5 }
};
const levelThresholds = [0, 100, 250, 500, 1000, 2000, 3500, 5000, 7500, 10000];
const levelTitles = ["ROOKIE", "TAP TRAINEE", "QUICK TAPPER", "SPEED TAPPER", "COMBO MASTER", "TAP WARRIOR", "TAP CHAMPION", "ELITE TAPPER", "TAP LEGEND", "TAP RUSH LEGEND"];

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

function nicknameFromCookie(request) {
  const nickname = cleanNickname(parseCookies(request)[PLAYER_NICKNAME_COOKIE] || "");
  return validNickname(nickname) ? nickname : "";
}

function cleanSessionId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "";
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? ["", ""] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([name]) => name));
}

function signPlayerToken(token) {
  return crypto.createHmac("sha256", PLAYER_ID_COOKIE_SECRET).update(token).digest("base64url");
}

function playerIdFromToken(token) {
  const digest = crypto.createHash("sha256").update(`keu-tap-rush:${token}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function getPlayerIdentity(request, response) {
  const cookie = parseCookies(request)[PLAYER_ID_COOKIE] || "";
  const separator = cookie.lastIndexOf(".");
  const token = separator > 0 ? cookie.slice(0, separator) : "";
  const signature = separator > 0 ? cookie.slice(separator + 1) : "";
  let valid = false;
  if (token && signature) {
    const expected = signPlayerToken(token);
    valid = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
  const identityToken = valid ? token : crypto.randomBytes(32).toString("base64url");
  if (!valid) {
    const secure = request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted;
    const flags = [`${PLAYER_ID_COOKIE}=${encodeURIComponent(`${identityToken}.${signPlayerToken(identityToken)}`)}`, "Path=/", `Max-Age=${PLAYER_ID_COOKIE_MAX_AGE}`, "HttpOnly", "SameSite=Lax"];
    if (secure) flags.push("Secure");
    response.setHeader("Set-Cookie", flags.join("; "));
  }
  return playerIdFromToken(identityToken);
}

function setNicknameCookie(request, response, nickname) {
  const secure = request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted;
  const value = `${encodeURIComponent(nickname)}.${signPlayerToken(nickname)}`;
  const flags = [`${PLAYER_NICKNAME_COOKIE}=${value}`, "Path=/", `Max-Age=${PLAYER_ID_COOKIE_MAX_AGE}`, "HttpOnly", "SameSite=Lax"];
  if (secure) flags.push("Secure");
  const existing = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", existing ? [existing, flags.join("; ")].flat() : flags.join("; "));
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
  if (!session || session.submitted || session.mode !== mode) return { error: "Invalid game session" };
  const nickname = session.nickname;

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

function presenceRow(session, status = "online", score = 0) {
  const timestamp = new Date().toISOString();
  return {
    player_id: session.playerId,
    session_id: session.sessionId,
    nickname: session.nickname,
    mode: session.mode,
    status,
    score,
    last_seen_at: timestamp,
    updated_at: timestamp
  };
}

async function startPresence(session) {
  await supabaseRequest("active_players?on_conflict=session_id", {
    method: "POST",
    headers: { Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify(presenceRow(session))
  });
}

function sessionForPresence(request, response, body) {
  const sessionId = cleanSessionId(body?.sessionId);
  const session = sessions.get(sessionId);
  const playerId = getPlayerIdentity(request, response);
  if (!session || session.playerId !== playerId || session.submitted) return null;
  return { session, playerId };
}

async function startSession(request, response) {
  const body = await readBody(request);
  if (!validMode(body.mode)) return json(response, 400, { error: "Invalid game mode" });
  const nickname = cleanNickname(body.nickname);
  if (!validNickname(nickname)) return json(response, 400, { error: "Nickname must be 1 to 16 characters" });
  const sessionId = crypto.randomUUID();
  const playerId = getPlayerIdentity(request, response);
  setNicknameCookie(request, response, nickname);
  sessions.set(sessionId, { sessionId, mode: body.mode, nickname, playerId, startedAt: Date.now(), submitted: false });
  if (configured()) {
    try {
      await startPresence({ sessionId, mode: body.mode, nickname, playerId });
    } catch (error) {
      sessions.delete(sessionId);
      console.error(error.message);
      return json(response, 502, { error: "Online leaderboard database error" });
    }
  }
  return json(response, 200, { sessionId, online: configured() });
}

async function presenceStart(request, response) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const body = await readBody(request);
  const active = sessionForPresence(request, response, body);
  if (!active) {
    return json(response, 400, { error: "Invalid active player session" });
  }
  try {
    await startPresence(active.session);
    return json(response, 200, { online: true });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

async function presenceHeartbeat(request, response) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const body = await readBody(request);
  const active = sessionForPresence(request, response, body);
  const currentScore = Number(body.score ?? 0);
  if (!active || !Number.isInteger(currentScore) || currentScore < 0) return json(response, 400, { error: "Invalid active player session" });
  try {
    const timestamp = new Date().toISOString();
    await supabaseRequest(`active_players?session_id=eq.${encodeURIComponent(active.session.sessionId)}&player_id=eq.${encodeURIComponent(active.playerId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ nickname: active.session.nickname, mode: active.session.mode, score: currentScore, status: "online", last_seen_at: timestamp, updated_at: timestamp })
    });
    return json(response, 200, { online: true });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

async function presenceStop(request, response) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const body = await readBody(request);
  const active = sessionForPresence(request, response, body);
  if (!active) return json(response, 400, { error: "Invalid active player session" });
  try {
    const timestamp = new Date().toISOString();
    await supabaseRequest(`active_players?session_id=eq.${encodeURIComponent(active.session.sessionId)}&player_id=eq.${encodeURIComponent(active.playerId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "offline", last_seen_at: timestamp, updated_at: timestamp })
    });
    return json(response, 200, { stopped: true });
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
  const row = { player_id: session.playerId, nickname, mode, score, highest_combo: highestCombo, total_taps: taps, speed_bonus: speedBonus };
  try {
    const previous = await supabaseRequest(`scores?select=score,highest_combo,total_taps,mode&player_id=eq.${encodeURIComponent(session.playerId)}&limit=10000`);
    const previousLevel = levelFromXp(totalXp(previous.data));
    await supabaseRequest("scores", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    const higher = await supabaseRequest(`scores?select=score&score=gt.${score}`);
    const personal = await supabaseRequest(`scores?select=score&player_id=eq.${encodeURIComponent(session.playerId)}&order=score.desc&limit=1`);
    const currentLevel = levelFromXp(totalXp([...previous.data, row]));
    try { await markPresenceOffline(session); } catch (cleanupError) { console.error(cleanupError.message); }
    sessions.delete(body.sessionId);
    return json(response, 201, {
      score,
      rank: higher.data.length + 1,
      bestScore: Math.max(score, personal.data[0]?.score || 0),
      xpEarned: scoreXp(row),
      levelUp: currentLevel > previousLevel,
      level: currentLevel,
      title: levelTitles[currentLevel - 1]
    });
  } catch (error) {
    session.submitted = false;
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

async function markPresenceOffline(session) {
  if (!configured()) return;
  const timestamp = new Date().toISOString();
  await supabaseRequest(`active_players?session_id=eq.${encodeURIComponent(session.sessionId)}&player_id=eq.${encodeURIComponent(session.playerId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "offline", last_seen_at: timestamp, updated_at: timestamp })
  });
}

async function leaderboard(request, response, url) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const mode = url.searchParams.get("mode");
  if (mode && !validMode(mode)) return json(response, 400, { error: "Invalid game mode" });
  const playerId = getPlayerIdentity(request, response);
  const filter = mode ? `&mode=eq.${encodeURIComponent(mode)}` : "";
  try {
    const result = await supabaseRequest(`scores?select=player_id,nickname,mode,score,highest_combo,total_taps,speed_bonus,created_at&order=score.desc,created_at.asc&limit=10${filter}`);
    const entries = result.data.map((entry) => ({ ...entry, isCurrentPlayer: entry.player_id === playerId }));
    entries.forEach((entry) => delete entry.player_id);
    return json(response, 200, { entries });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Online leaderboard database error" });
  }
}

function modeStats(records) {
  return Object.keys(modes).map((mode) => {
    const modeRecords = records.filter((record) => record.mode === mode);
    return {
      mode,
      bestScore: modeRecords.reduce((best, record) => Math.max(best, record.score), 0),
      highestCombo: modeRecords.reduce((best, record) => Math.max(best, record.highest_combo), 0),
      gamesPlayed: modeRecords.length
    };
  });
}

function scoreXp(record) {
  const score = Number(record.score) || 0;
  const taps = Number(record.total_taps) || 0;
  const combo = Number(record.highest_combo) || 0;
  const scoreBonus = score >= 100 ? 50 : score >= 50 ? 25 : score >= 25 ? 10 : 0;
  return 10 + taps + (combo * 5) + scoreBonus;
}

function totalXp(records) {
  return records.reduce((total, record) => total + scoreXp(record), 0);
}

function levelFromXp(xp) {
  let level = 1;
  levelThresholds.forEach((threshold, index) => {
    if (xp >= threshold) level = index + 1;
  });
  return level;
}

function profileProgress(records, currentRank) {
  const xp = totalXp(records);
  const level = levelFromXp(xp);
  const bestScore = records.reduce((best, record) => Math.max(best, Number(record.score) || 0), 0);
  const totalTaps = records.reduce((total, record) => total + (Number(record.total_taps) || 0), 0);
  const highestCombo = records.reduce((best, record) => Math.max(best, Number(record.highest_combo) || 0), 0);
  const badges = [
    { id: "firstScore", icon: "🏆", name: "FIRST SCORE", requirement: "Submit your first verified score.", unlocked: records.length >= 1 },
    { id: "comboStarter", icon: "🔥", name: "COMBO STARTER", requirement: "Reach a highest verified combo of 10.", unlocked: highestCombo >= 10 },
    { id: "tapMaster", icon: "⚡", name: "TAP MASTER", requirement: "Reach 100 total verified taps.", unlocked: totalTaps >= 100 },
    { id: "score50", icon: "💯", name: "SCORE 50", requirement: "Reach a verified score of 50.", unlocked: bestScore >= 50 },
    { id: "score100", icon: "💯", name: "SCORE 100", requirement: "Reach a verified score of 100.", unlocked: bestScore >= 100 },
    { id: "hardPlayer", icon: "🎯", name: "HARD PLAYER", requirement: "Submit one verified HARD score.", unlocked: records.some((record) => record.mode === "hard") },
    { id: "superHard", icon: "🔥", name: "SUPER HARD", requirement: "Submit one verified SUPER HARD score.", unlocked: records.some((record) => record.mode === "superHard") },
    { id: "godMode", icon: "👑", name: "GOD MODE", requirement: "Submit one verified GOD MODE score.", unlocked: records.some((record) => record.mode === "god") },
    { id: "top3", icon: "🏅", name: "TOP 3", requirement: "Reach verified leaderboard rank 3 or better.", unlocked: currentRank !== null && currentRank <= 3 }
  ];
  return {
    xp,
    level,
    title: levelTitles[level - 1],
    nextLevelXp: level < levelThresholds.length ? levelThresholds[level] : null,
    badges,
    bestScore,
    totalTaps,
    highestCombo
  };
}

async function profile(request, response) {
  if (!configured()) return json(response, 503, { error: "Profile data unavailable" });
  const playerId = getPlayerIdentity(request, response);
  try {
    const result = await supabaseRequest(`scores?select=mode,score,highest_combo,total_taps,created_at,nickname&player_id=eq.${encodeURIComponent(playerId)}&order=created_at.desc&limit=10000`);
    const records = result.data;
    const bestScore = records.reduce((best, record) => Math.max(best, Number(record.score) || 0), 0);
    const bestRecord = records.find((record) => Number(record.score) === bestScore);
    let rank = null;
    if (bestRecord) {
      const higher = await supabaseRequest(`scores?select=id&score=gt.${bestScore}&limit=10000`);
      rank = higher.data.length + 1;
    }
    const progress = profileProgress(records, rank);
    const achievements = Object.fromEntries(progress.badges.map((badge) => [badge.id, badge.unlocked]));
    const nickname = nicknameFromCookie(request) || records[0]?.nickname || "PLAYER";
    return json(response, 200, {
      player: { nickname, playerIdShort: playerId.slice(0, 8) },
      stats: { gamesPlayed: records.length, totalTaps: progress.totalTaps, bestScore: progress.bestScore, highestCombo: progress.highestCombo, currentRank: rank },
      level: progress.level,
      xp: progress.xp,
      nextLevelXp: progress.nextLevelXp,
      title: progress.title,
      badges: progress.badges,
      nickname,
      playerIdShort: playerId.slice(0, 8),
      gamesPlayed: records.length,
      totalTaps: progress.totalTaps,
      bestScore: progress.bestScore,
      highestCombo: progress.highestCombo,
      currentRank: rank,
      bestRank: rank,
      modeStats: modeStats(records),
      achievements
    });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Profile data unavailable" });
  }
}

async function myScores(request, response, url) {
  if (!configured()) return json(response, 503, { error: "Profile data unavailable" });
  const mode = url.searchParams.get("mode");
  if (mode && !validMode(mode)) return json(response, 400, { error: "Invalid game mode" });
  const playerId = getPlayerIdentity(request, response);
  const filter = mode ? `&mode=eq.${encodeURIComponent(mode)}` : "";
  try {
    const result = await supabaseRequest(`scores?select=mode,score,highest_combo,total_taps,created_at&player_id=eq.${encodeURIComponent(playerId)}&order=created_at.desc&limit=20${filter}`);
    return json(response, 200, { scores: result.data });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: "Profile data unavailable" });
  }
}

async function updateNickname(request, response) {
  const playerId = getPlayerIdentity(request, response);
  if (!configured()) return json(response, 503, { error: "Profile data unavailable" });
  const body = await readBody(request);
  const nickname = cleanNickname(body.nickname);
  if (!validNickname(nickname)) return json(response, 400, { error: "Nickname must be 1 to 16 characters" });
  setNicknameCookie(request, response, nickname);
  return json(response, 200, { nickname, playerIdShort: playerId.slice(0, 8) });
}

async function activePlayers(request, response) {
  if (!configured()) return json(response, 503, { error: "Online leaderboard unavailable" });
  const cutoff = new Date(Date.now() - ACTIVE_PLAYER_TIMEOUT_MS).toISOString();
  try {
    const result = await supabaseRequest(`active_players?select=player_id,nickname,mode,status,last_seen_at&status=eq.online&last_seen_at=gt.${encodeURIComponent(cutoff)}&order=last_seen_at.desc&limit=100`);
    const playerId = getPlayerIdentity(request, response);
    const freshest = new Map();
    result.data.forEach((player) => {
      if (!freshest.has(player.player_id)) freshest.set(player.player_id, player);
    });
    const players = [...freshest.values()].map((player) => ({ nickname: player.nickname, mode: player.mode, status: player.status, last_seen_at: player.last_seen_at, isCurrentPlayer: player.player_id === playerId }));
    return json(response, 200, { players });
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
    if (request.method === "GET" && url.pathname === "/api/profile") return profile(request, response);
    if (request.method === "GET" && url.pathname === "/api/my-scores") return myScores(request, response, url);
    if (request.method === "PATCH" && url.pathname === "/api/profile/nickname") return updateNickname(request, response);
    if (request.method === "POST" && url.pathname === "/api/games/start") return startSession(request, response);
    if (request.method === "POST" && url.pathname === "/api/presence/start") return presenceStart(request, response);
    if (request.method === "POST" && url.pathname === "/api/presence/heartbeat") return presenceHeartbeat(request, response);
    if (request.method === "POST" && url.pathname === "/api/presence/stop") return presenceStop(request, response);
    if (request.method === "POST" && url.pathname === "/api/players/heartbeat") return presenceHeartbeat(request, response);
    if (request.method === "POST" && url.pathname === "/api/players/remove") return presenceStop(request, response);
    if (request.method === "GET" && url.pathname === "/api/players/live") return activePlayers(request, response);
    if (request.method === "GET" && url.pathname === "/api/players") return activePlayers(request, response);
    if (request.method === "POST" && url.pathname === "/api/scores") return submitScore(request, response);
    return staticFile(request, response, url);
  } catch (error) {
    return json(response, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => console.log(`KEU TAP RUSH listening on http://localhost:${PORT}`));
