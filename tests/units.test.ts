import { describe, expect, it } from "vitest";
import { flagsFor, parseToolArgs } from "../src/cli/flags.js";
import { formatOutput, selectFields } from "../src/cli/output.js";
import { EXIT, httpError, toSlipwayError } from "../src/errors.js";
import { defineTool, jsonSchema as contract, Secrets, slipway, z } from "../src/index.js";
import { searchTools } from "../src/search.js";
import { readPolicy } from "../src/policy.js";
import { inputJsonSchema, jsonSchema, resolveLocalRef, shareRepeats, type JsonSchema } from "../src/schema.js";

describe("flags", () => {
  const schema = inputJsonSchema(
    z.object({
      text: z.string().describe("What to post."),
      count: z.number().int().optional(),
      draft: z.boolean().optional(),
      kind: z.enum(["post", "reply"]).optional(),
      ids: z.array(z.number().int()).optional(),
      labels: z.array(z.string()).optional(),
      meta: z.object({ a: z.string() }).optional(),
    }),
  );
  const flags = flagsFor(schema);

  it("derives kinds, choices and requirement from the schema", () => {
    const by = Object.fromEntries(flags.map((flag) => [flag.key, flag]));
    expect(by.text).toMatchObject({ flag: "--text", kind: "string", required: true, help: "What to post." });
    expect(by.count!.kind).toBe("integer");
    expect(by.kind).toMatchObject({ kind: "enum", choices: ["post", "reply"] });
    expect(by.ids).toMatchObject({ kind: "integer", repeatable: true });
    expect(by.meta!.kind).toBe("json");
  });

  it("parses every spelling a person types", () => {
    expect(parseToolArgs(["hello", "--count=3", "--draft", "--kind", "reply", "--ids", "1,2", "--ids", "3", "--labels", "a,b", "--meta", '{"a":"x"}'], flags, [])).toEqual({
      text: "hello",
      count: 3,
      draft: true,
      kind: "reply",
      ids: [1, 2, 3],
      labels: ["a,b"],
      meta: { a: "x" },
    });
    expect(parseToolArgs(["--text", "x", "--no-draft"], flags, [])).toEqual({ text: "x", draft: false });
    expect(parseToolArgs(["--text", "x", "--draft", "false"], flags, [])).toEqual({ text: "x", draft: false });
  });

  /** From ThriveCart: an enum element is a word you type, so `--status refunded` must not need JSON quotes. */
  it("takes an array of choices as a repeated word", () => {
    const statuses = flagsFor(inputJsonSchema(z.object({ status: z.array(z.enum(["paid", "refunded"])).optional() })));
    expect(statuses[0]).toMatchObject({ kind: "enum", repeatable: true });
    expect(parseToolArgs(["--status", "paid", "--status", "refunded"], statuses, [])).toEqual({ status: ["paid", "refunded"] });
  });

  it("explains a mistake in terms of flags", () => {
    expect(() => parseToolArgs(["--cuont", "3"], flags, [])).toThrow("Unknown option --cuont. Did you mean --count?");
    expect(() => parseToolArgs(["--count", "three"], flags, [])).toThrow("--count expects a whole number");
    expect(() => parseToolArgs(["--kind", "quote"], flags, [])).toThrow("one of: post, reply");
  });
});

describe("output", () => {
  it("selects nested fields across arrays without losing siblings", () => {
    const data = { posts: [{ uri: "a", text: "x", author: { handle: "h", name: "n" } }] };
    expect(selectFields(data, ["posts.uri", "posts.author.handle"])).toEqual({ posts: [{ uri: "a", author: { handle: "h" } }] });
  });

  /**
   * From ThriveCart: two paths under one head overwrote each other, so
   * `--select orders.id,orders.total` quietly returned only the total, on a
   * connector where the dropped field might be the amount.
   */
  it("keeps every path that shares a head, at every depth, beside a scalar", () => {
    expect(selectFields({ orders: [{ id: "9999", total: 4900, item_name: "Bundle" }] }, ["orders.id", "orders.total"])).toEqual({ orders: [{ id: "9999", total: 4900 }] });
    expect(selectFields({ a: { b: { c: 1, d: 2, e: 3 } } }, ["a.b.c", "a.b.e"])).toEqual({ a: { b: { c: 1, e: 3 } } });
    expect(selectFields({ x: 1, y: { z: 2, w: 3 } }, ["x", "y.z", "y.w"])).toEqual({ x: 1, y: { z: 2, w: 3 } });
  });

  it("escapes CSV cells and flattens nested values", () => {
    const text = formatOutput([{ id: 1, title: 'Say "hi", then go', tags: ["a"] }], undefined, { format: "csv" });
    expect(text).toBe('id,title,tags\n1,"Say ""hi"", then go","[""a""]"\n');
  });
});

