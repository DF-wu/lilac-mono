import { toast } from "./components/ui/toast";

export function showAppUpdateToast(activate: () => void, id = "app-update") {
  return toast.add({
    id,
    title: "Update available",
    description: "Reload to update.",
    type: "info",
    timeout: 0,
    actionProps: { children: "Reload", onClick: activate },
  });
}
