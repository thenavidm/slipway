/**
 * `doctor`: what someone types when nothing works yet.
 *
 * It answers in the order a person needs: is the runtime fine, is anything
 * configured, do the settings say what they think, and does the service's own
 * check pass. Each failure names its fix. Nothing it prints is a credential.
 */

import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import type { App, CliIO, DoctorCheck } from "./app.js";
import { EXIT, NotConfiguredError, SlipwayError } from "./errors.js";
import { policyEnvNames, switchWords } from "./policy.js";

export async function runDoctor(app: App, io: CliIO, options: { network: boolean; json: boolean }): Promise<number> {
  const checks: DoctorCheck[] = [];
  const names = policyEnvNames(app.envPrefix);
  const policy = app.policy(io.env);

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js", ok: major >= 22, detail: `v${process.versions.node}`, ...(major >= 22 ? {} : { fix: "Install Node.js 22 or later." }) });
  checks.push({ name: "Version", ok: true, detail: `${app.name} ${app.version}` });

  const paid = app.allTools.some((tool) => tool.spends) ? " and paid" : "";
  const words = switchWords(policy, names);
  const writes = !app.allTools.some((tool) => tool.risk !== "read")
    ? "none: every tool only reads"
    : policy.readOnly
      ? policy.readOnlyByDefault
        ? `off: ${words.readOnly}`
        : "off (read-only)"
      : policy.allowDestructive
        ? "on"
        : policy.destructiveOffByDefault
          ? `on, irreversible${paid} ones off until ${names.allowDestructive}=1 is set`
          : `on, irreversible${paid} ones refused`;
  checks.push({ name: "Writes", ok: true, detail: writes });
  checks.push({
    name: "Tools",
    ok: true,
    detail: `${app.tools(io.env).length} of ${app.allTools.length} on${policy.toolsets === "all" ? "" : ` (${names.toolsets}=${[...policy.toolsets].join(",")})`}`,
  });

  if (policy.auditLog) {
    let writable = true;
    try {
      accessSync(dirname(policy.auditLog), constants.W_OK);
    } catch {
      writable = false;
    }
    checks.push({
      name: "Audit log",
      ok: writable,
      detail: policy.auditLog,
      ...(writable ? {} : { fix: `The folder for ${names.auditLog} is missing or not writable.` }),
    });
  }

  if (app.allTools.some((tool) => tool.cache || tool.sync)) {
    const { dataDir, loadSqlite } = await import("./data.js");
    const sqlite = await loadSqlite();
    checks.push({
      name: "Local data",
      ok: Boolean(sqlite),
      ...(sqlite ? {} : { warn: true }),
      detail: sqlite ? `${dataDir(app.name, app.envPrefix, io.env)}${policy.cache ? "" : ` (cache off: ${names.cache}=0)`}` : "unavailable: this Node.js has no SQLite",
      ...(sqlite ? {} : { fix: "Install Node.js 22.13 or later for the cache and offline search." }),
    });
  }

  let configured = true;
  let unreadable = false;
  let ctx: unknown;
  try {
    ctx = await app.context(io.env);
  } catch (error) {
    configured = false;
    unreadable = true;
    const e = error instanceof SlipwayError ? error : new NotConfiguredError(String((error as Error)?.message ?? error));
    // Outside doctor, a setting that cannot be read points here; in here, it points at how to set it.
    const fix = e.hint && !e.hint.includes(`${app.bins.cli} doctor`) ? e.hint : `Run \`${app.bins.cli} login\` for what to set.`;
    checks.push({ name: "Setup", ok: false, detail: e.message, fix });
  }

  if (ctx !== undefined && app.definition.configured) {
    configured = await app.definition.configured(ctx as never);
    checks.push({
      name: "Credentials",
      ok: configured,
      detail: configured ? "configured" : "nothing configured",
      ...(configured ? {} : { fix: `Run \`${app.bins.cli} login\` to see how to connect an account.` }),
    });
  }

  const network = options.network || app.definition.doctorNetwork === true;
  if (ctx !== undefined && app.definition.doctor) {
    try {
      checks.push(...(await app.definition.doctor(ctx as never, { network })));
    } catch (error) {
      checks.push({ name: "Service check", ok: false, detail: app.secrets.redact((error as Error)?.message ?? String(error)) });
    }
  }
  if (!network && app.definition.doctor) {
    checks.push({ name: "Network", ok: true, warn: true, detail: "not checked; run with --network to call the service" });
  }

  const failed = checks.filter((check) => !check.ok && !check.warn);
  const code = !configured ? EXIT.notConfigured : failed.length ? EXIT.error : EXIT.ok;

  if (options.json) {
    io.stdout(`${JSON.stringify(app.secrets.redactDeep({ ok: code === EXIT.ok, exit_code: code, checks }), null, 2)}\n`);
  } else {
    const width = Math.max(...checks.map((check) => check.name.length)) + 2;
    const lines = [``, `${app.title} doctor`, ``];
    for (const check of checks) {
      const mark = check.ok ? (check.warn ? "-" : "✓") : check.warn ? "!" : "✗";
      lines.push(`  ${mark} ${check.name.padEnd(width)}${app.secrets.redact(check.detail ?? "")}`);
      if (!check.ok && check.fix) lines.push(`    ${" ".repeat(width)}${check.fix}`);
    }
    const verdict = code === EXIT.ok ? "Ready." : unreadable ? "A setting needs fixing." : code === EXIT.notConfigured ? "Nothing is configured yet." : "Something needs fixing.";
    lines.push(``, `  ${verdict}`, ``);
    io.stdout(lines.join("\n"));
  }
  return code;
}
