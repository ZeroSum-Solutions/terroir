"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BinViewModel } from "./bin-view-model";
import { draftFor, payloadFor, type BinDraft } from "./bin-form";

export function useBinEditor() {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BinDraft>(draftFor());
  const close = () => {
    setCreating(false);
    setEditingId(null);
  };
  const openCreate = () => {
    setEditingId(null);
    setDraft(draftFor());
    setCreating(true);
  };
  const openEdit = (bin: BinViewModel) => {
    setCreating(false);
    setDraft(draftFor(bin));
    setEditingId(bin.id);
  };
  return {
    creating,
    editingId,
    draft,
    setDraft,
    close,
    openCreate,
    openEdit,
  };
}

export function useBinRequests(editor: ReturnType<typeof useBinEditor>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const path = editor.editingId ? `/api/bins/${editor.editingId}` : "/api/bins";
    setBusy(true);
    setError(null);
    try {
      await mutate(path, editor.editingId ? "PATCH" : "POST", payloadFor(editor.draft));
      editor.close();
      router.refresh();
    } catch (caught) {
      setError(messageFor(caught, "Couldn't save bin."));
    } finally {
      setBusy(false);
    }
  };
  const retire = async (bin: BinViewModel) => {
    if (!window.confirm(`Retire bin ${bin.code}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/bins/${bin.id}`, "PATCH", { retired_at: new Date().toISOString() });
      router.refresh();
    } catch (caught) {
      setError(messageFor(caught, "Couldn't retire bin."));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, dismissError: () => setError(null), save, retire };
}

async function mutate(path: string, method: "POST" | "PATCH", body: object) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await responseError(response));
}

function messageFor(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string | { message?: string };
  } | null;
  if (typeof body?.error === "string") return body.error;
  if (body?.error && typeof body.error === "object" && body.error.message) {
    return body.error.message;
  }
  return "Couldn't save bin. Please try again.";
}
