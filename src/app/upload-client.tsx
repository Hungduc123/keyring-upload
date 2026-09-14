"use client";

import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { ProjectKey } from "@/lib/upstash";
import type { Role } from "@/lib/users";

type FaqItem = { question: string; answer: string };

type UploadResponse = {
  total: number;
  upserted: number;
  skipped: number;
  duplicates: number;
  failed: number;
  deleted: number;
  ids: string[];
  skippedIds: string[];
  deletedIds: string[];
  errors: { index: number; message: string }[];
};

type Mode = "file" | "manual" | "manage";

type StoredFaq = {
  id: string;
  question: string;
  answer: string;
  uploadedAt: string | null;
};

type FaqListResponse = { items: StoredFaq[]; nextCursor: string | null };

type DiffStatus =
  | "new"
  | "changed"
  | "unchanged"
  | "duplicate"
  | "invalid"
  | "removed";

type DiffEntry = {
  index: number;
  id: string;
  status: DiffStatus;
  question: string;
  answer: string;
  previousAnswer: string | null;
  message?: string;
};

type PreviewResponse = {
  total: number;
  counts: Record<DiffStatus, number>;
  entries: DiffEntry[];
};

const DIFF_LABELS: Record<DiffStatus, string> = {
  new: "New",
  changed: "Changed",
  unchanged: "Unchanged",
  duplicate: "Duplicate in file",
  invalid: "Invalid",
  removed: "Will be deleted",
};

const LIST_PAGE_SIZE = 50;

const EMPTY_ITEM: FaqItem = { question: "", answer: "" };

/** Pull the filename out of a `Content-Disposition` header, if present. */
function parseFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^"]+)"?/.exec(header);
  return match ? match[1] : null;
}

export const PROJECT_LABELS: Record<ProjectKey, string> = {
  "keyring-app": "Keyring",
  coinpool: "Coinpool",
  "coinpool-prod": "Coinpool (Production)",
  "nft-viewer": "NFT Viewer",
  "keyring-one": "Keyring One",
};

