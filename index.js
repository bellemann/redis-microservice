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
      // ===== Replace user:AUTH with the authenticated user’s key =====
      const tokenUserId = parseInt(req.user.user_id, 10);
      const argsProcessed = args.map((arg) =>
        typeof arg === "string" && arg === "user:AUTH"
          ? `user:${tokenUserId}`
          : arg
      );

      // ===== Access Control for "user:<id>:following" keys =====
      const restricted =
        argsProcessed &&
        argsProcessed.length > 0 &&
        typeof argsProcessed[0] === "string" &&
        /^user:\d+:following$/.test(argsProcessed[0]);

      if (restricted) {
        const key = argsProcessed[0];
        const idInKey = parseInt(key.split(":")[1], 10);
        if (idInKey !== tokenUserId) {
          results.push("ERR forbidden: private resource");
          continue;
        }
      }

      const result = await redis[cmd.toLowerCase()](...argsProcessed);
      results.push(result);
    } catch (err) {
      results.push(`ERR ${err.message}`);
    }
  }

  res.json(results);
});
