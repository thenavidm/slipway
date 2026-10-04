/**
 * Tab completion, generated from the same tool list as everything else.
 */

import type { App } from "../app.js";
import { UsageError } from "../errors.js";
import type { Tool } from "../tool.js";
import { flagsFor } from "./flags.js";
import { BUILTINS, GLOBAL_FLAGS } from "./help.js";

function globalFlags(): string[] {
  return GLOBAL_FLAGS.flatMap(([flag]) => flag.split(" / ").map((part) => part.split(" ")[0]!)).concat("--help");
}

function toolFlags(tool: Tool): string[] {
  return flagsFor(tool.jsonSchema).map((flag) => flag.flag);
}

function bash(bin: string, tools: readonly Tool[], words: readonly string[]): string {
  const fn = `_${bin.replace(/[^A-Za-z0-9]/g, "_")}`;
  const commands = [...tools.map((tool) => tool.command), ...words].join(" ");
  const globals = globalFlags().join(" ");
  const cases = tools
    .map((tool) => `    ${tool.command}) COMPREPLY=( $(compgen -W "${[...toolFlags(tool), ...(tool.paginate ? ["--all", "--max-items"] : [])].join(" ")} ${globals}" -- "$cur") ) ;;`)
    .join("\n");
  return `# ${bin} completion for bash
${fn}() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
    schema|help) COMPREPLY=( $(compgen -W "${tools.map((tool) => tool.command).join(" ")}" -- "$cur") ) ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;
    doctor) COMPREPLY=( $(compgen -W "--network --json" -- "$cur") ) ;;
    *) COMPREPLY=( $(compgen -W "${globals}" -- "$cur") ) ;;
  esac
}
complete -F ${fn} ${bin}
`;
}

function zsh(bin: string, tools: readonly Tool[], words: readonly string[]): string {
  return `#compdef ${bin}
# ${bin} completion for zsh, through zsh's bash compatibility layer.
autoload -U +X bashcompinit && bashcompinit
${bash(bin, tools, words)}`;
}

function fishEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function fish(bin: string, tools: readonly Tool[], words: readonly string[]): string {
  const lines = [`# ${bin} completion for fish`, `complete -c ${bin} -f`];
  for (const tool of tools) {
    lines.push(`complete -c ${bin} -n '__fish_use_subcommand' -a '${tool.command}' -d '${fishEscape(tool.title)}'`);
    for (const flag of flagsFor(tool.jsonSchema)) {
      lines.push(`complete -c ${bin} -n '__fish_seen_subcommand_from ${tool.command}' -l '${flag.flag.slice(2)}' -d '${fishEscape(flag.help.slice(0, 80))}'`);
    }
  }
  for (const word of words) lines.push(`complete -c ${bin} -n '__fish_use_subcommand' -a '${word}'`);
  for (const flag of globalFlags()) lines.push(`complete -c ${bin} -l '${flag.slice(2)}'`);
  return `${lines.join("\n")}\n`;
}

export function completionScript(app: App, shell: string | undefined, bin: string, env: NodeJS.ProcessEnv): string {
  const tools = app.tools(env);
  // The built-ins, then any terminal commands the app adds, such as logout.
  const words = [...BUILTINS, ...(app.definition.commands ?? []).map((command) => command.name)];
  if (shell === "bash") return bash(bin, tools, words);
  if (shell === "zsh") return zsh(bin, tools, words);
  if (shell === "fish") return fish(bin, tools, words);
  throw new UsageError(`completion expects bash, zsh or fish${shell ? `, got '${shell}'` : ""}.`, {
    hint: `Add \`source <(${bin} completion bash)\` to your shell's startup file.`,
  });
}
