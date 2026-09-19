import { Result } from "better-result";
import { WebRequestFailed } from "./http";

function copyFailure(): WebRequestFailed {
  return new WebRequestFailed({
    code: "unavailable",
    message: "Image could not be copied. Download it instead.",
  });
}

export async function copyPreviewImage(
  image: HTMLImageElement,
): Promise<Result<void, WebRequestFailed>> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    return Result.err(copyFailure());
  return Result.gen(async function* () {
    const canvas = yield* Result.try({
      try: () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(image, 0, 0);
        return canvas;
      },
      catch: copyFailure,
    });
    if (!canvas || !canvas.width || !canvas.height) return Result.err(copyFailure());
    const encoded = yield* Result.await(
      Result.tryPromise({
        try: () => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")),
        catch: copyFailure,
      }),
    );
    if (!encoded) return Result.err(copyFailure());
    yield* Result.await(
      Result.tryPromise({
        try: () => navigator.clipboard.write([new ClipboardItem({ "image/png": encoded })]),
        catch: copyFailure,
      }),
    );
    return Result.ok();
  });
}
