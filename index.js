import express from "express";
import cors from "cors";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Redis connection, disable ready‑check to avoid INFO permission warning
const redis = new Redis(process.env.REDIS_URL, { enableReadyCheck: false });

// Quick ping to test if the app is live (no auth)
app.get("/ping", (_req, res) => res.send("pong"));

// JWT authentication middleware
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log("Authorization header I got:", authHeader);
  if (!authHeader)
    return res.status(401).json({ error: "Missing token" });

  const token = authHeader.replace("Bearer ", "");
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

// Main read‑only redis proxy
app.post("/", async (req, res) => {
  const body = Array.isArray(req.body)
    ? req.body
    : Array.isArray(req.body.commands)
    ? req.body.commands
    : null;
  if (!body) return res.status(400).json({ error: "Body must be array" });

  const results = [];
  const tokenUserId = req.user.user_id;

  for (const [cmdRaw, ...args] of body) {
    const cmd = cmdRaw.toUpperCase();
    const writeCommands = [
      "SET", "DEL", "HSET", "HINCRBY", "ZADD", "ZREM",
      "INCR", "DECR", "MSET", "APPEND", "EXPIRE"
    ];
    if (writeCommands.includes(cmd)) {
      results.push("ERR read‑only mode");
      continue;
    }

    try {
      const argsProcessed = args.map(x =>
        typeof x === "string" ? x.replace("user:AUTH", `user:${tokenUserId}`) : x
      );

      // Owner check for user:<id>:following
      if (
        argsProcessed[0] &&
        /^user:[\w-]+:following$/.test(argsProcessed[0])
      ) {
        const idInKey = argsProcessed[0].split(":")[1];
        if (idInKey !== tokenUserId) {
          results.push("ERR forbidden: private resource");
          continue;
        }
      }

      // Block reading otp:* or session*
      if (
        argsProcessed[0] &&
        (/^otp:[\w-]+$/.test(argsProcessed[0]) ||
          /^session[\w-]+$/.test(argsProcessed[0]))
      ) {
        results.push("ERR forbidden: private key");
        continue;
      }

      console.log("=== Redis Request ===");
      console.log("User:", tokenUserId);
      console.log("Command:", cmd);
      console.log("Args original:", args);
      console.log("Args processed:", argsProcessed);

      const result = await redis[cmd.toLowerCase()](...argsProcessed);
      console.log("Redis result:", result);
      console.log("=====================");

      results.push(result);
    } catch (e) {
      console.error("Redis error:", e);
      results.push(`ERR ${e.message}`);
    }
  }

  res.json(results);
});

// /debug-auth shows what user:AUTH resolves to
app.get("/debug-auth", async (req, res) => {
  try {
    const key = `user:${req.user.user_id}`;
    const data = await redis.hgetall(key);

    console.log("/debug-auth key:", key, "data:", data);
    res.json({ user_id: req.user.user_id, key, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /whoami dumps the decoded JWT
app.get("/whoami", (req, res) =>
  res.json({ jwt_payload: req.user, resolved_user_key: `user:${req.user.user_id}` })
);

// Error handlers
process.on("uncaughtException", e => console.error("Uncaught:", e));
process.on("unhandledRejection", e => console.error("Unhandled:", e));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
