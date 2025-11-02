import express from "express";
import cors from "cors";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ===== Redis connection (disable ready check warning) =====
const redis = new Redis(process.env.REDIS_URL, { enableReadyCheck: false });

// ===== Simple /ping test (no auth) =====
app.all("/ping", (_req, res) => {
  res.send("pong");
});

// ===== JWT AUTH MIDDLEWARE =====
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log("Authorization header I got:", authHeader);
  if (!authHeader) return res.status(401).json({ error: "Missing token" });

  const token = authHeader.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

// ===== Read‑only Redis proxy endpoint =====
app.post("/", async (req, res) => {
  let commands = req.body;
  if (!Array.isArray(commands)) {
    if (Array.isArray(req.body.commands)) commands = req.body.commands;
    else
      return res
        .status(400)
        .json({ error: "Body must be an array of Redis commands" });
  }

  const results = [];
  const tokenUserId = req.user.user_id;

  for (const [cmdRaw, ...args] of commands) {
    const cmd = cmdRaw.toUpperCase();

    // disallow write ops
    const writeCommands = [
      "SET",
      "DEL",
      "HSET",
      "HINCRBY",
      "ZADD",
      "ZREM",
      "INCR",
      "DECR",
      "MSET",
      "APPEND",
      "EXPIRE"
    ];
    if (writeCommands.includes(cmd)) {
      results.push("ERR read-only mode");
      continue;
    }

    try {
      // Replace user:AUTH placeholders
      const argsProcessed = args.map((a) =>
        typeof a === "string" ? a.replace("user:AUTH", `user:${tokenUserId}`) : a
      );

      // Restrict user:<id>:following access
      if (
        argsProcessed.length > 0 &&
        typeof argsProcessed[0] === "string" &&
        /^user:[\w-]+:following$/.test(argsProcessed[0])
      ) {
        const idInKey = argsProcessed[0].split(":")[1];
        if (idInKey !== tokenUserId) {
          results.push("ERR forbidden: private resource");
          continue;
        }
      }

      // Block sensitive keys like otp:* and session*
      if (
        argsProcessed.length > 0 &&
        typeof argsProcessed[0] === "string"
      ) {
        const key = argsProcessed[0];
        if (/^otp:[\w-]+$/.test(key) || /^session[\w-]+$/.test(key)) {
          results.push("ERR forbidden: private key");
          continue;
        }
      }

      // Console logging for debug
      console.log("=== Redis Request ===");
      console.log("JWT user_id:", req.user.user_id);
      console.log("Command:", cmdRaw);
      console.log("Original args:", args);
      console.log("Resolved args:", argsProcessed);

      const result = await redis[cmd.toLowerCase()](...argsProcessed);

      console.log("Redis result:", result);
      console.log("=====================");

      results.push(result);
    } catch (err) {
      console.error("Redis error:", err);
      results.push(`ERR ${err.message}`);
    }
  }

  res.json(results);
});

// ===== /debug-auth: shows resolved Redis key =====
app.all("/debug-auth", async (req, res) => {
  try {
    const tokenUserId = req.user.user_id;
    const resolvedKey = `user:${tokenUserId}`;
    const data = await redis.hgetall(resolvedKey);

    console.log("=== /debug-auth ===");
    console.log("Token user_id:", tokenUserId);
    console.log("Resolved key:", resolvedKey);
    console.log("Redis data:", data);
    console.log("===================");

    res.json({
      user_id: tokenUserId,
      resolved_key: resolvedKey,
      redis_data: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== /whoami: return JWT payload =====
app.all("/whoami", (req, res) => {
  res.json({
    jwt_payload: req.user,
    resolved_user_key: `user:${req.user.user_id}`
  });
});

// ===== Error / crash logging =====
process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
