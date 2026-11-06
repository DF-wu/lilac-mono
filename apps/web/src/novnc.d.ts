// noVNC 1.7 exports its RFB class from the package root; the maintained types still name the old path.
declare module "@novnc/novnc" {
  export { default } from "@novnc/novnc/lib/rfb";
}
