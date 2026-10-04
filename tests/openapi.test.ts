import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { fromOpenAPI, httpExecutor, openapiHash, readOperations, slipway, toJsonSchema, toolName } from "../src/index.js";
import { formEncode } from "../src/openapi.js";
import { cli, connect } from "../src/testing.js";

/** A small API that uses every feature generation has to get right. */
const spec = {
  openapi: "3.0.3",
  info: { title: "Shop", version: "1.0.0" },
  paths: {
    "/products": {
      get: {
        operationId: "listProducts",
        summary: "List products",
        tags: ["Catalog"],
        parameters: [
          { name: "tag", in: "query", schema: { type: "array", items: { type: "string" } } },
          { name: "filter", in: "query", style: "deepObject", schema: { type: "object", properties: { color: { type: "string" } } } },
          { name: "X-Shop-Region", in: "header", schema: { type: "string" } },
          { name: "Authorization", in: "header", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductList" } } } } },
      },
      post: {
        operationId: "createProduct",
        summary: "Create a product",
        tags: ["Catalog"],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewProduct" } } } },
        responses: { "201": { description: "created" } },
      },
    },
    "/products/{productId}": {
      parameters: [{ name: "productId", in: "path", required: true, schema: { type: "string" }, description: "The product id." }],
      get: { operationId: "getProduct", summary: "Get a product", tags: ["Catalog"], responses: { "200": { description: "ok" } } },
      delete: { operationId: "deleteProduct", summary: "Delete a product", deprecated: true, responses: { "204": { description: "gone" } } },
    },
    "/orders": {
      post: {
        operationId: "placeOrder",
        summary: "Place an order",
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["product"],
                properties: {
                  product: { type: "string" },
                  confirm: { type: "boolean", description: "Charge at once." },
                  metadata: { type: "object", additionalProperties: { type: "string" } },
                },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/search": {
      post: { operationId: "searchProducts", summary: "Search products", requestBody: { content: { "application/json": { schema: { type: "object", properties: { q: { type: "string" } } } } } }, responses: { "200": { description: "ok" } } },
    },
    "/uploads": {
      post: { operationId: "upload", requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } }, responses: { "200": { description: "ok" } } },
    },
    "/health": { get: { responses: { "200": { description: "ok" } } } },
  },
  components: {
    schemas: {
      NewProduct: {
        type: "object",
        required: ["name", "id"],
        properties: {
          id: { type: "string", readOnly: true },
          name: { type: "string", example: "Mug" },
          price: { type: "number", minimum: 0, exclusiveMinimum: true },
          note: { type: "string", nullable: true },
          parent: { $ref: "#/components/schemas/NewProduct" },
        },
      },
      ProductList: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/NewProduct" } } } },
    },
  },
};

describe("reading an OpenAPI document", () => {
  it("names, risks and toolsets every operation, and says why any are skipped", () => {
    const tools = fromOpenAPI(spec, { execute: () => ({}) });
    expect(tools.map((tool) => [tool.name, tool.risk, tool.tags.join(",")])).toEqual([
      ["list_products", "read", "catalog"],
      ["create_product", "write", "catalog"],
      ["get_product", "read", "catalog"],
      ["delete_product", "destructive", ""],
      ["place_order", "write", ""],
      ["search_products", "write", ""],
      ["get_health", "read", ""],
    ]);
    expect(tools.find((tool) => tool.name === "delete_product")!.description).toBe("Deprecated. Delete a product");
    expect(tools.find((tool) => tool.name === "delete_product")!.requireConfirm).toBe(true);
    expect(readOperations(spec).skipped).toEqual([{ method: "POST", path: "/uploads", operationId: "upload", reason: "its body is multipart/form-data, which arguments cannot carry" }]);
  });

  it("turns OpenAPI's own schema dialect into JSON Schema 2020-12", () => {
    const create = fromOpenAPI(spec, { execute: () => ({}) }).find((tool) => tool.name === "create_product")!;
    const properties = create.jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["name", "price", "note", "parent"]);
    expect(create.jsonSchema.required).toEqual(["name"]);
    expect(properties.name).toEqual({ type: "string", examples: ["Mug"] });
    expect(properties.price).toEqual({ type: "number", exclusiveMinimum: 0 });
    expect(properties.note).toEqual({ type: ["string", "null"] });
    // The schema refers to itself, so the inner copy is described rather than expanded forever.
    expect(properties.parent!.description).toContain("A NewProduct, not spelled out here");
    expect(toJsonSchema({ type: "string", format: "made-up", "x-internal": true, discriminator: {} }, true)).toEqual({ type: "string" });
  });

  it("keeps parameter and body names apart from Slipway's own", () => {
    const order = fromOpenAPI(spec, { execute: () => ({}) }).find((tool) => tool.name === "place_order")!;
    expect(Object.keys(order.jsonSchema.properties as object)).toEqual(["product", "body_confirm", "metadata"]);
    const list = fromOpenAPI(spec, { execute: () => ({}) }).find((tool) => tool.name === "list_products")!;
    expect(Object.keys(list.jsonSchema.properties as object)).toEqual(["tag", "filter", "X-Shop-Region"]);
  });

  it("follows the caller's choices: which operations, their names, their risk", () => {
    const tools = fromOpenAPI(spec, {
      execute: () => ({}),
      include: ["searchProducts", "getProduct"],
      names: { getProduct: "product" },
      risk: { searchProducts: "read" },
    });
    expect(tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ["product", "read"],
      ["search_products", "read"],
    ]);
    expect(() => fromOpenAPI(spec, { execute: () => ({}), include: ["nope"] })).toThrow("No operations in the document with these ids: nope.");
  });

  it("refuses a pinned document that changed", () => {
    const pin = { sha256: openapiHash(spec) };
    expect(fromOpenAPI(spec, { execute: () => ({}), pin })).toHaveLength(7);
    const changed = { ...spec, info: { ...spec.info, version: "1.0.1" } };
    expect(() => fromOpenAPI(changed, { execute: () => ({}), pin })).toThrow("The OpenAPI document changed since it was pinned");
    expect(openapiHash(JSON.parse(JSON.stringify(spec)))).toBe(pin.sha256);
  });

  it("declares typed output only when asked", () => {
    expect(fromOpenAPI(spec, { execute: () => ({}) }).find((tool) => tool.name === "list_products")!.output).toBeUndefined();
    expect(fromOpenAPI(spec, { execute: () => ({}), typedOutput: true }).find((tool) => tool.name === "list_products")!.output).toBeDefined();
  });

  it("refuses what it cannot read", () => {
    expect(() => readOperations({ swagger: "2.0" })).toThrow("Swagger 2.0");
    expect(() => readOperations({ openapi: "3.0.0", paths: { "/a": { get: { parameters: [{ $ref: "other.json#/x" }] } } } })).toThrow("Bundle the document");
    const long = toolName("DeleteCustomersCustomerSubscriptionsSubscriptionExposedIdDiscountAndMore");
    expect(long).toMatch(/^delete_customers_customer_subscriptions_subscription_ex_[0-9a-f]{8}$/);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(toolName("DeleteCustomersCustomerSubscriptionsSubscriptionExposedIdDiscountAndLess")).not.toBe(long);
    expect(toolName("2fa.enable")).toBe("op_2fa_enable");
  });
});

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

