#!/usr/bin/env node
// A built server as a client launches it, used by the startup check.
import { defineTool, slipway } from "../../dist/index.js";

const app = slipway({
  name: "pinger",
  version: "1.0.0",
  instructions: "Pinger answers pong, to prove a server is alive.",
  context: () => ({}),
  tools: [
    defineTool({
      name: "ping",
      title: "Ping",
      description: "Answer pong, to prove the server is alive and answering.",
      risk: "read",
      handler: () => ({ pong: true }),
    }),
  ],
});

await app.main();