export default function UploadClient({
  username,
  role,
  allowedProjects,
}: {
  username: string;
  role: Role;
  /** Only these projects are offered; the API enforces the same list. */
  allowedProjects: ProjectKey[];
}) {
  const router = useRouter();
  const [project, setProject] = useState<ProjectKey>(allowedProjects[0]);
  const [mode, setMode] = useState<Mode>("file");

  const [fileName, setFileName] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<FaqItem[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [items, setItems] = useState<FaqItem[]>([{ ...EMPTY_ITEM }]);

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [hideUnchanged, setHideUnchanged] = useState(false);

  const [stored, setStored] = useState<StoredFaq[]>([]);
  const [storedCursor, setStoredCursor] = useState<string | null>(null);
  const [loadingStored, setLoadingStored] = useState(false);
  const [storedError, setStoredError] = useState<string | null>(null);
  const [storedLoaded, setStoredLoaded] = useState(false);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<FaqItem>({ ...EMPTY_ITEM });
  const [savingEdit, setSavingEdit] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const payload = useMemo<FaqItem[]>(() => {
    if (mode === "manage") return [];
    if (mode === "file") return filePreview ?? [];
    return items
      .map((i) => ({ question: i.question.trim(), answer: i.answer.trim() }))
      .filter((i) => i.question && i.answer);
  }, [mode, filePreview, items]);

  const filteredStored = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return stored;
    return stored.filter(
      (it) =>
        it.question.toLowerCase().includes(q) ||
        it.answer.toLowerCase().includes(q),
    );
  }, [stored, search]);

  function acceptFile(file: File | undefined | null) {
    setFileError(null);
    setFilePreview(null);
    setFileName(null);
    setResult(null);
    setTopError(null);
    setPreview(null);
    setPreviewError(null);

    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".json")) {
      setFileError("File must be .json");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setFileError("File too large (max 5MB)");
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.items)
            ? parsed.items
            : null;
        if (!arr) {
          setFileError(
            'JSON must be an array or { "items": [...] } of { question, answer }',
          );
          return;
        }
        const cleaned: FaqItem[] = [];
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (
            !it ||
            typeof it.question !== "string" ||
            typeof it.answer !== "string"
          ) {
            setFileError(`Item #${i + 1} is missing question/answer`);
            return;
          }
          cleaned.push({ question: it.question, answer: it.answer });
        }
        setFilePreview(cleaned);
        // Compare straight away so dropping a file is all the user has to do.
        runPreview(cleaned);
      } catch (err) {
        setFileError(
          err instanceof Error ? `Invalid JSON: ${err.message}` : "Invalid JSON",
        );
      }
    };
    reader.onerror = () => setFileError("Could not read file");
    reader.readAsText(file);
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    acceptFile(e.target.files?.[0]);
    // Allow picking the same file again after a reset.
    e.target.value = "";
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!dragging) setDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    // Ignore bubbling from children still inside the dropzone.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 1) {
      setFileError("Please drop a single .json file");
      return;
    }
    acceptFile(files[0]);
  }

  function updateItem(idx: number, field: keyof FaqItem, value: string) {
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)),
    );
  }

  // Results and diffs belong to the mode that produced them; carrying them
  // across would misreport what the next upload is about to do.
  function switchMode(next: Mode) {
    setMode(next);
    setTopError(null);
    setResult(null);
    setPreview(null);
    setPreviewError(null);
  }

  function addItem() {
    setItems((prev) => [...prev, { ...EMPTY_ITEM }]);
  }

  function removeItem(idx: number) {
    setItems((prev) =>
      prev.length === 1 ? [{ ...EMPTY_ITEM }] : prev.filter((_, i) => i !== idx),
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTopError(null);
    setResult(null);

    if (payload.length === 0) {
      setTopError("No valid items to upload");
      return;
    }

    // Uploading a file replaces the whole index, so confirm the pruning first.
    if (mode === "file") {
      const known = preview?.counts.removed;
      const warning =
        known === undefined
          ? "Uploading replaces the whole index: any Q&A not in this file will be permanently deleted. Continue?"
          : known > 0
            ? `${known} Q&A pair(s) in the index are not in this file and will be permanently deleted. Continue?`
            : null;
      if (warning && !window.confirm(warning)) return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          items: payload,
          // Only a full-file upload replaces the index; manual entry upserts.
          replaceAll: mode === "file",
        }),
      });
      const data: UploadResponse | { error: string } = await res
        .json()
        .catch(() => ({ error: "Invalid response" }));

      if (!res.ok && "error" in data) {
        setTopError(data.error);
        return;
      }
      setResult(data as UploadResponse);
      if (mode === "file" && preview) runPreview(payload);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function onExportPdf() {
    setTopError(null);

    if (payload.length === 0) {
      setTopError("No valid items to export");
      return;
    }

    setExporting(true);
    try {
      const res = await fetch("/api/export-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, items: payload }),
      });

      if (!res.ok) {
        const data = await res
          .json()
          .catch(() => ({ error: "Could not generate PDF" }));
        setTopError("error" in data ? data.error : "Could not generate PDF");
        return;
      }

      const blob = await res.blob();
      const filename =
        parseFilename(res.headers.get("Content-Disposition")) ??
        `${project}-faq.pdf`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const runPreview = useCallback(
    async (itemsToCompare: FaqItem[], forProject: ProjectKey = project) => {
      if (itemsToCompare.length === 0) {
        setPreview(null);
        setPreviewError("No items to compare");
        return;
      }
      setPreviewError(null);
      setPreviewing(true);
      try {
        const res = await fetch("/api/upload/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: forProject,
            items: itemsToCompare,
            replaceAll: true,
          }),
        });
        const data: PreviewResponse | { error: string } = await res
          .json()
          .catch(() => ({ error: "Invalid response" }));

        if (!res.ok || "error" in data) {
          setPreview(null);
          setPreviewError("error" in data ? data.error : "Compare failed");
          return;
        }
        setPreview(data);
      } catch (err) {
        setPreview(null);
        setPreviewError(err instanceof Error ? err.message : "Compare failed");
      } finally {
        setPreviewing(false);
      }
    },
    [project],
  );

  const loadStored = useCallback(
    async (cursor: string | null) => {
      setStoredError(null);
      setLoadingStored(true);
      try {
        const params = new URLSearchParams({
          project,
          limit: String(LIST_PAGE_SIZE),
        });
        if (cursor) params.set("cursor", cursor);

        const res = await fetch(`/api/faqs?${params.toString()}`);
        const data: FaqListResponse | { error: string } = await res
          .json()
          .catch(() => ({ error: "Invalid response" }));

        if (!res.ok || "error" in data) {
          setStoredError(
            "error" in data ? data.error : "Could not load stored items",
          );
          return;
        }

        setStored((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setStoredCursor(data.nextCursor);
        setStoredLoaded(true);
      } catch (err) {
        setStoredError(err instanceof Error ? err.message : "Could not load");
      } finally {
        setLoadingStored(false);
      }
    },
    [project],
  );

  function resetStored() {
    setStored([]);
    setStoredCursor(null);
    setStoredError(null);
    setStoredLoaded(false);
    setSelectedIds([]);
    setEditingId(null);
  }

  function startEdit(item: StoredFaq) {
    setStoredError(null);
    setEditingId(item.id);
    setEditDraft({ question: item.question, answer: item.answer });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft({ ...EMPTY_ITEM });
  }

  async function saveEdit(id: string) {
    const question = editDraft.question.trim();
    const answer = editDraft.answer.trim();
    if (!question || !answer) {
      setStoredError("Question and answer must not be empty");
      return;
    }

    setStoredError(null);
    setSavingEdit(true);
    try {
      const res = await fetch("/api/faqs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, id, question, answer }),
      });
      const data:
        | { id: string; previousId: string; question: string; answer: string }
        | { error: string } = await res
        .json()
        .catch(() => ({ error: "Invalid response" }));

      if (!res.ok || "error" in data) {
        setStoredError("error" in data ? data.error : "Update failed");
        return;
      }

      setStored((prev) =>
        prev.map((it) =>
          it.id === id
            ? {
                id: data.id,
                question: data.question,
                answer: data.answer,
                uploadedAt: new Date().toISOString(),
              }
            : it,
        ),
      );
      // The id may have changed, so drop the old one from the selection.
      setSelectedIds((prev) => prev.filter((x) => x !== id));
      cancelEdit();
    } catch (err) {
      setStoredError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSavingEdit(false);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function deleteStored(ids: string[]) {
    if (ids.length === 0) return;

    const label =
      ids.length === 1
        ? "Delete this Q&A from the index?"
        : `Delete ${ids.length} Q&A pairs from the index?`;
    if (!window.confirm(label)) return;

    setStoredError(null);
    setDeletingIds((prev) => [...prev, ...ids]);
    try {
      const res = await fetch("/api/faqs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, ids }),
      });
      const data: { deleted: number } | { error: string } = await res
        .json()
        .catch(() => ({ error: "Invalid response" }));

      if (!res.ok || "error" in data) {
        setStoredError("error" in data ? data.error : "Delete failed");
        return;
      }

      setStored((prev) => prev.filter((it) => !ids.includes(it.id)));
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    } catch (err) {
      setStoredError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingIds((prev) => prev.filter((id) => !ids.includes(id)));
    }
  }

  async function onLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50">
              Keyring · Upstash Vector Upload
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Upload FAQ data to your vector index
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                {username}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {role === "admin" ? "Admin" : "Editor"}
              </div>
            </div>
          <button
            onClick={onLogout}
            className="text-sm rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
          >
            Sign out
          </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <label
            htmlFor="project"
            className="text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            Project
          </label>
          {allowedProjects.length === 1 ? (
            // Nothing to choose: show the one project this account owns.
            <span
              id="project"
              className="inline-flex items-center rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-800 dark:text-slate-100"
            >
              {PROJECT_LABELS[project]}
            </span>
          ) : (
            <select
              id="project"
              value={project}
              onChange={(e) => {
                const next = e.target.value as ProjectKey;
                setProject(next);
                setResult(null);
                setTopError(null);
                setPreview(null);
                setPreviewError(null);
                resetStored();
                // The diff is per-project, so re-run it against the new index.
                if (mode === "file" && filePreview) {
                  runPreview(filePreview, next);
                }
              }}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {allowedProjects.map((value) => (
                <option key={value} value={value}>
                  {PROJECT_LABELS[value]}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1 mb-6">
          <ModeButton
            active={mode === "file"}
            onClick={() => switchMode("file")}
          >
            Upload JSON file
          </ModeButton>
          <ModeButton
            active={mode === "manual"}
            onClick={() => switchMode("manual")}
          >
            Enter manually
          </ModeButton>
          <ModeButton
            active={mode === "manage"}
            onClick={() => {
              switchMode("manage");
              if (!storedLoaded && !loadingStored) loadStored(null);
            }}
          >
            Manage uploaded
          </ModeButton>
        </div>

        {mode === "manage" ? (
          <ManageSection
            items={filteredStored}
            totalLoaded={stored.length}
            loading={loadingStored}
            loaded={storedLoaded}
            error={storedError}
            nextCursor={storedCursor}
            deletingIds={deletingIds}
            selectedIds={selectedIds}
            search={search}
            onSearchChange={setSearch}
            editingId={editingId}
            editDraft={editDraft}
            savingEdit={savingEdit}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onEditDraftChange={(field, value) =>
              setEditDraft((prev) => ({ ...prev, [field]: value }))
            }
            onSaveEdit={saveEdit}
            onToggleSelected={toggleSelected}
            onClearSelection={() => setSelectedIds([])}
            onSelectAll={() =>
              setSelectedIds(filteredStored.map((it) => it.id))
            }
            onDelete={deleteStored}
            onReload={() => {
              resetStored();
              loadStored(null);
            }}
            onLoadMore={() => loadStored(storedCursor)}
          />
        ) : (
        <form onSubmit={onSubmit} className="space-y-6">
          {mode === "file" ? (
            <section className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6">
              <div
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`rounded-xl border-2 border-dashed transition-colors ${
                  dragging
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                    : "border-slate-300 dark:border-slate-700"
                }`}
              >
                <label className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center cursor-pointer">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className={`w-8 h-8 ${
                      dragging
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-slate-400"
                    }`}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 16.5V6m0 0L8.25 9.75M12 6l3.75 3.75M4.5 16.5v1.875A1.875 1.875 0 0 0 6.375 20.25h11.25A1.875 1.875 0 0 0 19.5 18.375V16.5"
                    />
                  </svg>
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    {dragging
                      ? "Drop the .json file here"
                      : "Drag & drop a .json file here"}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    or{" "}
                    <span className="text-blue-600 dark:text-blue-400 underline">
                      browse
                    </span>{" "}
                    · max 5MB
                  </span>
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>
              </div>

              <p className="text-xs text-amber-700 dark:text-amber-400 mt-3">
                Full sync: the file replaces the whole index. Any Q&A missing
                from it is deleted.
              </p>

              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Accepts a JSON array of{" "}
                <code className="font-mono">{`{ "question": "...", "answer": "..." }`}</code>{" "}
                or <code className="font-mono">{`{ "items": [...] }`}</code>.
              </p>

              {fileError && (
                <div className="mt-4 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                  {fileError}
                </div>
              )}

              {filePreview && (
                <div className="mt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                    <div className="text-sm text-slate-700 dark:text-slate-300">
                      Loaded{" "}
                      <span className="font-semibold">{filePreview.length}</span>{" "}
                      items from <span className="font-mono">{fileName}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => runPreview(filePreview)}
                      disabled={previewing}
                      className="text-sm rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                    >
                      {previewing ? "Comparing..." : "Recompare"}
                    </button>
                  </div>

                  {previewError && (
                    <div className="mb-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                      {previewError}
                    </div>
                  )}

                  {preview ? (
                    <DiffPreview
                      preview={preview}
                      hideUnchanged={hideUnchanged}
                      onToggleHideUnchanged={() =>
                        setHideUnchanged((v) => !v)
                      }
                    />
                  ) : previewing ? (
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-6 text-sm text-slate-500 dark:text-slate-400 text-center">
                      Comparing with the index...
                    </div>
                  ) : (
                    <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
                      {filePreview.map((it, i) => (
                        <div
                          key={i}
                          className="p-3 text-sm bg-slate-50/50 dark:bg-slate-950/50"
                        >
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {i + 1}. {it.question}
                          </div>
                          <div className="text-slate-600 dark:text-slate-400 mt-1">
                            {it.answer}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          ) : (
            <section className="space-y-3">
              {items.map((it, idx) => (
                <div
                  key={idx}
                  className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      Item #{idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      className="text-xs text-red-600 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="space-y-2">
                    <input
                      type="text"
                      placeholder="Question"
                      value={it.question}
                      onChange={(e) =>
                        updateItem(idx, "question", e.target.value)
                      }
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <textarea
                      placeholder="Answer"
                      rows={3}
                      value={it.answer}
                      onChange={(e) =>
                        updateItem(idx, "answer", e.target.value)
                      }
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addItem}
                className="w-full rounded-lg border border-dashed border-slate-300 dark:border-slate-700 py-2.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900"
              >
                + Add item
              </button>
            </section>
          )}

          {topError && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {topError}
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-600 dark:text-slate-400">
              {payload.length} valid item{payload.length === 1 ? "" : "s"} ready
              to upload
              {mode === "manual" && (
                <span className="block text-xs text-slate-500 dark:text-slate-500">
                  Adds new items and updates existing ones. Nothing is deleted.
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onExportPdf}
                disabled={exporting || payload.length === 0}
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200 font-medium px-5 py-2.5"
              >
                {exporting ? "Preparing PDF..." : "Export PDF"}
              </button>
              <button
                type="submit"
                disabled={submitting || payload.length === 0}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-medium px-5 py-2.5"
              >
                {submitting
                  ? "Uploading..."
                  : `Upload to ${PROJECT_LABELS[project]}`}
              </button>
            </div>
          </div>
        </form>
        )}

        {result && (
          <section className="mt-8 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
              Upload result
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-4">
              <Stat label="Total" value={result.total} />
              <Stat label="Upserted" value={result.upserted} accent="green" />
              <Stat label="Skipped (identical)" value={result.skipped ?? 0} />
              <Stat
                label="Deleted (not in file)"
                value={result.deleted ?? 0}
                accent={result.deleted > 0 ? "red" : undefined}
              />
              <Stat
                label="Failed"
                value={result.failed}
                accent={result.failed > 0 ? "red" : undefined}
              />
            </div>

            {result.duplicates > 0 && (
              <div className="mb-4 text-xs text-slate-600 dark:text-slate-400">
                {result.duplicates} duplicate question
                {result.duplicates === 1 ? "" : "s"} in the file were collapsed
                (last one wins).
              </div>
            )}

            {result.errors.length > 0 && (
              <details className="mt-2">
                <summary className="text-sm text-red-700 dark:text-red-400 cursor-pointer">
                  {result.errors.length} error
                  {result.errors.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 text-xs space-y-1 text-red-600 dark:text-red-300">
                  {result.errors.map((e, i) => (
                    <li key={i} className="font-mono">
                      {e.index >= 0 ? `#${e.index}: ` : ""}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {result.deletedIds?.length > 0 && (
              <details className="mt-3">
                <summary className="text-sm text-red-700 dark:text-red-400 cursor-pointer">
                  View {result.deletedIds.length} deleted ID
                  {result.deletedIds.length === 1 ? "" : "s"}
                </summary>
                <pre className="mt-2 text-xs bg-slate-50 dark:bg-slate-950 p-3 rounded-lg max-h-60 overflow-auto">
                  {result.deletedIds.join("\n")}
                </pre>
              </details>
            )}

            {result.ids.length > 0 && (
              <details className="mt-3">
                <summary className="text-sm text-slate-600 dark:text-slate-400 cursor-pointer">
                  View {result.ids.length} upserted ID
                  {result.ids.length === 1 ? "" : "s"}
                </summary>
                <pre className="mt-2 text-xs bg-slate-50 dark:bg-slate-950 p-3 rounded-lg max-h-60 overflow-auto">
                  {result.ids.join("\n")}
                </pre>
              </details>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

const DIFF_BADGE: Record<DiffStatus, string> = {
  removed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  new: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  changed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  unchanged: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  duplicate: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300",
  invalid: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

const DIFF_ROW: Record<DiffStatus, string> = {
  removed: "border-l-4 border-l-red-600 bg-red-50/60 dark:bg-red-950/20",
  new: "border-l-4 border-l-green-500 bg-green-50/60 dark:bg-green-950/20",
  changed: "border-l-4 border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/20",
  unchanged: "border-l-4 border-l-slate-300 dark:border-l-slate-700",
  duplicate: "border-l-4 border-l-purple-400 bg-purple-50/60 dark:bg-purple-950/20",
  invalid: "border-l-4 border-l-red-500 bg-red-50/60 dark:bg-red-950/20",
};

function DiffPreview({
  preview,
  hideUnchanged,
  onToggleHideUnchanged,
}: {
  preview: PreviewResponse;
  hideUnchanged: boolean;
  onToggleHideUnchanged: () => void;
}) {
  const { counts, entries } = preview;
  const willUpload = counts.new + counts.changed;
  const visible = hideUnchanged
    ? entries.filter((e) => e.status !== "unchanged")
    : entries;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {(Object.keys(DIFF_LABELS) as DiffStatus[])
          .filter((k) => counts[k] > 0)
          .map((k) => (
            <span
              key={k}
              className={`text-xs font-medium px-2 py-1 rounded-full ${DIFF_BADGE[k]}`}
            >
              {DIFF_LABELS[k]}: {counts[k]}
            </span>
          ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={hideUnchanged}
            onChange={onToggleHideUnchanged}
          />
          Hide unchanged
        </label>
      </div>

      <div className="text-sm text-slate-700 dark:text-slate-300 mb-2">
        {willUpload} item{willUpload === 1 ? "" : "s"} will be uploaded ·{" "}
        {counts.unchanged} identical item{counts.unchanged === 1 ? "" : "s"}{" "}
        skipped
      </div>

      {counts.removed > 0 && (
        <div className="mb-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {counts.removed} item{counts.removed === 1 ? "" : "s"} in the index
          {counts.removed === 1 ? " is" : " are"} not in this file and will be{" "}
          <strong>permanently deleted</strong> on upload.
        </div>
      )}

      <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
        {visible.length === 0 && (
          <div className="p-3 text-sm text-slate-500 dark:text-slate-400">
            Nothing to show.
          </div>
        )}
        {visible.map((e) => (
          <div
            key={`${e.index}-${e.id}`}
            className={`p-3 text-sm ${DIFF_ROW[e.status]}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="font-medium text-slate-900 dark:text-slate-100 break-words">
                {e.status === "removed" ? "" : `${e.index + 1}. `}
                <span
                  className={
                    e.status === "removed" ? "line-through opacity-70" : ""
                  }
                >
                  {e.question || <em>(empty)</em>}
                </span>
              </div>
              <span
                className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${DIFF_BADGE[e.status]}`}
              >
                {DIFF_LABELS[e.status]}
              </span>
            </div>

            {e.status === "invalid" ? (
              <div className="mt-1 text-red-700 dark:text-red-300">
                {e.message}
              </div>
            ) : e.status === "changed" ? (
              <div className="mt-2 font-mono text-xs rounded-md overflow-hidden border border-slate-200 dark:border-slate-800">
                <div className="bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 px-2 py-1 whitespace-pre-wrap break-words">
                  <span className="select-none opacity-60">- </span>
                  {e.previousAnswer}
                </div>
                <div className="bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300 px-2 py-1 whitespace-pre-wrap break-words">
                  <span className="select-none opacity-60">+ </span>
                  {e.answer}
                </div>
              </div>
            ) : (
              <div
                className={`text-slate-600 dark:text-slate-400 mt-1 whitespace-pre-wrap break-words ${
                  e.status === "removed" ? "line-through opacity-70" : ""
                }`}
              >
                {e.answer}
              </div>
            )}

            {e.status === "removed" && (
              <div className="mt-1 text-xs text-red-700 dark:text-red-300">
                Not present in the uploaded file · {e.id}
              </div>
            )}

            {e.status === "duplicate" && (
              <div className="mt-1 text-xs text-purple-700 dark:text-purple-300">
                Same question appears later in the file; only the last one is
                uploaded.
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ManageSection({
  items,
  totalLoaded,
  loading,
  loaded,
  error,
  nextCursor,
  deletingIds,
  selectedIds,
  search,
  onSearchChange,
  editingId,
  editDraft,
  savingEdit,
  onStartEdit,
  onCancelEdit,
  onEditDraftChange,
  onSaveEdit,
  onToggleSelected,
  onClearSelection,
  onSelectAll,
  onDelete,
  onReload,
  onLoadMore,
}: {
  items: StoredFaq[];
  totalLoaded: number;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  nextCursor: string | null;
  deletingIds: string[];
  selectedIds: string[];
  search: string;
  onSearchChange: (value: string) => void;
  editingId: string | null;
  editDraft: FaqItem;
  savingEdit: boolean;
  onStartEdit: (item: StoredFaq) => void;
  onCancelEdit: () => void;
  onEditDraftChange: (field: keyof FaqItem, value: string) => void;
  onSaveEdit: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onClearSelection: () => void;
  onSelectAll: () => void;
  onDelete: (ids: string[]) => void;
  onReload: () => void;
  onLoadMore: () => void;
}) {
  const filtering = search.trim().length > 0;
  const allSelected =
    items.length > 0 && items.every((it) => selectedIds.includes(it.id));

  return (
    <section className="space-y-3">
      <div className="relative">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search question or answer..."
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-4.35-4.35M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z"
          />
        </svg>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-600 dark:text-slate-400">
          {loaded ? (
            <>
              {filtering
                ? `${items.length} of ${totalLoaded} match`
                : `${totalLoaded} item${totalLoaded === 1 ? "" : "s"} loaded`}
              {nextCursor ? " (more available)" : ""}
              {selectedIds.length > 0 ? ` · ${selectedIds.length} selected` : ""}
            </>
          ) : (
            "Loading uploaded Q&A..."
          )}
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              type="button"
              onClick={allSelected ? onClearSelection : onSelectAll}
              className="text-sm rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {allSelected
                ? "Clear selection"
                : filtering
                  ? "Select matches"
                  : "Select all"}
            </button>
          )}
          <button
            type="button"
            onClick={onReload}
            disabled={loading}
            className="text-sm rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => onDelete(selectedIds)}
            disabled={selectedIds.length === 0}
            className="text-sm rounded-lg bg-red-600 hover:bg-red-700 disabled:bg-red-400 disabled:cursor-not-allowed text-white px-3 py-1.5"
          >
            Delete selected
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loaded && items.length === 0 && !error && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 text-sm text-slate-600 dark:text-slate-400">
          {filtering
            ? `No item matches "${search.trim()}".`
            : "No Q&A found in this index."}
        </div>
      )}

      {items.map((it) => {
        const deleting = deletingIds.includes(it.id);
        const editing = editingId === it.id;

        if (editing) {
          return (
            <div
              key={it.id}
              className="bg-white dark:bg-slate-900 rounded-2xl border-2 border-blue-500 p-4"
            >
              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Question"
                  value={editDraft.question}
                  onChange={(e) =>
                    onEditDraftChange("question", e.target.value)
                  }
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <textarea
                  placeholder="Answer"
                  rows={5}
                  value={editDraft.answer}
                  onChange={(e) => onEditDraftChange("answer", e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {editDraft.question.trim() !== it.question && (
                <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  Changing the question creates a new id and removes the old
                  record.
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onSaveEdit(it.id)}
                  disabled={savingEdit}
                  className="text-sm rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-4 py-1.5"
                >
                  {savingEdit ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  disabled={savingEdit}
                  className="text-sm rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          );
        }

        return (
          <div
            key={it.id}
            className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4"
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <label className="flex items-start gap-2 min-w-0">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(it.id)}
                  onChange={() => onToggleSelected(it.id)}
                  className="mt-1"
                />
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100 break-words">
                  <Highlight text={it.question} term={search} />
                </span>
              </label>
              <div className="shrink-0 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onStartEdit(it)}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => onDelete([it.id])}
                  disabled={deleting}
                  className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  {deleting ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-words">
              <Highlight text={it.answer} term={search} />
            </div>
            <div className="mt-2 text-xs font-mono text-slate-400 dark:text-slate-500 break-all">
              {it.id}
              {it.uploadedAt ? ` · ${it.uploadedAt}` : ""}
            </div>
          </div>
        );
      })}

      {nextCursor && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="w-full rounded-lg border border-dashed border-slate-300 dark:border-slate-700 py-2.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900 disabled:opacity-50"
        >
          {loading ? "Loading..." : "Load more"}
        </button>
      )}
    </section>
  );
}

/** Wrap every case-insensitive occurrence of `term` in a highlight span. */
function Highlight({ text, term }: { text: string; term: string }) {
  const needle = term.trim();
  if (!needle) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let from = 0;

  for (;;) {
    const at = lowerText.indexOf(lowerNeedle, from);
    if (at === -1) break;
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark
        key={at}
        className="bg-yellow-200 dark:bg-yellow-600/50 text-inherit rounded-sm"
      >
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }

  if (parts.length === 0) return <>{text}</>;
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
        active
          ? "bg-blue-600 text-white"
          : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "green" | "red";
}) {
  const color =
    accent === "green"
      ? "text-green-600 dark:text-green-400"
      : accent === "red"
        ? "text-red-600 dark:text-red-400"
        : "text-slate-900 dark:text-slate-100";
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-2xl font-bold mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}
