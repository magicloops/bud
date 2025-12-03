/**
 * Registry of known REPL/interactive programs and their interaction patterns.
 * Used by the agent to understand how to interact with programs running in the terminal.
 */

export type InteractionStyle = "natural_language" | "code" | "sql" | "commands";

export interface ProgramInfo {
  name: string;
  displayName: string;
  interactionStyle: InteractionStyle;
  exitCommands: string[];
  hints: string[];
}

/**
 * Known programs that the agent may run in the terminal.
 * When the agent starts one of these programs, we track it as a "pending command"
 * and provide context-specific guidance.
 */
export const KNOWN_PROGRAMS: Record<string, ProgramInfo> = {
  claude: {
    name: "claude",
    displayName: "Claude Code",
    interactionStyle: "natural_language",
    exitCommands: ["exit", "/exit"],
    hints: [
      "Use natural language requests, not shell commands",
      "Ask Claude to perform tasks: 'Please review src/main.rs for bugs'",
      "To run shell commands, ask Claude: 'Run npm test'",
      "Do NOT send raw shell commands - Claude will misinterpret them as requests"
    ]
  },

  python: {
    name: "python",
    displayName: "Python REPL",
    interactionStyle: "code",
    exitCommands: ["exit()", "quit()"],
    hints: [
      "Send Python code, not shell commands",
      "Use print() to display output",
      "Multi-line input uses ... continuation prompt"
    ]
  },

  python3: {
    name: "python3",
    displayName: "Python 3 REPL",
    interactionStyle: "code",
    exitCommands: ["exit()", "quit()"],
    hints: [
      "Send Python code, not shell commands",
      "Use print() to display output",
      "Multi-line input uses ... continuation prompt"
    ]
  },

  ipython: {
    name: "ipython",
    displayName: "IPython",
    interactionStyle: "code",
    exitCommands: ["exit", "quit"],
    hints: [
      "Send Python code, not shell commands",
      "Use In[]/Out[] for input/output history",
      "Magic commands start with % (e.g., %run, %timeit)"
    ]
  },

  node: {
    name: "node",
    displayName: "Node.js REPL",
    interactionStyle: "code",
    exitCommands: [".exit"],
    hints: [
      "Send JavaScript code, not shell commands",
      "Use console.log() for output",
      "Multi-line input uses ... continuation"
    ]
  },

  deno: {
    name: "deno",
    displayName: "Deno REPL",
    interactionStyle: "code",
    exitCommands: ["close()"],
    hints: [
      "Send TypeScript/JavaScript code",
      "Use console.log() for output"
    ]
  },

  irb: {
    name: "irb",
    displayName: "Ruby IRB",
    interactionStyle: "code",
    exitCommands: ["exit", "quit"],
    hints: [
      "Send Ruby code, not shell commands",
      "Use puts/p for output"
    ]
  },

  psql: {
    name: "psql",
    displayName: "PostgreSQL",
    interactionStyle: "sql",
    exitCommands: ["\\q"],
    hints: [
      "Send SQL commands ending with semicolon",
      "Meta-commands start with backslash (\\dt, \\d table, \\l)",
      "Use \\? for help on meta-commands"
    ]
  },

  mysql: {
    name: "mysql",
    displayName: "MySQL",
    interactionStyle: "sql",
    exitCommands: ["exit", "quit"],
    hints: [
      "Send SQL commands ending with semicolon",
      "Use SHOW TABLES, DESCRIBE table for schema info"
    ]
  },

  sqlite3: {
    name: "sqlite3",
    displayName: "SQLite",
    interactionStyle: "sql",
    exitCommands: [".quit", ".exit"],
    hints: [
      "Send SQL commands ending with semicolon",
      "Dot-commands for meta operations (.tables, .schema)"
    ]
  },

  redis: {
    name: "redis-cli",
    displayName: "Redis CLI",
    interactionStyle: "commands",
    exitCommands: ["quit", "exit"],
    hints: [
      "Send Redis commands (GET, SET, KEYS, etc.)",
      "Commands are case-insensitive"
    ]
  },

  mongosh: {
    name: "mongosh",
    displayName: "MongoDB Shell",
    interactionStyle: "code",
    exitCommands: ["exit", "quit"],
    hints: [
      "Send JavaScript/MongoDB commands",
      "Use db.collection.find(), db.collection.insertOne(), etc."
    ]
  },

  ghci: {
    name: "ghci",
    displayName: "GHCi (Haskell)",
    interactionStyle: "code",
    exitCommands: [":quit", ":q"],
    hints: [
      "Send Haskell expressions",
      "Commands start with colon (:type, :load, :reload)"
    ]
  },

  erl: {
    name: "erl",
    displayName: "Erlang Shell",
    interactionStyle: "code",
    exitCommands: ["q().", "halt()."],
    hints: [
      "Send Erlang expressions ending with period",
      "Use c(module) to compile"
    ]
  },

  iex: {
    name: "iex",
    displayName: "Elixir IEx",
    interactionStyle: "code",
    exitCommands: [],
    hints: [
      "Send Elixir expressions",
      "Use h(function) for help",
      "Exit with Ctrl+C twice"
    ]
  },

  scala: {
    name: "scala",
    displayName: "Scala REPL",
    interactionStyle: "code",
    exitCommands: [":quit", ":q"],
    hints: [
      "Send Scala expressions",
      "Commands start with colon (:help, :type)"
    ]
  },

  lua: {
    name: "lua",
    displayName: "Lua REPL",
    interactionStyle: "code",
    exitCommands: ["os.exit()"],
    hints: [
      "Send Lua code",
      "Use print() for output",
      "Exit with Ctrl+D or os.exit()"
    ]
  },

  R: {
    name: "R",
    displayName: "R Console",
    interactionStyle: "code",
    exitCommands: ["q()", "quit()"],
    hints: [
      "Send R expressions",
      "Use print() or just expression for output"
    ]
  },

  julia: {
    name: "julia",
    displayName: "Julia REPL",
    interactionStyle: "code",
    exitCommands: ["exit()"],
    hints: [
      "Send Julia expressions",
      "Use println() for output",
      "Package mode with ], help with ?"
    ]
  }
};

/**
 * Check if a command name corresponds to a known REPL program.
 */
export function isKnownReplProgram(command: string): boolean {
  return command in KNOWN_PROGRAMS;
}

/**
 * Get program info for a command, if known.
 */
export function getProgramInfo(command: string): ProgramInfo | undefined {
  return KNOWN_PROGRAMS[command];
}
