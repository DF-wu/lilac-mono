import { CircleAlert, WifiOff } from "lucide-react";
import { Button } from "./ui/button";
import { LoadingSpinner } from "./ui/loading-spinner";

const states = {
  loading: { icon: <LoadingSpinner />, label: "Loading" },
  offline: { icon: <WifiOff className="size-4" />, label: "Offline" },
  error: { icon: <CircleAlert className="size-4" />, label: "Couldn't load conversation" },
};

export function ConversationStatus({
  state,
  detail,
  onRetry,
}: {
  state: keyof typeof states;
  detail?: string;
  onRetry?: () => void;
}) {
  const { icon, label } = states[state];
  return (
    <div className="empty-chat gap-4 px-6 text-sm" role="status" data-state={state}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="inline-flex items-center gap-2">
          {icon}
          {label}
        </span>
        {detail ? <span className="max-w-80 text-xs break-words">{detail}</span> : null}
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
