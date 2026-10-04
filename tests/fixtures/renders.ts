/**
 * A render service with both kinds of long work: renders the service runs
 * and reports on, and an export the handler does itself, slowly.
 */

import { slipway, toolkit, z } from "../../src/index.js";

type Render = { id: string; state: "queued" | "rendering" | "done" | "failed"; percent: number; url?: string; reason?: string };

export type Service = {
  renders: Map<string, Render>;
  /** Status reads a render needs before it is done. */
  stepsToFinish: number;
  /** Renders with this title fail. */
  failTitle: string;
  /** Resolves the slow export, so a test decides when it finishes. */
  finishExport?: (value: { rows: number }) => void;
  failExport?: (error: Error) => void;
  started: string[];
};

export function createService(): Service {
  return { renders: new Map(), stepsToFinish: 2, failTitle: "broken", started: [] };
}

type Ctx = { service: Service };
const { defineTool } = toolkit<Ctx>();

export const renderVideo = defineTool({
  name: "render_video",
  title: "Render a video",
  description: "Start rendering a video from a title. Rendering runs on the service and takes a while.",
  input: z.object({ title: z.string().min(1).describe("The video title.") }),
  risk: "write",
  summary: ({ title }) => `render '${title}'`,
  job: {
    id: "id",
    status: (id, ctx) => {
      const render = ctx.service.renders.get(id);
      if (!render) throw new Error(`No render ${id}.`);
      if (render.state === "queued" || render.state === "rendering") {
        render.percent = Math.min(100, render.percent + Math.ceil(100 / ctx.service.stepsToFinish));
        render.state = render.percent >= 100 ? (render.id.endsWith("broken") ? "failed" : "done") : "rendering";
        if (render.state === "done") render.url = `https://cdn.example.com/${id}.mp4`;
        if (render.state === "failed") render.reason = "The encoder gave up.";
      }
      return { ...render };
    },
    done: (status: Render) => status.state === "done" || status.state === "failed",
    failed: (status: Render) => status.state === "failed",
    progress: (status: Render) => ({ progress: status.percent, total: 100, message: status.state }),
    pollMs: 250,
    waitSeconds: 2,
  },
  handler: ({ title }, ctx) => {
    const id = `r${ctx.service.renders.size + 1}${title === ctx.service.failTitle ? "-broken" : ""}`;
    const render: Render = { id, state: "queued", percent: 0 };
    ctx.service.renders.set(id, render);
    ctx.service.started.push(id);
    return { ...render };
  },
});

export const exportArchive = defineTool({
  name: "export_archive",
  title: "Export the archive",
  description: "Export every video's metadata as one archive. Slow, so it runs in the background.",
  risk: "read",
  job: { background: true, waitSeconds: 1 },
  handler: async (_args, ctx) => {
    await ctx.progress(10, 100, "counting");
    const value = await new Promise<{ rows: number }>((resolve, reject) => {
      ctx.service.finishExport = resolve;
      ctx.service.failExport = reject;
    });
    await ctx.progress(100, 100, "written");
    return value;
  },
});

export const startless = defineTool({
  name: "start_nothing",
  title: "Start nothing",
  description: "Start a job but forget to say which one, for testing a broken service.",
  risk: "write",
  job: { id: "job.id", status: () => ({}), done: () => true },
  handler: () => ({ ok: true }),
});

export function createRenderApp(service: Service = createService()) {
  return slipway<Ctx>({
    name: "renders",
    title: "Renders",
    version: "1.0.0",
    instructions: "Renders: start video renders and exports, and check on them until they finish.",
    context: () => ({ service }),
    tools: [renderVideo, exportArchive, startless],
  });
}
