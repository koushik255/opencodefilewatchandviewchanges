import { createOpencodeClient, type Event } from "@opencode-ai/sdk";

const port = process.env.OPENCODE_PORT || "4096";
const baseUrl = `http://127.0.0.1:${port}`;

console.log(`Connecting to opencode at ${baseUrl}...`);

const res = await fetch(`${baseUrl}/global/health`);
if (!res.ok) {
  console.error("Failed to connect:", res.status, res.statusText);
  process.exit(1);
}
const health = await res.json();
console.log(`Connected! Server version: ${health.version}\n`);
console.log("Watching for file edits... (Ctrl+C to stop)\n");

const client = createOpencodeClient({ baseUrl });
const { stream } = await client.event.subscribe();

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
      const time = new Date().toLocaleTimeString();

      if (input.oldString && input.newString) {
        const oldLines = input.oldString.split("\n");
        const newLines = input.newString.split("\n");
        const addedLines = newLines.filter(
          (line) => !oldLines.includes(line),
        );

        if (addedLines.length > 0) {
          console.log(
            `[${time}] ${input.filePath ?? "?"} (+${addedLines.length} lines)`,
          );
          for (const line of addedLines) {
            console.log(`  + ${line}`);
          }
          console.log();
        }
      } else if (input.newString) {
        console.log(`[${time}] ${input.filePath ?? "?"} (new file)`);
        for (const line of input.newString.split("\n")) {
          console.log(`  + ${line}`);
        }
        console.log();
      }
    }
  }
}
