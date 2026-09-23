import { useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import {
  notificationPermission,
  requestNotificationPermission,
  type createNotificationPreferences,
  type NotificationPermissionState,
} from "../notifications";
import { Switch } from "./ui/switch";

export function NotificationSettings({
  preferences,
}: {
  preferences: ReturnType<typeof createNotificationPreferences>;
}) {
  const values = useStore(preferences.store);
  const [permission, setPermission] = useState<NotificationPermissionState>(notificationPermission);
  const [requesting, setRequesting] = useState(false);
  useEffect(() => {
    const sync = () => {
      setPermission(notificationPermission());
      preferences.sync();
    };
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
    };
  }, [preferences]);
  async function enable(enabled: boolean) {
    if (!enabled) {
      preferences.update({ enabled: false });
      return;
    }
    setRequesting(true);
    const result = await requestNotificationPermission();
    setPermission(result);
    preferences.update({ enabled: result === "granted" });
    setRequesting(false);
  }
  const status = {
    granted: "Browser permission allowed.",
    denied: "Notifications are blocked. Allow them in your browser's site settings.",
    default: "Your browser will ask for permission when you enable notifications.",
    unsupported:
      "Notifications are unavailable in this browser. Use a supported browser over HTTPS.",
  }[permission];
  return (
    <>
      <h2>Notifications</h2>
      <p className="text-sm text-muted-foreground mb-8">
        Receive notifications while Lilac is open, including in a background tab.
      </p>
      <NotificationSetting
        label="Browser notifications"
        description="Saved for your account on this browser."
        value={values.enabled && permission === "granted"}
        disabled={requesting || permission === "unsupported" || permission === "denied"}
        onChange={(enabled) => void enable(enabled)}
      />
      <p role="status" className="text-sm text-muted-foreground mb-8">
        {status}
      </p>
      <NotificationSetting
        label="Response finished"
        description="When the agent finishes a response."
        value={values.completion}
        disabled={!values.enabled || permission !== "granted"}
        onChange={(completion) => preferences.update({ completion })}
      />
      <NotificationSetting
        label="Run failed"
        description="When an agent run ends with an error."
        value={values.failure}
        disabled={!values.enabled || permission !== "granted"}
        onChange={(failure) => preferences.update({ failure })}
      />
      <p className="text-sm text-muted-foreground">
        Notifications show the conversation title without message previews. No alert appears while
        you are viewing that conversation.
      </p>
    </>
  );
}
function NotificationSetting({
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 mb-8">
      <div className="min-w-0">
        <label htmlFor={id}>{label}</label>
        <p id={`${id}-description`} className="text-sm text-muted-foreground mt-1">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        className="mt-0.5"
        aria-describedby={`${id}-description`}
        checked={value}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}
