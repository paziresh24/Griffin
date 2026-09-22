import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, Maximize2 } from "lucide-react";
import { Streamdown } from "streamdown";
import { useApiBase } from "../base.js";
import { textDir } from "../dir.js";

const TEXT = /^text\/|^application\/(json|yaml|xml|x-ndjson)$/;

function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Renders any file a tool produced, by type. `media` = { mediaId, mimeType, name, bytes }.
export function MediaView({ media, caption }) {
  const base = useApiBase();
  if (!media?.mediaId) return null;
  const url = `${base}/media/${media.mediaId}`;
  const type = media.mimeType || "application/octet-stream";
  const name = media.name || "file";

  let body;
  if (type.startsWith("image/")) {
    body = (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={name} loading="lazy" className="max-h-[28rem] max-w-full rounded-md border bg-muted/40 object-contain" />
      </a>
    );
  } else if (type.startsWith("video/")) {
    body = <video src={url} controls preload="metadata" className="max-h-[28rem] w-full rounded-md border bg-black" />;
  } else if (type.startsWith("audio/")) {
    body = <audio src={url} controls preload="metadata" className="w-full" />;
  } else if (type === "application/pdf") {
    body = <PdfView url={url} name={name} />;
  } else if (TEXT.test(type)) {
    body = <TextView url={url} type={type} />;
  } else {
    body = (
      <div className="flex items-center gap-2 rounded-md border px-3 py-3 text-sm">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <span className="ltr min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
      </div>
    );
  }

  return (
    <figure className="space-y-1.5">
      {body}
      <figcaption className="flex items-center gap-2 text-xs text-muted-foreground">
        {caption ? <span dir="auto" className="min-w-0 truncate">{caption}</span> : null}
        <span className="ltr min-w-0 truncate font-mono">{name} · {type} · {formatBytes(media.bytes)}</span>
        <a href={url} target="_blank" rel="noreferrer" className="ms-auto shrink-0 hover:text-foreground" title="باز کردن">
          <ExternalLink className="size-3.5" />
        </a>
        <a href={url} download={name} className="shrink-0 hover:text-foreground" title="دانلود">
          <Download className="size-3.5" />
        </a>
      </figcaption>
    </figure>
  );
}

function PdfView({ url, name }) {
  const [tall, setTall] = useState(false);
  return (
    <div className="relative">
      <iframe src={url} title={name} className={`w-full rounded-md border bg-white ${tall ? "h-[80vh]" : "h-96"}`} />
      <button
        type="button"
        onClick={() => setTall(!tall)}
        className="absolute end-2 top-2 rounded-md border bg-card/90 p-1 text-muted-foreground hover:text-foreground"
        title="بزرگ‌تر"
      >
        <Maximize2 className="size-3.5" />
      </button>
    </div>
  );
}

function TextView({ url, type }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`http ${r.status}`))))
      .then((t) => alive && setText(t.length > 400_000 ? `${t.slice(0, 400_000)}\n… [بریده شد]` : t))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [url]);
  if (error) return <p className="text-xs text-bad">{error}</p>;
  if (text === null) return <p className="text-xs text-muted-foreground">در حال بارگذاری…</p>;
  if (type === "text/markdown") {
    const dir = textDir(text) === "ltr" ? "ltr" : "rtl";
    return (
      <div className="scrollbar-thin sd-block max-h-[32rem] overflow-auto rounded-md border px-4 py-3 text-sm" dir={dir}>
        <Streamdown dir={dir}>{text}</Streamdown>
      </div>
    );
  }
  return <pre className="ltr scrollbar-thin max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>;
}