/** A real HTTP server on this machine, answering like an API would. */
async function shop(reply: (seen: Seen) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(request);
      const answer = reply(request);
      res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { seen, url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function shopApp(baseUrl: string) {
  return slipway<{ token: string }>({
    name: "shop",
    version: "1.0.0",
    instructions: "Shop: products and orders.",
    context: (env) => ({ token: env.SHOP_TOKEN ?? "" }),
    secrets: (ctx) => [ctx.token],
    tools: fromOpenAPI<{ token: string }>(spec, {
      execute: httpExecutor({ baseUrl, headers: (ctx) => ({ authorization: `Bearer ${ctx.token}` }) }),
    }),
  });
}

describe("calling the API", () => {
  it("writes the path, the query in each parameter's style, headers and a JSON body", async () => {
    const api = await shop(() => ({ status: 200, body: { ok: true } }));
    const app = shopApp(api.url);
    const env = { SHOP_TOKEN: "tok-123456789" };
    await app.invoke("list_products", { tag: ["red", "big"], filter: { color: "blue" }, "X-Shop-Region": "eu" }, { surface: "mcp", env });
    await app.invoke("create_product", { name: "Mug", price: 3 }, { surface: "mcp", env });
    await app.invoke("get_product", { productId: "a/b c" }, { surface: "mcp", env });
    await api.close();

    expect(api.seen[0]!.url).toBe("/v1/products?tag=red&tag=big&filter%5Bcolor%5D=blue");
    expect(api.seen[0]!.headers["x-shop-region"]).toBe("eu");
    expect(api.seen[0]!.headers.authorization).toBe("Bearer tok-123456789");
    expect(api.seen[1]).toMatchObject({ method: "POST", url: "/v1/products", body: '{"name":"Mug","price":3}' });
    expect(api.seen[1]!.headers["content-type"]).toBe("application/json");
    expect(api.seen[2]!.url).toBe("/v1/products/a%2Fb%20c");
  });

  it("sends a form body with nested fields in bracket style, and its renamed fields under their own names", async () => {
    const api = await shop(() => ({ status: 200, body: { id: "o1" } }));
    const app = shopApp(api.url);
    await app.invoke("place_order", { product: "p1", body_confirm: true, metadata: { plan: "pro" } }, { surface: "mcp", env: {} });
    await api.close();
    expect(api.seen[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(api.seen[0]!.body).toBe("product=p1&confirm=true&metadata%5Bplan%5D=pro");
    expect(formEncode({ items: [{ price: "p", quantity: 2 }] })).toBe("items%5B0%5D%5Bprice%5D=p&items%5B0%5D%5Bquantity%5D=2");
  });

  it("maps the API's failures to errors a model and a script can act on, with the credential masked", async () => {
    const api = await shop((request) =>
      request.url.includes("missing")
        ? { status: 404, body: { error: { message: "No such product: missing" } } }
        : { status: 429, body: { message: "Slow down, tok-123456789" }, headers: { "retry-after": "30" } },
    );
    const app = shopApp(api.url);
    const env = { SHOP_TOKEN: "tok-123456789" };
    const mcp = await connect(app, { env });
    const missing = await mcp.callTool("get_product", { productId: "missing" });
    const limited = await mcp.callTool("get_product", { productId: "busy" });
    await mcp.close();
    const run = await cli(app, ["get-product", "missing"], { env });
    await api.close();

    expect(JSON.parse(missing.content[0]!.text as string)).toMatchObject({ code: "not_found", status: 404, error: "No such product: missing" });
    const limitedPayload = JSON.parse(limited.content[0]!.text as string);
    expect(limitedPayload).toMatchObject({ code: "rate_limited", retry_after_seconds: 30, error: "Slow down, [redacted]" });
    expect(run.code).toBe(3);
  });

  it("asks for confirmation before a generated DELETE, like any irreversible tool", async () => {
    const api = await shop(() => ({ status: 204 }));
    const app = shopApp(api.url);
    const refused = await cli(app, ["delete-product", "p1"], { env: {} });
    const done = await cli(app, ["delete-product", "p1", "--confirm", "--compact"], { env: {} });
    await api.close();
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr).error).toContain("DELETE /products/{productId} (p1)");
    expect(done.stdout).toBe('{"ok":true,"status":204}\n');
    expect(api.seen.map((request) => request.method)).toEqual(["DELETE"]);
  });

  it("refuses to send credentials over plain HTTP to another machine", async () => {
    const app = shopApp("http://api.example.com/v1");
    await expect(app.invoke("get_product", { productId: "1" }, { surface: "mcp", env: {} })).rejects.toThrow("only https");
  });
});