describe("errors", () => {
  it("map HTTP statuses to exit codes a script can branch on", () => {
    expect(httpError(401, "x").exitCode).toBe(EXIT.auth);
    expect(httpError(404, "x").exitCode).toBe(EXIT.notFound);
    expect(httpError(422, "x").exitCode).toBe(EXIT.usage);
    expect(httpError(429, "x").exitCode).toBe(EXIT.rateLimited);
    expect(httpError(503, "x").exitCode).toBe(EXIT.api);
  });

  it("classify errors from code that knows nothing about Slipway", () => {
    expect(toSlipwayError(Object.assign(new Error("boom"), { status: 403 })).code).toBe("auth");
    expect(toSlipwayError(new Error("No API key is configured")).code).toBe("not_configured");
    expect(toSlipwayError(new Error("something odd")).exitCode).toBe(EXIT.error);
  });

  it("treat a request that never got an answer as the service's failure, not a bug", () => {
    // Bluesky's client reports an unreachable host as status 0 with this message; its 1.2.3 exited 5 for it.
    expect(toSlipwayError(Object.assign(new Error("Could not reach https://x: fetch failed"), { status: 0 })).exitCode).toBe(EXIT.api);
    expect(toSlipwayError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })).exitCode).toBe(EXIT.api);
    expect(toSlipwayError(Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })).exitCode).toBe(EXIT.api);
    expect(toSlipwayError(new Error("socket hang up")).exitCode).toBe(EXIT.api);
  });
});

describe("secrets", () => {
  it("masks registered values and credential-named fields, and leaves short values alone", () => {
    const secrets = new Secrets();
    secrets.add("sk-live-123456", "eu");
    expect(secrets.redact("key sk-live-123456 in eu")).toBe("key [redacted] in eu");
    expect(secrets.redactDeep({ headers: { Authorization: "Bearer abc" }, password: "pw", region: "eu" })).toEqual({
      headers: { Authorization: "[redacted]" },
      password: "[redacted]",
      region: "eu",
    });
  });
});

describe("policy", () => {
  it("reads every switch under the app's own prefix", () => {
    const policy = readPolicy({ X_READ_ONLY: "true", X_ALLOW_DESTRUCTIVE: "0", X_TOOLSETS: "a, b", X_SURFACE: "search", X_TOOL_TIMEOUT_MS: "500" }, "X");
    expect(policy).toMatchObject({ readOnly: true, allowDestructive: false, surface: "search", toolTimeoutMs: 500, confirm: "human" });
    expect(readPolicy({ X_CONFIRM: "MODEL" }, "X").confirm).toBe("model");
    expect(readPolicy({ X_CONFIRM: "maybe" }, "X", { confirm: "model" }).confirm).toBe("model");
    expect([...(policy.toolsets as Set<string>)]).toEqual(["a", "b"]);
    expect(readPolicy({}, "X").toolsets).toBe("all");
  });

  it("lets a default toolset follow an older switch in the environment", () => {
    const defaults = { toolsets: (env: NodeJS.ProcessEnv) => (env.X_ENABLE_BETA === "1" ? ("all" as const) : []) };
    expect([...(readPolicy({}, "X", defaults).toolsets as Set<string>)]).toEqual([]);
    expect(readPolicy({ X_ENABLE_BETA: "1" }, "X", defaults).toolsets).toBe("all");
    expect([...(readPolicy({ X_ENABLE_BETA: "1", X_TOOLSETS: "beta" }, "X", defaults).toolsets as Set<string>)]).toEqual(["beta"]);
  });

  it("hides the irreversible tools with destructive writes off only when the app asks", () => {
    expect(readPolicy({ X_ALLOW_DESTRUCTIVE: "0" }, "X").hideDestructive).toBe(false);
    expect(readPolicy({ X_ALLOW_DESTRUCTIVE: "0" }, "X", { destructiveOff: "hide" }).hideDestructive).toBe(true);
    expect(readPolicy({}, "X", { destructiveOff: "hide" }).hideDestructive).toBe(false);
  });
});

