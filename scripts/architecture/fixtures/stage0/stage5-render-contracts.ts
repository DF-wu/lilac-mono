export interface ImportedMethodContract {
  decode(value: unknown): string;
}

export interface ImportedCallContract {
  (value: unknown): string;
}

export interface ImportedNestedContract {
  readonly child: {
    render(value: unknown): string;
  };
}

type DeepContract<
  Depth extends number,
  Seen extends readonly string[] = [],
> = Seen["length"] extends Depth
  ? { readonly value: string }
  : { readonly value: string; readonly next: DeepContract<Depth, readonly [...Seen, "next"]> };

export type ImportedOverBudgetContract = DeepContract<300>;

export interface ImportedRecursiveContract {
  readonly label: string;
  readonly next?: ImportedRecursiveContract;
}
