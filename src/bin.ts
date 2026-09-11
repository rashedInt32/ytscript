#!/usr/bin/env node
import { run } from "./Cli.ts"

// Downstream `head` or a closed pipe should end the run quietly, not crash.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0)
})

process.exitCode = await run(process.argv.slice(2))
