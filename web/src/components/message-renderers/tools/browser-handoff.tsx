import { useOpenBrowserPane } from "@/features/browser/pane";
import type { ToolContentRendererProps } from "../types";

export function BrowserHandoffContent({ payload }: ToolContentRendererProps) {
  const open = useOpenBrowserPane();
  const path =
    typeof payload.viewer_path === "string" &&
    /^\/browser\/browser_[0-9A-HJKMNP-TV-Z]{26}$/.test(payload.viewer_path)
      ? payload.viewer_path
      : null;
  return (
    <div className="space-y-2">
      <p>
        {typeof payload.summary === "string"
          ? payload.summary
          : typeof payload.reason === "string"
            ? payload.reason
            : "Browser needs your help."}
      </p>
      {path && (
        <a
          className="inline-block rounded border border-border px-3 py-2 text-sm hover:bg-secondary"
          href={path}
          onClick={(event) => {
            if (open && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              open(path.slice(9));
            }
          }}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open browser
        </a>
      )}
    </div>
  );
}
