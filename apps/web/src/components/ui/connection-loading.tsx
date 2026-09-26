import { Ring } from "loading-dev";
import { LoadingSpinner } from "./loading-spinner";
import { useEffect, useState } from "react";

export function ConnectionLoading() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div role="status" aria-label="Connecting" className="flex h-5 justify-center">
      <div
        data-slot="connection-spinner"
        data-visible={visible}
        className="size-5 text-muted-foreground opacity-0 transition-opacity duration-200 data-[visible=true]:opacity-100"
        aria-hidden="true"
      >
        <LoadingSpinner spinner={Ring} size={20} />
      </div>
    </div>
  );
}
