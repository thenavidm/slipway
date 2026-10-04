import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, z } from "../src/index.js";
import { cli, connect } from "../src/testing.js";
import { createApp } from "./fixtures/notes.js";
import { createRenderApp, createService } from "./fixtures/renders.js";

function payload(result: { content?: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content?.[0]?.text ?? "null");
}

describe("job tools", () => {
  it("list a status tool after each job tool, reading, in the same toolsets, with wait_seconds on both", async () => {
    const mcp = await connect(createRenderApp());
    const tools = await mcp.listTools();
    await mcp.close();
    expect(tools.map((tool) => tool.name)).toEqual([
      "render_video",
      "render_video_status",
      "export_archive",
      "export_archive_status",
      "start_nothing",
      "start_nothing_status",
    ]);
    const status = tools.find((tool) => tool.name === "render_video_status")!;
    expect(status.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(status.title).toBe("Render a video: status");
    expect(status.inputSchema).toMatchObject({ required: ["job_id"], properties: { wait_seconds: { type: "integer", maximum: 55, default: 2 } } });
    const start = tools.find((tool) => tool.name === "render_video")!;
    expect((start.inputSchema.properties as Record<string, unknown>).wait_seconds).toMatchObject({ maximum: 55, default: 2 });
  });

  it("return the finished job when it finishes within the wait, with progress along the way", async () => {
    const app = createRenderApp();
    const updates: number[] = [];
    const result = await app.invoke("render_video", { title: "Trailer" }, { surface: "mcp", onProgress: (update) => void updates.push(update.progress) });
    expect(result).toMatchObject({ job_id: "r1", tool: "render_video", done: true, status: { state: "done", url: "https://cdn.example.com/r1.mp4" } });
    expect(updates).toEqual([0, 50, 100]);
  });

  it("hand back the job to check later when it is still running, and finish it through the status tool", async () => {
    const mcp = await connect(createRenderApp());
    const started = await mcp.callTool("render_video", { title: "Trailer", wait_seconds: 0 });
    expect(started.structuredContent).toMatchObject({ job_id: "r1", done: false, status: { state: "queued" } });
    expect((started.structuredContent as { check: string }).check).toBe('Call render_video_status with job_id "r1" to check on it. Pass wait_seconds to wait for it to finish.');

    const checked = await mcp.callTool("render_video_status", { job_id: "r1", wait_seconds: 0 });
    expect(checked.structuredContent).toMatchObject({ done: false, status: { state: "rendering", percent: 50 } });
    const finished = await mcp.callTool("render_video_status", { job_id: "r1", wait_seconds: 5 });
    await mcp.close();
    expect(finished.structuredContent).toMatchObject({ done: true, status: { state: "done" } });
    expect((finished.structuredContent as Record<string, unknown>).check).toBeUndefined();
  });

  it("stop waiting at the deadline and say how to check again", async () => {
    const service = createService();
    service.stepsToFinish = 1_000;
    const started = Date.now();
    const result = (await createRenderApp(service).invoke("render_video", { title: "Feature", wait_seconds: 1 }, { surface: "mcp" })) as { done: boolean };
    const took = Date.now() - started;
    expect(result.done).toBe(false);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(2_000);
  });

  it("report a failed job as an API error with the service's status", async () => {
    const mcp = await connect(createRenderApp());
    const result = await mcp.callTool("render_video", { title: "broken" });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: "api", error: "render_video job r1-broken failed.", details: { state: "failed", reason: "The encoder gave up." } });
  });

  it("refuse a started job the service gave no id for", async () => {
    await expect(createRenderApp().invoke("start_nothing", {}, { surface: "mcp" })).rejects.toMatchObject({
      code: "api",
      message: "start_nothing started a job but returned no job id at 'job.id'.",
    });
  });

  it("stop waiting when the caller cancels, and leave the job running", async () => {
    const service = createService();
    service.stepsToFinish = 1_000;
    const app = createRenderApp(service);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(app.invoke("render_video", { title: "Long" }, { surface: "mcp", signal: controller.signal })).rejects.toMatchObject({ code: "canceled" });
    expect(service.started).toEqual(["r1"]);
  });
});

