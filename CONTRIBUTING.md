# Contributing

Thanks for looking. Here is what helps and what does not.

## Issues, yes

Bug reports are genuinely useful, and the more concrete the better: the tool definition, the command or MCP call you made, what you expected, and what happened instead. The output of `slipway check --json` helps most.

Feature requests are welcome too. Describe the server you were building and the point where Slipway got in the way.

## Pull requests, no

Every server built on Slipway inherits its behavior, so a change here has to be checked against the servers that depend on it, not only against this repo's tests. Judging a patch means running those servers end to end, which takes longer than writing it.

That is a property of how this is maintained, not a judgment on the patch. If something is broken, an issue gets it fixed faster than a pull request will.

## Security

Please do not open a public issue for a vulnerability. Use the private reporting path in [SECURITY.md](SECURITY.md).