describe("definitions", () => {
  it("reject a tool that cannot work, at load time", () => {
    const base = { title: "T", description: "A tool for testing definitions.", risk: "read" as const, handler: () => ({}) };
    expect(() => defineTool({ ...base, name: "Bad-Name" })).toThrow("snake_case");
    expect(() => defineTool({ ...base, name: "ok", positional: ["nope"] })).toThrow("positional 'nope'");
    expect(() => slipway({ name: "x", version: "1", context: () => ({}), tools: [defineTool({ ...base, name: "a" }), defineTool({ ...base, name: "a" })] })).toThrow(
      "two tools are named 'a'",
    );
  });

  it("keep a class-based context's methods and getters in handlers", async () => {
    class Client {
      private readonly base = "https://api.example";
      get origin() {
        return this.base;
      }
      ping() {
        return "pong";
      }
    }
    const tool = defineTool<{ client: Client }>({
      name: "probe",
      title: "Probe",
      description: "Return the client's origin and ping reply.",
      risk: "read",
      handler: (_args, ctx) => ({ origin: ctx.client.origin, reply: ctx.client.ping(), surface: ctx.surface }),
    });
    const app = slipway({ name: "probe", version: "1", context: () => ({ client: new Client() }), tools: [tool] });
    expect(await app.invoke("probe", {}, { surface: "cli", env: {} })).toEqual({ origin: "https://api.example", reply: "pong", surface: "cli" });
  });
});

/** A schema with every local reference written out again, to compare with what went in. */
function inlined(root: JsonSchema, node: unknown = root): unknown {
  if (Array.isArray(node)) return node.map((item) => inlined(root, item));
  if (node === null || typeof node !== "object") return node;
  const resolved = resolveLocalRef(root, node as Record<string, unknown>);
  return Object.fromEntries(Object.entries(resolved).filter(([key]) => node !== root || key !== "$defs").map(([key, value]) => [key, inlined(root, value)]));
}

describe("shareRepeats", () => {
  const style = {
    type: "object",
    description: "How the block looks on the web and in the email.",
    properties: Object.fromEntries(["background_color", "text_color", "border_color", "padding", "margin", "alignment"].map((name) => [name, { type: "string", description: `The block's ${name.replace("_", " ")}.` }])),
  };
  const block = (kind: string, extra: Record<string, unknown>) => ({
    type: "object",
    properties: { type: { type: "string", enum: [kind] }, visual_settings: style, ...extra },
    required: ["type"],
  });
  const blocks = { type: "array", description: "The post's content.", items: { oneOf: [block("paragraph", { text: { type: "string" } }), block("image", { image_url: { type: "string" }, caption: { type: "string" } }), block("quote", { quote: { type: "string" } })] } };
  const post: JsonSchema = { type: "object", properties: { title: { type: "string" }, blocks, payload: { type: "object", description: "The whole body.", properties: { title: { type: "string" }, blocks } } }, required: ["title"] };

  it("writes each repeated part once, names it, and loses nothing", () => {
    const shared = shareRepeats(post);
    expect(JSON.stringify(shared).length).toBeLessThan(JSON.stringify(post).length / 2);
    expect(Object.keys(shared.$defs as object)).toEqual(expect.arrayContaining(["blocks", "visual_settings"]));
    expect(inlined(shared)).toEqual(post);
  });

  it("leaves small repeats inline, and a schema with nothing to share as it was", () => {
    const small: JsonSchema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } };
    expect(shareRepeats(small)).toBe(small);
  });

  it("keeps a schema whose references point anywhere but its definitions as it was", () => {
    const pointing: JsonSchema = { ...post, properties: { ...(post.properties as object), again: { $ref: "#/properties/blocks" } } };
    expect(shareRepeats(pointing)).toBe(pointing);
  });

  it("refers an inline copy of an existing definition to it, keeping its name", () => {
    const withDefs: JsonSchema = { type: "object", properties: { one: style, two: style }, $defs: { look: style } };
    const shared = shareRepeats(withDefs);
    expect(shared.properties).toEqual({ one: { $ref: "#/$defs/look" }, two: { $ref: "#/$defs/look" } });
    expect(Object.keys(shared.$defs as object)).toEqual(["look"]);
  });

  it("keeps both names of two definitions with the same body, so a reference to either still resolves", () => {
    const twins: JsonSchema = { type: "object", properties: { a: { $ref: "#/$defs/first" }, b: { $ref: "#/$defs/second" }, c: style, d: style }, $defs: { first: style, second: style } };
    const shared = shareRepeats(twins);
    expect(Object.keys(shared.$defs as object).sort()).toEqual(["first", "second"]);
    expect(inlined(shared)).toEqual(inlined(twins));
  });

  it("derives the same flags, and accepts and refuses the same arguments", async () => {
    const shared = shareRepeats(post);
    expect(flagsFor(shared)).toEqual(flagsFor(post));
    const full = jsonSchema(post);
    const lean = jsonSchema(post, { shareRepeats: true });
    expect(inputJsonSchema(lean)).toEqual(shared);
    for (const value of [{ title: "Hi", blocks: [{ type: "image", image_url: "https://example.com/a.png" }] }, { title: "Hi", blocks: [{ type: "video" }] }, { blocks: [] }]) {
      expect(Boolean((await lean["~standard"].validate(value)).issues)).toBe(Boolean((await full["~standard"].validate(value)).issues));
    }
  });

  it("is linear in the schema's size", () => {
    const many = { ...post, properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`blocks_${i}`, blocks])) };
    const start = performance.now();
    const shared = shareRepeats(many);
    expect(performance.now() - start).toBeLessThan(500);
    expect(inlined(shared)).toEqual(many);
  });
});

