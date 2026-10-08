# IDE setup

## VS Code

Install the recommended extensions from `.vscode/extensions.json`. The
workspace settings enable format-on-save, use the repository's Prettier
configuration, and keep generated `dist` output out of search results.

Useful tasks are available through the Makefile:

```bash
make type-check
make lint
make test
```

## IntelliJ IDEA / WebStorm

1. Open the repository root as the project directory.
2. Set the project Node.js interpreter to Node 20 or newer.
3. Enable the pnpm package manager under **Settings → Languages & Frameworks → Node.js**.
4. Enable the bundled TypeScript service and use the repository `tsconfig.json`.
5. Add a Node.js run configuration for `src/index.ts` using the `tsx` package, or run `make dev` from the terminal.
6. Mark `dist` as excluded and keep `.env.local` outside version control.

Run the same checks used by CI before opening a pull request:

```bash
make format-check
make lint
make type-check
make test
```
