# HADL for Visual Studio Code

Syntax highlighting, indentation and snippets for [HADL](https://github.com/dscanavall11/hadl) — a
programming language written in natural language, which compiles to Java, TypeScript, Python and Go.

## What it colours

HADL has almost no punctuation, so the highlighting carries more weight than
usual: it is what tells a declaration apart from the prose around it.

| Part of the language | Example | Scope |
| --- | --- | --- |
| Declaration kind | `## aggregate Order` | `keyword.other.declaration` |
| Declared type | `Order`, `TaskNotFound` | `entity.name.type` |
| Primitive | `text`, `uuid`, `timestamp` | `support.type.primitive` |
| Field name | `- title: text` | `variable.other.member` |
| Constraint | `required`, `min length 1` | `keyword.other.constraint` |
| Spelled operator | `is not`, `contains`, `divided by` | `keyword.operator.word` |
| Statement | `let`, `perform`, `return`, `fail with` | `keyword.control` |
| Scenario step | `given`, `when`, `then`, `and` | `keyword.control.scenario` |
| Constant | `now`, `nothing`, `true` | `constant.language` |
| Route placeholder | `/tasks/{id}` | `variable.parameter.route` |
| Message interpolation | `"no task with id {taskId}"` | `variable.other.member` |

Because the scopes are the standard ones, every theme you already use will
colour HADL without knowing it exists.

## Indentation

An operation body is indented under the `:` that opens it, two spaces, always
spaces. The extension sets that per language, so a project-wide tab setting does
not fight it:

```json
"[hadl]": {
  "editor.insertSpaces": true,
  "editor.tabSize": 2,
  "editor.detectIndentation": false
}
```

Indentation guides are on and whitespace is rendered at boundaries, because in a
language with this little punctuation the indentation *is* the structure.

## Snippets

Type the prefix and press Tab.

| Prefix | Gives you |
| --- | --- |
| `module` | the frontmatter and title a file starts with |
| `aggregate` | an aggregate with identity and an invariant |
| `port` | an outbound port carrying its own adapter |
| `usecases` | an inbound port |
| `service` | a service wired to both, with its first operation |
| `query` | a specification with criteria, sort and limit |
| `endpoint` | one HTTP route bound to one operation |
| `scenario` | a runnable example for `haic test` |
| `infrastructure` | port, database and deployment target |

## Installing

Not on the Marketplace yet. To use it now:

```bash
git clone https://github.com/dscanavall11/hadl
```

Then copy `editors/vscode` into your extensions folder and reload the window:

- Linux / macOS: `~/.vscode/extensions/hadl`
- Windows: `%USERPROFILE%\.vscode\extensions\hadl`

Or package it, which is tidier:

```bash
npx @vscode/vsce package
```

That writes `hadl-0.2.1.vsix`, which installs with **Extensions → … → Install
from VSIX**.

## The language server

The extension does not implement the language. It launches `haic lsp` — the
compiler itself — so what you see in the editor is what CI sees, from the same
passes, with the same codes.

| Feature | What it does |
| --- | --- |
| Diagnostics | Every `haic check` finding, live, with its code and its `help:` line. Project-wide, so fixing one module clears the warning it caused in another. |
| Format on save | `haic fmt`, which rewrites layout and only layout. On by default for `.hadl`; turn it off with `"editor.formatOnSave": false` under `[hadl]`. |
| Go to definition | Any declared name, in whichever module declares it. |
| Hover | What a declaration declares — fields, operations, invariants, and the language an operation is written in when it carries a fenced block. |
| Outline | Every declaration in the file, with its kind. |
| Completion | Declaration keywords after `##`, clauses under a heading, statements inside a body, and types after `:` or `->`. |

### Finding the compiler

In order: whatever `hadl.server.command` is set to, then the workspace's own
`node_modules/.bin/haic`, then `packages/cli/dist/bin.js` if the workspace *is*
the HADL checkout, then `haic` on `PATH`. Install it with:

```bash
npm install -g @haic/cli
```

Set `hadl.trace.server` to `messages` to watch the traffic in the output panel.

### Before packaging

The client depends on `vscode-languageclient`, so install it once in this
folder:

```bash
cd editors/vscode && npm install
```

## What it does not do yet

No rename, no code actions, and no quick fixes from the `help:` lines — the
compiler knows the fix in prose but does not yet describe it as an edit.

## Licence

Apache-2.0, the same as the compiler.

