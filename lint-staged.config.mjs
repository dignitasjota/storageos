import path from 'node:path';

const WORKSPACES = ['apps/api', 'apps/web', 'packages/database', 'packages/shared', 'packages/ui'];

const ESLINT_RE = /\.(ts|tsx)$/;
const PRETTIER_RE = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml)$/;

const root = process.cwd();

function findWorkspace(absFile) {
  const rel = path.relative(root, absFile);
  return WORKSPACES.find((ws) => rel === ws || rel.startsWith(ws + path.sep));
}

function quote(p) {
  return `"${p}"`;
}

export default (stagedFiles) => {
  const commands = [];

  const byWorkspace = new Map();
  for (const file of stagedFiles) {
    if (!ESLINT_RE.test(file)) continue;
    const ws = findWorkspace(file);
    if (!ws) continue;
    if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
    byWorkspace.get(ws).push(file);
  }

  for (const [ws, files] of byWorkspace) {
    const wsAbs = path.resolve(root, ws);
    const rels = files.map((f) => quote(path.relative(wsAbs, f))).join(' ');
    commands.push(
      `pnpm --filter ./${ws} exec eslint --max-warnings=0 --no-warn-ignored --fix ${rels}`,
    );
  }

  const prettierFiles = stagedFiles.filter((f) => PRETTIER_RE.test(f));
  if (prettierFiles.length > 0) {
    const rels = prettierFiles.map((f) => quote(path.relative(root, f))).join(' ');
    commands.push(`prettier --write --ignore-unknown ${rels}`);
  }

  return commands;
};
