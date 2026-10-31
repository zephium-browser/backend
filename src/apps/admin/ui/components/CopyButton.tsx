import { useEffect, useState } from "preact/hooks";
import { Icon } from "./Icon";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        class="btn btn-icon"
        aria-label={label}
        title={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            // Clipboard access can be denied; the value stays selectable on screen.
          }
        }}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
      <span class="sr-only" role="status">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </>
  );
}
