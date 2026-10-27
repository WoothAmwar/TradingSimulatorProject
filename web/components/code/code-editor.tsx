"use client";

import Editor from "@monaco-editor/react";
import { monacoLanguage } from "@/lib/templates";

export function CodeEditor({
  language,
  value,
  onChange,
  readOnly = false,
  height = "60vh",
}: {
  language: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Editor
        height={height}
        theme="vs-dark"
        language={monacoLanguage(language)}
        value={value}
        onChange={(v) => onChange?.(v ?? "")}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          scrollBeyondLastLine: false,
          tabSize: language === "go" ? 8 : 4,
          insertSpaces: language !== "go",
        }}
        loading={<div className="p-4 text-sm text-muted">Loading editor…</div>}
      />
    </div>
  );
}
