import express from "express";

import cors from "cors";

import Redis from "ioredis";

import dotenv from "dotenv";

import jwt from "jsonwebtoken";

dotenv.config();

const app = express();

app.use(cors());

app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);

// ===== JWT AUTH MIDDLEWARE =====

app.use((req, res, next) => {

const authHeader = req.headers.authorization;

if (!authHeader) return res.status(401).json({ error: "Missing token" });

const token = authHeader.replace("Bearer ", "");

try {

const decoded = jwt.verify(token, process.env.JWT_SECRET);

req.user = decoded; // store user info

next();

} catch {

return res.status(401).json({ error: "Invalid token" });

}

});

// ====== READ-ONLY, UPSTASH-COMPATIBLE ENDPOINT ======

// Works just like Upstash REST but enforces read-only + access control.

app.post("/", async (req, res) => {

let commands = req.body;

if (!Array.isArray(commands)) {

if (Array.isArray(req.body.commands)) {

commands = req.body.commands;

} else {

return res

.status(400)

.json({ error: "Body must be an array of Redis commands" });

}

}

const results = [];

for (const [cmdRaw, ...args] of commands) {

const cmd = cmdRaw.toUpperCase();

// ===== Prevent write commands =====

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

// === Access Control for "user:<id>:following" keys ===

// Only the owner user_id in token can read that key.

// Example key: user:123:following

const restricted =

args &&

args.length > 0 &&

typeof args[0] === "string" &&

/^user:\d+:following$/.test(args[0]); // matches pattern


if (restricted) {

const key = args[0];

const idInKey = parseInt(key.split(":")[1], 10);

const tokenUserId = parseInt(req.user.user_id, 10);


if (idInKey !== tokenUserId) {

results.push("ERR forbidden: private resource");

continue;

}

}


// If allowed, perform the command

const result = await rediscmd.toLowerCase();

results.push(result);

} catch (err) {

results.push(ERR ${err.message});

}

}

res.json(results);

});

// ===== Server startup =====

app.listen(process.env.PORT || 3000, () =>

console.log("Read-only Redis API with permissions + JWT auth running.")

);
