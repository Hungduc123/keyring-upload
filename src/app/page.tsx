"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type FaqItem = { question: string; answer: string };

type UploadResponse = {
  total: number;
  upserted: number;
  failed: number;
  ids: string[];
  errors: { index: number; message: string }[];
};

type Mode = "file" | "manual";

const EMPTY_ITEM: FaqItem = { question: "", answer: "" };

export default function UploadPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("file");

  const [fileName, setFileName] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<FaqItem[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const [items, setItems] = useState<FaqItem[]>([{ ...EMPTY_ITEM }]);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const payload = useMemo<FaqItem[]>(() => {
    if (mode === "file") return filePreview ?? [];
    return items
      .map((i) => ({ question: i.question.trim(), answer: i.answer.trim() }))
      .filter((i) => i.question && i.answer);
  }, [mode, filePreview, items]);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    setFileError(null);
    setFilePreview(null);
    setFileName(null);
    setResult(null);
    setTopError(null);

    const file = e.target.files?.[0];
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
      } catch (err) {
        setFileError(
          err instanceof Error ? `Invalid JSON: ${err.message}` : "Invalid JSON",
        );
      }
    };
    reader.onerror = () => setFileError("Could not read file");
    reader.readAsText(file);
  }

  function updateItem(idx: number, field: keyof FaqItem, value: string) {
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)),
    );
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

    setSubmitting(true);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: payload }),
      });
      const data: UploadResponse | { error: string } = await res
        .json()
        .catch(() => ({ error: "Invalid response" }));

      if (!res.ok && "error" in data) {
        setTopError(data.error);
        return;
      }
      setResult(data as UploadResponse);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSubmitting(false);
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
          <button
            onClick={onLogout}
            className="text-sm rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1 mb-6">
          <ModeButton active={mode === "file"} onClick={() => setMode("file")}>
            Upload JSON file
          </ModeButton>
          <ModeButton
            active={mode === "manual"}
            onClick={() => setMode("manual")}
          >
            Enter manually
          </ModeButton>
        </div>

        <form onSubmit={onSubmit} className="space-y-6">
          {mode === "file" ? (
            <section className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6">
              <label className="block">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Select a .json file
                </span>
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={handleFileChange}
                  className="block mt-2 text-sm text-slate-700 dark:text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-white hover:file:bg-blue-700"
                />
              </label>

              <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
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
                  <div className="text-sm text-slate-700 dark:text-slate-300 mb-2">
                    Loaded{" "}
                    <span className="font-semibold">{filePreview.length}</span>{" "}
                    items from <span className="font-mono">{fileName}</span>
                  </div>
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
            </div>
            <button
              type="submit"
              disabled={submitting || payload.length === 0}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-medium px-5 py-2.5"
            >
              {submitting ? "Uploading..." : "Upload to Upstash"}
            </button>
          </div>
        </form>

        {result && (
          <section className="mt-8 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
              Upload result
            </h2>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <Stat label="Total" value={result.total} />
              <Stat label="Upserted" value={result.upserted} accent="green" />
              <Stat
                label="Failed"
                value={result.failed}
                accent={result.failed > 0 ? "red" : undefined}
              />
            </div>

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
