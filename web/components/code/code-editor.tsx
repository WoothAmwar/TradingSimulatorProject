"use client";

import Editor from "@monaco-editor/react";

// On Safari, Monaco pre-arms a clipboard write on every click and keypress in the editor and logs
// Safari's refusal (NotAllowedError) as an error, which Next's dev overlay shows as a "Console Error".
// Copy and paste still work, so drop just that log: a NotAllowedError logged from Monaco's code.
let clipboardLogQuieted = false;
function quietMonacoClipboardLog() {
  if (clipboardLogQuieted) return;
  clipboardLogQuieted = true;
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const denied = args.some((a) => (a as { name?: unknown } | null)?.name === "NotAllowedError");
    if (denied && new Error().stack?.includes("monaco-editor")) return;
    original.apply(console, args);
  };
}

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
        language={language}
        value={value}
        onChange={(v) => onChange?.(v ?? "")}
        beforeMount={quietMonacoClipboardLog}
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
