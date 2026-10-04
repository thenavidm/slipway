#!/usr/bin/env node
// A server that quits when its key is missing, which the startup check must catch.
if (!process.env.SOME_API_KEY) {
  console.error("SOME_API_KEY is required");
  process.exit(1);
}
