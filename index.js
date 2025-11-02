import express from "express";
import cors from "cors";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// disable ready check to avoid NOPERM warning
const redis = new Redis(process.env.REDIS_URL, { enableReadyCheck: false });

// ===== JWT AUTH MIDDLEWARE =====
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
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

// ===== READ‑ONLY REDIS ENDPOINT =====
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
  const tokenUserId = req.user.user_id; // works for UUID or numeric

  for (const [cmdRaw, ...args] of commands) {
    const cmd = cmdRaw.toUpperCase();

    // Prevent writes
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
      results.push("ERR read‑only mode");
      continue;
    }

    try {
      // Replace user:AUTH with real key
      const argsProcessed = args.map((a) =>
        typeof a === "string" ? a.replace("user:AUTH", `user:${tokenUserId}`) : a
      );

      // Restrict user:<id>:following to owner only
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

      // Block reading sensitive keys (otp:*, session*)
      if (
        argsProcessed.length > 0 &&
        typeof argsProcessed[0] === "string"
      ) {
        const key = argsProcessed[0];
        if (
          /^otp:[\w-]+$/.test(key) ||
          /^session[\w-]+$/.test(key)
        ) {
          results.push("ERR forbidden: private key");
          continue;
        }
      }

      // === DEBUG LOGGING ===
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

// ===== DEBUG AUTH ENDPOINT =====
app.get("/debug-auth", async (req, res) => {
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

// ===== Simple whoami check =====
app.get("/whoami", (req, res) => {
  res.json({
    jwt_payload: req.user,
    resolved_user_key: `user:${req.user.user_id}`
  });
});

// ===== Crash logging =====
process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) =>
  console.error("Unhandled:", err)
);

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
