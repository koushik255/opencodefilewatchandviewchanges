import {
  BoxRenderable,
  CodeRenderable,
  createCliRenderer,
  LineNumberRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  type KeyEvent,
} from "@opentui/core";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk";
import {
  type Change,
  buildChangeView,
  isEditTool,
  isSessionCompleteEvent,
} from "./watch-edits-shared";

const interactive = process.argv
  .slice(2)
  .some((arg) => arg === "--interactive" || arg === "-i");
const port = process.env.OPENCODE_PORT || "4096";
const baseUrl = `http://127.0.0.1:${port}`;

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true,
  useConsole: true,
});

const root = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  flexDirection: "column",
  padding: 1,
  gap: 1,
  backgroundColor: "#0b1220",
});

const header = new BoxRenderable(renderer, {
  width: "100%",
  border: true,
  borderStyle: "rounded",
  borderColor: "#334155",
  padding: 1,
  flexDirection: "column",
  gap: 1,
});

const titleText = new TextRenderable(renderer, {
  content: "OpenCode Watch",
  fg: "#f8fafc",
});

const statusText = new TextRenderable(renderer, {
  content: `Connecting to ${baseUrl}...`,
  fg: "#93c5fd",
});

const modeText = new TextRenderable(renderer, {
  content: interactive
    ? "Interactive mode. Press n, Enter, or Space for next, p or left for previous, and right to move forward through history. Press q or Esc to quit."
    : "Watching for file edits. Press q or Esc to quit. Use the mouse wheel or arrow keys to scroll.",
  fg: "#94a3b8",
});

const detailsText = new TextRenderable(renderer, {
  content: "Waiting for the first edit...",
  fg: "#cbd5e1",
});

header.add(titleText);
header.add(statusText);
header.add(modeText);
header.add(detailsText);

const viewerFrame = new BoxRenderable(renderer, {
  width: "100%",
  flexGrow: 1,
  border: true,
  borderStyle: "rounded",
  borderColor: "#334155",
  padding: 0,
  title: "Change Viewer",
});

const scrollBox = new ScrollBoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  flexGrow: 1,
  scrollY: true,
  scrollX: true,
  stickyScroll: false,
});

const code = new CodeRenderable(renderer, {
  id: "watch-code",
  content: "Waiting for opencode edits...",
  filetype: "typescript",
  syntaxStyle: SyntaxStyle.create(),
  width: "100%",
  drawUnstyledText: true,
  wrapMode: "none",
});

const lineNumbers = new LineNumberRenderable(renderer, {
  id: "watch-line-numbers",
  width: "100%",
  target: code,
  showLineNumbers: true,
});

scrollBox.add(lineNumbers);
viewerFrame.add(scrollBox);

const footerText = new TextRenderable(renderer, {
  content: "No changes yet.",
  fg: "#64748b",
});

root.add(header);
root.add(viewerFrame);
root.add(footerText);
renderer.root.add(root);
scrollBox.focus();

const pendingBySession = new Map<string, Change[]>();
const reviewQueue: Change[][] = [];
let currentBatch: Change[] | null = null;
let currentBatchIndex = -1;
let waitingForAdvance = false;
let hasSeenChange = false;
const reviewHistory: Change[] = [];
let reviewHistoryIndex = -1;

function setFooter(message: string): void {
  footerText.content = message;
}

function setStatus(message: string, fg = "#93c5fd"): void {
  statusText.content = message;
  statusText.fg = fg;
}

function applyCurrentChange(change: Change, contextLabel: string): void {
  const view = buildChangeView(change);
  hasSeenChange = true;

  code.content = view.code || "\n";
  code.filetype = view.filetype;
  lineNumbers.lineNumberOffset = view.lineNumberOffset;
  lineNumbers.clearAllLineColors();

  if (
    view.highlightedLineStart !== null &&
    view.highlightedLineEnd !== null
  ) {
    lineNumbers.highlightLines(view.highlightedLineStart, view.highlightedLineEnd, {
      gutter: "#14532d",
      content: "#052e16",
    });
  }

  const location =
    view.resolvedRange !== null
      ? `${change.filePath}:${view.resolvedRange.start}-${view.resolvedRange.end}`
      : change.filePath;
  const insertedSummary =
    view.insertedLineCount > 0
      ? `${view.insertedLineCount} inserted line${view.insertedLineCount === 1 ? "" : "s"}`
      : "Edited content";

  detailsText.content = `${contextLabel}\n${location}\n${insertedSummary}`;
  viewerFrame.title = change.filePath;
  setFooter(view.summary[0] ?? `Updated ${change.filePath}`);
  scrollBox.scrollTo({ x: 0, y: 0 });
}

function renderHistoryChange(index: number, suffix: string): void {
  const change = reviewHistory[index];
  if (!change) {
    return;
  }

  reviewHistoryIndex = index;
  applyCurrentChange(
    change,
    `History ${index + 1}/${reviewHistory.length}${suffix}`,
  );
}

function refreshWaitingState(): void {
  if (interactive && !hasSeenChange) {
    detailsText.content = "Waiting for the first interactive batch...";
    code.content = "Interactive review is enabled.\n\nChanges will appear when a session goes idle.";
    code.filetype = "text";
    lineNumbers.lineNumberOffset = 0;
    lineNumbers.clearAllLineColors();
    viewerFrame.title = "Change Viewer";
    setFooter("No completed sessions yet.");
  }
}

