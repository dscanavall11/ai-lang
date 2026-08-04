/**
 * `haic explain <code>` — the reasoning behind a design rule.
 *
 * Syntax errors carry their own hint. The rules worth explaining are the ones a
 * reader will push back on: why the compiler refuses a shape that would compile
 * fine in any other language.
 */
import { EXIT_OK, EXIT_USAGE, type Command } from '../command.js';
import { dim, error, heading, info } from '../output.js';

interface Explanation {
  title: string;
  why: string;
  fix: string;
}

const CATALOGUE: Record<string, Explanation> = {
  HADL2206: {
    title: 'Reaching past an aggregate root',
    why: 'An aggregate is the boundary inside which invariants hold. If code outside can hold a reference to an inner entity, it can change that entity without the root ever seeing it, and the invariant silently stops being true.',
    fix: 'Route the change through the aggregate root, or expose a dto carrying only the data the caller needs.',
  },
  HADL2207: {
    title: 'One aggregate embedding another',
    why: 'Two aggregates embedded in one object must be loaded, locked and saved together. That turns two consistency boundaries into one, and the transaction grows every time either side does.',
    fix: 'Store the other aggregate\'s identity as a uuid and load it when you actually need it.',
  },
  HADL2208: {
    title: 'A value object holding something with identity',
    why: 'Value objects are compared field by field and are freely copied. Putting an entity inside one means two copies of the same identity can drift apart while still comparing equal.',
    fix: 'Hold the identity as a uuid instead.',
  },
  HADL2213: {
    title: 'I/O inside the domain',
    why: 'An aggregate that calls a repository cannot be tested without one, cannot be reasoned about without knowing what the call does, and quietly becomes the place where transactions begin.',
    fix: 'Move the call into the service that orchestrates the use case, and pass the loaded data into the aggregate.',
  },
  HADL2214: {
    title: 'An aggregate with no rules',
    why: 'An aggregate with no invariants and no behaviour is a database row with extra ceremony. It costs a class, a repository and a mapper, and buys nothing over a dto.',
    fix: 'Add the rule that makes this a consistency boundary, or declare it as a dto.',
  },
  HADL2302: {
    title: 'An unchecked error in a contract',
    why: 'Unchecked errors mean a defect: a null that should not be null, an invariant already broken. Declaring one invites callers to write handling code for a situation they cannot fix, which hides the bug instead of surfacing it.',
    fix: 'Drop it from the return type, or make it checked if callers really can recover.',
  },
  HADL2303: {
    title: 'Raising an error the contract does not declare',
    why: 'The point of checked errors is that a caller can read the signature and know every way the call can fail. An undeclared error breaks that promise and reaches the caller as a surprise.',
    fix: 'Add it to the return type after "or".',
  },
  HADL2304: {
    title: 'Declaring an error that is never raised',
    why: 'Every declared error becomes a branch someone writes, a test someone maintains, and a status code someone documents. If it cannot happen, all of that is dead weight.',
    fix: 'Remove it from the contract.',
  },
  HADL2305: {
    title: 'An endpoint that does not map a checked error',
    why: 'An unmapped error escapes the transport layer and becomes a 500. The client sees a server fault for what was a perfectly ordinary business outcome.',
    fix: 'Add "responds <status> when <Error>".',
  },
  HADL2402: {
    title: 'A service depending on an adapter',
    why: 'The dependency should point inwards: the application layer defines what it needs, and the infrastructure supplies it. Pointing outwards means the use case cannot be tested or redeployed without the database it happens to use today.',
    fix: 'Depend on the port the adapter implements.',
  },
  HADL2408: {
    title: 'An outbound port with no adapter',
    why: 'A port is a hole in the application waiting to be filled. Without an adapter the generated composition root has nothing to inject, so the service cannot start.',
    fix: 'Declare an adapter, using "in-memory" if you only need it for tests so far.',
  },
  HADL2421: {
    title: 'A port with too many operations',
    why: 'Every client of a wide port depends on operations it never calls, and every new adapter has to implement all of them. Interface segregation is what keeps that cost from compounding.',
    fix: 'Split the port along the lines its callers actually use.',
  },
  HADL2422: {
    title: 'A service that splits into unrelated groups',
    why: 'When a service\'s operations use disjoint sets of ports, they have no shared reason to change. That is two responsibilities sharing a name and a deployment.',
    fix: 'Split it into one service per group.',
  },
  HADL2501: {
    title: 'A declaration nothing reaches',
    why: 'Unreachable declarations still get generated, compiled, reviewed and shipped. They are the most common way a generated codebase grows past what anyone asked for.',
    fix: 'Delete it, or connect it to the flow it was written for.',
  },
  HADL2502: {
    title: 'Two declarations with the same shape',
    why: 'A dto exists to carry less than the model. One that mirrors the aggregate field for field adds a mapping layer with no purpose, and now two places have to change together.',
    fix: 'Drop the fields the caller does not need, or reuse the existing shape.',
  },
  HADL2503: {
    title: 'A service operation that only forwards',
    why: 'A pass-through adds a class, a test, a mock and a stack frame, and changes nothing about what happens. It is the shape a layer takes when it was added on principle rather than for a reason.',
    fix: 'Let the caller use the port directly, or add the rule this operation was meant to hold.',
  },
  HADL2504: {
    title: 'A port nobody calls',
    why: 'An abstraction bought before it is needed is priced on a guess. This one has no callers, so nothing yet constrains whether its shape is right.',
    fix: 'Wire it into the service that needs it, or delete it until something does.',
  },
  HADL2505: {
    title: 'A field nothing reads or writes',
    why: 'A stored field that no rule, projection or contract mentions still costs a column, a migration and a place for stale data to accumulate.',
    fix: 'Keep it only if something outside this module needs it.',
  },
  HADL2602: {
    title: 'An operation no scenario can reach',
    why: 'A fenced block is target-language source, so `haic test` has nothing to run: the design stops being executable exactly where the logic got interesting enough to write by hand. That is the code most worth exercising before it ships.',
    fix: 'Write the HADL statements beside the block. They stay the reference implementation the scenarios run, and the block still wins for its own target.',
  },
  HADL2603: {
    title: 'A body written for another language',
    why: 'A design compiles to whatever target is asked for. An operation implemented only in TypeScript quietly makes that one target the real source, and the first build for another one finds a hole where a body should be.',
    fix: 'Add HADL statements as the portable body, add a block for the other target, or say plainly that this module is single-target.',
  },
  HADL2604: {
    title: 'A block in an aggregate that names a port',
    why: 'An aggregate that reaches a repository cannot be tested without one, cannot be reasoned about without knowing what the call does, and becomes the place transactions quietly begin. The compiler enforces that by reading the statements of an operation — and a fenced block has no statements to read, so the rule would stop applying exactly where the code gets interesting.',
    fix: 'Pass what the block needs in as a parameter, or move the operation to the service that already holds the port. If the name is a coincidence, rename the local: the compiler cannot read the block, so a mention is all it has to go on.',
  },
  HADL3060: {
    title: 'No body for the target being built',
    why: 'The compiler will not invent an implementation, and will not emit a project with a method that silently does nothing. Every other file in that build would look finished.',
    fix: 'Add a block for this target, add HADL statements, or build the language the operation was written for with "--language".',
  },
};

export const explainCommand: Command = {
  name: 'explain',
  summary: 'Explain the reasoning behind a diagnostic code',
  usage: 'haic explain <code>',

  run({ args }) {
    const code = args.positional[0]?.toUpperCase();
    if (!code) {
      heading('Explained codes');
      for (const [id, entry] of Object.entries(CATALOGUE)) info(`  ${id}  ${entry.title}`);
      info('');
      info(dim('Run "haic explain HADL2503" for the reasoning behind one of them.'));
      return EXIT_OK;
    }

    const entry = CATALOGUE[code];
    if (!entry) {
      error(`no long-form explanation for ${code}. Run "haic explain" to see the codes that have one.`);
      return EXIT_USAGE;
    }

    heading(`${code}: ${entry.title}`);
    info('');
    info(wrap(entry.why));
    info('');
    info(`${dim('Fix:')} ${wrap(entry.fix)}`);
    return EXIT_OK;
  },
};

function wrap(text: string, width = 88): string {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}
