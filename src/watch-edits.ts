import { readFileSync } from "fs";
import { createInterface } from "readline";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk";

const interactive = process.argv.slice(2).some(
  (a) => a === "--interactive" || a === "-i",
);

const port = process.env.OPENCODE_PORT || "4096";
const baseUrl = `http://127.0.0.1:${port}`;

console.log(`Connecting to opencode at ${baseUrl}...`);

const res = await fetch(`${baseUrl}/global/health`);
if (!res.ok) {
  console.error("Failed to connect:", res.status, res.statusText);
  process.exit(1);
}
const health = (await res.json()) as { version: string };
console.log(`Connected! Server version: ${health.version}\n`);
console.log(
  interactive
    ? "Interactive mode: reviewing changes one at a time\n"
    : "Watching for file edits... (Ctrl+C to stop)\n",
);

const client = createOpencodeClient({ baseUrl });
const { stream } = await client.event.subscribe();

function time() {
  return new Date().toLocaleTimeString();
}

function findNewStringLines(
  content: string,
  newString: string,
): { start: number; end: number } | null {
  const idx = content.indexOf(newString);
  if (idx === -1) return null;
  const start = content.slice(0, idx).split("\n").length;
  const end = start + newString.split("\n").length - 1;
  return { start, end };
}

interface Change {
  filePath: string;
  oldString?: string;
  newString: string;
}

interface ChangeBatch {
  sessionID: string;
  changes: Change[];
}

function findInsertedLines(oldString: string | undefined, newString: string) {
  const newLines = newString.split("\n");
  if (!oldString) {
    return { startOffset: 0, lines: newLines };
  }

  const oldLines = oldString.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const insertedLines = newLines.slice(prefix, newLines.length - suffix);
  return { startOffset: prefix, lines: insertedLines };
}

function formatEdit(
  filePath: string,
  oldString: string | undefined,
  newString: string,
): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const loc = findNewStringLines(content, newString);
    const inserted = findInsertedLines(oldString, newString);

    if (loc && inserted.lines.length > 0) {
      const start = loc.start + inserted.startOffset;
      const end = start + inserted.lines.length - 1;
      const range = start === end ? `${start}` : `${start}-${end}`;
      return [
        `[${time()}] ${filePath}:${range} (+${inserted.lines.length} lines)`,
        ...inserted.lines.map((line, i) => `  ${start + i} + ${line}`),
      ];
    }

    if (inserted.lines.length > 0) {
      return [
        `[${time()}] ${filePath} (+${inserted.lines.length} lines)`,
        ...inserted.lines.map((line) => `  + ${line}`),
      ];
    }

    return [
      `[${time()}] ${filePath} (edited)`,
    ];
  } catch {
    return [`[${time()}] ${filePath} (edited)`];
  }
}

function showEdit(filePath: string, oldString: string | undefined, newString: string) {
  for (const line of formatEdit(filePath, oldString, newString)) {
    console.log(line);
  }
  console.log();
}

const pendingBySession = new Map<string, Change[]>();
const reviewQueue: ChangeBatch[] = [];
let isReviewing = false;

async function promptNext(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => {
    rl.question("Next? (Y) ", resolve);
  });
  rl.close();

  if (answer.trim().toLowerCase() === "n") {
    console.log("exiting program");
    process.exit(0);
  }
}

async function reviewLoop(): Promise<void> {
  if (isReviewing) return;
  isReviewing = true;

  while (reviewQueue.length > 0) {
    const batch = reviewQueue.shift()!;
    const batchSize = batch.changes.length;

    for (let index = 0; index < batch.changes.length; index++) {
      const change = batch.changes[index]!;
      const reviewedInBatch = index + 1;

      console.log(`--- Change ${reviewedInBatch} of ${batchSize} ---`);
      for (const line of formatEdit(change.filePath, change.oldString, change.newString)) {
        console.log(line);
      }
      console.log();

      if (reviewedInBatch >= batchSize) {
        console.log("That's all.\n");
        continue;
      }

      await promptNext();
    }
  }

  isReviewing = false;
}

function flushSessionChanges(sessionID: string) {
  const changes = pendingBySession.get(sessionID);
  if (!changes || changes.length === 0) return;

  pendingBySession.delete(sessionID);
  reviewQueue.push({ sessionID, changes });
  void reviewLoop();
}

for await (const event of stream) {
  const e = event as Event;

  if (interactive) {
    if (e.type === "session.idle") {
      flushSessionChanges(e.properties.sessionID);
      continue;
    }

    if (
      e.type === "session.status" &&
      e.properties.status.type === "idle"
    ) {
      flushSessionChanges(e.properties.sessionID);
      continue;
    }

    if (e.type === "session.error" && e.properties.sessionID) {
      flushSessionChanges(e.properties.sessionID);
      continue;
    }
  }

  if (e.type === "message.part.updated") {
    const part = e.properties.part;
    if (part.type === "tool" && part.state.status === "completed") {
      const toolName = part.tool;
      const isEditTool =
        toolName.includes("edit") ||
        toolName.includes("write") ||
        toolName.includes("file") ||
        toolName.includes("patch") ||
        toolName.includes("create");
      if (!isEditTool) continue;

      const input = part.state.input as {
        filePath?: string;
        oldString?: string;
        newString?: string;
      };
      if (!input.filePath || !input.newString) continue;

      if (interactive) {
        const sessionChanges = pendingBySession.get(part.sessionID) ?? [];
        sessionChanges.push({
          filePath: input.filePath,
          oldString: input.oldString,
          newString: input.newString,
        });
        pendingBySession.set(part.sessionID, sessionChanges);
      } else {
        showEdit(input.filePath, input.oldString, input.newString);
      }
    }
  }
}
