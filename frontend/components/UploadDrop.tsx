"use client";

import clsx from "clsx";
import { UploadCloud } from "lucide-react";
import { useDropzone } from "react-dropzone";

export function UploadDrop({
  onFile,
  disabled,
  title = "Drop a draft video",
  hint = "MP4, MOV, M4V, WebM or MKV",
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
  title?: string;
  hint?: string;
}) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "video/mp4": [".mp4", ".m4v"],
      "video/quicktime": [".mov"],
      "video/webm": [".webm"],
      "video/x-matroska": [".mkv"],
    },
    multiple: false,
    disabled,
    onDropAccepted: (files) => files[0] && onFile(files[0]),
  });
  return (
    <div
      {...getRootProps()}
      className={clsx(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition",
        isDragActive ? "border-emerald-400 bg-emerald-500/5" : "border-zinc-700 hover:border-zinc-500",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <input {...getInputProps()} />
      <UploadCloud className="h-8 w-8 text-emerald-400" />
      <div className="text-sm font-semibold">{isDragActive ? "Drop to start the audit" : title}</div>
      <div className="text-xs text-zinc-500">{hint} · or click to browse</div>
    </div>
  );
}
