/**
 * The extension side of the language server.
 *
 * There is deliberately no bundled copy of the compiler here. The server this
 * launches is the same `haic` that runs in the terminal and in CI, so the
 * squiggle in the editor cannot disagree with the build — and an editor
 * extension can never be a version behind the project it is editing.
 */
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { workspace, window } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  const server = resolveServer();
  if (!server) {
    window.showWarningMessage(
      'HADL: no compiler found, so diagnostics and formatting are off. Install it with "npm install -g @haic/cli", or set "hadl.server.command".',
    );
    return;
  }

  client = new LanguageClient(
    'hadl',
    'HADL',
    {
      run: { ...server, transport: TransportKind.stdio },
      debug: { ...server, transport: TransportKind.stdio },
    },
    {
      documentSelector: [{ scheme: 'file', language: 'hadl' }],
      // The server analyses the whole project, so it wants to know about every
      // source, not only the one on screen: a change in one module can fix or
      // break a diagnostic in another.
      synchronize: { fileEvents: workspace.createFileSystemWatcher('**/*.hadl') },
    },
  );

  context.subscriptions.push(client);
  client.start();
}

/**
 * Where to find the compiler, in the order a project would want it found:
 * whatever the workspace configured, then its own dependency, then the checkout
 * itself when this is the HADL repository, then whatever is on PATH.
 */
function resolveServer() {
  const configured = workspace.getConfiguration('hadl').get('server.command');
  if (typeof configured === 'string' && configured.trim() !== '') {
    return { command: configured, args: ['lsp'] };
  }

  for (const folder of workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    const local = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'haic.cmd' : 'haic');
    if (existsSync(local)) return { command: local, args: ['lsp'] };

    const checkout = join(root, 'packages', 'cli', 'dist', 'bin.js');
    if (existsSync(checkout)) return { module: checkout, args: ['lsp'] };
  }

  return { command: process.platform === 'win32' ? 'haic.cmd' : 'haic', args: ['lsp'] };
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