function showNextQueuedChange(): void {
  if (!interactive) {
    return;
  }

  if (
    currentBatch !== null &&
    currentBatchIndex + 1 < currentBatch.length
  ) {
    currentBatchIndex += 1;
  } else {
    currentBatch = reviewQueue.shift() ?? null;
    currentBatchIndex = 0;
  }

  if (currentBatch === null || currentBatch.length === 0) {
    waitingForAdvance = false;
    refreshWaitingState();
    return;
  }

  const batchPosition = currentBatchIndex + 1;
  const batchSize = currentBatch.length;
  waitingForAdvance = batchPosition < batchSize;
  const change = currentBatch[currentBatchIndex];
  if (!change) {
    waitingForAdvance = false;
    setFooter("Skipped an empty queued change.");
    return;
  }

  reviewHistory.push(change);
  reviewHistoryIndex = reviewHistory.length - 1;

  applyCurrentChange(
    change,
    `Batch ${batchPosition}/${batchSize}${waitingForAdvance ? "  Press n, Enter, or Space for next. Press p or left to revisit the previous change." : "  Batch complete. Press p or left to revisit the previous change."}`,
  );
}

function queueInteractiveBatch(changes: Change[]): void {
  if (changes.length === 0) {
    return;
  }

  reviewQueue.push(changes);
  if (currentBatch === null || (!waitingForAdvance && currentBatchIndex + 1 >= currentBatch.length)) {
    currentBatch = null;
    currentBatchIndex = -1;
    showNextQueuedChange();
  } else {
    setFooter(`Queued ${changes.length} more change${changes.length === 1 ? "" : "s"} from a completed session.`);
  }
}

function flushSessionChanges(sessionID: string): void {
  const changes = pendingBySession.get(sessionID);
  if (!changes || changes.length === 0) {
    return;
  }

  pendingBySession.delete(sessionID);
  queueInteractiveBatch(changes);
}

function shouldAdvance(key: KeyEvent): boolean {
  return key.name === "enter" || key.name === "return" || key.name === "space" || key.name === "n";
}

function shouldGoBack(key: KeyEvent): boolean {
  return key.name === "p" || key.name === "left";
}

function shouldGoForwardHistory(key: KeyEvent): boolean {
  return key.name === "right";
}

renderer.keyInput.on("keypress", async (key: KeyEvent) => {
  if (key.name === "escape" || key.name === "q") {
    await renderer.destroy();
    return;
  }

  if (key.name === "f12") {
    renderer.console.toggle();
    return;
  }

  if (interactive && shouldGoBack(key) && reviewHistoryIndex > 0) {
    waitingForAdvance = false;
    renderHistoryChange(
      reviewHistoryIndex - 1,
      "  Historical view. Press right to move forward, or n to continue when available.",
    );
    return;
  }

  if (
    interactive &&
    shouldGoForwardHistory(key) &&
    reviewHistoryIndex >= 0 &&
    reviewHistoryIndex + 1 < reviewHistory.length
  ) {
    const nextIndex = reviewHistoryIndex + 1;
    const isLatestViewed = nextIndex === reviewHistory.length - 1;
    waitingForAdvance =
      isLatestViewed &&
      currentBatch !== null &&
      currentBatchIndex + 1 < currentBatch.length;
    renderHistoryChange(
      nextIndex,
      isLatestViewed && waitingForAdvance
        ? "  Latest viewed change. Press n, Enter, or Space for the next queued change."
        : "  Historical view. Press left to move back.",
    );
    return;
  }

  if (interactive && waitingForAdvance && shouldAdvance(key)) {
    showNextQueuedChange();
  }
});

refreshWaitingState();

try {
  const healthResponse = await fetch(`${baseUrl}/global/health`);
  if (!healthResponse.ok) {
    throw new Error(
      `Health check failed with ${healthResponse.status} ${healthResponse.statusText}`,
    );
  }

  const health = (await healthResponse.json()) as { version: string };
  setStatus(`Connected to ${baseUrl}  Server ${health.version}`, "#86efac");
  setFooter(interactive ? "Waiting for the first completed session..." : "Watching for live edits...");

  const client = createOpencodeClient({ baseUrl });
  const { stream } = await client.event.subscribe();

  for await (const event of stream) {
    const typedEvent = event as Event;

    if (interactive) {
      const sessionID = isSessionCompleteEvent(typedEvent);
      if (sessionID) {
        flushSessionChanges(sessionID);
        continue;
      }
    }

    if (typedEvent.type !== "message.part.updated") {
      continue;
    }

    const part = typedEvent.properties.part;
    if (part.type !== "tool" || part.state.status !== "completed") {
      continue;
    }

    if (!isEditTool(part.tool)) {
      continue;
    }

    const input = part.state.input as {
      filePath?: string;
      oldString?: string;
      newString?: string;
    };

    if (!input.filePath || !input.newString) {
      continue;
    }

    const change: Change = {
      filePath: input.filePath,
      oldString: input.oldString,
      newString: input.newString,
    };

    if (interactive) {
      const sessionChanges = pendingBySession.get(part.sessionID) ?? [];
      sessionChanges.push(change);
      pendingBySession.set(part.sessionID, sessionChanges);
      setFooter(
        `Buffered ${sessionChanges.length} change${sessionChanges.length === 1 ? "" : "s"} for session ${part.sessionID.slice(0, 8)}...`,
      );
      continue;
    }

    applyCurrentChange(change, "Live update");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`Connection failed`, "#fca5a5");
  detailsText.content = `Unable to reach ${baseUrl}\n\n${message}`;
  code.content = `Connection error:\n${message}`;
  code.filetype = "text";
  lineNumbers.lineNumberOffset = 0;
  lineNumbers.clearAllLineColors();
  viewerFrame.title = "Connection Error";
  setFooter("Press q or Esc to close. Press F12 for the console overlay.");
}
