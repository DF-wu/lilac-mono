import RFB from "./core/rfb.js";

const parentOrigin = new URLSearchParams(location.search).get("parentOrigin");
let rfb;
function report(state) {
  if (parentOrigin) parent.postMessage({ type: "lilac-computer-state", state }, parentOrigin);
}
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== parentOrigin) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "lilac-computer-input" && typeof message.enabled === "boolean") {
    if (rfb) rfb.viewOnly = !message.enabled;
    return;
  }
  if (message.type !== "lilac-computer-connect" || typeof message.password !== "string" || rfb)
    return;
  const socket = new URL("./websockify", location.href);
  socket.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket.search = "";
  rfb = new RFB(document.getElementById("desktop"), socket.href, {
    credentials: { password: message.password },
  });
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.addEventListener("connect", () => report("connected"));
  rfb.addEventListener("disconnect", () => report("disconnected"));
  rfb.addEventListener("securityfailure", () => report("failed"));
});
report("ready");
