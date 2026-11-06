import RFB from "@novnc/novnc";
import { decodeComputerCommand } from "./computer-viewer";

const query = new URLSearchParams(location.search);
const parentOrigin = location.origin;
let rfb: RFB | undefined;

function report(state: "ready" | "connected" | "disconnected" | "failed") {
  parent.postMessage({ type: "lilac-computer-state", state }, parentOrigin);
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent || event.origin !== parentOrigin) return;
  const command = decodeComputerCommand(event);
  if (!command) return;
  if (command.type === "lilac-computer-input") {
    if (rfb) rfb.viewOnly = !command.enabled;
    return;
  }
  if (rfb) return;
  const target = document.getElementById("desktop");
  if (!target) return;
  const socket = new URL("/api/computer/socket", location.href);
  socket.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket.searchParams.set("threadId", query.get("threadId") ?? "");
  socket.searchParams.set("generation", query.get("generation") ?? "");
  rfb = new RFB(target, socket.href, {
    credentials: { password: command.password, username: "", target: "" },
  });
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.addEventListener("connect", () => report("connected"));
  rfb.addEventListener("disconnect", () => report("disconnected"));
  rfb.addEventListener("securityfailure", () => report("failed"));
});
window.addEventListener("pagehide", () => rfb?.disconnect());
report("ready");
