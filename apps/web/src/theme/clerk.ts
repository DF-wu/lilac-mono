import type { Appearance } from "@clerk/ui";
import { shadcn } from "@clerk/ui/themes";
import { buttonVariants } from "../components/ui/button";
import { inputClassName } from "../components/ui/input";

const clerkTheme: typeof shadcn = {
  ...shadcn,
  elements: { ...shadcn.elements, input: "", cardBox: "" },
};

export const clerkAppearance = {
  theme: clerkTheme,
  cssLayerName: "clerk",
  variables: {
    colorBackground: "var(--ui-surface)",
    colorForeground: "var(--ui-surface-foreground)",
    colorPrimary: "var(--ui-primary)",
    colorPrimaryForeground: "var(--ui-primary-foreground)",
    colorNeutral: "var(--ui-foreground)",
    colorInput: "var(--ui-input-background)",
    colorInputForeground: "var(--ui-input-foreground)",
    colorMuted: "var(--ui-muted)",
    colorMutedForeground: "var(--ui-muted-foreground)",
    colorDanger: "var(--ui-danger)",
    colorSuccess: "var(--ui-success)",
    colorWarning: "var(--ui-warning)",
    colorBorder: "var(--ui-border)",
    colorRing: "var(--ui-focus)",
    colorModalBackdrop: "var(--ui-overlay)",
    fontFamily: "var(--ui-font-sans)",
    fontSize: "var(--ui-text-sm)",
    borderRadius: "var(--ui-radius-lg)",
    spacing: "calc(var(--ui-space-unit) * 4)",
  },
  elements: {
    rootBox: "w-full min-w-0",
    headerTitle: "text-lg font-semibold",
    headerSubtitle: "text-sm text-muted-foreground",
    formFieldInput: inputClassName,
    otpCodeFieldInput:
      "border border-muted-foreground bg-input-background text-input-foreground shadow-none data-[focus-within=true]:border-ring data-[focus-within=true]:ring-3 data-[focus-within=true]:ring-ring/50 data-[feedback=success]:border-success data-[feedback=success]:data-[focus-within=true]:border-success aria-invalid:border-destructive aria-invalid:data-[focus-within=true]:border-destructive aria-invalid:ring-destructive/20",
    formFieldInput__password: "pr-10",
    formButtonPrimary: buttonVariants({ className: "w-full" }),
    socialButtonsBlockButton: buttonVariants({ variant: "outline", className: "w-full" }),
    formFieldAction: "text-link hover:text-link-hover",
    footer: "bg-surface bg-none",
    footerAction__signIn: "hidden",
  },
  signIn: {
    elements: {
      cardBox:
        "w-full min-w-0 overflow-hidden rounded-xl border border-border bg-surface text-surface-foreground shadow-sm",
      card: "gap-6 bg-surface p-6 text-surface-foreground",
    },
  },
} satisfies Appearance;

export const clerkProfileAppearance = {
  elements: {
    rootBox: "w-full min-w-0",
    cardBox:
      "flex-col w-full h-auto min-h-0 min-w-0 max-w-none rounded-none border-0 bg-transparent shadow-none",
    card: "w-full min-w-0 bg-transparent p-0 shadow-none",
    navbar:
      "sm:w-full sm:max-w-none sm:basis-auto sm:flex-row sm:items-start sm:gap-4 sm:rounded-none sm:bg-transparent sm:p-0 sm:me-0 sm:[&>div]:basis-auto sm:[&>div:has(.cl-navbarButtons)]:min-w-0 sm:[&>div:has(.cl-navbarButtons)]:flex-1",
    footerItem:
      "sm:[.cl-navbar>&]:w-auto sm:[.cl-navbar>&]:shrink-0 sm:[.cl-navbar>&]:self-start sm:[.cl-navbar>&]:ms-auto",
    navbarButtons: "sm:flex-row sm:gap-2",
    navbarButton: "sm:w-auto",
    navbarMobileMenuRow: "w-full shrink-0 rounded-lg bg-surface px-4 py-3",
    navbarMobileMenuButton: "text-foreground",
    scrollBox: "w-full rounded-none bg-transparent shadow-none",
    pageScrollBox: "p-0",
    page: "w-full min-w-0 gap-6 m-0 p-0 pt-6",
    profilePage: "min-w-0",
    profileSection: "min-w-0",
    badge: "bg-muted text-muted-foreground",
  },
} satisfies Appearance;
