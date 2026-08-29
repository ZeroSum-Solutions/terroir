"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  canReadClipboardFiles,
  dragCarriesFiles,
  filesFromDataTransfer,
  isEditableTarget,
  isFileInputTarget,
  namePastedFiles,
  readClipboardFiles,
  type ClipboardReadOutcome,
} from "./file-intake";

export interface FileIntakeOptions {
  /** Handed the files a drop or paste carried, in the order they arrived.
   * Given the same treatment the file picker's own selection gets — this hook
   * validates nothing itself. */
  onFiles: (files: File[]) => void;
  /** False while the screen is not accepting an upload (mid-preview, mid-scan).
   * A drop is still swallowed when disabled — see the drop handler. */
  enabled?: boolean;
}

export interface FileIntake {
  /** True while a drag carrying files is over the window, for the drop overlay. */
  isDragging: boolean;
  /** Reads the clipboard directly and forwards anything usable. Call from a
   * click handler: browsers refuse outside a user gesture. */
  pasteFromClipboard: () => Promise<ClipboardReadOutcome>;
  /** Whether this browser can be asked for the clipboard at all — false during
   * SSR and on the first client render, so the button it gates never causes a
   * hydration mismatch. */
  canPasteFromClipboard: boolean;
}

/** No store to subscribe to: clipboard support cannot change during a session. */
const subscribeNever = () => () => {};
const notOnTheServer = () => false;

/**
 * Adds the two doors a file picker doesn't have: dragging a file onto the
 * window, and pasting one.
 *
 * Both are window-level rather than zone-level. There is exactly one upload
 * target on any screen that uses this, so making the operator hit a specific
 * rectangle buys nothing and costs a missed drop.
 */
export function useFileIntake({ onFiles, enabled = true }: FileIntakeOptions): FileIntake {
  const [isDragging, setIsDragging] = useState(false);
  // Counts dragenter minus dragleave: both fire for every nested element the
  // pointer crosses, so a single boolean flickers off while the drag is still
  // very much over the page.
  const dragDepth = useRef(0);
  const onFilesRef = useRef(onFiles);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    onFilesRef.current = onFiles;
    enabledRef.current = enabled;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleDragEnter = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth.current += 1;
      if (enabledRef.current) setIsDragging(true);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      // Required. A window that doesn't cancel dragover is declaring itself not
      // a drop target, and no drop event ever follows.
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = enabledRef.current ? "copy" : "none";
      }
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setIsDragging(false);
    };

    const handleDrop = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      if (isFileInputTarget(event.target)) return;
      // Cancelled even when intake is disabled. The browser's default for a
      // file dropped on a page is to NAVIGATE to it — which would abandon a
      // scan or a half-reviewed import without so much as a confirmation.
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      if (!enabledRef.current) return;
      const files = filesFromDataTransfer(event.dataTransfer);
      if (files.length > 0) onFilesRef.current(files);
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (!enabledRef.current) return;
      // The listener is on the window, so it also sees pastes aimed at a text
      // field elsewhere on the screen. Those belong to the field.
      if (isEditableTarget(event.target)) return;
      const files = namePastedFiles(filesFromDataTransfer(event.clipboardData), new Date());
      if (files.length === 0) return;
      event.preventDefault();
      onFilesRef.current(files);
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("paste", handlePaste);
    };
  }, []);

  const pasteFromClipboard = useCallback(async (): Promise<ClipboardReadOutcome> => {
    const outcome = await readClipboardFiles();
    if (outcome.ok) onFilesRef.current(outcome.files);
    return outcome;
  }, []);

  const canPasteFromClipboard = useSyncExternalStore(
    subscribeNever,
    canReadClipboardFiles,
    notOnTheServer,
  );

  return { isDragging, pasteFromClipboard, canPasteFromClipboard };
}
