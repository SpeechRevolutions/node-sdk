/**
 * Optional console progress rendering for upload + transcription jobs.
 *
 * Neither AssemblyAI nor Deepgram surfaces live percentage progress for
 * pre-recorded transcription — our pipeline is chunked and emits SSE progress
 * events, so this is a Speech Revolutions extra. The same renderer also drives
 * the byte-level *upload* bar.
 *
 * There is no tqdm in JS, so this is a tiny built-in renderer: a single line
 * written to stderr, updated in place with a carriage return, showing a
 * percentage and a `[####----]`-style bar. It always forwards each event to a
 * user-supplied callback, so programmatic access via `onProgress` /
 * `onUploadProgress` is unaffected whether or not the console display is on.
 */

import type { ProgressCallback, ProgressEvent } from "./types.js";

const DEFAULT_LABEL = "Transcribing";
// Minimum ms between redraws (a byte upload fires many events).
const MIN_REDRAW_INTERVAL_MS = 80;
const BAR_WIDTH = 30;

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = n;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function stderr(): NodeJS.WriteStream | undefined {
  if (typeof process === "undefined" || !process.stderr) return undefined;
  return process.stderr;
}

/**
 * A progress callback that renders to the console and forwards events.
 *
 * `bytesMode` renders sizes (e.g. `2.5MB/6.0MB`) alongside the bar. For
 * transcription the volatile step name (preprocess / chunk:N / aggregation) is
 * deliberately kept off the bar — chunks finish out of order and made the label
 * jump around; callers who want it read `event.step` in their callback.
 */
export class ProgressPrinter {
  private readonly forward?: ProgressCallback;
  private readonly label: string;
  private readonly bytesMode: boolean;
  private lastDraw = 0;
  private lastPct = 0;
  private drewAny = false;
  private finished = false;
  private closed = false;

  constructor(opts: {
    forward?: ProgressCallback;
    label?: string;
    bytesMode?: boolean;
  } = {}) {
    this.forward = opts.forward;
    this.label = opts.label ?? DEFAULT_LABEL;
    this.bytesMode = opts.bytesMode ?? false;
  }

  /** Use as the `onProgress` callback — renders, then forwards. */
  readonly handle: ProgressCallback = (event: ProgressEvent): void => {
    try {
      this.render(event);
    } finally {
      this.forward?.(event);
    }
  };

  private render(event: ProgressEvent): void {
    const pct = event.percent;
    if (pct === undefined) return;
    this.draw(pct, event.completed, event.total);
  }

  private draw(
    pct: number,
    completed?: number,
    total?: number,
    force = false,
  ): void {
    const out = stderr();
    if (!out) return;
    const complete = pct >= 100;
    const now = Date.now();
    // Throttle redraws (uploads emit many events); always draw the final 100%.
    if (
      !force &&
      !complete &&
      this.lastDraw !== 0 &&
      now - this.lastDraw < MIN_REDRAW_INTERVAL_MS
    ) {
      return;
    }
    this.lastDraw = now;
    this.lastPct = pct;

    const filled = Math.round((BAR_WIDTH * pct) / 100);
    const bar = "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled);
    let line = `\r${this.label}: ${String(Math.round(pct)).padStart(3)}% [${bar}]`;
    if (this.bytesMode && total) {
      line += ` ${formatBytes(completed ?? 0)}/${formatBytes(total)}`;
    }
    out.write(line);
    this.drewAny = true;
    if (complete) {
      out.write("\n");
      this.finished = true;
    }
  }

  /** Finish the bar. Safe to call more than once. Always leaves 100% drawn. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.drewAny && !this.finished) {
      this.draw(100, undefined, undefined, true);
    }
  }
}

/**
 * Build the effective progress callback for an upload/transcription phase.
 *
 * When `show` is true, wrap `onProgress` in a {@link ProgressPrinter} that
 * renders to the console and still forwards to the user callback. The returned
 * printer (or `undefined`) must have `.close()` called when done.
 */
export function resolveProgress(
  onProgress: ProgressCallback | undefined,
  show: boolean,
  opts: { label?: string; bytesMode?: boolean } = {},
): { callback?: ProgressCallback; printer?: ProgressPrinter } {
  if (!show) return { callback: onProgress };
  const printer = new ProgressPrinter({
    forward: onProgress,
    label: opts.label,
    bytesMode: opts.bytesMode,
  });
  return { callback: printer.handle, printer };
}
