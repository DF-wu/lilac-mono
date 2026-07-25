import { ExternalLink } from "lucide-react";

import { SOURCE_SNAPSHOT_COMMIT } from "../data/types";
import type { SourceRef } from "../data/types";

const REPO_BLOB_BASE = `https://github.com/DF-wu/lilac-mono/blob/${SOURCE_SNAPSHOT_COMMIT}`;

export function SourceLinks({
  sources,
  compact = false,
}: {
  sources: readonly SourceRef[];
  compact?: boolean;
}) {
  return (
    <div className={compact ? "source-links source-links--compact" : "source-links"}>
      {sources.map((item) => (
        <a
          className="source-link"
          href={`${REPO_BLOB_BASE}/${item.path}#L${item.line}`}
          key={`${item.path}:${item.line}`}
          target="_blank"
          rel="noreferrer"
          title={`開啟 ${item.path}:${item.line}`}
        >
          <span>
            {item.label ?? item.path}
            <b>:{item.line}</b>
          </span>
          <ExternalLink aria-hidden="true" size={13} />
        </a>
      ))}
    </div>
  );
}
