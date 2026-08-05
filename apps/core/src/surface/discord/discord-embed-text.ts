import { z } from "zod";

export type DiscordEmbedTextMode = "inbound" | "surface";

export type DiscordEmbedTextField = {
  name?: string;
  value?: string;
};

export type DiscordEmbedTextMeta = {
  title?: string;
  description?: string;
  fields?: DiscordEmbedTextField[];
  imageUrl?: string;
  footer?: string;
};

const optionalNonEmptyStringSchema = z
  .union([z.string(), z.undefined(), z.unknown().transform(() => undefined)])
  .transform((value) => (value?.trim().length ? value : undefined));

const discordEmbedFieldSchema = z
  .object({
    name: optionalNonEmptyStringSchema,
    value: optionalNonEmptyStringSchema,
  })
  .passthrough()
  .transform((field): DiscordEmbedTextField | null => {
    if (!field.name && !field.value) return null;
    return {
      ...(field.name ? { name: field.name } : {}),
      ...(field.value ? { value: field.value } : {}),
    };
  });

const discordEmbedImageSchema = z.object({ url: optionalNonEmptyStringSchema }).passthrough();
const discordEmbedFooterSchema = z.object({ text: optionalNonEmptyStringSchema }).passthrough();

const discordEmbedSchema = z
  .object({
    title: optionalNonEmptyStringSchema,
    description: optionalNonEmptyStringSchema,
    fields: z.union([
      z.array(z.union([discordEmbedFieldSchema, z.unknown().transform(() => null)])),
      z.unknown().transform(() => [] as null[]),
    ]),
    image: z.union([discordEmbedImageSchema, z.unknown().transform(() => ({ url: undefined }))]),
    footer: z.union([discordEmbedFooterSchema, z.unknown().transform(() => ({ text: undefined }))]),
  })
  .passthrough()
  .transform((embed): DiscordEmbedTextMeta | null => {
    const fields: DiscordEmbedTextField[] = [];
    for (const field of embed.fields) {
      if (field !== null) fields.push(field);
    }
    const imageUrl = embed.image.url;
    const footer = embed.footer.text;
    if (!embed.title && !embed.description && fields.length === 0 && !imageUrl && !footer) {
      return null;
    }
    return {
      ...(embed.title ? { title: embed.title } : {}),
      ...(embed.description ? { description: embed.description } : {}),
      ...(fields.length > 0 ? { fields } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(footer ? { footer } : {}),
    };
  });

const discordEmbedInputSchema = z.union([
  z
    .string()
    .transform((description): DiscordEmbedTextMeta | null =>
      description.trim().length > 0 ? { description } : null,
    ),
  discordEmbedSchema,
]);
const discordEmbedsSchema = z.array(
  z.union([discordEmbedInputSchema, z.unknown().transform(() => null)]),
);

export function normalizeDiscordEmbeds(input: unknown): DiscordEmbedTextMeta[] {
  const parsed = discordEmbedsSchema.safeParse(input);
  return parsed.success
    ? parsed.data.filter((embed): embed is DiscordEmbedTextMeta => embed !== null)
    : [];
}

function asNonEmptyString(value: string | undefined): string | undefined {
  return value?.trim().length ? value : undefined;
}

function formatEmbedFields(fields: readonly DiscordEmbedTextField[]): string | undefined {
  const lines = fields
    .map((field) => {
      const name = field.name ?? "";
      const value = field.value ?? "";
      const hasName = name.trim().length > 0;
      const hasValue = value.trim().length > 0;

      if (hasName && hasValue) return `${name}: ${value}`;
      if (hasValue) return value;
      if (hasName) return name;
      return "";
    })
    .filter((line) => line.length > 0);

  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

export function buildDiscordRichTextFromContentAndEmbeds(params: {
  content?: string;
  embeds?: readonly DiscordEmbedTextMeta[];
  mode: DiscordEmbedTextMode;
}): string {
  const blocks: string[] = [];

  const content = asNonEmptyString(params.content);
  if (content) blocks.push(content);

  for (const embed of params.embeds ?? []) {
    const title = asNonEmptyString(embed.title);
    const description = asNonEmptyString(embed.description);
    const imageUrl = asNonEmptyString(embed.imageUrl);
    const footer = asNonEmptyString(embed.footer);

    if (title) blocks.push(title);
    if (description) blocks.push(description);

    if (params.mode === "surface") {
      const fields = formatEmbedFields(embed.fields ?? []);
      if (fields) blocks.push(fields);
    }

    if (imageUrl) blocks.push(imageUrl);

    if (params.mode === "surface" && footer) {
      blocks.push(footer);
    }
  }

  return blocks.join("\n\n");
}

export function buildDiscordTaggedTextFromContentAndEmbeds(params: {
  content?: string;
  embeds?: readonly DiscordEmbedTextMeta[];
  labelEmbeds?: boolean;
}): string {
  const blocks: string[] = [];
  const labelEmbeds = params.labelEmbeds ?? true;

  const content = asNonEmptyString(params.content);
  if (content) blocks.push(content);

  for (const embed of params.embeds ?? []) {
    const title = asNonEmptyString(embed.title);
    const description = asNonEmptyString(embed.description);
    const imageUrl = asNonEmptyString(embed.imageUrl);
    const embedContentBlocks = [title, description, imageUrl].filter(
      (block): block is string => typeof block === "string",
    );

    if (embedContentBlocks.length === 0) continue;

    const embedBlocks: string[] = [];

    if (labelEmbeds) {
      embedBlocks.push("[discord_embed]");
    }

    embedBlocks.push(...embedContentBlocks);

    blocks.push(embedBlocks.join("\n\n"));
  }

  return blocks.join("\n\n");
}
