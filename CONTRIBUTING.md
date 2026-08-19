# Contributing

Bug reports, focused feature proposals, documentation fixes, and pull requests are welcome.

## Before contributing

- Search the [issues](https://github.com/drawde-nadroj/pi-subagent-supervisor/issues) before opening a duplicate.
- Use an issue to discuss substantial behavior or interface changes before implementing them.
- Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.

## Development

Requirements: Node.js 22.19 or newer and npm.

```sh
npm ci
npm test
npm pack --dry-run
```

Do not run the routing evaluation scripts unless you intend to invoke real agents and incur provider costs.

Keep changes focused, use tabs, follow the current TypeScript style, and add stable tests for behavior changes. Treat agent-definition changes as security-sensitive: review their instructions, tools, routing scope, and trust boundaries carefully. Do not include credentials, local paths, generated package archives, or personal data.

## Pull requests

Explain the problem and solution, link related issues, and list the checks you ran. Update documentation and the changelog when the change affects users. By contributing, you agree that your contribution is licensed under the MIT License.
