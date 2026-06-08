"use client";

import { useEffect, useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import Badge from "./Badge";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function RequestLogSessionModal({ sessionName, onClose }) {
  const [session, setSession] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState(null);
  const { copy, copied } = useCopyToClipboard();

  useEffect(() => {
    if (!sessionName) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/request-logs/sessions/${encodeURIComponent(sessionName)}`);
        const data = await res.json();
        if (!mounted) return;
        if (!res.ok) {
          setError(data.error || "Failed to load session");
          return;
        }
        setSession(data);
        if (data.files?.length) {
          setSelectedFile(data.files[0].name);
        }
      } catch (e) {
        if (mounted) setError(e.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [sessionName]);

  useEffect(() => {
    if (!sessionName || !selectedFile) return;
    let mounted = true;
    (async () => {
      setFileLoading(true);
      try {
        const res = await fetch(
          `/api/request-logs/sessions/${encodeURIComponent(sessionName)}?file=${encodeURIComponent(selectedFile)}`
        );
        const data = await res.json();
        if (!mounted) return;
        if (res.ok) setFileContent(data.content || "");
        else setFileContent(data.error || "Failed to load file");
      } catch (e) {
        if (mounted) setFileContent(e.message);
      } finally {
        if (mounted) setFileLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [sessionName, selectedFile]);

  return (
    <Modal
      isOpen={!!sessionName}
      onClose={onClose}
      title={sessionName ? "Log session" : ""}
      size="xl"
    >
      {loading ? (
        <p className="text-sm text-text-muted py-8 text-center">Loading session…</p>
      ) : error ? (
        <p className="text-sm text-danger py-4">{error}</p>
      ) : (
        <div className="flex flex-col gap-3 min-h-[320px]">
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs font-mono bg-surface-2 px-2 py-1 rounded truncate max-w-full">{session?.name}</code>
            {session?.hasError ? (
              <Badge variant="error" size="sm">failed</Badge>
            ) : (
              <Badge variant="success" size="sm">ok</Badge>
            )}
            {session?.mtime && (
              <span className="text-xs text-text-muted">{new Date(session.mtime).toLocaleString()}</span>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-3 flex-1 min-h-0">
            <div className="sm:w-48 shrink-0 flex flex-col gap-1 max-h-64 overflow-y-auto">
              {(session?.files || []).map((f) => (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => setSelectedFile(f.name)}
                  className={`text-left text-xs font-mono px-2 py-1.5 rounded transition-colors ${
                    selectedFile === f.name ? "bg-primary/10 text-primary" : "hover:bg-surface-2 text-text-muted"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => copy(fileContent, `log-${selectedFile}`)}
                  disabled={!fileContent || fileLoading}
                >
                  <span className="material-symbols-outlined text-[14px] mr-1">
                    {copied === `log-${selectedFile}` ? "check" : "content_copy"}
                  </span>
                  {copied === `log-${selectedFile}` ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="flex-1 overflow-auto rounded-lg border border-border bg-bg-alt p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-96">
                {fileLoading ? "Loading…" : fileContent || "Select a file"}
              </pre>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
