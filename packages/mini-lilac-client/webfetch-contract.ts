import { z } from "zod";

export const MINI_LILAC_WEBFETCH_MAX_URL_CHARACTERS = 2_048;

export const miniLilacWebfetchUrlSchema = z
  .url()
  .trim()
  .max(MINI_LILAC_WEBFETCH_MAX_URL_CHARACTERS)
  .superRefine((value, context) => {
    if (!URL.canParse(value)) {
      context.addIssue({ code: "custom", message: "Invalid webfetch URL" });
      return;
    }
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "URL must use HTTP or HTTPS" });
    }
    if (url.username || url.password) {
      context.addIssue({ code: "custom", message: "URL credentials are not allowed" });
    }
  });