describe("background jobs", () => {
  it("run the handler in the background and keep its result for the status tool", async () => {
    const service = createService();
    const mcp = await connect(createRenderApp(service));
    const started = await mcp.callTool("export_archive", { wait_seconds: 0 });
    const job = started.structuredContent as { job_id: string; done: boolean; progress: unknown; check: string };
    expect(job.job_id).toMatch(/^job_[0-9a-f]{24}$/);
    expect(job.done).toBe(false);
    expect(job.progress).toEqual({ progress: 10, total: 100, message: "counting" });

    service.finishExport!({ rows: 42 });
    const finished = await mcp.callTool("export_archive_status", { job_id: job.job_id, wait_seconds: 5 });
    await mcp.close();
    expect(finished.structuredContent).toMatchObject({ job_id: job.job_id, done: true, result: { rows: 42 }, progress: { progress: 100 } });
    expect((finished.structuredContent as { finished_at?: string }).finished_at).toMatch(/^\d{4}-/);
  });

  it("report the handler's own error once the job failed", async () => {
    const service = createService();
    const mcp = await connect(createRenderApp(service));
    const job = (await mcp.callTool("export_archive", { wait_seconds: 0 })).structuredContent as { job_id: string };
    service.failExport!(Object.assign(new Error("Disk full"), { status: 507 }));
    const failed = await mcp.callTool("export_archive_status", { job_id: job.job_id, wait_seconds: 5 });
    await mcp.close();
    expect(failed.isError).toBe(true);
    expect(payload(failed)).toMatchObject({ code: "api", error: "Disk full", status: 507 });
  });

  it("say plainly when a job id is unknown here", async () => {
    const mcp = await connect(createRenderApp());
    const result = await mcp.callTool("export_archive_status", { job_id: "job_nope" });
    await mcp.close();
    expect(payload(result)).toMatchObject({ code: "not_found" });
    expect(payload(result).hint).toContain("server that started them");
  });

  it("refuse to start more than a hundred at once", async () => {
    const app = createRenderApp();
    for (let i = 0; i < 100; i++) await app.invoke("export_archive", { wait_seconds: 0 }, { surface: "mcp" });
    await expect(app.invoke("export_archive", { wait_seconds: 0 }, { surface: "mcp" })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("jobs in a terminal", () => {
  it("wait to the end with --wait, and print the finished job", async () => {
    const run = await cli(createRenderApp(), ["render-video", "Trailer", "--wait", "--compact"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ done: true, status: { state: "done" } });
  });

  it("print the command that checks on a job still running", async () => {
    const service = createService();
    service.stepsToFinish = 1_000;
    const run = await cli(createRenderApp(service), ["render-video", "Feature", "--wait-seconds", "0", "--compact"]);
    expect(JSON.parse(run.stdout).check).toBe("renders-cli render-video-status r1 --wait");
  });

  it("wait for a background job to the end, since the command's process is all that keeps it alive", async () => {
    const service = createService();
    const app = createRenderApp(service);
    const pending = cli(app, ["export-archive", "--compact"]);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    service.finishExport!({ rows: 7 });
    const run = await pending;
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ done: true, result: { rows: 7 } });
  });

  it("explain --wait on a command that starts no job, and show job flags in help", async () => {
    const wrong = await cli(createApp(), ["get-note", "1", "--wait"]);
    expect(wrong.code).toBe(2);
    expect(JSON.parse(wrong.stderr).error).toBe("get-note does not start a job, so --wait does not apply.");
    const help = await cli(createRenderApp(), ["render-video", "--help"]);
    expect(help.stdout).toContain("render-video-status <job-id>");
    expect(help.stdout).toContain("--wait-seconds <n>");
  });

  it("records a job still running as started in the audit log", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "slipway-jobs-")), "audit.jsonl");
    const service = createService();
    service.stepsToFinish = 1_000;
    await cli(createRenderApp(service), ["render-video", "Feature", "--wait-seconds", "0"], { env: { RENDERS_AUDIT_LOG: log } });
    const outcomes = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).outcome);
    expect(outcomes).toEqual(["allowed", "started"]);
  });
});

describe("job definitions", () => {
  const base = { title: "X", description: "Something that takes long enough to need a job.", risk: "write" as const, handler: () => ({}) };

  it("are checked when the tool is defined", () => {
    expect(() => defineTool({ ...base, name: "bad_job", job: { id: "id" } as never })).toThrow("job needs id, status and done");
    expect(() => defineTool({ ...base, name: "x".repeat(58), job: { background: true } })).toThrow("at most 57 characters");
    expect(() => defineTool({ ...base, name: "slow", job: { background: true, waitSeconds: 90 } })).toThrow("0-55");
    expect(() => defineTool({ ...base, name: "own_wait", input: z.object({ wait_seconds: z.number() }), job: { background: true } })).toThrow(
      "'wait_seconds' is Slipway's own argument",
    );
    expect(() => defineTool({ ...base, name: "own_confirm", input: z.object({ confirm: z.boolean() }) })).toThrow("'confirm' is Slipway's own argument");
  });

  it("reject a wait longer than a client will hold a call open", async () => {
    const mcp = await connect(createRenderApp());
    const result = await mcp.callTool("render_video", { title: "x", wait_seconds: 120 });
    await mcp.close();
    expect(result.isError).toBe(true);
  });
});