describe("flags through references", () => {
  it("reads a property that is only a reference as the definition it points to", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { blocks: { type: "array", items: { $ref: "#/$defs/block" } }, look: { $ref: "#/$defs/style" }, size: { $ref: "#/$defs/size", description: "How big." } },
      $defs: { block: { type: "object", properties: { kind: { type: "string" } } }, style: { type: "object", description: "How it looks." }, size: { type: "string", enum: ["s", "m"] } },
    };
    const by = Object.fromEntries(flagsFor(schema).map((flag) => [flag.key, flag]));
    expect(by.blocks).toMatchObject({ kind: "json", repeatable: true });
    expect(by.look).toMatchObject({ kind: "json", help: "How it looks." });
    expect(by.size).toMatchObject({ kind: "enum", choices: ["s", "m"], help: "How big." });
  });
});

describe("search reads what a tool takes", () => {
  const tool = (name: string, title: string, properties: Record<string, unknown>) =>
    defineTool({ name, title, description: `${title}.`, input: contract({ type: "object", properties }), risk: "write", handler: () => ({}) });
  const tools = [
    tool("create_post", "Create a new post", { channelId: { type: "string" }, schedulingType: { type: "string" }, text: { type: "string" } }),
    tool("move_post", "Move a post", { postId: { type: "string" } }),
    tool("list_tags", "List tags", {}),
  ];

  it("finds a tool by its arguments, split where camelCase joins words", () => {
    const [first] = searchTools(tools, "schedule a post to a channel");
    expect(first?.tool.name).toBe("create_post");
  });

  it("still ranks a name above an argument", () => {
    expect(searchTools(tools, "move a post")[0]?.tool.name).toBe("move_post");
  });

  it("reads an argument by its own words, not through a synonym", () => {
    // Google Photos: "photos" means media, and get_media_item takes a media_item_id, but the picker is the answer.
    const photos = [
      defineTool({ name: "get_media_item", title: "Get one media item", description: "Fetch a single media item by id. To reach anything else, use start_pick_session.", input: contract({ type: "object", properties: { media_item_id: { type: "string" } } }), risk: "read", handler: () => ({}) }),
      defineTool({ name: "start_pick_session", title: "Start a photo picker session", description: "Open a picker so the user can choose photos from their library.", input: contract({ type: "object", properties: {} }), risk: "read", handler: () => ({}) }),
    ];
    const synonyms = { photos: ["media"], choose: ["pick"] };
    expect(searchTools(photos, "let me choose photos", 10, synonyms)[0]?.tool.name).toBe("start_pick_session");
  });
});
