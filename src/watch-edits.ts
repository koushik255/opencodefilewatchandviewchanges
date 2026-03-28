import { readFileSync } from "fs";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk";

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
console.log("Watching for file edits... (Ctrl+C to stop)\n");

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

function showEdit(filePath: string, newString: string) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const loc = findNewStringLines(content, newString);
    const newLines = newString.split("\n");

    if (loc) {
      const range = loc.start === loc.end ? `${loc.start}` : `${loc.start}-${loc.end}`;
      console.log(`[${time()}] ${filePath}:${range} (+${newLines.length} lines)`);
      for (let i = 0; i < newLines.length; i++) {
        console.log(`  ${loc.start + i} + ${newLines[i]}`);
      }
    } else {
      console.log(`[${time()}] ${filePath} (+${newLines.length} lines)`);
      for (const line of newLines) {
        console.log(`  + ${line}`);
      }
    }
    console.log();
  } catch {
    console.log(`[${time()}] ${filePath} (edited)\n`);
  }
}

for await (const event of stream) {
  const e = event as Event;

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

      showEdit(input.filePath, input.newString);
    }
  }
}
